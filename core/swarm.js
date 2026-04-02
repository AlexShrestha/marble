/**
 * Prism Swarm — Multi-Agent Story Curation
 *
 * Each agent evaluates stories through a different lens,
 * all grounded in the user's Clone (digital twin).
 *
 * The agents don't just score — they argue, advocate, and reach consensus.
 * This is how 100 stories become 10 magical ones.
 *
 * v2: Dynamic agent fleet — domain-aware agents generated per context.
 * Use generateAgentFleet(domain, contentSample, kgSummary) to spawn agents
 * tailored to the content type. Use explodeAgentQuestions() for N-question
 * per-agent scoring. Use computeDynamicWeights() to derive weights from
 * discriminability rather than hardcoded values.
 */

import { Clone } from './clone.js';
import Anthropic from '@anthropic-ai/sdk';

// ── Agent Definitions ──────────────────────────────────────────

const AGENT_LENSES = {
  career: {
    name: 'Career Agent',
    mandate: 'Find stories that directly impact the user\'s active projects, business, and professional goals. Ask: "Will this help them make money, avoid a mistake, or seize an opportunity in their current work?"',
    weight: 0.25
  },
  growth: {
    name: 'Growth Agent',
    mandate: 'Find stories that expand the user\'s thinking beyond their current bubble. Not random — adjacent interests, emerging fields they should know about, ideas that connect to what they already care about in non-obvious ways.',
    weight: 0.15
  },
  timing: {
    name: 'Timing Agent',
    mandate: 'Find stories where TODAY is the perfect day to hear them. Calendar events, project deadlines, meetings, seasonal relevance, breaking news that affects decisions they\'re making right now.',
    weight: 0.25
  },
  contrarian: {
    name: 'Contrarian Agent',
    mandate: 'Find stories everyone else would miss. Challenge the user\'s assumptions. Surface signal from noise. The story nobody is talking about that will matter in 2 weeks. The take that goes against the grain but is backed by evidence.',
    weight: 0.15
  },
  serendipity: {
    name: 'Serendipity Agent',
    mandate: 'Find stories that would genuinely delight, surprise, or inspire the user. Not clickbait — real moments of "I didn\'t know I needed to hear this today." Human stories, unexpected connections, the kind of thing you\'d screenshot and send to a friend.',
    weight: 0.20
  }
};

// ── Swarm Agent ──────────────────────────────────────────

class SwarmAgent {
  constructor(lens, clone) {
    this.lens = lens;
    this.clone = clone;
    this.picks = [];
  }

  /**
   * Evaluate all stories through this agent's lens.
   * Returns scored picks with reasoning.
   */
  evaluate(stories) {
    this.picks = stories.map(story => ({
      story,
      score: this.#score(story),
      reason: null // filled by LLM in deep mode
    }));

    this.picks.sort((a, b) => b.score - a.score);
    return this.picks;
  }

  /**
   * Get this agent's top N advocacy picks
   */
  advocate(n = 5) {
    return this.picks.slice(0, n);
  }

  /**
   * Generate prompt for LLM-based deep evaluation
   */
  toPrompt(stories) {
    return [
      `You are the ${this.lens.name} in a story curation swarm.`,
      '',
      `YOUR MANDATE: ${this.lens.mandate}`,
      '',
      this.clone.toPrompt(),
      '',
      '## Stories to evaluate',
      '',
      ...stories.map((s, i) =>
        `${i + 1}. [${s.source}] ${s.title}\n   ${s.summary}\n   Topics: ${(s.topics || []).join(', ')}`
      ),
      '',
      'Pick your top 5 stories. For each, explain WHY this user needs to hear this TODAY.',
      'Format: { "picks": [{ "index": N, "score": 0-1, "reason": "..." }] }'
    ].join('\n');
  }

  // ── Heuristic scoring (fast mode, no LLM) ──────────

  #score(story) {
    const engagement = this.clone.wouldEngage(story);

