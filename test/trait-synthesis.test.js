/**
 * trait-synthesis.test.js
 *
 * Covers the L2 trait synthesis pipeline end-to-end:
 *   - Phase 1  per-node trait extraction with a queued mock LLM
 *   - Phase 2  replication grouping (in-process, no LLM)
 *   - Phase 3  contradiction detection (in-process, no LLM)
 *   - Phase 4  K-way emergent fusion with a queued mock LLM
 *   - KG persistence (addSynthesis upsert, accessors)
 *   - Marble.synthesize() public wrapper
 *
 * All LLM calls are routed through a deterministic queue so the tests are
 * hermetic — no network, no API key required.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Marble } from '../core/index.js';
import { KnowledgeGraph } from '../core/kg.js';
import { wrapUserLLM } from '../core/llm-provider.js';
import { runTraitSynthesis, _internal } from '../core/trait-synthesis.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function tmpKgPath() {
  const dir = mkdtempSync(join(tmpdir(), 'marble-trait-'));
  return { path: join(dir, 'kg.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Build a client that returns a queue of pre-fabricated JSON string responses
 * in order. Raises if the caller exhausts the queue (surfaces test drift
 * immediately rather than silently returning empty).
 */
function queuedLLM(responses) {
  let idx = 0;
  const fn = async () => {
    if (idx >= responses.length) {
      throw new Error(`queuedLLM: exhausted after ${responses.length} calls`);
    }
    const out = responses[idx++];
    return out;
  };
  fn.index = () => idx;
  return { client: wrapUserLLM(fn), calls: fn };
}

/**
 * Lightweight KG with a given set of L1 nodes. Used by the in-process tests
 * that don't need a file-backed KG.
 */
function makeKg({ beliefs = [], preferences = [], identities = [] } = {}) {
  const kg = new KnowledgeGraph(':memory:');
  kg.user = {
    id: 'test',
    interests: [],
    context: {},
    history: [],
    source_trust: {},
    beliefs:     beliefs.map(b => ({ strength: 0.7, valid_to: null, ...b })),
    preferences: preferences.map(p => ({ strength: 0.7, valid_to: null, ...p })),
    identities:  identities.map(i => ({ salience: 0.8, valid_to: null, ...i })),
    confidence: {},
    clones: [],
    episodes: [],
    entities: [],
    insights: [],
    syntheses: [],
  };
  return kg;
}

// ── collectNodes ───────────────────────────────────────────────────────────

describe('collectNodes', () => {
  it('collects active beliefs/preferences/identities with stable refs', () => {
    const kg = makeKg({
      beliefs:     [{ topic: 'running', claim: 'enjoys long runs', strength: 0.7 }],
      preferences: [{ type: 'pace', description: 'slow', strength: 0.6 }],
      identities:  [{ role: 'founder', context: 'Barcelona', salience: 0.85 }],
    });
    const nodes = _internal.collectNodes(kg, [0.4, 0.9]);

    const refs = nodes.map(n => n.ref);
    assert.deepEqual(refs.sort(), ['belief:running', 'identity:founder', 'preference:pace']);
    assert.ok(nodes.every(n => typeof n.text === 'string' && n.text.length > 0));
  });

  it('drops out-of-range strengths and expired (valid_to) nodes', () => {
    const kg = makeKg({
      beliefs: [
        { topic: 'too_strong',  claim: 'x', strength: 0.95 },
        { topic: 'too_weak',    claim: 'x', strength: 0.3 },
        { topic: 'retired',     claim: 'x', strength: 0.7, valid_to: '2020-01-01' },
        { topic: 'just_right',  claim: 'x', strength: 0.6 },
      ],
    });
    const nodes = _internal.collectNodes(kg, [0.4, 0.9]);
    assert.deepEqual(nodes.map(n => n.ref), ['belief:just_right']);
  });
});

// ── groupByReplication ─────────────────────────────────────────────────────

