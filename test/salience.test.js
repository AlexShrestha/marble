/**
 * salience.test.js
 *
 * Covers:
 *   - computeSalience weighting (strength, evidence, volatility)
 *   - stale-active guardrail (old one-off facts fade faster than old reinforced ones)
 *   - computeVolatility over trailing window
 *   - getTopSalient ranking + domain filter + limit
 *   - salienceDistribution diagnostic shape
 *   - runChurnScan emits well-formed churn_pattern syntheses
 *   - Marble.rebuild() persists churn syntheses and returns distribution
 *   - inference.run() stays bounded even with a 5000-node synthetic KG
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Marble } from '../core/index.js';
import { KnowledgeGraph } from '../core/kg.js';
import { InferenceEngine } from '../core/inference-engine.js';
import {
  computeEffectiveStrength,
  computeSalience,
  computeVolatility,
  getTopSalient,
  salienceDistribution,
  runChurnScan,
  slotKeyFor,
  DEFAULT_SALIENCE_CONFIG,
} from '../core/salience.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function tmpKgPath() {
  const dir = mkdtempSync(join(tmpdir(), 'marble-salience-'));
  return { path: join(dir, 'kg.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

/** Build a bare KG with explicit nodes; no file I/O. */
function kgWith({ beliefs = [], preferences = [], identities = [] } = {}) {
  const kg = new KnowledgeGraph(':memory:');
  kg.user = {
    id: 'test', interests: [], context: {}, history: [], source_trust: {},
    beliefs, preferences, identities,
    confidence: {}, clones: [], episodes: [], entities: [],
    insights: [], syntheses: [],
  };
  return kg;
}

// ── computeEffectiveStrength + stale-active ────────────────────────────────

describe('computeEffectiveStrength + stale-active guardrail', () => {
  it('applies recency decay per halfLife', () => {
    const fresh = { strength: 0.9, recorded_at: daysAgo(0),   evidence_count: 3 };
    const aged  = { strength: 0.9, recorded_at: daysAgo(365), evidence_count: 3 };
    const fr = computeEffectiveStrength(fresh);
    const ag = computeEffectiveStrength(aged);
    assert.ok(fr > ag, 'fresh fact should be more effective than aged');
    assert.ok(Math.abs(ag - 0.45) < 0.05, `365d with halfLife=365 should be ~0.45, got ${ag}`);
  });

  it('halves effective strength for low-evidence stale facts', () => {
    const highEv = { strength: 0.8, recorded_at: daysAgo(200), evidence_count: 5 };
    const lowEv  = { strength: 0.8, recorded_at: daysAgo(200), evidence_count: 1 };
    assert.ok(
      computeEffectiveStrength(highEv) > computeEffectiveStrength(lowEv) * 1.5,
      'reinforced stale fact should dominate one-off stale fact',
    );
  });

  it('does NOT trigger guardrail when the fact is fresh', () => {
    const freshLowEv = { strength: 0.8, recorded_at: daysAgo(30), evidence_count: 1 };
    // Without guardrail: 0.8 × 2^(-30/365) ≈ 0.755
    const eff = computeEffectiveStrength(freshLowEv);
    assert.ok(eff > 0.7, `fresh low-evidence fact should not be halved, got ${eff}`);
  });
});

// ── computeVolatility ──────────────────────────────────────────────────────

