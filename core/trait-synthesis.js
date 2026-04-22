/**
 * Marble L2 Trait Synthesis
 *
 * Derives psychological/behavioral traits from individual facts, then checks
 * whether each trait replicates across domains (confidence up) or gets
 * contradicted elsewhere in the KG (surface as first-class inconsistency).
 * A smaller K-way fusion pass covers genuinely gestalt patterns that no
 * single-node extraction would produce.
 *
 * Four phases:
 *   1. Per-node trait extraction (LLM, batched by chunks of nodes)
 *   2. Replication grouping (deterministic, in-process)
 *   3. Contradiction detection (deterministic — same dimension, divergent
 *      values from distinct node sets)
 *   4. Emergent K-way fusion (LLM, small number of samples)
 *
 * Output: Synthesis[] — each with structured trait, evidence, confidence
 * components, affinities, aversions, predictions, provenance.
 *
 * Requires: LLM_PROVIDER + API key in env, OR opts.llmClient.
 */

import { createLLMClient } from './llm-provider.js';

// ── Config ─────────────────────────────────────────────────────────────────

const DEFAULTS = Object.freeze({
  perNodeExtraction:   true,
  extractionChunkSize: 10,
  fusionSamples:       5,
  k:                   10,
  contradictionScan:   true,
  domainSpread:        true,
  strengthRange:       [0.4, 0.9],
  alpha:               0.15,
  beta:                1.3,
  gamma:               0.2,
  requireSurprising:   false,
  minConfidence:       0.4,
  schemaStrict:        true,
});

// ── Parse Failure Counter (matches insight-swarm.js pattern) ───────────────

export const parseFailureCounter = {
  counts: {},
  increment(phase) { this.counts[phase] = (this.counts[phase] || 0) + 1; },
  reset()  { this.counts = {}; },
  total()  { return Object.values(this.counts).reduce((s, v) => s + v, 0); },
  report() { return { total: this.total(), byPhase: { ...this.counts } }; },
};

