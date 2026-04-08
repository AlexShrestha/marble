/**
 * test-kg-semantic-search.js
 *
 * Tests the native vector index + semanticSearch() on KnowledgeGraph.
 *
 * Uses a deterministic MockEmbeddings provider (keyword-overlap bag-of-words)
 * so no API key is required. The mock produces float32 vectors where shared
 * keywords push cosine similarity higher — enough to validate ranking logic.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeGraph } from '../core/kg.js';

// ── MockEmbeddings ────────────────────────────────────────────────────────────
// Deterministic 64-dim bag-of-words embedding. Words hash into [0, 63].
// Normalised to unit length so cosine similarity = dot product.

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

  cosineSimilarity(a, b) {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return dot; // both unit-length
  }

  #normalise(vec) {
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a KG entirely in-memory (no file I/O). */
function seedKG() {
  const kg = new KnowledgeGraph('/tmp/test-kg-semantic.json');
  kg.user = {
    id: 'test-user',
    interests: [
      { topic: 'ultra marathon training', weight: 0.9, last_boost: new Date().toISOString(), trend: 'rising' },
      { topic: 'trail running endurance', weight: 0.8, last_boost: new Date().toISOString(), trend: 'rising' },
      { topic: 'marathon nutrition strategy', weight: 0.7, last_boost: new Date().toISOString(), trend: 'rising' },
      { topic: 'long distance running gear', weight: 0.6, last_boost: new Date().toISOString(), trend: 'stable' },
      { topic: 'quantum computing research', weight: 0.5, last_boost: new Date().toISOString(), trend: 'stable' },
      { topic: 'machine learning algorithms', weight: 0.4, last_boost: new Date().toISOString(), trend: 'stable' },
      { topic: 'venture capital fundraising', weight: 0.3, last_boost: new Date().toISOString(), trend: 'falling' },
      { topic: 'interior design trends', weight: 0.2, last_boost: new Date().toISOString(), trend: 'falling' },
    ],
    beliefs: [
      { topic: 'training', claim: 'Consistent weekly mileage beats intensity for marathon performance', strength: 0.8, evidence_count: 5, valid_from: new Date().toISOString(), valid_to: null, recorded_at: new Date().toISOString() },
      { topic: 'AI ethics', claim: 'Alignment is the central challenge of AI development', strength: 0.7, evidence_count: 3, valid_from: new Date().toISOString(), valid_to: null, recorded_at: new Date().toISOString() },
    ],
    preferences: [
      { type: 'content_style', description: 'race reports and ultra marathon logs', strength: 0.9, valid_from: new Date().toISOString(), valid_to: null, recorded_at: new Date().toISOString() },
      { type: 'format', description: 'technical deep-dives over high-level summaries', strength: 0.6, valid_from: new Date().toISOString(), valid_to: null, recorded_at: new Date().toISOString() },
    ],
    identities: [
      { role: 'endurance athlete', context: 'running ultramarathons and trail races', salience: 0.85, valid_from: new Date().toISOString(), valid_to: null, recorded_at: new Date().toISOString() },
      { role: 'software engineer', context: 'building AI-powered products', salience: 0.75, valid_from: new Date().toISOString(), valid_to: null, recorded_at: new Date().toISOString() },
    ],
    confidence: { running: 0.9, AI: 0.7 },
    history: [],
    source_trust: {},
    _dimensionalPreferences: [],
    clones: [],
  };
  return kg;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('KnowledgeGraph — native vector index', () => {
  let kg;
  const mock = new MockEmbeddings();

  before(async () => {
    kg = seedKG();
    const count = await kg.buildVectorIndex(mock);
    assert.ok(count > 0, `Expected nodes to be indexed, got ${count}`);
  });

  it('buildVectorIndex populates the index with all node types', () => {
    // 8 interests + 2 beliefs + 2 preferences + 2 identities = 14
    assert.equal(kg._vectorIndex.size, 14, `Expected 14 indexed nodes, got ${kg._vectorIndex.size}`);
    assert.equal(kg._vectorIndexMeta.size, 14);
  });

  it('semanticSearch returns exactly topK results', async () => {
    const results = await kg.semanticSearch('ultra marathon training', 5, mock);
    assert.equal(results.length, 5, `Expected 5 results, got ${results.length}`);
  });

  it('semanticSearch results have required fields', async () => {
    const results = await kg.semanticSearch('ultra marathon training', 5, mock);
    for (const r of results) {
      assert.ok(typeof r.nodeId === 'string', 'nodeId must be a string');
      assert.ok(typeof r.similarity === 'number', 'similarity must be a number');
      assert.ok(typeof r.type === 'string', 'type must be a string');
      assert.ok(r.node !== undefined, 'node must be present');
      assert.ok(typeof r.text === 'string', 'text must be a string');
      assert.ok(r.similarity >= -1 && r.similarity <= 1, `similarity out of range: ${r.similarity}`);
    }
  });

  it('semanticSearch results are sorted descending by similarity', async () => {
    const results = await kg.semanticSearch('ultra marathon training', 5, mock);
    for (let i = 1; i < results.length; i++) {
      assert.ok(
        results[i - 1].similarity >= results[i].similarity,
        `Results not sorted: ${results[i - 1].similarity} < ${results[i].similarity}`
      );
    }
  });

  it('running-related nodes rank above unrelated ones', async () => {
    const results = await kg.semanticSearch('ultra marathon training', 14, mock);
    const topIds = results.slice(0, 5).map(r => r.nodeId);
    const allIds = results.map(r => r.nodeId);

    // The ultra marathon interest node should be in top results
    const ultraIdx = allIds.findIndex(id => {
      const meta = kg._vectorIndexMeta.get(id);
      return meta?.text?.includes('ultra marathon');
    });
    assert.ok(ultraIdx < 5, `Ultra marathon node ranked ${ultraIdx}, expected in top 5`);

    console.log('\nTop 5 results for "ultra marathon training":');
    results.slice(0, 5).forEach((r, i) => {
      console.log(`  ${i + 1}. [${r.type}] "${r.text}" (similarity: ${r.similarity.toFixed(4)})`);
    });
  });

  it('semanticSearch with topK > index size returns all nodes', async () => {
    const results = await kg.semanticSearch('running marathon', 999, mock);
    assert.equal(results.length, 14, `Expected all 14 nodes`);
  });

  it('semanticSearch on empty index returns []', async () => {
    const emptyKG = new KnowledgeGraph('/tmp/empty.json');
    emptyKG.user = {
      id: 'empty', interests: [], beliefs: [], preferences: [], identities: [],
      confidence: {}, history: [], source_trust: {}, clones: []
    };
    const results = await emptyKG.semanticSearch('test query', 5, mock);
    assert.deepEqual(results, []);
  });

  it('indexNode adds a custom node directly', async () => {
    const customVec = await mock.embed('custom marathon test node');
    kg.indexNode('custom:0', customVec, { type: 'custom', node: { label: 'test' }, text: 'custom marathon test node' });
    assert.ok(kg._vectorIndex.has('custom:0'));
    assert.equal(kg._vectorIndex.get('custom:0'), customVec);
    // Clean up
    kg._vectorIndex.delete('custom:0');
    kg._vectorIndexMeta.delete('custom:0');
  });
});