describe('groupByReplication', () => {
  const opts = { alpha: 0.15, beta: 1.3 };

  it('groups identical (dimension, value) pairs and marks isolation correctly', () => {
    const candidates = [
      { node_ref: 'belief:running',       domain: 'health',       dimension: 'time_orientation', value: 'compound', weight: 0.7, base_conf: 0.6 },
      { node_ref: 'identity:daily_prayer', domain: 'spirituality', dimension: 'time_orientation', value: 'compound', weight: 0.8, base_conf: 0.7 },
      { node_ref: 'preference:pace',      domain: 'health',       dimension: 'effort_profile',   value: 'sustained_low', weight: 0.7, base_conf: 0.6 },
    ];
    const groups = _internal.groupByReplication(candidates, opts);
    const timeGroup = groups.find(g => g.dimension === 'time_orientation');
    const effortGroup = groups.find(g => g.dimension === 'effort_profile');

    assert.equal(timeGroup.reinforcing_refs.length, 2);
    assert.equal(timeGroup.isolated, false);
    assert.equal(timeGroup.cross_domain, true);
    assert.ok(timeGroup.replication_bonus > 0);

    assert.equal(effortGroup.reinforcing_refs.length, 1);
    assert.equal(effortGroup.isolated, true);
    assert.equal(effortGroup.cross_domain, false);
    assert.equal(effortGroup.replication_bonus > 0, true);  // single-node still gets log(1+1) bonus
  });

  it('dedupes duplicate candidates from the same node', () => {
    const candidates = [
      { node_ref: 'belief:x', domain: 'work', dimension: 'd', value: 'v', weight: 0.7, base_conf: 0.6 },
      { node_ref: 'belief:x', domain: 'work', dimension: 'd', value: 'v', weight: 0.7, base_conf: 0.6 },
    ];
    const [g] = _internal.groupByReplication(candidates, opts);
    assert.equal(g.reinforcing_refs.length, 1, 'same node must not double-count');
  });

  it('cross-domain replication bonus exceeds same-domain replication bonus', () => {
    const sameDomain = _internal.groupByReplication([
      { node_ref: 'belief:a', domain: 'health', dimension: 'd', value: 'v', weight: 0.7, base_conf: 0.6 },
      { node_ref: 'belief:b', domain: 'health', dimension: 'd', value: 'v', weight: 0.7, base_conf: 0.6 },
    ], opts);
    const crossDomain = _internal.groupByReplication([
      { node_ref: 'belief:a', domain: 'health', dimension: 'd', value: 'v', weight: 0.7, base_conf: 0.6 },
      { node_ref: 'belief:b', domain: 'work',   dimension: 'd', value: 'v', weight: 0.7, base_conf: 0.6 },
    ], opts);
    assert.ok(crossDomain[0].replication_bonus > sameDomain[0].replication_bonus);
  });
});

// ── detectContradictions ───────────────────────────────────────────────────

describe('detectContradictions', () => {
  it('emits a contradiction when same dimension has divergent values from disjoint node sets', () => {
    const groups = [
      { dimension: 'follow_through', value: 'sustained',    reinforcing_refs: ['belief:run', 'identity:prayer'], domains_bridged: ['health','spirituality'], base_conf: 0.7, weight: 0.8, cross_domain: true, isolated: false, replication_bonus: 0.2 },
      { dimension: 'follow_through', value: 'inconsistent', reinforcing_refs: ['history:quit_3', 'history:jobhops'], domains_bridged: ['work'], base_conf: 0.65, weight: 0.7, cross_domain: false, isolated: false, replication_bonus: 0.1 },
    ];
    const contradictions = _internal.detectContradictions(groups);
    assert.equal(contradictions.length, 1);
    assert.equal(contradictions[0].dimension, 'follow_through');
    assert.ok(contradictions[0].sideA && contradictions[0].sideB);
  });

  it('skips pairs that share reinforcing nodes — overlap is complexity, not contradiction', () => {
    const groups = [
      { dimension: 'd', value: 'a', reinforcing_refs: ['belief:x', 'belief:y'], domains_bridged: ['w'], base_conf: 0.6, weight: 0.7, cross_domain: false, isolated: false, replication_bonus: 0.1 },
      { dimension: 'd', value: 'b', reinforcing_refs: ['belief:y', 'belief:z'], domains_bridged: ['w'], base_conf: 0.6, weight: 0.7, cross_domain: false, isolated: false, replication_bonus: 0.1 },
    ];
    assert.equal(_internal.detectContradictions(groups).length, 0);
  });

  it('returns empty when a dimension has only one value', () => {
    const groups = [
      { dimension: 'd', value: 'v', reinforcing_refs: ['a', 'b'], domains_bridged: ['x'], base_conf: 0.6, weight: 0.7, cross_domain: false, isolated: false, replication_bonus: 0 },
    ];
    assert.deepEqual(_internal.detectContradictions(groups), []);
  });
});

