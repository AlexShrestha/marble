/**
 * Marble Salience — filter L1 nodes by importance before any pairwise pass.
 *
 * Problem this solves: raw `getMemoryNodesSummary()` dumps every active
 * belief/preference/identity. On a real KG (thousands of nodes) this blows
 * up any O(N²) inference generator. Consumers need to say "give me the top
 * K important nodes" — this module defines what "important" means.
 *
 * Salience signals (all already in the KG, all cheap):
 *
 *   - effective_strength  strength × recency_decay, already computed by
 *                         getActive* views (halfLife-based exponential decay)
 *   - evidence_norm       log(1 + evidence_count), so a 20× reinforced belief
 *                         is worth ~1.3× a 1× belief (not 20×)
 *   - slot_volatility     how often the (type, slot) has been reassigned in
 *                         the trailing window — high volatility is a signal
 *                         of its own (e.g. "serial project pivoter")
 *
 *   salience = 0.6 × effective_strength + 0.2 × evidence_norm + 0.2 × slot_volatility
 *
 * Stale-active guardrail: valid_to=null but evidence_count=1 AND age>180d
 * gets effective_strength halved. Prevents old one-off facts (e.g. "user
 * builds a health tracker") from staying top-salient a year after the user
 * moved on.
 *
 * Churn scan: slots with high volatility (default >= 3 invalidations in
 * 180d) emit a first-class `origin: "churn_pattern"` synthesis. Captures
 * the "trait" that lives in the TIME SERIES of beliefs, not their current
 * snapshot — e.g. the user churns projects every few months.
 */

import { DEFAULT_DECAY_CONFIG } from './kg.js';

// ── Config ─────────────────────────────────────────────────────────────────

export const DEFAULT_SALIENCE_CONFIG = Object.freeze({
  // Salience term weights
  weightEffective:  0.6,
  weightEvidence:   0.2,
  weightVolatility: 0.2,

  // Stale-active guardrail
  staleActiveDays:     180,
  staleActiveCap:      0.5,   // effective_strength × this when guardrail fires
  staleEvidenceCutoff: 1,     // trigger when evidence_count <= this

  // Volatility window + normalization
  volatilityWindowDays:      180,
  volatilityInvalidationsForHigh: 3,   // count → 1.0 volatility

  // Churn scan thresholds
  churnMinInvalidations: 3,
  churnWindowDays:       180,
});

// ── Age helper ─────────────────────────────────────────────────────────────

function ageInDays(node, asOf) {
  const nowMs = asOf ? new Date(asOf).getTime() : Date.now();
  // `recorded_at` captures when the fact last hit the KG (new or reinforced);
  // fall back to `valid_from` for older records that predate recorded_at.
  const ref = node.recorded_at || node.valid_from;
  if (!ref) return 0;
  const refMs = new Date(ref).getTime();
  if (!Number.isFinite(refMs)) return 0;
  return Math.max(0, (nowMs - refMs) / (24 * 60 * 60 * 1000));
}

// ── effective_strength (+ stale-active guardrail) ──────────────────────────

/**
 * Recompute effective_strength with stale-active guardrail applied.
 *
 * Why not just use the `effective_strength` field attached by `getActiveBeliefs`
 * etc.: that field is a pure decay function of age. It doesn't distinguish
 * "old, heavily-reinforced fact" from "old, one-off fact". The guardrail
 * encodes the asymmetry — low-evidence stale facts fade faster.
 */
export function computeEffectiveStrength(node, opts = {}) {
  const cfg = { ...DEFAULT_DECAY_CONFIG, ...DEFAULT_SALIENCE_CONFIG, ...opts };
  const halfLife = cfg.halfLifeDays;
  const age = ageInDays(node, opts.asOf);
  const rawStrength = Math.abs(
    node.strength ?? node.salience ?? node.effective_strength ?? 0.7
  );
  let eff = rawStrength * Math.pow(2, -age / halfLife);

  const evidence = node.evidence_count ?? (node.evidence?.length ?? 1);
  if (age > cfg.staleActiveDays && evidence <= cfg.staleEvidenceCutoff) {
    eff *= cfg.staleActiveCap;
  }
  return Math.max(0, Math.min(1, eff));
}

