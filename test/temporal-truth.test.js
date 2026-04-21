/**
 * temporal-truth.test.js — PR 1 acceptance: episodes, source timestamps,
 * reconciliation, and read-time decay.
 *
 * Covers the four changes of "Temporal truth v1":
 *   1. `valid_from` stamped with source date, not extraction date
 *   2. Episodes are first-class and facts carry `evidence: [episode_id]`
 *   3. Reconciliation closes superseded facts on single-cardinality slots
 *   4. `getActiveX()` computes `effective_strength` + `age_days`, filters by
 *      threshold, and historical queries still return old facts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Marble, KnowledgeGraph, KG_VERSION } from '../core/index.js';

function mockLLMWithResponses(responses) {
  let i = 0;
  return async () => responses[i++] ?? '[]';
}

describe('episodes + source timestamps', () => {
  it('KnowledgeGraph.addEpisode stores and dedups by content hash', async () => {
    const kg = new KnowledgeGraph(join(tmpdir(), `marble-temporal-${Date.now()}-a.json`));
    await kg.load();

    const a = kg.addEpisode({ source: 'test', source_date: '2022-01-01T00:00:00Z', content: 'Hello world' });
    const b = kg.addEpisode({ source: 'test', source_date: '2022-01-01T00:00:00Z', content: 'Hello world' });
    assert.equal(a.id, b.id, 'same content → dedup returns same record');
    assert.equal(kg.user.episodes.length, 1);
    assert.equal(kg.version, KG_VERSION);
  });

  it('addBelief({ validFrom, episodeId }) threads source time + provenance', async () => {
    const kg = new KnowledgeGraph(join(tmpdir(), `marble-temporal-${Date.now()}-b.json`));
    await kg.load();

    const ep = kg.addEpisode({ source: 'test', source_date: '2020-06-01T00:00:00Z', content: 'Source material' });
    kg.addBelief('work', 'loves ai', 0.8, { validFrom: '2020-06-01T00:00:00Z', episodeId: ep.id });

    const b = kg.getActiveBeliefs()[0];
    assert.equal(b.valid_from, '2020-06-01T00:00:00Z', 'valid_from is the source date');
    assert.deepEqual(b.evidence, [ep.id], 'evidence points back to episode');

    const prov = kg.getFactProvenance(b);
    assert.equal(prov.length, 1);
    assert.equal(prov[0].id, ep.id);
  });

  it('contradiction closure uses source date, not wall-clock', async () => {
    const kg = new KnowledgeGraph(join(tmpdir(), `marble-temporal-${Date.now()}-c.json`));
    await kg.load();

    kg.addBelief('role', 'engineer', 0.9, { validFrom: '2019-01-01T00:00:00Z' });
    kg.addBelief('role', 'founder', 0.9, { validFrom: '2023-01-01T00:00:00Z' });

    const history = kg.getFactHistory('belief', 'role');
    assert.equal(history.length, 2);
    assert.equal(history[0].valid_to, '2023-01-01T00:00:00Z',
      'old fact is closed at the new fact\'s source date, not now()');
  });
});

describe('ingestEpisodes end-to-end', () => {
  it('creates episodes, stamps valid_from, links evidence', async () => {
    const storage = join(tmpdir(), `marble-temporal-${Date.now()}-d.json`);
    const marble = new Marble({
      storage,
      llm: mockLLMWithResponses([
        JSON.stringify([{ type: 'belief', value: 'User journals daily', confidence: 0.9, topic: 'habit_journal' }]),
        JSON.stringify([{ type: 'identity', value: 'Lives in Barcelona', confidence: 0.95, topic: 'current_city' }]),
      ]),
      silent: true,
    });
    await marble.init();

    const stats = await marble.ingestEpisodes([
      { id: 'ep-a', source: 'journal', source_date: '2023-03-15T00:00:00Z', content: 'I journal every evening.' },
      { id: 'ep-b', source: 'notes', source_date: '2024-07-01T00:00:00Z', content: 'Life in Barcelona is good.' },
    ], { runInference: false });

    assert.equal(stats.episodes, 2);
    assert.equal(stats.ingested, 2);

    const b = marble.kg.getActiveBeliefs().find(x => x.topic === 'habit_journal');
    assert.ok(b);
    assert.equal(b.valid_from, '2023-03-15T00:00:00Z');
    assert.deepEqual(b.evidence, ['ep-a']);

    const i = marble.kg.getActiveIdentities().find(x => x.role === 'current_city');
    assert.ok(i);
    assert.equal(i.valid_from, '2024-07-01T00:00:00Z');
    assert.deepEqual(i.evidence, ['ep-b']);

    await unlink(storage).catch(() => {});
  });
});

describe('reconciliation on single-cardinality slots', () => {
  it('collapses multiple active preferences on a one-cardinality slot', async () => {
    const kg = new KnowledgeGraph(join(tmpdir(), `marble-temporal-${Date.now()}-e.json`));
    await kg.load();

    kg.addPreference('primary_diet', 'vegetarian', 0.9, { validFrom: '2020-01-01T00:00:00Z' });
    kg.addPreference('primary_diet', 'omnivore', 0.9, { validFrom: '2024-01-01T00:00:00Z' });
    // Before reconcile: both active (preferences don't auto-close on same type + different description).
    assert.equal(kg.getActivePreferences().length, 2);

    const result = kg.reconcile({ preferences: { primary_diet: 'one' } });
    assert.equal(result.preferences_invalidated, 1);
    assert.equal(kg.getActivePreferences().length, 1);
    const surviving = kg.getActivePreferences()[0];
    assert.equal(surviving.description, 'omnivore');
  });

  it('respects asOf for historical queries after reconcile', async () => {
    const kg = new KnowledgeGraph(join(tmpdir(), `marble-temporal-${Date.now()}-f.json`));
    await kg.load();

    kg.addIdentity('current_city', 'Barcelona', 0.9, { validFrom: '2019-01-01T00:00:00Z' });
    kg.addIdentity('current_city', 'Lisbon', 0.9, { validFrom: '2024-01-01T00:00:00Z' });
    kg.reconcile({ identities: { current_city: 'one' } });

    const nowActive = kg.getActiveIdentities();
    assert.equal(nowActive.length, 1);
    assert.equal(nowActive[0].context, 'Lisbon');

    const at2020 = kg.getActiveIdentities('2020-06-01T00:00:00Z');
    assert.equal(at2020.length, 1);
    assert.equal(at2020[0].context, 'Barcelona',
      'historical query still finds the old fact');
  });
});

describe('temporal decay at read time', () => {
  it('computes effective_strength and age_days without mutating facts', async () => {
    const kg = new KnowledgeGraph(
      join(tmpdir(), `marble-temporal-${Date.now()}-g.json`),
      { decayConfig: { halfLifeDays: 365, minEffectiveStrength: 0 } }
    );
    await kg.load();

    const oneYearAgo = new Date(Date.now() - 365 * 86400000).toISOString();
    kg.addBelief('opinion', 'claim', 0.8, { validFrom: oneYearAgo });

    const active = kg.getActiveBeliefs();
    assert.equal(active.length, 1);
    assert.ok(active[0].age_days >= 364 && active[0].age_days <= 366);
    // One half-life → effective strength ~= 0.4
    assert.ok(Math.abs(active[0].effective_strength - 0.4) < 0.01);

    // Underlying stored fact is not mutated
    const stored = kg.user.beliefs[0];
    assert.equal(stored.effective_strength, undefined);
    assert.equal(stored.strength, 0.8);
  });

  it('filters below threshold; historical query still returns', async () => {
    const kg = new KnowledgeGraph(
      join(tmpdir(), `marble-temporal-${Date.now()}-h.json`),
      { decayConfig: { halfLifeDays: 365, minEffectiveStrength: 0.1 } }
    );
    await kg.load();

    const fiveYearsAgo = new Date(Date.now() - 5 * 365 * 86400000).toISOString();
    kg.addBelief('old', 'claim', 0.5, { validFrom: fiveYearsAgo });
    // 5 half-lives: 0.5 * 2^-5 = 0.015625 < 0.1 threshold
    assert.equal(kg.getActiveBeliefs().length, 0, 'stale fact filtered out at default threshold');

    // Overriding threshold returns it
    const withZero = kg.getActiveBeliefs(null, { minEffectiveStrength: 0 });
    assert.equal(withZero.length, 1);

    // Historical query at creation time: effective strength is full
    const atCreation = kg.getActiveBeliefs(fiveYearsAgo, { minEffectiveStrength: 0 });
    assert.equal(atCreation.length, 1);
    assert.ok(atCreation[0].effective_strength >= 0.49);
  });
});
