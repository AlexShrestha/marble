/**
 * rich-accessors.test.js — PR 5: singular `getActiveBelief/Preference/Identity`.
 *
 * Verifies the trimmed rich-view shape consumers can filter without reaching
 * into KG internals (feedback #17).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { KnowledgeGraph } from '../core/index.js';

async function freshKG({ halfLifeDays = 365, minEffectiveStrength = 0 } = {}) {
  const kg = new KnowledgeGraph(
    join(tmpdir(), `rich-${Date.now()}-${Math.random().toString(16).slice(2, 6)}.json`),
    { decayConfig: { halfLifeDays, minEffectiveStrength } }
  );
  await kg.load();
  return kg;
}

describe('getActiveBelief — rich shape', () => {
  it('returns { value, confidence, freshness_days, evidence_count, top_sources }', async () => {
    const kg = await freshKG();
    const ep = kg.addEpisode({ id: 'e1', source: 'chat', source_date: '2023-06-01T00:00:00Z', content: 'Context.' });
    kg.addBelief('work_style', 'ships fast', 0.8, { validFrom: '2023-06-01T00:00:00Z', episodeId: ep.id });

    const view = kg.getActiveBelief('work_style');
    assert.ok(view);
    assert.equal(view.value, 'ships fast');
    assert.ok(typeof view.confidence === 'number');
    assert.ok(typeof view.freshness_days === 'number');
    assert.equal(view.evidence_count, 1);
    assert.equal(view.top_sources.length, 1);
    assert.deepEqual(view.top_sources[0], {
      id: 'e1', source: 'chat', source_date: '2023-06-01T00:00:00Z'
    });
  });

  it('returns null when no active belief matches', async () => {
    const kg = await freshKG();
    assert.equal(kg.getActiveBelief('nothing'), null);
  });

  it('honours minConfidence (effective_strength) filter', async () => {
    const kg = await freshKG();
    const veryOld = new Date(Date.now() - 10 * 365 * 86400000).toISOString();
    kg.addBelief('topic', 'claim', 0.5, { validFrom: veryOld });
    // 10 half-lives out, effective_strength ~= 0.0005 → below 0.1 filter
    assert.equal(kg.getActiveBelief('topic', { minConfidence: 0.1 }), null);
    // Below 0 filter → present
    const view = kg.getActiveBelief('topic', { minConfidence: 0 });
    assert.ok(view);
    assert.ok(view.confidence < 0.01);
  });

  it('honours maxFreshnessDays filter', async () => {
    const kg = await freshKG();
    kg.addBelief('fresh', 'claim', 0.9, { validFrom: new Date(Date.now() - 10 * 86400000).toISOString() });
    kg.addBelief('stale', 'claim', 0.9, { validFrom: new Date(Date.now() - 500 * 86400000).toISOString() });

    assert.ok(kg.getActiveBelief('fresh', { maxFreshnessDays: 30 }));
    assert.equal(kg.getActiveBelief('stale', { maxFreshnessDays: 30 }), null);
  });
});

describe('getActivePreference — rich shape', () => {
  it('with multiple entries on one type, returns the strongest by effective_strength', async () => {
    const kg = await freshKG();
    kg.addPreference('music_genre', 'jazz', 0.6, { validFrom: '2024-01-01T00:00:00Z' });
    kg.addPreference('music_genre', 'techno', 0.9, { validFrom: '2024-06-01T00:00:00Z' });

    const view = kg.getActivePreference('music_genre');
    assert.ok(view);
    // Strongest wins; values differ only by strength + age, but techno has
    // higher strength *and* is fresher, so must win.
    assert.equal(view.value, 'techno');
  });

  it('with description, targets a specific entry', async () => {
    const kg = await freshKG();
    kg.addPreference('music_genre', 'jazz', 0.6);
    kg.addPreference('music_genre', 'techno', 0.9);

    const view = kg.getActivePreference('music_genre', { description: 'jazz' });
    assert.ok(view);
    assert.equal(view.value, 'jazz');
  });
});

describe('getActiveIdentity — rich shape', () => {
  it('confidence is derived from salience when strength absent', async () => {
    const kg = await freshKG();
    kg.addIdentity('current_city', 'Barcelona', 0.9, { validFrom: new Date().toISOString() });
    const view = kg.getActiveIdentity('current_city');
    assert.ok(view);
    assert.equal(view.value, 'Barcelona');
    // Fresh identity → confidence is ~0.9 (near full salience)
    assert.ok(view.confidence > 0.89 && view.confidence <= 0.9);
  });

  it('top_sources caps at opts.topSources', async () => {
    const kg = await freshKG();
    const eps = [];
    for (let i = 0; i < 5; i++) {
      eps.push(kg.addEpisode({ id: `e${i}`, source: 'test', source_date: '2024-01-01T00:00:00Z', content: `msg ${i}` }));
    }
    // Add identity with 5 evidence ids
    kg.addIdentity('role', 'context', 0.8, { validFrom: '2024-01-01T00:00:00Z', episodeId: eps[0].id });
    // Manually extend to simulate multi-episode case
    kg.user.identities[0].evidence = eps.map(e => e.id);

    const view = kg.getActiveIdentity('role', { topSources: 2 });
    assert.equal(view.top_sources.length, 2);
    assert.equal(view.top_sources[0].id, 'e0');
  });
});