// Tolerant JSON parser — mirrors insight-swarm.js
function _parseJSON(text, phaseName = 'unknown') {
  const s = String(text).trim();
  try { return JSON.parse(s); } catch {}
  const fence = s.match(/```json?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch {} }
  const obj = s.indexOf('{'), objE = s.lastIndexOf('}');
  if (obj !== -1 && objE > obj) { try { return JSON.parse(s.slice(obj, objE + 1)); } catch {} }
  const arr = s.indexOf('['), arrE = s.lastIndexOf(']');
  if (arr !== -1 && arrE > arr) { try { return JSON.parse(s.slice(arr, arrE + 1)); } catch {} }
  parseFailureCounter.increment(phaseName);
  return null;
}

// ── Node Normalization ─────────────────────────────────────────────────────

/**
 * Collect all L1 nodes from the KG and normalize them to a common shape.
 * Each node gets a stable `ref` (e.g. "belief:running", "preference:pace",
 * "identity:founder") used as the provenance anchor in syntheses.
 */
function collectNodes(kg, strengthRange) {
  const [lo, hi] = strengthRange;
  const user = kg.user || kg.getUser?.() || {};
  const nodes = [];

  for (const b of user.beliefs || []) {
    if (b.valid_to) continue;
    const s = b.strength ?? 0.7;
    if (s < lo || s > hi) continue;
    nodes.push({
      ref: `belief:${b.topic}`,
      type: 'belief',
      strength: s,
      text: `Belief — ${b.topic}: ${b.claim}`,
    });
  }
  for (const p of user.preferences || []) {
    if (p.valid_to) continue;
    const s = p.strength ?? 0.7;
    if (s < lo || s > hi) continue;
    const desc = p.description || p.value || '';
    const type = p.type || p.category || 'unknown';
    nodes.push({
      ref: `preference:${type}`,
      type: 'preference',
      strength: s,
      text: `Preference — ${type}: ${desc}`,
    });
  }
  for (const i of user.identities || []) {
    if (i.valid_to) continue;
    const s = i.salience ?? 0.8;
    if (s < lo || s > hi) continue;
    nodes.push({
      ref: `identity:${i.role}`,
      type: 'identity',
      strength: s,
      text: `Identity — ${i.role}${i.context ? ` (${i.context})` : ''}`,
    });
  }
  return nodes;
}

// ── Phase 1: Per-node Trait Extraction ─────────────────────────────────────

async function extractTraits(nodes, llmClient, model, opts) {
  const chunkSize = opts.extractionChunkSize;
  const out = [];

  for (let i = 0; i < nodes.length; i += chunkSize) {
    const chunk = nodes.slice(i, i + chunkSize);
    const prompt = buildExtractionPrompt(chunk);

    try {
      const res = await llmClient.messages.create({
        model,
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      });
      const text = res.content?.[0]?.text || res.content || '';
      const parsed = _parseJSON(text, 'extraction');
      if (!Array.isArray(parsed)) continue;

      for (const entry of parsed) {
        if (!entry || typeof entry.node_ref !== 'string') continue;
        if (!Array.isArray(entry.traits)) continue;
        const domain = typeof entry.domain === 'string' ? entry.domain.toLowerCase().trim() : 'unknown';
        for (const t of entry.traits) {
          if (!t || !t.dimension || !t.value) continue;
          out.push({
            node_ref:    entry.node_ref,
            domain,
            dimension:   String(t.dimension).toLowerCase().trim(),
            value:       String(t.value).toLowerCase().trim(),
            weight:      clamp(Number(t.weight ?? 0.6), 0, 1),
            base_conf:   clamp(Number(t.confidence ?? 0.6), 0, 1),
            evidence_q:  typeof t.evidence_quote === 'string' ? t.evidence_quote : '',
          });
        }
      }
    } catch (err) {
      console.error('[TraitSynthesis] extraction chunk failed:', err.message);
    }
  }

  return out;
}

function buildExtractionPrompt(chunk) {
  const lines = chunk.map(n => `  - [${n.ref}] ${n.text} (strength=${n.strength.toFixed(2)})`);
  return `You are analyzing individual facts about a user to extract psychological/behavioral traits that each fact implies on its own.

FACTS:
${lines.join('\n')}

For EACH fact, extract 1-3 traits it implies. A trait is a compact predicate a downstream system can match against content.

Rules:
- Each trait must have: dimension (e.g. "time_orientation"), value (e.g. "compound"), weight (0-1, how strong this implication is from THIS fact alone), confidence (0-1, how sure).
- Prefer short snake_case values. Use enum-like vocabularies where natural (e.g. time_orientation: compound|peak_driven|short_horizon).
- Include a short evidence_quote copying the exact fragment of the fact that supports the trait.
- Also classify each fact into a life domain: health, work, family, spirituality, hobbies, finance, relationships, politics, intellectual, or other.
- Do NOT invent traits that aren't supported — isolated facts carry only moderate weight. If no meaningful trait, return traits: [].

Respond with JSON array only. Each element has node_ref, domain, traits.

[
  {
    "node_ref": "belief:running",
    "domain": "health",
    "traits": [
      { "dimension": "time_orientation",   "value": "compound", "weight": 0.7, "confidence": 0.65, "evidence_quote": "enjoys long runs" },
      { "dimension": "effort_profile",     "value": "sustained_low_intensity", "weight": 0.8, "confidence": 0.7, "evidence_quote": "long runs" }
    ]
  }
]`;
}

// ── Phase 2: Replication Grouping ──────────────────────────────────────────

/**
 * Group candidate traits by (dimension, value). For each group, compute
 * reinforcing_nodes, domains_bridged, and a replication-adjusted confidence.
 */
function groupByReplication(candidates, opts) {
  const byKey = new Map();
  for (const c of candidates) {
    const key = `${c.dimension}|${c.value}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(c);
  }

  const groups = [];
  for (const [key, members] of byKey.entries()) {
    const reinforcingRefs = [...new Set(members.map(m => m.node_ref))];
    const domains = [...new Set(members.map(m => m.domain).filter(Boolean))];
    const base = avg(members.map(m => m.base_conf));
    const weight = avg(members.map(m => m.weight));
    const crossDomain = domains.length > 1;

    const replicationBonus = Math.min(
      0.3,
      opts.alpha * Math.log(1 + reinforcingRefs.length)
    ) * (crossDomain ? opts.beta : 1.0);

    groups.push({
      key,
      dimension: members[0].dimension,
      value:     members[0].value,
      weight,
      reinforcing_refs: reinforcingRefs,
      reinforcing_members: members,
      domains_bridged: domains,
      cross_domain: crossDomain,
      base_conf: base,
      replication_bonus: replicationBonus,
      isolated: reinforcingRefs.length === 1,
    });
  }
  return groups;
}

// ── Phase 3: Contradiction Detection ───────────────────────────────────────

/**
 * For each dimension that has multiple distinct values (i.e. at least two
 * non-overlapping trait groups), emit a contradiction record. Deterministic:
 * no LLM call — we expose the raw divergence and let downstream tools (or
 * the user) decide if it's genuine tension or just complexity. Contradictions
 * are only recorded when the two sides come from DIFFERENT node sets; a
 * single node implying two values on the same dimension is not a
 * contradiction, it's just multi-faceted.
 */