    switch (this.lens.name) {
      case 'Career Agent':
        return this.#careerScore(story, engagement);
      case 'Growth Agent':
        return this.#growthScore(story, engagement);
      case 'Timing Agent':
        return this.#timingScore(story, engagement);
      case 'Contrarian Agent':
        return this.#contrarianScore(story, engagement);
      case 'Serendipity Agent':
        return this.#serendipityScore(story, engagement);
      default:
        return engagement;
    }
  }

  #careerScore(story, base) {
    let score = base;
    const text = `${story.title} ${story.summary}`.toLowerCase();
    const ctx = this.clone._snapshot?.context || {};

    // Direct project mention = strong signal
    for (const project of ctx.projects || []) {
      if (text.includes(project.toLowerCase())) {
        score += 0.4;
        break;
      }
    }

    // Business-relevant keywords
    const bizWords = ['revenue', 'funding', 'launch', 'acquisition', 'api', 'pricing',
      'competitor', 'market', 'growth', 'customer', 'saas', 'shopify', 'stripe'];
    const bizHits = bizWords.filter(w => text.includes(w)).length;
    score += Math.min(0.2, bizHits * 0.05);

    return Math.min(1, score);
  }

  #growthScore(story, base) {
    let score = base * 0.5; // de-weight pure interest match
    const interests = this.clone._snapshot?.interests || {};

    // Adjacent topics score higher than direct matches
    const directMatch = (story.topics || []).some(t => interests[t]?.weight > 0.5);
    const adjacentMatch = (story.topics || []).some(t => {
      const w = interests[t]?.weight;
      return w && w > 0.1 && w < 0.5; // known but not saturated
    });

    if (adjacentMatch && !directMatch) score += 0.3; // adjacent = growth
    if (!directMatch && !adjacentMatch) score += 0.15; // unknown = potential stretch

    return Math.min(1, score);
  }

  #timingScore(story, base) {
    let score = 0.1;
    const text = `${story.title} ${story.summary}`.toLowerCase();
    const ctx = this.clone._snapshot?.context || {};

    // Calendar match = highest signal
    for (const event of ctx.calendar || []) {
      const words = event.toLowerCase().split(/\s+/);
      if (words.some(w => w.length > 3 && text.includes(w))) {
        score += 0.4;
        break;
      }
    }

    // Recent conversation match
    for (const convo of ctx.conversations || []) {
      if (text.includes(convo.toLowerCase())) {
        score += 0.25;
        break;
      }
    }

    // Freshness matters more for timing
    const hoursOld = story.freshness || 24;
    if (hoursOld < 3) score += 0.2;
    else if (hoursOld < 6) score += 0.1;

    return Math.min(1, score);
  }

  #contrarianScore(story, base) {
    let score = 0.2;
    const patterns = this.clone._snapshot?.patterns || {};

    // Stories on topics the user usually avoids but from trusted sources
    const isAvoided = (story.topics || []).some(t =>
      (patterns.avoids || []).includes(t)
    );
    const isTrusted = (this.clone._snapshot?.source_trust?.[story.source] ?? 0.5) > 0.6;

    if (isAvoided && isTrusted) score += 0.4; // contrarian gold
    if (story.valence === 'alarming') score += 0.1;

    // Low saturation = less covered = contrarian
    const interests = this.clone._snapshot?.interests || {};
    const isMainstream = (story.topics || []).some(t => interests[t]?.weight > 0.7);
    if (!isMainstream) score += 0.15;

    return Math.min(1, score);
  }

  #serendipityScore(story, base) {
    let score = 0.15;

    if (story.valence === 'fun') score += 0.25;
    if (story.valence === 'inspiring') score += 0.2;

    // Moderate interest match = sweet spot (not boring, not irrelevant)
    const interests = this.clone._snapshot?.interests || {};
    const matchStrength = Math.max(
      ...(story.topics || []).map(t => interests[t]?.weight || 0),
      0
    );
    if (matchStrength > 0.2 && matchStrength < 0.6) score += 0.2;

    // Shareable stories score high
    const shareWords = ['beautiful', 'amazing', 'unexpected', 'first ever',
      'discovered', 'breakthrough', 'heartwarming', 'incredible'];
    const text = `${story.title} ${story.summary}`.toLowerCase();
    const shareHits = shareWords.filter(w => text.includes(w)).length;
    score += Math.min(0.2, shareHits * 0.1);

    return Math.min(1, score);
  }
}

// ── Swarm Orchestrator ──────────────────────────────────────

