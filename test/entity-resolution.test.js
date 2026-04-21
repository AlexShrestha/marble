/**
 * entity-resolution.test.js — PR 3 acceptance.
 *
 * Covers:
 *   - `kg.resolveEntity()` matches via exact / acronym / manual alias tiers
 *   - Creates new canonical entity when no tier matches
 *   - `addBelief({ entityId })` reinforces in place across different phrasings
 *   - Miner passes `entityId` through when `entityResolution.enabled`
 *   - Default (disabled) is a no-op — existing behaviour unchanged
 *   - Schema v2 migration adds entities: [] to older KGs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Marble, KnowledgeGraph, KG_VERSION } from '../core/index.js';

describe('kg.resolveEntity — tiered matching', () => {
  it('exact match (case-insensitive, whitespace-normalised)', async () => {
    const kg = new KnowledgeGraph(join(tmpdir(), `er-${Date.now()}-a.json`));
    await kg.load();

    const a = await kg.resolveEntity('British School Barcelona');
    const b = await kg.resolveEntity('british school barcelona');
    const c = await kg.resolveEntity('  British School Barcelona  ');
    assert.equal(a.matched_via, 'created');
    assert.equal(b.matched_via, 'exact');
    assert.equal(c.matched_via, 'exact');
    assert.equal(a.id, b.id);
    assert.equal(a.id, c.id);
  });

  it('acronym match records the novel phrasing as an alias', async () => {
    const kg = new KnowledgeGraph(join(tmpdir(), `er-${Date.now()}-b.json`));
    await kg.load();

    const full = await kg.resolveEntity('British School Barcelona');
    const acronym = await kg.resolveEntity('BSB');
    assert.equal(acronym.matched_via, 'acronym');
    assert.equal(acronym.id, full.id);

    const ent = kg.getEntity(full.id);
    assert.ok(ent.aliases.includes('BSB'), 'BSB registered as alias');

    // Second exact-case call should now hit the exact tier
    const again = await kg.resolveEntity('BSB');
    assert.equal(again.matched_via, 'exact');
  });

  it('acronym match does not fire on lowercase coincidences', async () => {
    const kg = new KnowledgeGraph(join(tmpdir(), `er-${Date.now()}-c.json`));
    await kg.load();

    const a = await kg.resolveEntity('Blue Sandy Beach');
    const b = await kg.resolveEntity('bsb');  // lowercase — should not acronym-match
    assert.notEqual(a.id, b.id, 'lowercase "bsb" is its own entity');
    assert.equal(b.matched_via, 'created');
  });

  it('registerEntityAlias creates the canonical and links the alias', async () => {
    const kg = new KnowledgeGraph(join(tmpdir(), `er-${Date.now()}-d.json`));
    await kg.load();

    const id = kg.registerEntityAlias('Barcelona', 'bcn');
    const hit = await kg.resolveEntity('bcn');
    assert.equal(hit.matched_via, 'exact');
    assert.equal(hit.id, id);
  });

  it('distinct labels with no shared structure create distinct entities', async () => {
    const kg = new KnowledgeGraph(join(tmpdir(), `er-${Date.now()}-e.json`));
    await kg.load();

    const a = await kg.resolveEntity('Google');
    const b = await kg.resolveEntity('Anthropic');
    assert.notEqual(a.id, b.id);
    assert.equal(a.matched_via, 'created');
    assert.equal(b.matched_via, 'created');
  });
});

describe('entity-aware addBelief/Preference/Identity', () => {
  it('same slot, same entity, different phrasing → in-place reinforce', async () => {
    const kg = new KnowledgeGraph(join(tmpdir(), `er-${Date.now()}-f.json`));
    await kg.load();
    const { id: entityId } = await kg.resolveEntity('British School Barcelona');
    kg.registerEntityAlias('British School Barcelona', 'BSB');

    kg.addBelief('school', 'BSB', 0.8, { entityId, validFrom: '2020-01-01T00:00:00Z' });
    kg.addBelief('school', 'British School Barcelona', 0.9, { entityId, validFrom: '2021-01-01T00:00:00Z' });

    // Should be a single active belief, reinforced to strength 0.9.
    // evidence_count bumps from 1 → 2 because the second call was recognised
    // as a restatement of the same fact via entity_id.
    const active = kg.getActiveBeliefs(null, { minEffectiveStrength: 0 });
    assert.equal(active.length, 1, 'in-place reinforce, not two rows');
    assert.equal(active[0].strength, 0.9);
    assert.equal(active[0].evidence_count, 2, 'reinforcement bumped evidence count');
  });

  it('same slot, different entity → contradiction closure', async () => {
    const kg = new KnowledgeGraph(join(tmpdir(), `er-${Date.now()}-g.json`));
    await kg.load();
    const { id: entA } = await kg.resolveEntity('Google');
    const { id: entB } = await kg.resolveEntity('Anthropic');

    kg.addBelief('current_employer', 'Google', 0.9, { entityId: entA, validFrom: '2020-01-01T00:00:00Z' });
    kg.addBelief('current_employer', 'Anthropic', 0.9, { entityId: entB, validFrom: '2024-01-01T00:00:00Z' });

    const history = kg.getFactHistory('belief', 'current_employer');
    assert.equal(history.length, 2);
    assert.equal(history[0].valid_to, '2024-01-01T00:00:00Z', 'old employer closed');
    assert.equal(history[1].valid_to, null);
  });
});

describe('Marble miner pipeline integration', () => {
  it('disabled (default) → no entity_id on facts', async () => {
    const storage = join(tmpdir(), `er-${Date.now()}-h.json`);
    const marble = new Marble({
      storage,
      llm: async () => JSON.stringify([
        { type: 'belief', value: 'BSB', confidence: 0.9, topic: 'school' },
      ]),
      silent: true,
    });
    await marble.init();

    await marble.ingestEpisodes([
      { id: 'ep1', source: 'test', source_date: '2024-01-01T00:00:00Z', content: 'Her school is BSB.' },
    ], { runInference: false });

    const b = marble.kg.user.beliefs[0];
    assert.equal(b.entity_id, undefined, 'no entity_id when disabled');
    assert.equal(marble.kg.user.entities.length, 0, 'no entities created');

    await unlink(storage).catch(() => {});
  });

  it('enabled → facts carry entity_id and aliases cluster', async () => {
    const storage = join(tmpdir(), `er-${Date.now()}-i.json`);
    const responses = [
      JSON.stringify([{ type: 'belief', value: 'British School Barcelona', confidence: 0.9, topic: 'school' }]),
      JSON.stringify([{ type: 'belief', value: 'BSB', confidence: 0.9, topic: 'school' }]),
    ];
    let i = 0;
    const marble = new Marble({
      storage,
      llm: async () => responses[i++] ?? '[]',
      silent: true,
      entityResolution: { enabled: true, threshold: 0.85 },
    });
    await marble.init();

    const s1 = await marble.ingestEpisodes([
      { id: 'ep1', source: 'test', source_date: '2023-01-01T00:00:00Z', content: 'Her school is British School Barcelona.' },
    ], { runInference: false });
    assert.equal(s1.entities_resolved, 1);

    const s2 = await marble.ingestEpisodes([
      { id: 'ep2', source: 'test', source_date: '2024-01-01T00:00:00Z', content: 'Her school is BSB.' },
    ], { runInference: false });
    assert.equal(s2.entities_resolved, 1);

    // One entity, two aliases (well, one canonical + one alias)
    assert.equal(marble.kg.user.entities.length, 1);
    const ent = marble.kg.user.entities[0];
    assert.equal(ent.canonical, 'British School Barcelona');
    assert.ok(ent.aliases.includes('BSB'));

    // One active belief — second ingest reinforced in place
    const active = marble.kg.getActiveBeliefs(null, { minEffectiveStrength: 0 });
    assert.equal(active.length, 1);
    assert.equal(active[0].entity_id, ent.id);

    await unlink(storage).catch(() => {});
  });
});

describe('schema migration', () => {
  it('loads an older v1 KG and adds entities: []', async () => {
    const path = join(tmpdir(), `er-${Date.now()}-j.json`);
    const legacy = {
      version: 1,
      user: {
        id: 'legacy',
        interests: [], context: {}, history: [], source_trust: {},
        beliefs: [], preferences: [], identities: [],
        confidence: {}, clones: [], episodes: [],
        // no entities field — simulating a pre-PR-3 KG
      },
      _dimensionalPreferences: [],
      updated_at: '2025-01-01T00:00:00Z',
    };
    await writeFile(path, JSON.stringify(legacy));

    const kg = new KnowledgeGraph(path);
    await kg.load();
    assert.equal(kg.version, KG_VERSION);
    assert.ok(Array.isArray(kg.user.entities));
    assert.equal(kg.user.entities.length, 0);

    await unlink(path).catch(() => {});
  });
});