describe('computeVolatility', () => {
  it('counts invalidations within the trailing window, grouped by slot', () => {
    const kg = kgWith({
      beliefs: [
        // Three invalidations on current_project in the last 90d — "serial pivoter"
        { topic: 'current_project', claim: 'Vivo health tracker', strength: 0.8, valid_from: daysAgo(200), valid_to: daysAgo(120), recorded_at: daysAgo(200) },
        { topic: 'current_project', claim: 'Marble',              strength: 0.8, valid_from: daysAgo(120), valid_to: daysAgo(60),  recorded_at: daysAgo(120) },
        { topic: 'current_project', claim: 'Another startup',     strength: 0.8, valid_from: daysAgo(60),  valid_to: daysAgo(30),  recorded_at: daysAgo(60) },
        { topic: 'current_project', claim: 'Latest thing',        strength: 0.8, valid_from: daysAgo(30),  valid_to: null,         recorded_at: daysAgo(30) },
        // Unrelated stable belief — 0 invalidations
        { topic: 'home_country',    claim: 'Spain',               strength: 0.95, valid_from: daysAgo(1000), valid_to: null,        recorded_at: daysAgo(10) },
      ],
    });
    const vol = computeVolatility(kg);
    assert.equal(vol.get('belief:current_project').invalidations, 3);
    assert.ok(vol.get('belief:current_project').score >= 1, 'serial pivoter normalizes to 1.0');
    assert.equal(vol.get('belief:home_country').invalidations, 0);
    assert.equal(vol.get('belief:home_country').score, 0);
  });

  it('ignores invalidations outside the trailing window', () => {
    const kg = kgWith({
      beliefs: [
        { topic: 'ancient', claim: 'x', strength: 0.7, valid_from: daysAgo(1000), valid_to: daysAgo(900), recorded_at: daysAgo(1000) },
      ],
    });
    const vol = computeVolatility(kg, { volatilityWindowDays: 180 });
    assert.equal(vol.get('belief:ancient').invalidations, 0);
  });
});

// ── computeSalience ────────────────────────────────────────────────────────

describe('computeSalience', () => {
  it('rewards reinforced beliefs more than one-off beliefs of equal strength', () => {
    const reinforced = { strength: 0.7, recorded_at: daysAgo(30), evidence_count: 10, topic: 'a', claim: 'a' };
    const oneOff     = { strength: 0.7, recorded_at: daysAgo(30), evidence_count: 1,  topic: 'b', claim: 'b' };
    const sReinforced = computeSalience(reinforced, {}, {});
    const sOneOff     = computeSalience(oneOff, {}, {});
    assert.ok(sReinforced > sOneOff, `reinforced should outscore one-off; got ${sReinforced} vs ${sOneOff}`);
  });

  it('rewards volatile slots (pattern IS the churn)', () => {
    const base = { strength: 0.7, recorded_at: daysAgo(10), evidence_count: 1, topic: 'pivot_slot', claim: 'current' };
    const ctxCalm  = { volatility: new Map([['belief:pivot_slot', { score: 0 }]]) };
    const ctxChurn = { volatility: new Map([['belief:pivot_slot', { score: 1 }]]) };
    assert.ok(
      computeSalience(base, ctxChurn, {}) > computeSalience(base, ctxCalm, {}),
      'the same fresh belief should score higher on a volatile slot than a calm one',
    );
  });

  it('clamps to [0, 1]', () => {
    const n = { strength: 1.0, recorded_at: daysAgo(0), evidence_count: 1_000_000, topic: 'x', claim: 'x' };
    const s = computeSalience(n, { volatility: new Map([['belief:x', { score: 1 }]]) }, {});
    assert.ok(s >= 0 && s <= 1, `salience must be 0..1, got ${s}`);
  });
});

// ── slotKeyFor ─────────────────────────────────────────────────────────────

describe('slotKeyFor', () => {
  it('returns stable keys per type', () => {
    assert.equal(slotKeyFor({ topic: 'Running',  claim: 'x' }, 'belief'),     'belief:running');
    assert.equal(slotKeyFor({ type:  'Pace',     description: 'slow' }, 'preference'), 'preference:pace');
    assert.equal(slotKeyFor({ role:  'Founder',  context: 'BCN' }, 'identity'),        'identity:founder');
  });
});

// ── getTopSalient ──────────────────────────────────────────────────────────