// ── Composition ────────────────────────────────────────────────────────────

describe('composition: replication syntheses', () => {
  const opts = { minConfidence: 0.4 };

  it('emits origin=trait_replication for multi-node groups and origin=single_node for isolated', () => {
    const replicated = [{
      dimension: 'd', value: 'v', weight: 0.8,
      reinforcing_refs: ['belief:a', 'belief:b'],
      domains_bridged: ['health', 'work'],
      base_conf: 0.65, replication_bonus: 0.22,
      cross_domain: true, isolated: false,
    }];
    const isolated = [{
      dimension: 'd2', value: 'v2', weight: 0.5,
      reinforcing_refs: ['belief:only'],
      domains_bridged: ['hobbies'],
      base_conf: 0.55, replication_bonus: 0.05,
      cross_domain: false, isolated: true,
    }];
    const [r] = _internal.composeReplicationSyntheses(replicated, opts);
    const [i] = _internal.composeReplicationSyntheses(isolated, opts);

    assert.equal(r.origin, 'trait_replication');
    assert.equal(r.confidence, 0.87);
    assert.equal(r.confidence_components.cross_domain, true);
    assert.equal(r.confidence_components.replication_bonus, 0.22);
    assert.equal(i.origin, 'single_node');
    assert.equal(i.isolated, true);
  });

  it('drops syntheses below opts.minConfidence', () => {
    const groups = [{
      dimension: 'd', value: 'v', weight: 0.4,
      reinforcing_refs: ['belief:weak'],
      domains_bridged: ['x'],
      base_conf: 0.2, replication_bonus: 0.05,
      cross_domain: false, isolated: true,
    }];
    assert.deepEqual(_internal.composeReplicationSyntheses(groups, { minConfidence: 0.5 }), []);
  });
});

describe('composition: contradiction syntheses', () => {
  const opts = { minConfidence: 0.3, gamma: 0.2 };

  it('penalizes confidence by contradiction_penalty and keeps both node sides', () => {
    const contradictions = [{
      dimension: 'follow_through',
      sideA: { value: 'sustained',    reinforcing_refs: ['a', 'b'], domains_bridged: ['health'], base_conf: 0.7, weight: 0.8, cross_domain: false, isolated: false, replication_bonus: 0.1 },
      sideB: { value: 'inconsistent', reinforcing_refs: ['c'],       domains_bridged: ['work'],    base_conf: 0.65, weight: 0.7, cross_domain: false, isolated: true,  replication_bonus: 0 },
    }];
    const [s] = _internal.composeContradictionSyntheses(contradictions, opts);

    assert.equal(s.origin, 'contradiction');
    assert.deepEqual(s.reinforcing_nodes, ['a', 'b']);
    assert.deepEqual(s.contradicting_nodes, ['c']);
    assert.equal(s.confidence_components.contradiction_penalty > 0, true);
    assert.equal(s.surprising, true);
    assert.ok(s.domains_bridged.includes('health') && s.domains_bridged.includes('work'));
  });
});

describe('composition: fusion syntheses', () => {
  const baseFusion = {
    label: 'Endurance-engineered founder',
    mechanics: 'Long-horizon disciplines across health, spirituality, and work share the same psychological toolkit of delayed gratification.',
    trait: { dimension: 'time_orientation', value: 'compound', weight: 0.85 },
    affinities: ['marathon essays', 'stoicism'],
    aversions: ['hustle porn'],
    predictions: ['dwells 2x on endurance content'],
    domains_bridged: ['health', 'spirituality', 'work'],
    surprising: true,
    confidence: 0.72,
    source_refs: ['belief:running', 'identity:prayer', 'preference:5yr_positions'],
  };

  it('passes a well-formed fusion through with origin=emergent_fusion', () => {
    const [s] = _internal.composeFusionSyntheses([baseFusion], { minConfidence: 0.4, schemaStrict: true, requireSurprising: false });
    assert.equal(s.origin, 'emergent_fusion');
    assert.equal(s.trait.dimension, 'time_orientation');
    assert.equal(s.mode, 'fusion');
    assert.deepEqual(s.reinforcing_nodes, baseFusion.source_refs);
    assert.equal(s.surprising, true);
  });

  it('rejects fusion missing trait under schemaStrict', () => {
    const bad = { ...baseFusion, trait: null };
    assert.deepEqual(
      _internal.composeFusionSyntheses([bad], { minConfidence: 0.4, schemaStrict: true, requireSurprising: false }),
      []
    );
  });

  it('drops non-surprising when requireSurprising=true', () => {
    const meh = { ...baseFusion, surprising: false };
    assert.deepEqual(
      _internal.composeFusionSyntheses([meh], { minConfidence: 0.4, schemaStrict: true, requireSurprising: true }),
      []
    );
  });
});

