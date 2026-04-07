/**
 * Marble L1.5 Dynamic Psychological Probe Committee
 *
 * Replaces 5 hardcoded heuristic agents with a dynamic LLM-generated committee.
 *
 * Flow:
 *   1. Extract real KG data (what we actually know about the user)
 *   2. LLM generates N agent personas tailored to that specific user's data
 *   3. Each agent specialises in one psychological dimension:
 *      desires, motivations, frustrations, dreams, challenges, fears, blind spots
 *   4. Each agent generates 3-5 probing questions grounded in the user's real data
 *   5. Outputs: Insight[] (backward-compatible) — each insight carries a probe question
 *
 * Requires: LLM_PROVIDER + API key in env (deepseek, anthropic, or openai)
 *
 * Usage:
 *   import { runInsightSwarm } from './insight-swarm.js';
 *   const insights = await runInsightSwarm(kg);
 *   // insights: Insight[]  (sorted by priority desc)
 *
 * Extended usage (custom client):
 *   const insights = await runInsightSwarm(kg, { llmClient, model: 'deepseek-chat' });
 */

import { createLLMClient, defaultModel } from './llm-provider.js';

// ── Parse Failure Counter (kept for benchmark compat) ─────────────────────
export const parseFailureCounter = {
  counts: {},
  increment(agentName) { this.counts[agentName] = (this.counts[agentName] || 0) + 1; },
  reset()  { this.counts = {}; },
  total()  { return Object.values(this.counts).reduce((s, v) => s + v, 0); },
  report() { return { total: this.total(), byAgent: { ...this.counts } }; },
};

// ── KG Extraction ──────────────────────────────────────────────────────────

/**
 * Pull everything real out of the KG into a plain object for the LLM.
 * If the KG is sparse we still give the LLM what we have — the committee
 * adapts to the data, not the other way around.
 */
function extractKGSummary(kg) {
  const user     = kg.user || kg.getUser?.() || {};
  const memNodes = kg.getMemoryNodesSummary?.() || { beliefs: [], preferences: [], identities: [], confidence: {} };
  const dimPrefs = kg.getDimensionalPreferences?.() || [];

  const interests  = (user.interests  || []).map(i => ({ topic: i.topic, weight: i.weight, trend: i.trend }));
  const history    = (user.history    || []).filter(h => h.story_id && !h.story_id.startsWith('sim_'));
  const beliefs    = memNodes.beliefs    || [];
  const identities = memNodes.identities || [];

  // Aggregate topic signals from real history
  const topicSignals = {};
  for (const h of history) {
    for (const t of (h.topics || [])) {
      const k = t.toLowerCase();
      if (!topicSignals[k]) topicSignals[k] = { up: 0, down: 0, share: 0 };
      if (h.reaction === 'up')    topicSignals[k].up++;
      if (h.reaction === 'down')  topicSignals[k].down++;
      if (h.reaction === 'share') topicSignals[k].share++;
    }
  }
  const topTopics = Object.entries(topicSignals)
    .sort((a, b) => (b[1].up + b[1].share) - (a[1].up + a[1].share))
    .slice(0, 10)
    .map(([t, v]) => ({ topic: t, ...v }));

  return {
    userId:      user.id || 'unknown',
    interests:   interests.slice(0, 15),
    topTopics,
    beliefs:     beliefs.slice(0, 20),
    identities:  identities.slice(0, 15),
    dimPrefs:    dimPrefs.slice(0, 20),
    historySize: history.length,
    context:     user.context || {},
  };
}

// ── JSON Parser ────────────────────────────────────────────────────────────