function detectContradictions(groups) {
  const byDim = new Map();
  for (const g of groups) {
    if (!byDim.has(g.dimension)) byDim.set(g.dimension, []);
    byDim.get(g.dimension).push(g);
  }

  const contradictions = [];
  for (const [dimension, dimGroups] of byDim.entries()) {
    if (dimGroups.length < 2) continue;
    for (let i = 0; i < dimGroups.length - 1; i++) {
      for (let j = i + 1; j < dimGroups.length; j++) {
        const a = dimGroups[i], b = dimGroups[j];
        const aRefs = new Set(a.reinforcing_refs);
        const disjoint = b.reinforcing_refs.every(r => !aRefs.has(r));
        if (!disjoint) continue;
        contradictions.push({
          dimension,
          sideA: a,
          sideB: b,
        });
      }
    }
  }
  return contradictions;
}

// ── Phase 4: Emergent K-way Fusion ─────────────────────────────────────────

async function runFusionPass(nodes, llmClient, model, opts) {
  const samples = [];
  const sampleCount = Math.min(opts.fusionSamples, Math.floor(nodes.length / opts.k));
  if (sampleCount <= 0) return [];

  const usedCounts = new Map();
  for (let i = 0; i < sampleCount; i++) {
    const sample = sampleAcrossDomains(nodes, opts.k, usedCounts, opts.domainSpread);
    if (sample.length < Math.min(4, opts.k)) continue;
    for (const s of sample) usedCounts.set(s.ref, (usedCounts.get(s.ref) || 0) + 1);
    samples.push(sample);
  }

  const results = [];
  for (const sample of samples) {
    const prompt = buildFusionPrompt(sample);
    try {
      const res = await llmClient.messages.create({
        model,
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      });
      const text = res.content?.[0]?.text || res.content || '';
      const parsed = _parseJSON(text, 'fusion');
      if (!parsed || parsed.label === null) continue;
      if (typeof parsed.label !== 'string') continue;
      results.push({
        ...parsed,
        source_refs: sample.map(s => s.ref),
      });
    } catch (err) {
      console.error('[TraitSynthesis] fusion call failed:', err.message);
    }
  }
  return results;
}

/**
 * Pick k nodes that collectively span as many distinct domains as possible,
 * preferring nodes not yet heavily reused. Domain is unknown at this stage
 * (it's assigned by Phase 1 via LLM). We approximate domain spread by node
 * type + a rough topic bucketing; the fusion LLM call re-classifies anyway.
 */
function sampleAcrossDomains(nodes, k, usedCounts, domainSpread) {
  const pool = [...nodes].sort((a, b) => {
    const ua = usedCounts.get(a.ref) || 0;
    const ub = usedCounts.get(b.ref) || 0;
    if (ua !== ub) return ua - ub;
    return Math.random() - 0.5;
  });

  if (!domainSpread) return pool.slice(0, k);

  const picked = [];
  const typesSeen = new Set();
  for (const n of pool) {
    if (picked.length >= k) break;
    if (!typesSeen.has(n.type) || picked.length >= Math.min(3, k)) {
      picked.push(n);
      typesSeen.add(n.type);
    }
  }
  for (const n of pool) {
    if (picked.length >= k) break;
    if (!picked.includes(n)) picked.push(n);
  }
  return picked.slice(0, k);
}

function buildFusionPrompt(sample) {
  const lines = sample.map(n => `  - [${n.ref}] ${n.text}`);
  return `You are looking at a set of facts about a person drawn from different life domains. Find ONE cross-domain pattern that no single fact reveals on its own, if there is one.

FACTS:
${lines.join('\n')}

Rules:
- Return one gestalt pattern that only emerges when several of these facts are considered together.
- If the facts don't cohere into a single pattern, return {"label": null}. Do NOT invent.
- "mechanics" must explain WHY the combination produces the pattern — not restate the facts.
- affinities/aversions/predictions must be specific enough to match real content. No buzzwords.
- Predictions must be falsifiable via observable behavior (dwell, share, skip).

Respond with JSON only:
{
  "label":       "short human handle (3-6 words) or null",
  "mechanics":   "2-4 sentences on WHY this combination produces a pattern",
  "trait":       { "dimension": "...", "value": "...", "weight": 0.0-1.0 },
  "affinities":  ["content type 1", "content type 2", ...],
  "aversions":   ["content to avoid 1", ...],
  "predictions": ["falsifiable observation 1", ...],
  "domains_bridged": ["domain1", "domain2", ...],
  "surprising":  true,
  "confidence":  0.0-1.0
}`;
}