export class Swarm {
  constructor(kg, options = {}) {
    this.clone = new Clone(kg);
    this.agents = [];
    this.options = {
      mode: options.mode || 'fast', // 'fast' (heuristic) or 'deep' (LLM)
      llm: options.llm || null,     // LLM function for deep mode
      topN: options.topN || 10
    };
  }

  /**
   * Run the swarm curation process.
   * Each agent evaluates independently, then consensus is reached.
   *
   * @param {Story[]} stories - All candidate stories (~100)
   * @returns {ScoredStory[]} - Final curated selection
   */
  async curate(stories) {
    // Step 1: Create digital twin snapshot
    this.clone.takeSnapshot();

    // Step 2: Spawn agents with different lenses
    this.agents = Object.entries(AGENT_LENSES).map(([key, lens]) =>
      new SwarmAgent(lens, this.clone)
    );

    // Step 3: Each agent evaluates independently
    if (this.options.mode === 'deep' && this.options.llm) {
      await this.#deepEvaluation(stories);
    } else {
      this.#fastEvaluation(stories);
    }

    // Step 4: Consensus — weighted vote across all agents
    const consensus = this.#buildConsensus(stories);

    // Step 5: Return top N with arc positions
    return consensus.slice(0, this.options.topN);
  }

  /**
   * Fast mode: heuristic scoring, no LLM calls
   */
  #fastEvaluation(stories) {
    for (const agent of this.agents) {
      agent.evaluate(stories);
    }
  }

  /**
   * Deep mode: LLM-powered evaluation per agent
   */
  async #deepEvaluation(stories) {
    const promises = this.agents.map(async (agent) => {
      const prompt = agent.toPrompt(stories);
      const response = await this.options.llm(prompt);

      try {
        const parsed = JSON.parse(response);
        for (const pick of parsed.picks || []) {
          const story = stories[pick.index - 1];
          if (story) {
            agent.picks.push({
              story,
              score: pick.score,
              reason: pick.reason
            });
          }
        }
      } catch {
        // Fallback to heuristic if LLM parsing fails
        agent.evaluate(stories);
      }
    });

    await Promise.all(promises);
  }

  /**
   * Consensus: combine agent picks with weighted voting
   */
  #buildConsensus(stories) {
    const storyScores = new Map();
    const lensKeys = Object.keys(AGENT_LENSES);

    for (let i = 0; i < this.agents.length; i++) {
      const agent = this.agents[i];
      const lens = AGENT_LENSES[lensKeys[i]];
      const topPicks = agent.advocate(15); // each agent's top 15

      for (const pick of topPicks) {
        const id = pick.story.id;
        if (!storyScores.has(id)) {
          storyScores.set(id, {
            story: pick.story,
            total_score: 0,
            agent_scores: {},
            reasons: []
          });
        }

        const entry = storyScores.get(id);
        entry.total_score += pick.score * lens.weight;
        entry.agent_scores[lens.name] = pick.score;
        if (pick.reason) entry.reasons.push(`${lens.name}: ${pick.reason}`);
      }
    }

    // Sort by consensus score
    const ranked = [...storyScores.values()]
      .sort((a, b) => b.total_score - a.total_score);

    // Format as ScoredStory
    return ranked.map((entry, i) => ({
      story: entry.story,
      magic_score: entry.total_score,
      agent_scores: entry.agent_scores,
      why: entry.reasons.length ? entry.reasons.join(' | ') : this.#generateWhy(entry),
      arc_position: i + 1
    }));
  }

  #generateWhy(entry) {
    const top = Object.entries(entry.agent_scores)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 2)
      .map(([agent, score]) => `${agent.replace(' Agent', '')}: ${(score * 100).toFixed(0)}%`);
    return top.join(', ');
  }
}

export { Clone, SwarmAgent, AGENT_LENSES };

/**
 * Synchronous single-story scorer — runs all agent lenses and returns weighted consensus.
 * @param {Object} story
 * @param {Object} kg - Knowledge graph / user clone
 * @returns {{ score: number, agentScores: Object }}
 */