function _parseJSON(text, agentName = 'unknown') {
  const s = String(text).trim();
  try { return JSON.parse(s); } catch {}
  const fence = s.match(/```json?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch {} }
  const obj = s.indexOf('{'), objE = s.lastIndexOf('}');
  if (obj !== -1 && objE > obj) { try { return JSON.parse(s.slice(obj, objE + 1)); } catch {} }
  const arr = s.indexOf('['), arrE = s.lastIndexOf(']');
  if (arr !== -1 && arrE > arr) { try { return JSON.parse(s.slice(arr, arrE + 1)); } catch {} }
  parseFailureCounter.increment(agentName);
  return null;
}

// ── Step 1: Generate Committee ─────────────────────────────────────────────

const PSYCH_DIMENSIONS = [
  'core desires',
  'hidden fears',
  'primary motivations',
  'recurring frustrations',
  'unfulfilled dreams',
  'identity tensions',
  'avoidance patterns',
];

/**
 * Ask the LLM to generate a committee of agents tuned to this user's actual data.
 * Returns an array of agent descriptors: { name, dimension, angle, rationale }
 */
async function generateCommittee(kgSummary, llmClient, model) {
  const prompt = `You are building a psychological probe committee for a user knowledge graph system.

USER DATA SNAPSHOT:
- Interests (by weight): ${kgSummary.interests.map(i => `${i.topic}(${i.weight?.toFixed(2)})`).join(', ') || 'none yet'}
- Top engaged topics: ${kgSummary.topTopics.map(t => `${t.topic}(+${t.up}/-${t.down})`).join(', ') || 'none yet'}
- Known beliefs: ${kgSummary.beliefs.map(b => b.topic || b.content || JSON.stringify(b)).slice(0,8).join(', ') || 'none yet'}
- Identity signals: ${kgSummary.identities.map(i => i.label || i.type || JSON.stringify(i)).slice(0,6).join(', ') || 'none yet'}
- History events: ${kgSummary.historySize} real interactions recorded

AVAILABLE PSYCHOLOGICAL DIMENSIONS:
${PSYCH_DIMENSIONS.map((d, i) => `${i + 1}. ${d}`).join('\n')}

Generate a committee of 5-6 agents. Each agent specialises in ONE psychological dimension, and their angle should be specifically calibrated to what we see in this user's data — not generic.

For each agent decide:
- Which dimension resonates most with this user's apparent patterns
- What specific angle to probe given what we already know
- Why this angle matters for THIS specific user (1 sentence)

Respond with JSON array only:
[
  {
    "name": "AgentName",
    "dimension": "one of the dimensions above",
    "angle": "specific angle tailored to this user's data",
    "rationale": "why this angle for this user"
  }
]`;

  try {
    const res = await llmClient.messages.create({
      model,
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = res.content?.[0]?.text || res.content || '';
    const committee = _parseJSON(text, 'committee-generator');
    if (Array.isArray(committee) && committee.length > 0) return committee;
  } catch (err) {
    console.error('[InsightSwarm] committee generation failed:', err.message);
  }

  // Fallback: generic committee if LLM fails
  return PSYCH_DIMENSIONS.slice(0, 5).map((dim, i) => ({
    name: `Agent${i + 1}`,
    dimension: dim,
    angle: `Explore ${dim} patterns from available data`,
    rationale: 'fallback agent',
  }));
}

// ── Step 2: Run Each Agent ─────────────────────────────────────────────────

/**
 * Each agent receives the KG summary and its specific psychological brief.
 * It returns 3-5 insights, each containing a probing question grounded in real data.
 */
async function runAgent(agent, kgSummary, llmClient, model) {
  const dataContext = buildDataContext(kgSummary);

  const prompt = `You are ${agent.name}, a psychological probe agent.

YOUR DIMENSION: ${agent.dimension}
YOUR ANGLE: ${agent.angle}
YOUR BRIEF: ${agent.rationale}

USER DATA:
${dataContext}

Your job: generate 3-5 insights that DEEPEN UNDERSTANDING of this user's "${agent.dimension}".

Each insight must:
1. Be grounded in SPECIFIC data points from the user data above (quote topics, weights, patterns)
2. Identify a gap, tension, or unexplored pattern
3. Include a probing QUESTION that, if answered, would significantly enrich the model
4. NOT be generic — must reference something specific to this user

The questions should feel like they come from someone who has studied this person —
not a generic psychology survey.

Respond with JSON array only:
[
  {
    "insight": "Observation grounded in specific data (1-2 sentences)",
    "question": "The probing question to ask the user",
    "confidence": 0.0-1.0,
    "data_refs": ["specific data point 1", "specific data point 2"]
  }
]`;

  try {
    const res = await llmClient.messages.create({
      model,
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = res.content?.[0]?.text || res.content || '';
    const raw = _parseJSON(text, agent.name);
    if (!Array.isArray(raw)) return [];

    return raw
      .filter(r => r.insight && r.question)
      .map(r => ({
        insight:              r.insight,
        question:             r.question,
        confidence:           Math.min(1, Math.max(0, r.confidence || 0.7)),
        supporting_facts:     (r.data_refs || []).map(d => `data:${d}`),
        lens:                 agent.dimension.replace(/\s+/g, '_'),
        agent:                agent.name,
        // backward-compat aliases consumed by swarm.js
        observation:          r.insight,
        hypothesis:           r.insight,
        derived_predictions:  [],
        contradicting_signals:[],
        source_layer:         'l1.5',
        l2_seed:              (r.confidence || 0.7) >= 0.7,
      }));
  } catch (err) {
    console.error(`[InsightSwarm] agent ${agent.name} failed:`, err.message);
    return [];
  }
}

// ── Data Context Builder ───────────────────────────────────────────────────

function buildDataContext(kgSummary) {
  const lines = [];

  if (kgSummary.interests.length > 0) {
    lines.push('INTERESTS (topic / weight / trend):');
    kgSummary.interests.forEach(i => lines.push(`  - ${i.topic}: weight=${i.weight?.toFixed(2)} trend=${i.trend || 'stable'}`));
  }

  if (kgSummary.topTopics.length > 0) {
    lines.push('ENGAGED TOPICS (from real interactions):');
    kgSummary.topTopics.forEach(t => lines.push(`  - ${t.topic}: +${t.up} up / -${t.down} down / ${t.share} shared`));
  }

  if (kgSummary.beliefs.length > 0) {
    lines.push('KNOWN BELIEFS:');
    kgSummary.beliefs.slice(0, 10).forEach(b => {
      const label = b.topic || b.content || JSON.stringify(b);
      const strength = b.strength !== undefined ? ` (strength: ${b.strength?.toFixed(2)})` : '';
      lines.push(`  - ${label}${strength}`);
    });
  }

  if (kgSummary.identities.length > 0) {
    lines.push('IDENTITY SIGNALS:');
    kgSummary.identities.slice(0, 8).forEach(i => {
      const label = i.label || i.type || JSON.stringify(i);
      lines.push(`  - ${label}`);
    });
  }

  if (kgSummary.dimPrefs.length > 0) {
    lines.push('DIMENSIONAL PREFERENCES:');
    kgSummary.dimPrefs.slice(0, 10).forEach(d => {
      lines.push(`  - ${d.domain || '?'} / ${d.dimensionId || '?'}: strength=${d.strength?.toFixed(2)}`);
    });
  }

  lines.push(`HISTORY SIZE: ${kgSummary.historySize} real interactions`);

  if (Object.keys(kgSummary.context || {}).length > 0) {
    lines.push('CONTEXT: ' + JSON.stringify(kgSummary.context));
  }

  return lines.join('\n') || '(No data yet — user is new to the system)';
}

// ── Aggregator ─────────────────────────────────────────────────────────────

function aggregate(rawInsights) {
  // Dedup on insight prefix
  const seen = new Map();
  for (const ins of rawInsights) {
    const key = ins.insight.slice(0, 60).toLowerCase().replace(/\s+/g, ' ');
    const existing = seen.get(key);
    if (!existing || ins.confidence > existing.confidence) seen.set(key, ins);
  }

  const deduped = [...seen.values()];

  // Reward lens diversity
  const lensCount = {};
  for (const ins of deduped) lensCount[ins.lens] = (lensCount[ins.lens] || 0) + 1;

  return deduped
    .map(ins => ({ ...ins, _rank: ins.confidence + (1 / (lensCount[ins.lens] || 1)) * 0.05 }))
    .sort((a, b) => b._rank - a._rank)
    .map(({ _rank, ...rest }) => rest);
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Run the dynamic psychological probe committee against a KG.
 *
 * @param {import('./kg.js').KnowledgeGraph} kg
 * @param {Object} [opts]
 * @param {Object} [opts.llmClient]  - Pre-built LLM client (default: from env)
 * @param {string} [opts.model]      - Model override
 * @returns {Promise<Insight[]>}
 */
export async function runInsightSwarm(kg, opts = {}) {
  const llmClient = opts.llmClient || createLLMClient();
  const model     = opts.model || llmClient.defaultModel('heavy');

  const kgSummary = extractKGSummary(kg);

  // Generate committee tailored to this user's data
  const committee = await generateCommittee(kgSummary, llmClient, model);

  // Run agents sequentially — self-hosted single-GPU servers can't handle parallel requests
  const agentResults = [];
  for (const agent of committee) {
    agentResults.push(await runAgent(agent, kgSummary, llmClient, model));
  }

  return aggregate(agentResults.flat());
}

/**
 * Return only L2-seed insights (confidence >= 0.7).
 *
 * @param {import('./kg.js').KnowledgeGraph} kg
 * @param {Object} [opts]
 * @returns {Promise<Insight[]>}
 */
export async function getL2Seeds(kg, opts = {}) {
  const insights = await runInsightSwarm(kg, opts);
  return insights.filter(i => i.l2_seed);
}