// ── Slot key helper ────────────────────────────────────────────────────────

/**
 * A slot is the addressable unit of contradiction — "beliefs about X",
 * "preferences on type Y", "identity role Z". Two facts on the same slot
 * can invalidate each other; facts on different slots coexist.
 */
export function slotKeyFor(node, type) {
  const t = (type || node._type || '').toLowerCase();
  if (t === 'belief')     return `belief:${(node.topic || '').toLowerCase()}`;
  if (t === 'preference') return `preference:${(node.type || node.category || '').toLowerCase()}`;
  if (t === 'identity')   return `identity:${(node.role || '').toLowerCase()}`;
  return `unknown:${JSON.stringify(node).slice(0, 32)}`;
}

function typeOfNode(node) {
  if (node.topic !== undefined && node.claim !== undefined) return 'belief';
  if (node.type !== undefined && node.description !== undefined) return 'preference';
  if (node.role !== undefined && node.salience !== undefined) return 'identity';
  if (node.role !== undefined) return 'identity';
  return 'unknown';
}

// ── Volatility ─────────────────────────────────────────────────────────────

/**
 * For each slot, count how many invalidations (valid_to set) fell within
 * the trailing window. Normalizes to 0..1 using volatilityInvalidationsForHigh.
 *
 * Includes BOTH active and invalidated records — the pattern we want is
 * "this slot has been overwritten a lot", which is visible only when we
 * count historical closures.
 */
export function computeVolatility(kg, opts = {}) {
  const cfg = { ...DEFAULT_SALIENCE_CONFIG, ...opts };
  const now = opts.asOf ? new Date(opts.asOf).getTime() : Date.now();
  const cutoff = now - cfg.volatilityWindowDays * 24 * 60 * 60 * 1000;
  const byKey = new Map();

  const tally = (rec, type) => {
    const key = slotKeyFor(rec, type);
    if (!byKey.has(key)) byKey.set(key, { invalidations: 0, total: 0, records: [] });
    const entry = byKey.get(key);
    entry.total += 1;
    entry.records.push({ record: rec, type });
    if (rec.valid_to) {
      const closedAt = new Date(rec.valid_to).getTime();
      if (Number.isFinite(closedAt) && closedAt >= cutoff) {
        entry.invalidations += 1;
      }
    }
  };

  const user = kg.user || {};
  (user.beliefs     || []).forEach(r => tally(r, 'belief'));
  (user.preferences || []).forEach(r => tally(r, 'preference'));
  (user.identities  || []).forEach(r => tally(r, 'identity'));

  // Normalize score per slot
  const result = new Map();
  for (const [key, v] of byKey.entries()) {
    const score = Math.min(1, v.invalidations / cfg.volatilityInvalidationsForHigh);
    result.set(key, {
      score,
      invalidations: v.invalidations,
      total: v.total,
      records: v.records,
    });
  }
  return result;
}

// ── Salience score ─────────────────────────────────────────────────────────

/**
 * Score a single node. `ctx.volatility` is the Map produced by
 * `computeVolatility` — pre-compute once, pass in, amortize across all nodes.
 */
export function computeSalience(node, ctx = {}, opts = {}) {
  const cfg = { ...DEFAULT_SALIENCE_CONFIG, ...opts };
  const type = node._type || typeOfNode(node);
  const eff = computeEffectiveStrength(node, opts);
  const evidence = node.evidence_count ?? (node.evidence?.length ?? 1);
  const evidenceNorm = Math.min(1, Math.log1p(evidence) / Math.log(10));  // 10× evidence → ~1.0

  let volScore = 0;
  if (ctx.volatility) {
    const key = slotKeyFor(node, type);
    volScore = ctx.volatility.get(key)?.score || 0;
  }

  return clamp(
    cfg.weightEffective  * eff +
    cfg.weightEvidence   * evidenceNorm +
    cfg.weightVolatility * volScore,
    0, 1
  );
}

