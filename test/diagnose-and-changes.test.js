/**
 * diagnose-and-changes.test.js — PR 2 acceptance.
 *
 * Covers:
 *   - `marble.diagnose()` returns a usable health summary
 *   - `learn()` returns a `changes` object with add/invalidate counts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Marble, KG_VERSION } from '../core/index.js';

function mockLLM(responses = []) {
  let i = 0;
  return async () => responses[i++] ?? '[]';
}

describe('marble.diagnose()', () => {
  it('summarises empty KG before any work', async () => {
    const storage = join(tmpdir(), `marble-diag-${Date.now()}-a.json`);
    const marble = new Marble({ storage, llm: mockLLM(), silent: true });
    await marble.init();

    const report = marble.diagnose();
    assert.equal(report.version, KG_VERSION);
    assert.deepEqual(report.facts.beliefs, {
      total: 0, active: 0, invalidated: 0, with_evidence: 0, with_valid_from: 0,
    });
    assert.equal(report.episodes.total, 0);
    assert.equal(report.clones.total, 0);
    assert.equal(report.last_learn_at, null);
    assert.equal(report.days_since_last_learn, null);

    await unlink(storage).catch(() => {});
  });

  it('reports provenance coverage after ingestion', async () => {
    const storage = join(tmpdir(), `marble-diag-${Date.now()}-b.json`);
    const marble = new Marble({
      storage,
      llm: mockLLM([
        JSON.stringify([
          { type: 'belief', value: 'User likes hiking', confidence: 0.8, topic: 'outdoors' },
          { type: 'preference', value: 'Prefers morning workouts', confidence: 0.85, topic: 'schedule' },
        ]),
      ]),
      silent: true,
    });
    await marble.init();

    await marble.ingestEpisodes([
      { id: 'ep1', source: 'journal', source_date: '2024-06-01T00:00:00Z', content: 'I hike every weekend and love morning workouts.' },
    ], { runInference: false });

    const report = marble.diagnose();
    assert.equal(report.episodes.total, 1);
    assert.ok(report.facts.beliefs.total >= 1);
    assert.ok(report.facts.preferences.total >= 1);
    // All ingested facts should have provenance and validity
    assert.equal(report.facts.beliefs.with_evidence, report.facts.beliefs.total);
    assert.equal(report.facts.beliefs.with_valid_from, report.facts.beliefs.total);
    assert.equal(report.facts.preferences.with_evidence, report.facts.preferences.total);

    await unlink(storage).catch(() => {});
  });

  it('counts stale facts below threshold correctly', async () => {
    const storage = join(tmpdir(), `marble-diag-${Date.now()}-c.json`);
    const marble = new Marble({
      storage,
      llm: mockLLM(),
      silent: true,
      decayConfig: { halfLifeDays: 365, minEffectiveStrength: 0.4 },
    });
    await marble.init();

    const fresh = new Date(Date.now() - 10 * 86400000).toISOString();
    const old = new Date(Date.now() - 5 * 365 * 86400000).toISOString();
    marble.kg.addBelief('topic1', 'fresh', 0.8, { validFrom: fresh });
    marble.kg.addBelief('topic2', 'old', 0.5, { validFrom: old });

    const report = marble.diagnose();
    assert.equal(report.decay.threshold, 0.4);
    assert.equal(report.decay.half_life_days, 365);
    // topic2 at 5 half-lives decays to ~0.015 → below 0.4
    assert.equal(report.decay.below_threshold, 1);

    await unlink(storage).catch(() => {});
  });
});

describe('learn() reports changes', () => {
  it('returns a changes object with per-type deltas', async () => {
    const storage = join(tmpdir(), `marble-changes-${Date.now()}-a.json`);
    // LLM can fail — we only need the shape to be present.
    const marble = new Marble({
      storage,
      llm: async () => '[]', // intentionally empty so no stage produces output
      silent: true,
    });
    await marble.init();

    // Pre-seed some facts so counts aren't zero.
    marble.kg.addBelief('t', 'claim', 0.8);
    marble.kg.addPreference('t', 'desc', 0.7);

    const result = await marble.learn();
    assert.ok(result.changes, 'changes object present');
    for (const key of [
      'beliefs_added', 'beliefs_invalidated',
      'preferences_added', 'preferences_invalidated',
      'identities_added', 'identities_invalidated',
      'clones_seeded', 'clones_bred', 'clones_killed',
      'insights_generated', 'candidates_generated',
    ]) {
      assert.equal(typeof result.changes[key], 'number', `changes.${key} is a number`);
      assert.ok(result.changes[key] >= 0, `changes.${key} is non-negative`);
    }

    // learn() stamps a last-run timestamp
    const report = marble.diagnose();
    assert.ok(report.last_learn_at, 'last_learn_at is set after learn()');
    assert.ok(report.days_since_last_learn < 1, 'days_since_last_learn is small');

    await unlink(storage).catch(() => {});
  });
});
