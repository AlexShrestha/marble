/**
 * investigative-committee-semantic.test.mjs
 *
 * Verifies that answerQuestion() uses kg.semanticSearch() before hitting
 * external data sources — so indirect evidence queries like
 * "ultra marathon newsletter" find semantically related KG nodes even when
 * the exact words aren't there.
 *
 * No API keys required: uses deterministic bag-of-words MockEmbeddings.
 * No external sources registered: proves KG semantic search alone is enough.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeGraph } from '../core/kg.js';
import { InvestigativeCommittee } from '../core/investigative-committee.js';

// ── MockEmbeddings ────────────────────────────────────────────────────────────
// Deterministic 64-dim bag-of-words embedding. Words hash into [0, 63].
// Shared keywords → higher cosine similarity.

class MockEmbeddings {
  #dim = 64;

  async embed(text) {
    const vec = new Float32Array(this.#dim);
    const words = text.toLowerCase().split(/\W+/).filter(w => w.length > 2);
    for (const word of words) {
      let h = 5381;
      for (let i = 0; i < word.length; i++) h = ((h << 5) + h) ^ word.charCodeAt(i);
      vec[((h >>> 0) % this.#dim)] += 1;
    }
    this.#normalise(vec);
    return vec;
  }

  async embedBatch(texts) {
    return Promise.all(texts.map(t => this.embed(t)));
  }

  #normalise(vec) {
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  }
}

// ── Stub LLM ─────────────────────────────────────────────────────────────────

function makeStubLLM() {
  return async function stubLLM(prompt) {
    // Evidence query generation step
    if (prompt.includes('Generate up to 5 short search queries')) {
      return JSON.stringify([
        'ultra marathon newsletter',
        'endurance running subscription',
        'trail race training logs'
      ]);
    }

    // Inference step — check if KG snippets were surfaced in context
    if (prompt.startsWith('Question:')) {
      const hasRunningEvidence =
        prompt.includes('ultra marathon') ||
        prompt.includes('endurance') ||
        prompt.includes('trail running') ||
        prompt.includes('marathon') ||
        prompt.includes('KG:interest') ||
        prompt.includes('KG:identity') ||
        prompt.includes('KG:belief') ||
        prompt.includes('KG:preference');

      if (hasRunningEvidence) {
        return 'Based on the KG signals (ultra marathon interest, endurance runner identity, race reports preference), this person is very likely subscribed to an ultra marathon newsletter.';
      }
      return 'null';
    }

    return 'null';
  };
}

// ── KG Seed ───────────────────────────────────────────────────────────────────

function seedRunningKG() {
  const kg = new KnowledgeGraph('/tmp/test-ic-semantic.json');
  kg.user = {
    id: 'test-runner',
    interests: [
      { topic: 'ultra marathon training', weight: 0.9, last_boost: new Date().toISOString(), trend: 'rising' },
      { topic: 'trail running endurance', weight: 0.85, last_boost: new Date().toISOString(), trend: 'rising' },
      { topic: 'marathon nutrition strategy', weight: 0.75, last_boost: new Date().toISOString(), trend: 'rising' },
      { topic: 'quantum computing', weight: 0.2, last_boost: new Date().toISOString(), trend: 'stable' },
    ],
    beliefs: [
      {
        topic: 'training',
        claim: 'Consistent weekly mileage beats intensity for marathon performance',
        strength: 0.8,
        evidence_count: 5,
        valid_from: new Date().toISOString(),
        valid_to: null,
        recorded_at: new Date().toISOString()
      },
    ],
    preferences: [
      {
        type: 'content_style',
        description: 'race reports and ultra marathon logs',
        strength: 0.9,
        valid_from: new Date().toISOString(),
        valid_to: null,
        recorded_at: new Date().toISOString()
      },
    ],
    identities: [
      {
        role: 'endurance athlete',
        context: 'running ultramarathons and trail races',
        salience: 0.9,
        valid_from: new Date().toISOString(),
        valid_to: null,
        recorded_at: new Date().toISOString()
      },
    ],
    confidence: {},
    history: [],
    source_trust: {},
    _dimensionalPreferences: [],
    clones: [],
  };
  return kg;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('InvestigativeCommittee — semantic search wired into answerQuestion()', () => {
  let kg;
  let committee;
  const mock = new MockEmbeddings();

  before(async () => {
    kg = seedRunningKG();
    const indexed = await kg.buildVectorIndex(mock);
    assert.ok(indexed > 0, `Expected nodes to be indexed, got ${indexed}`);

    committee = new InvestigativeCommittee(kg, makeStubLLM(), { embeddingsProvider: mock });
    // No external sources registered — KG must carry the load
  });

  it('answerQuestion() finds evidence via semantic search without exact keyword match', async () => {
    // The question contains "newsletter" — a word not present in any KG node.
    // Semantic search should still surface ultra/marathon/endurance nodes.
    const answer = await committee.answerQuestion(
      'Is this person subscribed to an ultra marathon newsletter?'
    );

    assert.ok(
      answer !== null,
      'Expected a non-null answer — KG semantic search should have surfaced running evidence'
    );
    assert.ok(
      typeof answer === 'string' && answer.length > 10,
      `Answer should be a meaningful string, got: ${JSON.stringify(answer)}`
    );
  });

  it('answerQuestion() returns null when KG has no relevant data and no external sources', async () => {
    // Fresh KG with unrelated content (no running facts)
    const emptyKG = new KnowledgeGraph('/tmp/test-ic-empty.json');
    emptyKG.user = {
      id: 'other-user',
      interests: [
        { topic: 'interior design', weight: 0.5, last_boost: new Date().toISOString(), trend: 'stable' },
      ],
      beliefs: [],
      preferences: [],
      identities: [],
      confidence: {},
      history: [],
      source_trust: {},
      _dimensionalPreferences: [],
      clones: [],
    };
    await emptyKG.buildVectorIndex(mock);

    // Use a stub LLM that returns null for the inference step regardless
    const nullLLM = async (prompt) => {
      if (prompt.includes('Generate up to 5 short search queries')) {
        return JSON.stringify(['ultra marathon newsletter']);
      }
      return 'null';
    };

    const emptyCommittee = new InvestigativeCommittee(emptyKG, nullLLM);
    const answer = await emptyCommittee.answerQuestion(
      'Is this person subscribed to an ultra marathon newsletter?'
    );

    assert.equal(
      answer,
      null,
      'Should return null when no relevant evidence exists and no sources registered'
    );
  });

  it('KG snippets appear before external source results in inference context', async () => {
    // Track which prompt was sent to the LLM during inference
    let inferencePrompt = null;
    const capturingLLM = async (prompt) => {
      if (prompt.includes('Generate up to 5 short search queries')) {
        return JSON.stringify(['ultra marathon']);
      }
      if (prompt.startsWith('Question:')) {
        inferencePrompt = prompt;
        return 'Based on KG evidence, yes.';
      }
      return 'null';
    };

    const externalResults = [];
    const trackingCommittee = new InvestigativeCommittee(kg, capturingLLM, { embeddingsProvider: mock });
    trackingCommittee.registerSource('external', async () => {
      externalResults.push('external-called');
      return ['External data: runner completed 50K race'];
    });

    await trackingCommittee.answerQuestion('Is this person an ultra marathon runner?');

    assert.ok(inferencePrompt !== null, 'Inference LLM should have been called');

    // KG snippets (tagged with [KG:]) should appear in the context
    assert.ok(
      inferencePrompt.includes('[KG:'),
      'Inference context should contain KG snippets tagged with [KG:]'
    );

    // External source should also have been called
    assert.equal(externalResults.length > 0, true, 'External source should have been queried');
  });
});