// ── getTopSalient ──────────────────────────────────────────────────────────

/**
 * Rank all active nodes (across the requested types) by salience and return
 * the top `limit`. Stable-sorted by (salience desc, slot asc) so diagnostic
 * output is reproducible.
 *
 * @param {Object} kg              - KnowledgeGraph-like with `user`
 * @param {Object} [opts]
 * @param {('belief'|'preference'|'identity')[]} [opts.types]  default: all three
 * @param {number}   [opts.limit]    default: 100
 * @param {string[]} [opts.domains]  if provided, keeps only nodes whose
 *                                   stored `domain` field matches (used in
 *                                   conjunction with trait-synthesis outputs)
 * @param {Map}      [opts.volatility] pre-computed volatility map; computed
 *                                     here if absent
 * @param {string}   [opts.asOf]    ISO date for as-of queries
 * @returns {Array<{node, type, ref, salience, effective_strength, slot_volatility, stale_active}>}
 */
export function getTopSalient(kg, opts = {}) {
  const types = opts.types || ['belief', 'preference', 'identity'];
  const limit = opts.limit ?? 100;
  const volatility = opts.volatility || computeVolatility(kg, opts);
  const user = kg.user || {};

  const collected = [];
  if (types.includes('belief')) {
    for (const b of user.beliefs || []) {
      if (b.valid_to) continue;
      collected.push(_annotate(b, 'belief', volatility, opts));
    }
  }
  if (types.includes('preference')) {
    for (const p of user.preferences || []) {
      if (p.valid_to) continue;
      collected.push(_annotate(p, 'preference', volatility, opts));
    }
  }
  if (types.includes('identity')) {
    for (const i of user.identities || []) {
      if (i.valid_to) continue;
      collected.push(_annotate(i, 'identity', volatility, opts));
    }
  }

  if (Array.isArray(opts.domains) && opts.domains.length > 0) {
    const want = new Set(opts.domains.map(d => String(d).toLowerCase()));
    for (let k = collected.length - 1; k >= 0; k--) {
      const domain = (collected[k].node.domain || '').toLowerCase();
      if (!want.has(domain)) collected.splice(k, 1);
    }
  }

  collected.sort((a, b) => {
    if (b.salience !== a.salience) return b.salience - a.salience;
    return a.ref.localeCompare(b.ref);
  });

  return collected.slice(0, limit);
}

function _annotate(node, type, volatility, opts) {
  const ref   = slotKeyFor(node, type);
  const eff   = computeEffectiveStrength(node, opts);
  const vol   = volatility.get(ref)?.score || 0;
  const age   = ageInDays(node, opts.asOf);
  const ev    = node.evidence_count ?? (node.evidence?.length ?? 1);
  const staleActive = age > (opts.staleActiveDays ?? DEFAULT_SALIENCE_CONFIG.staleActiveDays)
                   && ev <= (opts.staleEvidenceCutoff ?? DEFAULT_SALIENCE_CONFIG.staleEvidenceCutoff);

  return {
    node,
    type,
    ref,
    salience: computeSalience(node, { volatility }, opts),
    effective_strength: eff,
    slot_volatility:    vol,
    stale_active:       staleActive,
  };
}

// ── Diagnostics ────────────────────────────────────────────────────────────

/**
 * Produce a distribution summary — counts, percentiles, stale-active counts.
 * Useful for the PR diagnostic and for "is the KG signal or noise?" triage.
 */