export function swarmScore(story, kg) {
  const clone = new Clone(kg);
  clone.takeSnapshot();
  const agents = Object.entries(AGENT_LENSES).map(([, lens]) => new SwarmAgent(lens, clone));
  const agentScores = {};
  let weighted = 0;
  let totalWeight = 0;
  for (const agent of agents) {
    agent.evaluate([story]);
    const s = agent.picks[0]?.score ?? 0;
    const w = agent.lens.weight ?? 1;
    agentScores[agent.lens.name ?? agent.lens.role] = s;
    weighted += s * w;
    totalWeight += w;
  }
  return { score: totalWeight > 0 ? weighted / totalWeight : 0, agentScores };
}

// ── Dynamic Weights ──────────────────────────────────────────────────────────

/**
 * Derive agent weights from discriminability (variance) across a scored batch.
 *
 * Weight = variance(agent.scores) × weightHint, normalized to sum=1.
 * Agents that score all candidates identically contribute no signal → weight ≈ 0.
 *
 * @param {Array<Object>} agentScoreMatrix - Per-item agent score objects,
 *   e.g. [{ career: 0.8, timing: 0.3, serendipity: 0.5, growth: 0.4, contrarian: 0.6 }, ...]
 * @param {Object} [weightHints] - Base weight hints (defaults to AGENT_LENSES weights)
 * @param {number} [varianceThreshold=0.001] - Agents below this variance are excluded
 * @returns {Object} Normalized weights, e.g. { career: 0.31, timing: 0.28, ... }
 */
export function computeDynamicWeights(agentScoreMatrix, weightHints = null, varianceThreshold = 0.001) {
  const defaultHints = Object.fromEntries(
    Object.entries(AGENT_LENSES).map(([k, v]) => [k, v.weight])
  );
  const hints = weightHints || defaultHints;

  if (!agentScoreMatrix || agentScoreMatrix.length < 2) {
    return { ...hints };
  }

  const agentNames = Object.keys(hints);
  const n = agentScoreMatrix.length;

  // Compute variance per agent
  const variances = {};
  for (const name of agentNames) {
    const scores = agentScoreMatrix.map(row => row[name] ?? 0);
    const mean = scores.reduce((s, v) => s + v, 0) / n;
    variances[name] = scores.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  }

  // Raw weight = variance × hint; near-zero variance → excluded
  const rawWeights = {};
  for (const name of agentNames) {
    const hint = hints[name] ?? (1 / agentNames.length);
    rawWeights[name] = variances[name] < varianceThreshold ? 0 : variances[name] * hint;
  }

  // Normalize; fall back to hints if all excluded
  const total = Object.values(rawWeights).reduce((s, w) => s + w, 0);
  if (total === 0) return { ...hints };

  const normalized = {};
  for (const name of agentNames) {
    normalized[name] = Math.round((rawWeights[name] / total) * 1000) / 1000;
  }
  return normalized;
}

// ── Domain Detection ─────────────────────────────────────────────────────────

const _DOMAIN_KEYWORDS = {
  'HackerNews': ['news.ycombinator.com', 'hn.algolia.com', 'hacker news', 'hn discussion'],
  'Twitter': ['twitter.com', 'x.com', '@', 'tweet'],
  'Reddit': ['reddit.com', 'r/', '/u/', 'subreddit'],
  'Medium': ['medium.com', 'medium story', 'medium article'],
  'Dev.to': ['dev.to', 'devto'],
  'YouTube': ['youtube.com', 'youtu.be', 'youtube video'],
  'GitHub': ['github.com', 'github.io', 'gist.github'],
  'LinkedIn': ['linkedin.com', 'linkedin'],
  'Blog': ['.substack.com', '.newsletter', 'substack'],
  'News': ['bbc.com', 'cnn.com', 'ny times', 'nytimes.com', 'theverge.com', 'techcrunch.com'],
  'Academic': ['arxiv.org', 'paper', 'research'],
};

const _URL_PATTERN = /https?:\/\/([^\s\/]+)/gi;

/**
 * Detect content domain from a text sample. Heuristic-first, LLM fallback.
 *
 * @param {string} contentSample - Title + summary + url, etc.
 * @param {boolean} [useLLM=false] - Force LLM if heuristics are inconclusive
 * @returns {Promise<{domain: string, availableSignals: string[], contextHint: string}>}
 */