describe('getTopSalient', () => {
  it('returns top-K ranked by salience, highest first', () => {
    const kg = kgWith({
      beliefs: [
        { topic: 'strong_recent',     claim: 'x', strength: 0.9,  recorded_at: daysAgo(5),   evidence_count: 5, valid_to: null },
        { topic: 'weak_old_one_off',  claim: 'x', strength: 0.6,  recorded_at: daysAgo(300), evidence_count: 1, valid_to: null },
        { topic: 'medium',            claim: 'x', strength: 0.7,  recorded_at: daysAgo(30),  evidence_count: 2, valid_to: null },
      ],
    });
    const top = kg.getTopSalient({ types: ['belief'], limit: 10 });
    assert.equal(top[0].ref, 'belief:strong_recent');
    assert.equal(top[top.length - 1].ref, 'belief:weak_old_one_off');
    assert.ok(top.every(a => a.salience >= 0 && a.salience <= 1));
  });

  it('honors limit and filters out invalidated nodes', () => {
    const kg = kgWith({
      beliefs: Array.from({ length: 20 }, (_, i) => ({
        topic: `t${i}`, claim: 'x', strength: 0.8 - i * 0.01,
        recorded_at: daysAgo(5), evidence_count: 2, valid_to: i % 5 === 0 ? daysAgo(1) : null,
      })),
    });
    const top = kg.getTopSalient({ types: ['belief'], limit: 5 });
    assert.equal(top.length, 5);
    assert.ok(top.every(a => !a.node.valid_to), 'invalidated nodes should be dropped');
  });

  it('mixes types and sorts by salience not by type', () => {
    const kg = kgWith({
      beliefs:     [{ topic: 'b', claim: 'x', strength: 0.5, recorded_at: daysAgo(1), evidence_count: 1, valid_to: null }],
      preferences: [{ type: 'p',  description: 'x', strength: 0.95, recorded_at: daysAgo(0), evidence_count: 1, valid_to: null }],
      identities:  [{ role: 'i',  context: 'x', salience: 0.95, recorded_at: daysAgo(0), valid_to: null }],
    });
    const top = kg.getTopSalient({ limit: 3 });
    assert.equal(top.length, 3);
    // The highest-salience node should be the strong fresh preference or identity,
    // definitely not the weak belief.
    assert.notEqual(top[0].type, 'belief');
  });

  it('stale-active flag fires on old one-off facts', () => {
    const kg = kgWith({
      beliefs: [
        { topic: 'old_one_off', claim: 'x', strength: 0.7, recorded_at: daysAgo(200), evidence_count: 1, valid_to: null },
      ],
    });
    const [only] = kg.getTopSalient({ limit: 1 });
    assert.equal(only.stale_active, true);
  });
});

// ── salienceDistribution ───────────────────────────────────────────────────

describe('salienceDistribution', () => {
  it('produces counts, percentiles, byType breakdown', () => {
    const kg = kgWith({
      beliefs:     [{ topic: 'a', claim: 'x', strength: 0.8, recorded_at: daysAgo(1), evidence_count: 1, valid_to: null }],
      preferences: [{ type: 'p',  description: 'x', strength: 0.5, recorded_at: daysAgo(1), evidence_count: 1, valid_to: null }],
    });
    const d = kg.salienceDistribution();
    assert.equal(d.total, 2);
    assert.ok(d.percentiles.p50 >= 0);
    assert.equal(d.byType.belief.count, 1);
    assert.equal(d.byType.preference.count, 1);
    assert.ok(Array.isArray(d.topExamples));
  });

  it('returns empty shape when KG is empty', () => {
    const kg = kgWith();
    const d = kg.salienceDistribution();
    assert.equal(d.total, 0);
    assert.equal(d.staleActive, 0);
  });
});

// ── runChurnScan ───────────────────────────────────────────────────────────