// ── Composition: turn Phase 2/3/4 outputs into Synthesis records ───────────

function composeReplicationSyntheses(groups, opts) {
  const out = [];
  for (const g of groups) {
    const finalConf = clamp(g.base_conf + g.replication_bonus, 0, 1);
    if (finalConf < opts.minConfidence) continue;

    const origin = g.isolated ? 'single_node' : 'trait_replication';
    const label = buildTraitLabel(g);

    out.push({
      label,
      origin,
      trait: { dimension: g.dimension, value: g.value, weight: round2(g.weight) },
      mechanics: buildTraitMechanics(g),
      reinforcing_nodes: g.reinforcing_refs,
      domains_bridged:   g.domains_bridged,
      contradicting_nodes: [],
      isolated:  g.isolated,
      confidence: round2(finalConf),
      confidence_components: {
        base_from_llm:         round2(g.base_conf),
        replication_bonus:     round2(g.replication_bonus),
        contradiction_penalty: 0,
        cross_domain:          g.cross_domain,
      },
      affinities:  [],
      aversions:   [],
      predictions: [],
      surprising:  false,
      mode: 'trait_synthesis',
    });
  }
  return out;
}

function composeContradictionSyntheses(contradictions, opts) {
  const out = [];
  for (const c of contradictions) {
    const { sideA, sideB } = c;
    const combinedBase = avg([sideA.base_conf, sideB.base_conf]);
    const penalty = Math.min(
      0.5,
      opts.gamma * Math.min(sideA.reinforcing_refs.length, sideB.reinforcing_refs.length)
    );
    const finalConf = clamp(combinedBase - penalty, 0, 1);
    if (finalConf < opts.minConfidence) continue;

    const label = `Conflicting signals on ${c.dimension.replace(/_/g, ' ')}`;
    const mechanics =
      `On dimension "${c.dimension}" the user's facts diverge: ` +
      `${sideA.reinforcing_refs.join(', ')} imply "${sideA.value}", while ` +
      `${sideB.reinforcing_refs.join(', ')} imply "${sideB.value}". ` +
      `Downstream tools should treat this as an aspirational-vs-actual gap or a genuine complexity, not a single coherent trait.`;

    out.push({
      label,
      origin: 'contradiction',
      trait: { dimension: c.dimension, value: `${sideA.value}↔${sideB.value}`, weight: round2(avg([sideA.weight, sideB.weight])) },
      mechanics,
      reinforcing_nodes:   sideA.reinforcing_refs,
      contradicting_nodes: sideB.reinforcing_refs,
      domains_bridged:     [...new Set([...sideA.domains_bridged, ...sideB.domains_bridged])],
      isolated: false,
      confidence: round2(finalConf),
      confidence_components: {
        base_from_llm:         round2(combinedBase),
        replication_bonus:     0,
        contradiction_penalty: round2(penalty),
        cross_domain:          (sideA.cross_domain || sideB.cross_domain),
      },
      affinities:  [],
      aversions:   [],
      predictions: [],
      surprising:  true,
      mode: 'trait_synthesis',
    });
  }
  return out;
}

function composeFusionSyntheses(fusions, opts) {
  const out = [];
  for (const f of fusions) {
    const conf = clamp(Number(f.confidence ?? 0.5), 0, 1);
    if (conf < opts.minConfidence) continue;
    if (opts.schemaStrict) {
      if (!f.trait || !f.trait.dimension || !f.trait.value) continue;
      if (typeof f.mechanics !== 'string' || f.mechanics.length < 20) continue;
    }
    if (opts.requireSurprising && !f.surprising) continue;

    out.push({
      label: f.label,
      origin: 'emergent_fusion',
      trait: {
        dimension: String(f.trait.dimension).toLowerCase().trim(),
        value:     String(f.trait.value).toLowerCase().trim(),
        weight:    clamp(Number(f.trait.weight ?? 0.7), 0, 1),
      },
      mechanics: f.mechanics,
      reinforcing_nodes:   f.source_refs || [],
      contradicting_nodes: [],
      domains_bridged:     Array.isArray(f.domains_bridged) ? f.domains_bridged.map(d => String(d).toLowerCase()) : [],
      isolated: false,
      confidence: round2(conf),
      confidence_components: {
        base_from_llm:         round2(conf),
        replication_bonus:     0,
        contradiction_penalty: 0,
        cross_domain:          (Array.isArray(f.domains_bridged) && f.domains_bridged.length > 1),
      },
      affinities:  Array.isArray(f.affinities)  ? f.affinities.slice(0, 8).map(String)  : [],
      aversions:   Array.isArray(f.aversions)   ? f.aversions.slice(0, 8).map(String)   : [],
      predictions: Array.isArray(f.predictions) ? f.predictions.slice(0, 8).map(String) : [],
      surprising:  !!f.surprising,
      mode: 'fusion',
    });
  }
  return out;
}