export async function detectDomain(contentSample, useLLM = false) {
  if (!contentSample || typeof contentSample !== 'string') {
    return { domain: 'unknown', availableSignals: [], contextHint: 'No content to analyze' };
  }

  const text = contentSample.toLowerCase();
  const signals = [];
  let detectedDomain = null;

  const urls = (contentSample.match(_URL_PATTERN) || []).map(u => u.toLowerCase());
  if (urls.length > 0) {
    signals.push(`url_found:${urls[0]}`);
    for (const [domain, keywords] of Object.entries(_DOMAIN_KEYWORDS)) {
      for (const kw of keywords) {
        if (urls.some(u => u.includes(kw))) { detectedDomain = domain; signals.push(`url_match:${kw}`); break; }
      }
      if (detectedDomain) break;
    }
  }

  if (!detectedDomain) {
    for (const [domain, keywords] of Object.entries(_DOMAIN_KEYWORDS)) {
      for (const kw of keywords) {
        if (text.includes(kw)) { detectedDomain = domain; signals.push(`keyword_match:${kw}`); break; }
      }
      if (detectedDomain) break;
    }
  }

  if (!detectedDomain && (useLLM || signals.length === 0)) {
    try {
      const client = new Anthropic();
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 150,
        messages: [{
          role: 'user',
          content: `Identify the content domain from this text. Return ONLY the domain name (e.g. "HackerNews", "Medium", "Twitter", "Blog", "YouTube", "News", "Academic", "GitHub" or "unknown"):\n\n${contentSample.slice(0, 500)}`
        }]
      });
      const llmDomain = (response.content[0]?.type === 'text' ? response.content[0].text : '').trim();
      if (llmDomain && llmDomain !== 'unknown') { detectedDomain = llmDomain; signals.push(`llm_detected:${llmDomain}`); }
    } catch (err) {
      signals.push(`llm_error:${err.message}`);
    }
  }

  const domain = detectedDomain || 'unknown';
  return {
    domain,
    availableSignals: signals,
    contextHint: domain === 'unknown'
      ? 'Unable to determine domain; using general context'
      : `Content from ${domain}; apply domain-specific scoring adjustments`
  };
}

// ── Dynamic Agent Fleet ──────────────────────────────────────────────────────

const _fleetCache = new Map();

function _hashKgSummary(kgSummary) {
  const str = JSON.stringify(kgSummary || '').slice(0, 600);
  let h = 0;
  for (let i = 0; i < str.length; i++) h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Build a synchronous scorer from a generated agent spec.
 * Spec fields: name, boost_keywords, penalty_keywords, domain_signals, insight_keywords, interest_topics
 */
function _buildSpecScorer(spec) {
  return function specScorer(story, ctx) {
    let score = 0;
    const reasons = [];
    const text = `${story.title || ''} ${story.summary || ''}`.toLowerCase();

    for (const kw of (spec.boost_keywords || [])) {
      if (text.includes(kw.toLowerCase())) { score += 0.2; reasons.push(`[${spec.name}] boost: "${kw}"`); break; }
    }
    for (const kw of (spec.penalty_keywords || [])) {
      if (text.includes(kw.toLowerCase())) { score -= 0.1; reasons.push(`[${spec.name}] penalty: "${kw}"`); break; }
    }
    const domainSignals = (spec.domain_signals || {})[ctx._domain] || [];
    for (const sig of domainSignals) {
      if (text.includes(sig.toLowerCase())) { score += 0.15; reasons.push(`[${spec.name}] domain signal: "${sig}"`); break; }
    }
    for (const kw of (spec.insight_keywords || [])) {
      if (text.includes(kw.toLowerCase())) { score += 0.15; reasons.push(`[${spec.name}] kg insight: "${kw}"`); break; }
    }

    return { score: Math.max(0, Math.min(1, score)), reasons, agent: spec.name };
  };
}

async function _generateFleetFromLLM(domain, contentSample, kgSummary, llm) {
  const client = llm || new Anthropic();
  const prompt = `You are designing a fleet of 5 scoring agents for Marble, a personalized content ranking system.

Domain: ${domain}
Content sample: ${(contentSample || '').slice(0, 400)}
User KG summary: ${JSON.stringify(kgSummary || {}, null, 0).slice(0, 800)}

Generate exactly 5 agent specs as a JSON array, tailored to this domain and user profile.
Each spec must have:
- name (string, unique, snake_case)
- description (string, one sentence)
- weight (number 0-1, all 5 must sum to 1.0)
- boost_keywords (string[], 3-8 keywords that raise score)
- penalty_keywords (string[], 2-4 keywords that lower score)
- domain_signals (object: domain name → string[] of platform-specific signals)
- insight_keywords (string[], derived from user KG)
- interest_topics (string[], topic names from user interests)

Return ONLY the JSON array, no commentary. Example weights: [0.25, 0.25, 0.20, 0.15, 0.15]`;

  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1200,
    messages: [{ role: 'user', content: prompt }]
  });

  const raw = response.content[0]?.type === 'text' ? response.content[0].text : '';
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('No JSON array found in LLM response');
  const specs = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(specs) || specs.length === 0) throw new Error('Invalid specs array');
  return specs;
}