// ── sampleAcrossDomains ────────────────────────────────────────────────────

describe('sampleAcrossDomains', () => {
  it('prefers domain spread when enabled', () => {
    const nodes = [
      { ref: 'belief:a',     type: 'belief',     text: 'a', strength: 0.7 },
      { ref: 'belief:b',     type: 'belief',     text: 'b', strength: 0.7 },
      { ref: 'preference:a', type: 'preference', text: 'a', strength: 0.7 },
      { ref: 'preference:b', type: 'preference', text: 'b', strength: 0.7 },
      { ref: 'identity:a',   type: 'identity',   text: 'a', strength: 0.7 },
    ];
    const sample = _internal.sampleAcrossDomains(nodes, 3, new Map(), true);
    const types = new Set(sample.map(s => s.type));
    assert.equal(sample.length, 3);
    assert.equal(types.size, 3, 'should pick one from each type before backfilling');
  });

  it('honors usedCounts — less-used nodes picked first', () => {
    const nodes = [
      { ref: 'a', type: 'belief', text: 'a', strength: 0.7 },
      { ref: 'b', type: 'belief', text: 'b', strength: 0.7 },
    ];
    const used = new Map([['a', 5], ['b', 0]]);
    const [first] = _internal.sampleAcrossDomains(nodes, 1, used, false);
    assert.equal(first.ref, 'b');
  });
});

// ── _parseJSON ─────────────────────────────────────────────────────────────

describe('_parseJSON', () => {
  it('parses raw JSON', () => {
    assert.deepEqual(_internal._parseJSON('{"a":1}'), { a: 1 });
  });
  it('parses fenced JSON', () => {
    assert.deepEqual(_internal._parseJSON('```json\n{"a":2}\n```'), { a: 2 });
  });
  it('extracts JSON from surrounding prose', () => {
    assert.deepEqual(_internal._parseJSON('here you go: {"a":3} thanks'), { a: 3 });
  });
  it('returns null on unparseable input', () => {
    assert.equal(_internal._parseJSON('this has no json'), null);
  });
});

// ── KG persistence ─────────────────────────────────────────────────────────

describe('kg.addSynthesis / getSyntheses / getSynthesesForNode', () => {
  it('assigns an id + generated_at if missing, upserts on (origin, trait.dim, trait.val)', () => {
    const kg = makeKg();
    const a = kg.addSynthesis({
      origin: 'trait_replication',
      trait: { dimension: 'd', value: 'v', weight: 0.7 },
      confidence: 0.6,
      reinforcing_nodes: ['belief:x'],
      domains_bridged: ['health'],
    });
    assert.ok(a.id);
    assert.ok(a.generated_at);

    // Higher-confidence write on same key replaces (keeping original id)
    const b = kg.addSynthesis({
      origin: 'trait_replication',
      trait: { dimension: 'd', value: 'v', weight: 0.8 },
      confidence: 0.8,
      reinforcing_nodes: ['belief:x', 'belief:y'],
      domains_bridged: ['health', 'work'],
    });
    assert.equal(b.id, a.id, 'upsert must preserve the original id');
    assert.equal(kg.user.syntheses.length, 1);
    assert.equal(kg.user.syntheses[0].confidence, 0.8);

    // Lower-confidence write on same key is ignored
    kg.addSynthesis({
      origin: 'trait_replication',
      trait: { dimension: 'd', value: 'v', weight: 0.1 },
      confidence: 0.1,
      reinforcing_nodes: [],
      domains_bridged: [],
    });
    assert.equal(kg.user.syntheses[0].confidence, 0.8, 'lower-confidence write should not overwrite');
  });

  it('filters by origin, minConfidence, surprising, trait, and domainsIncludes', () => {
    const kg = makeKg();
    kg.addSynthesis({ origin: 'single_node',        trait: { dimension: 'd1', value: 'v1', weight: 0.5 }, confidence: 0.5, surprising: false, domains_bridged: ['health'],        reinforcing_nodes: ['belief:a'] });
    kg.addSynthesis({ origin: 'trait_replication',  trait: { dimension: 'd1', value: 'v2', weight: 0.7 }, confidence: 0.8, surprising: false, domains_bridged: ['health', 'work'], reinforcing_nodes: ['belief:a', 'belief:b'] });
    kg.addSynthesis({ origin: 'contradiction',      trait: { dimension: 'd2', value: 'x↔y', weight: 0.6 }, confidence: 0.65, surprising: true, domains_bridged: ['work'],          reinforcing_nodes: ['belief:c'], contradicting_nodes: ['belief:d'] });

    assert.equal(kg.getSyntheses({ minConfidence: 0.7 }).length, 1);
    assert.equal(kg.getSyntheses({ origin: 'contradiction' }).length, 1);
    assert.equal(kg.getSyntheses({ surprising: true }).length, 1);
    assert.equal(kg.getSyntheses({ trait: { dimension: 'd1' } }).length, 2);
    assert.equal(kg.getSyntheses({ domainsIncludes: ['health', 'work'] }).length, 1);
  });

  it('getSynthesesForNode returns records from both reinforcing and contradicting sides', () => {
    const kg = makeKg();
    kg.addSynthesis({ origin: 'contradiction', trait: { dimension: 'd', value: 'a↔b', weight: 0.6 }, confidence: 0.6, reinforcing_nodes: ['belief:r'], contradicting_nodes: ['belief:c'], domains_bridged: [] });
    assert.equal(kg.getSynthesesForNode('belief:r').length, 1);
    assert.equal(kg.getSynthesesForNode('belief:c').length, 1);
    assert.equal(kg.getSynthesesForNode('belief:absent').length, 0);
  });
});