describe('runChurnScan', () => {
  it('emits a churn_pattern synthesis for high-invalidation slots', () => {
    const kg = kgWith({
      beliefs: [
        { topic: 'current_project', claim: 'Vivo',         strength: 0.8, valid_from: daysAgo(200), valid_to: daysAgo(120), recorded_at: daysAgo(200) },
        { topic: 'current_project', claim: 'Marble',       strength: 0.8, valid_from: daysAgo(120), valid_to: daysAgo(60),  recorded_at: daysAgo(120) },
        { topic: 'current_project', claim: 'OtherStartup', strength: 0.8, valid_from: daysAgo(60),  valid_to: daysAgo(30),  recorded_at: daysAgo(60) },
        { topic: 'current_project', claim: 'Latest',       strength: 0.8, valid_from: daysAgo(30),  valid_to: null,         recorded_at: daysAgo(30) },
      ],
    });
    const syntheses = runChurnScan(kg);
    assert.equal(syntheses.length, 1);
    const [s] = syntheses;
    assert.equal(s.origin, 'churn_pattern');
    assert.equal(s.trait.dimension, 'stability_belief');
    assert.equal(s.trait.value, 'serial_pivoter');
    assert.ok(s.confidence >= 0.7, 'three invalidations should yield confidence ≥0.7');
    assert.ok(s.mechanics.includes('current_project'));
    assert.ok(s.reinforcing_nodes.length >= 3);
  });

  it('does NOT emit when invalidations fall below threshold', () => {
    const kg = kgWith({
      beliefs: [
        { topic: 'stable', claim: 'v1', strength: 0.8, valid_from: daysAgo(200), valid_to: daysAgo(100), recorded_at: daysAgo(200) },
        { topic: 'stable', claim: 'v2', strength: 0.8, valid_from: daysAgo(100), valid_to: null,        recorded_at: daysAgo(100) },
      ],
    });
    assert.deepEqual(runChurnScan(kg), []);
  });
});

// ── Marble.rebuild() wrapper ───────────────────────────────────────────────

describe('Marble.rebuild()', () => {
  it('persists churn syntheses via kg.addSynthesis and returns distribution', async () => {
    const { path, cleanup } = tmpKgPath();
    try {
      const marble = new Marble({ storage: path, llm: null, silent: true });
      await marble.init();

      // Seed a serial-pivot pattern on current_project
      marble.kg.addBelief('current_project', 'Vivo',       0.8);
      marble.kg.addBelief('current_project', 'Marble',     0.8);
      marble.kg.addBelief('current_project', 'Other',      0.8);
      marble.kg.addBelief('current_project', 'Latest',     0.8);

      const { churnSyntheses, distribution } = await marble.rebuild();
      assert.ok(churnSyntheses.length >= 1);
      assert.equal(churnSyntheses[0].origin, 'churn_pattern');
      assert.ok(churnSyntheses[0].id, 'persisted records have ids');
      assert.ok(distribution.total >= 1);
      assert.ok(marble.kg.user._last_rebuild_at, 'rebuild timestamp written');
    } finally { cleanup(); }
  });
});

// ── Inference engine OOM regression ────────────────────────────────────────

describe('InferenceEngine.run() on a 5000-node synthetic KG', () => {
  it('completes in bounded time/memory (the old O(N²) pairwise would OOM)', async () => {
    const beliefs = Array.from({ length: 2000 }, (_, i) => ({
      topic:          `topic_${i}`,
      claim:          `claim_${i}`,
      strength:       0.4 + (i % 6) * 0.1,
      recorded_at:    daysAgo(i % 400),
      evidence_count: 1 + (i % 5),
      valid_to:       null,
    }));
    const preferences = Array.from({ length: 2000 }, (_, i) => ({
      type:           `pref_${i}`,
      description:    `desc_${i}`,
      strength:       0.4 + (i % 6) * 0.1,
      recorded_at:    daysAgo(i % 400),
      valid_to:       null,
    }));
    const identities = Array.from({ length: 1000 }, (_, i) => ({
      role:          `role_${i}`,
      context:       `ctx_${i}`,
      salience:      0.5 + (i % 5) * 0.1,
      recorded_at:   daysAgo(i % 400),
      valid_to:      null,
    }));
    const kg = kgWith({ beliefs, preferences, identities });

    const engine = new InferenceEngine(kg, { seeds: [] });
    const t0 = Date.now();
    const candidates = await engine.run();
    const elapsed = Date.now() - t0;

    // The old pairwise pass would have allocated ~10M candidates from the
    // beliefs alone. Post-refactor, temporal patterns over top-100 salient
    // yields at most ~200 candidates, and we budget 2 seconds for it.
    assert.ok(elapsed < 2000, `inference.run() too slow on 5000-node KG: ${elapsed}ms`);
    assert.ok(candidates.length < 500, `candidate output should be bounded, got ${candidates.length}`);
  });
});