function _buildStaticFleet(domain) {
  const specs = Object.entries(AGENT_LENSES).map(([name, lens]) => ({
    name,
    weight: lens.weight,
    scoreFn: _buildSpecScorer({
      name,
      boost_keywords: [],
      penalty_keywords: [],
      domain_signals: {},
      insight_keywords: [],
    }),
    isStatic: true,
  }));

  return { agents: specs, weights: Object.fromEntries(specs.map(s => [s.name, s.weight])), source: 'static_fallback', domain };
}

/**
 * Spawn a dynamic agent fleet from domain + KG context.
 *
 * Uses claude-opus-4-6 to generate 5 domain/KG-aware agents.
 * Caches per (domain, kgHash). Falls back to static agents on LLM failure.
 *
 * @param {string} domain - Content domain (e.g. "HackerNews", "movies", "Twitter")
 * @param {string} contentSample - Sample content for context
 * @param {Object} kgSummary - Compact KG summary { interests, insights, ... }
 * @param {Object} [llm] - Optional pre-constructed Anthropic client
 * @returns {Promise<{ agents, weights, scoreStory, source, domain, cacheKey }>}
 */
export async function generateAgentFleet(domain, contentSample, kgSummary, llm = null) {
  const kgHash = _hashKgSummary(kgSummary);
  const cacheKey = `${domain || 'unknown'}:${kgHash}`;

  if (_fleetCache.has(cacheKey)) {
    return { ..._fleetCache.get(cacheKey), cacheKey, fromCache: true };
  }

  let fleet = null;

  try {
    const specs = await _generateFleetFromLLM(domain, contentSample, kgSummary, llm);

    const totalWeight = specs.reduce((s, sp) => s + (sp.weight || 0), 0);
    const normalized = specs.map(sp => ({
      ...sp,
      weight: totalWeight > 0 ? sp.weight / totalWeight : 1 / specs.length,
    }));

    const agentEntries = normalized.map(spec => ({
      name: spec.name,
      weight: spec.weight,
      scoreFn: _buildSpecScorer(spec),
      spec,
      isStatic: false,
    }));

    const weights = {};
    for (const a of agentEntries) weights[a.name] = a.weight;

    fleet = {
      agents: agentEntries,
      weights,
      source: 'llm_generated',
      domain,
      scoreStory(story, ctx) {
        const domainCtx = { ...ctx, _domain: domain };
        let composite = 0;
        const agentScores = {};
        const allReasons = [];
        for (const agent of this.agents) {
          const result = agent.scoreFn(story, domainCtx);
          agentScores[agent.name] = result.score;
          composite += result.score * agent.weight;
          for (const r of result.reasons) allReasons.push({ agent: agent.name, reason: r });
        }
        return {
          score: Math.round(composite * 1000) / 1000,
          agentScores,
          reasons: allReasons,
          story: { title: story.title, topics: story.topics },
          fleetSource: this.source,
        };
      }
    };
  } catch (err) {
    console.warn('[generateAgentFleet] LLM generation failed, using static fallback:', err.message);
    fleet = { ..._buildStaticFleet(domain) };
  }

  fleet.cacheKey = cacheKey;
  _fleetCache.set(cacheKey, fleet);
  return fleet;
}