// ── End-to-end with mocked LLM ─────────────────────────────────────────────

describe('runTraitSynthesis end-to-end (mocked LLM)', () => {
  it('produces replication + contradiction + fusion origins from a crafted KG', async () => {
    const kg = makeKg({
      beliefs:     [{ topic: 'running', claim: 'enjoys long Higdon-style runs', strength: 0.7 }],
      preferences: [{ type: 'positions', description: 'holds 5+ years', strength: 0.7 }],
      identities:  [
        { role: 'daily_prayer', context: 'consistent 3yr practice', salience: 0.75 },
        { role: 'serial_quitter', context: 'abandons side-projects at 4mo', salience: 0.7 },
      ],
    });

    // Phase 1 response: one per extraction chunk. With chunkSize=10 (default)
    // and 4 nodes, there's exactly one chunk — one LLM call.
    const extraction = JSON.stringify([
      { node_ref: 'belief:running', domain: 'health',       traits: [
        { dimension: 'time_orientation', value: 'compound', weight: 0.75, confidence: 0.7, evidence_quote: 'long runs' },
      ]},
      { node_ref: 'preference:positions', domain: 'finance',      traits: [
        { dimension: 'time_orientation', value: 'compound', weight: 0.8,  confidence: 0.75, evidence_quote: '5+ years' },
      ]},
      { node_ref: 'identity:daily_prayer', domain: 'spirituality', traits: [
        { dimension: 'time_orientation', value: 'compound', weight: 0.7,  confidence: 0.65, evidence_quote: 'consistent 3yr' },
        { dimension: 'follow_through',   value: 'sustained', weight: 0.8, confidence: 0.75, evidence_quote: 'consistent' },
      ]},
      { node_ref: 'identity:serial_quitter', domain: 'work',      traits: [
        { dimension: 'follow_through',   value: 'inconsistent', weight: 0.8, confidence: 0.75, evidence_quote: 'abandons at 4mo' },
      ]},
    ]);

    // Phase 4 response — one fusion call (fusionSamples=5 capped by floor(N/k)).
    // With k=3 and 4 nodes, floor(4/3)=1 — one fusion call.
    const fusion = JSON.stringify({
      label:       'Endurance-engineered discipline',
      mechanics:   'Long-horizon practices span health, spirituality, and finance using the same psychological toolkit of delayed gratification and repetition without stimulation.',
      trait:       { dimension: 'effort_profile', value: 'sustained_low_intensity', weight: 0.8 },
      affinities:  ['marathon essays', 'contemplative practice content'],
      aversions:   ['hustle porn'],
      predictions: ['dwells >2x on endurance content'],
      domains_bridged: ['health', 'spirituality', 'finance'],
      surprising:  true,
      confidence:  0.72,
    });

    const { client } = queuedLLM([extraction, fusion]);

    const syntheses = await runTraitSynthesis(kg, {
      llmClient: client,
      k: 3,
      fusionSamples: 5,
      minConfidence: 0.4,
    });

    const origins = syntheses.map(s => s.origin);
    assert.ok(origins.includes('trait_replication'), 'missing trait_replication origin');
    assert.ok(origins.includes('contradiction'),     'missing contradiction origin');
    assert.ok(origins.includes('emergent_fusion'),   'missing emergent_fusion origin');

    const replication = syntheses.find(s => s.origin === 'trait_replication');
    assert.equal(replication.trait.dimension, 'time_orientation');
    assert.equal(replication.trait.value, 'compound');
    assert.equal(replication.reinforcing_nodes.length, 3);
    assert.equal(replication.confidence_components.cross_domain, true);
    assert.ok(replication.confidence > 0.7, `replicated confidence should be boosted, got ${replication.confidence}`);

    const contradiction = syntheses.find(s => s.origin === 'contradiction');
    assert.equal(contradiction.trait.dimension, 'follow_through');
    assert.equal(contradiction.reinforcing_nodes.length, 1);
    assert.equal(contradiction.contradicting_nodes.length, 1);
    assert.equal(contradiction.surprising, true);
    assert.ok(contradiction.confidence_components.contradiction_penalty > 0);

    const fusionSyn = syntheses.find(s => s.origin === 'emergent_fusion');
    assert.equal(fusionSyn.mode, 'fusion');
    assert.ok(fusionSyn.affinities.includes('marathon essays'));
    assert.ok(fusionSyn.aversions.includes('hustle porn'));
    assert.equal(fusionSyn.surprising, true);
  });

  it('returns [] when no L1 nodes meet the strength range', async () => {
    const kg = makeKg({
      beliefs: [{ topic: 'too_weak', claim: 'x', strength: 0.2 }],
    });
    const { client } = queuedLLM([]);
    const out = await runTraitSynthesis(kg, { llmClient: client });
    assert.deepEqual(out, []);
  });

  it('gracefully handles LLM returning unparseable text (drops that chunk)', async () => {
    const kg = makeKg({
      beliefs: [{ topic: 'x', claim: 'y', strength: 0.6 }],
    });
    const { client } = queuedLLM([
      'i am not json at all, sorry',
      '{"label":null}',  // fusion returns null — skip
    ]);
    const out = await runTraitSynthesis(kg, {
      llmClient: client,
      fusionSamples: 1,
      k: 1,
    });
    // Nothing to synthesize when extraction fails and fusion returned null.
    assert.deepEqual(out, []);
  });
});