export function salienceDistribution(kg, opts = {}) {
  const all = getTopSalient(kg, { ...opts, limit: Number.MAX_SAFE_INTEGER });
  const n = all.length;
  if (n === 0) {
    return { total: 0, staleActive: 0, percentiles: {}, byType: {} };
  }
  const scores = all.map(a => a.salience).sort((a, b) => a - b);
  const p = (q) => scores[Math.max(0, Math.min(n - 1, Math.floor(q * n)))];
  const byType = {};
  for (const a of all) {
    if (!byType[a.type]) byType[a.type] = { count: 0, staleActive: 0 };
    byType[a.type].count += 1;
    if (a.stale_active) byType[a.type].staleActive += 1;
  }
  return {
    total: n,
    staleActive: all.filter(a => a.stale_active).length,
    percentiles: { p10: p(0.1), p50: p(0.5), p90: p(0.9), p99: p(0.99), max: scores[n - 1] },
    byType,
    topExamples: all.slice(0, 10).map(a => ({
      ref: a.ref,
      salience: round2(a.salience),
      effective_strength: round2(a.effective_strength),
      slot_volatility: round2(a.slot_volatility),
      stale_active: a.stale_active,
    })),
  };
}

// ── Churn scan → churn_pattern syntheses ───────────────────────────────────

/**
 * Scan for slots where the pattern IS the churn. Emits syntheses with
 * origin="churn_pattern" that downstream tools can treat as first-class
 * traits.
 *
 * Unlike replication/contradiction syntheses, these live in the time series
 * of belief invalidations, not the current snapshot. This is what captures
 * "user serial-pivots projects" as a trait — the signal is the rate of
 * `valid_to` closures on the `current_project` slot, not any single belief.
 *
 * @returns {Array<Synthesis>}  trait-synthesis-compatible records, ready
 *                              for kg.addSynthesis()
 */
export function runChurnScan(kg, opts = {}) {
  const cfg = { ...DEFAULT_SALIENCE_CONFIG, ...opts };
  const volatility = computeVolatility(kg, {
    ...opts,
    volatilityWindowDays: cfg.churnWindowDays,
  });
  const syntheses = [];
  const nowIso = new Date().toISOString();

  for (const [key, v] of volatility.entries()) {
    if (v.invalidations < cfg.churnMinInvalidations) continue;

    const slotType = key.split(':')[0];                 // belief|preference|identity
    const slotName = key.slice(slotType.length + 1);    // topic / type / role
    const refs = v.records.map(r => `${slotType}:${slotName}#${new Date(r.record.valid_from || r.record.recorded_at || 0).getTime()}`);
    const confidence = Math.min(
      0.95,
      0.4 + 0.15 * Math.min(5, v.invalidations)  // 3→0.85, 4→1.0, 5+→capped at 0.95
    );

    syntheses.push({
      label: `Churn on ${slotType} "${slotName}"`,
      origin: 'churn_pattern',
      trait: {
        dimension: `stability_${slotType}`,
        value:     'serial_pivoter',
        weight:    Math.min(1, v.invalidations / cfg.volatilityInvalidationsForHigh),
      },
      mechanics:
        `The ${slotType} slot "${slotName}" has been reassigned ${v.invalidations} times ` +
        `in the past ${cfg.churnWindowDays} days. This pattern itself is a trait: the user ` +
        `cycles through states on this slot rather than settling on one. Downstream tools ` +
        `should weight the CURRENT value of this slot less (it's likely to change again) ` +
        `and treat the churn itself as the stable signal.`,
      reinforcing_nodes:   refs,
      contradicting_nodes: [],
      domains_bridged:     [slotType],
      isolated: false,
      confidence,
      confidence_components: {
        base_from_llm:         0,   // no LLM — deterministic derivation
        replication_bonus:     0,
        contradiction_penalty: 0,
        cross_domain:          false,
      },
      affinities:  [],
      aversions:   [],
      predictions: [
        `The current value on slot "${slotName}" will be reassigned again within ${cfg.churnWindowDays}d.`,
      ],
      surprising:  v.invalidations >= cfg.volatilityInvalidationsForHigh,
      generated_at: nowIso,
      mode: 'churn_scan',
    });
  }

  return syntheses;
}

// ── utilities ──────────────────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function round2(x) { return Math.round(x * 100) / 100; }

// Exposed for tests
export const _internal = {
  ageInDays,
  typeOfNode,
  clamp,
  round2,
};