/** Invalidate a specific fleet cache entry (e.g., after KG update). */
export function invalidateFleetCache(domain, kgSummary) {
  const kgHash = _hashKgSummary(kgSummary);
  return _fleetCache.delete(`${domain || 'unknown'}:${kgHash}`);
}

/** Get fleet cache stats for debugging. */
export function getFleetCacheStats() {
  return { size: _fleetCache.size, keys: Array.from(_fleetCache.keys()) };
}

// ── Question Explosion ────────────────────────────────────────────────────────

/**
 * Generate N evaluation questions for an agent and score them against content.
 *
 * Each question: { question, fired, confidence }
 * Agent score = sum(fired * confidence) / questionsWithData
 *
 * Questions that can't be answered (no signal in content) score 0 — no penalty.
 * This keeps agents honest: they can only claim credit where data exists.
 *
 * @param {Object|string} agent - Agent spec or plain name string
 * @param {string} contentSample - Content to evaluate
 * @param {Object} kgSummary - Compact KG summary
 * @param {Object} [llm] - Optional pre-constructed Anthropic client
 * @param {Object} [opts] - { n: number of questions (default 5) }
 * @returns {Promise<{ agent, questions, score, questionsWithData, source }>}
 */
export async function explodeAgentQuestions(agent, contentSample, kgSummary, llm = null, opts = {}) {
  const n = opts.n || 5;
  const client = llm || new Anthropic();

  const agentSpec = typeof agent === 'string' ? { name: agent, description: `${agent} lens` } : agent;
  const agentName = agentSpec.name || 'unknown';
  const agentDesc = agentSpec.description || agentSpec.name || '';
  const boostKw = (agentSpec.boost_keywords || []).join(', ');
  const insightKw = (agentSpec.insight_keywords || []).join(', ');

  const prompt = `You are the "${agentName}" scoring agent in Marble, a personalized content ranking system.

Agent description: ${agentDesc}
${boostKw ? `Boost keywords: ${boostKw}` : ''}
${insightKw ? `User KG insights: ${insightKw}` : ''}
User KG summary: ${JSON.stringify(kgSummary || {}, null, 0).slice(0, 600)}

Content to evaluate:
${(contentSample || '').slice(0, 600)}

Generate exactly ${n} yes/no evaluation questions that this agent would ask about this content.
For each, evaluate whether it fires (true/false) based on the content, and provide confidence (0.0-1.0).

Return a JSON array only, no commentary:
[
  { "question": "...", "fired": true/false, "confidence": 0.0-1.0 },
  ...
]

Guidelines:
- Questions must be specific to the "${agentName}" lens (not generic)
- fired=true means the content satisfies this question
- confidence reflects certainty about the fired value
- Unfired questions should have low confidence (0.1-0.3)`;

  let questions = [];
  let source = 'llm';

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }]
    });

    const raw = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array in LLM response');

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) throw new Error('LLM response is not an array');

    questions = parsed.slice(0, n).map(q => ({
      question: q.question || '',
      fired: Boolean(q.fired),
      confidence: Math.max(0, Math.min(1, Number(q.confidence) || 0)),
    }));
  } catch (err) {
    source = 'fallback';
    const text = (contentSample || '').toLowerCase();
    const keywords = [
      ...(agentSpec.boost_keywords || []),
      ...(agentSpec.insight_keywords || []),
    ].slice(0, n);

    questions = keywords.map(kw => ({
      question: `Does the content relate to "${kw}"?`,
      fired: text.includes(kw.toLowerCase()),
      confidence: text.includes(kw.toLowerCase()) ? 0.7 : 0.2,
    }));

    while (questions.length < n) {
      questions.push({ question: `Is this content relevant to the ${agentName} agent?`, fired: false, confidence: 0.1 });
    }
  }

  const questionsWithData = questions.length;
  const scoreSum = questions.reduce((s, q) => s + (q.fired ? q.confidence : 0), 0);
  const score = questionsWithData > 0 ? Math.round((scoreSum / questionsWithData) * 1000) / 1000 : 0;

  return { agent: agentName, questions, score, questionsWithData, source };
}