// ── Marble.synthesize() public wrapper ─────────────────────────────────────

describe('Marble.synthesize() public wrapper', () => {
  it('persists syntheses to kg.user.syntheses and returns the stored records', async () => {
    const { path, cleanup } = tmpKgPath();
    try {
      const extraction = JSON.stringify([
        { node_ref: 'belief:x', domain: 'work', traits: [
          { dimension: 'follow_through', value: 'sustained', weight: 0.7, confidence: 0.7, evidence_quote: 'ships fast' },
        ]},
        { node_ref: 'preference:y', domain: 'work', traits: [
          { dimension: 'follow_through', value: 'sustained', weight: 0.75, confidence: 0.7, evidence_quote: 'no fluff' },
        ]},
      ]);
      // Provide a fusion response even though the node count may not trigger
      // a fusion call — queuedLLM will raise if over-requested, so an extra
      // response in the queue is a test safety net rather than a requirement.
      const fusion = JSON.stringify({ label: null });

      const { client } = queuedLLM([extraction, fusion]);
      const marble = new Marble({ storage: path, llm: null, silent: true });
      marble.llm = client;  // bypass wrapUserLLM — we already wrapped above
      await marble.init();
      marble.kg.addBelief('x', 'ships fast', 0.7);
      marble.kg.addPreference('y', 'no fluff', 0.7);

      const result = await marble.synthesize({ fusionSamples: 0 });
      assert.ok(Array.isArray(result));
      assert.ok(result.length >= 1, 'at least one synthesis should persist');
      assert.ok(result[0].id, 'persisted records have ids');
      assert.ok(marble.kg.user.syntheses.length >= 1, 'kg.user.syntheses populated');
      assert.ok(result.every(s => s.generated_at), 'generated_at set by addSynthesis');
    } finally { cleanup(); }
  });
});