// ── Label/Mechanics helpers ────────────────────────────────────────────────

function buildTraitLabel(g) {
  const d = g.dimension.replace(/_/g, ' ');
  const v = g.value.replace(/_/g, ' ');
  if (g.isolated) return `Isolated signal — ${d}: ${v}`;
  if (g.cross_domain) return `Replicated across ${g.domains_bridged.length} domains — ${d}: ${v}`;
  return `Replicated — ${d}: ${v}`;
}

function buildTraitMechanics(g) {
  if (g.isolated) {
    const only = g.reinforcing_refs[0];
    return `The trait "${g.dimension} = ${g.value}" is implied by a single fact (${only}). No replication across other domains yet, so the signal is moderate at best — it may be real but cannot be confirmed by cross-domain coherence.`;
  }
  const refs = g.reinforcing_refs.join(', ');
  const doms = g.domains_bridged.join(', ') || 'a single domain';
  return `The trait "${g.dimension} = ${g.value}" is independently implied by ${g.reinforcing_refs.length} facts (${refs}) spanning ${doms}. Replication across distinct facts raises confidence beyond what any single fact would support.`;
}

// ── Utilities ──────────────────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function avg(xs) { return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length; }
function round2(x) { return Math.round(x * 100) / 100; }

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Run trait-based synthesis against a KG. Returns Synthesis[].
 *
 * The caller is responsible for persisting results (e.g. `kg.addSynthesis`) —
 * this function is pure w.r.t. the KG.
 *
 * @param {import('./kg.js').KnowledgeGraph} kg
 * @param {Object} [opts]
 * @param {Object} [opts.llmClient]
 * @param {string} [opts.model]
 * @param {boolean} [opts.perNodeExtraction=true]
 * @param {number}  [opts.extractionChunkSize=10]
 * @param {number}  [opts.fusionSamples=5]
 * @param {number}  [opts.k=10]
 * @param {boolean} [opts.contradictionScan=true]
 * @param {boolean} [opts.domainSpread=true]
 * @param {number[]} [opts.strengthRange=[0.4, 0.9]]
 * @param {number}  [opts.alpha=0.15]
 * @param {number}  [opts.beta=1.3]
 * @param {number}  [opts.gamma=0.2]
 * @param {boolean} [opts.requireSurprising=false]
 * @param {number}  [opts.minConfidence=0.4]
 * @param {boolean} [opts.schemaStrict=true]
 * @returns {Promise<Synthesis[]>}
 */
export async function runTraitSynthesis(kg, opts = {}) {
  const mergedOpts = { ...DEFAULTS, ...opts };
  const llmClient = opts.llmClient || createLLMClient();
  const model     = opts.model || llmClient.defaultModel?.('heavy') || 'default';

  const nodes = collectNodes(kg, mergedOpts.strengthRange);
  if (nodes.length === 0) return [];

  // Phase 1
  const candidates = mergedOpts.perNodeExtraction
    ? await extractTraits(nodes, llmClient, model, mergedOpts)
    : [];

  // Phase 2
  const groups = groupByReplication(candidates, mergedOpts);

  // Phase 3
  const contradictions = mergedOpts.contradictionScan
    ? detectContradictions(groups)
    : [];

  // Phase 4
  const fusions = mergedOpts.fusionSamples > 0
    ? await runFusionPass(nodes, llmClient, model, mergedOpts)
    : [];

  // Compose + dedup by trait key
  const all = [
    ...composeReplicationSyntheses(groups, mergedOpts),
    ...composeContradictionSyntheses(contradictions, mergedOpts),
    ...composeFusionSyntheses(fusions, mergedOpts),
  ];

  return dedupAndRank(all);
}

function dedupAndRank(list) {
  const seen = new Map();
  for (const s of list) {
    const key = `${s.origin}|${s.trait.dimension}|${s.trait.value}`;
    const existing = seen.get(key);
    if (!existing || s.confidence > existing.confidence) seen.set(key, s);
  }
  return [...seen.values()].sort((a, b) => b.confidence - a.confidence);
}

// Exposed for tests
export const _internal = {
  collectNodes,
  groupByReplication,
  detectContradictions,
  composeReplicationSyntheses,
  composeContradictionSyntheses,
  composeFusionSyntheses,
  dedupAndRank,
  sampleAcrossDomains,
  _parseJSON,
};
