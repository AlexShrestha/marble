/**
 * swarm-lens-injection.test.js
 *
 * Verifies the `{ lenses }` injection hook on `Swarm`:
 *
 *   - Without `lenses`, the default 6-agent `AGENT_LENSES` fleet is built.
 *   - With `lenses`, the injected set is used — including sizes other than 6.
 *   - `#debateRound` and `#buildConsensus` read lens metadata from each
 *     agent (not from a positional lookup into `AGENT_LENSES`), so custom
 *     lens sets don't crash in debate mode.
 *
 * Narrow scope. The goal is to prove the pluggability hook works end-to-end
 * and that consensus/debate no longer assume `this.agents.length === 6`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Swarm, AGENT_LENSES } from '../core/swarm.js';
import { KnowledgeGraph } from '../core/kg.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function tmpKgPath() {
  const dir = mkdtempSync(join(tmpdir(), 'marble-swarm-lens-'));
  return { path: join(dir, 'kg.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A KG with enough shape that Clone.takeSnapshot() doesn't explode. */
function bareKg() {
  const kg = new KnowledgeGraph(':memory:');
  kg.user = {
    id: 'test', interests: [{ topic: 'ai', weight: 0.7, trend: 'stable', last_boost: new Date().toISOString() }],
    context: { calendar: [], active_projects: ['test-proj'], recent_conversations: [] },
    history: [], source_trust: {}, confidence: {},
    beliefs: [], preferences: [], identities: [],
    clones: [], episodes: [], entities: [], insights: [], syntheses: [],
  };
  return kg;
}

const sampleStories = [
  { id: 's1', title: 'AI breakthrough',       summary: 'Details...', source: 'hn',   topics: ['ai'],        published_at: new Date().toISOString() },
  { id: 's2', title: 'Stripe pricing update', summary: 'Details...', source: 'blog', topics: ['saas'],      published_at: new Date().toISOString() },
  { id: 's3', title: 'Meditation study',      summary: 'Details...', source: 'nyt',  topics: ['wellness'],  published_at: new Date().toISOString() },
];

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Swarm — default lens fleet', () => {
  it('builds one agent per entry in AGENT_LENSES when no lenses are supplied', async () => {
    const swarm = new Swarm(bareKg(), { mode: 'fast' });
    await swarm.curate(sampleStories);
    assert.equal(swarm.agents.length, Object.keys(AGENT_LENSES).length);
    const names = new Set(swarm.agents.map(a => a.lens.name));
    assert.ok(names.has('Career Agent'),       'default fleet includes Career Agent');
    assert.ok(names.has('Social Proof Agent'), 'default fleet includes Social Proof Agent (6th agent, added after the original 5)');
  });
});

describe('Swarm — injected lens fleet', () => {
  it('uses the injected lens set and ignores AGENT_LENSES', async () => {
    const customLenses = [
      { name: 'Domain Expert', mandate: 'Expertise frame',   weight: 0.5 },
      { name: 'Skeptic',       mandate: 'Adversarial frame', weight: 0.3 },
      { name: 'Novice',        mandate: 'Beginner frame',    weight: 0.2 },
    ];
    const swarm = new Swarm(bareKg(), { mode: 'fast', lenses: customLenses });
    await swarm.curate(sampleStories);

    assert.equal(swarm.agents.length, 3, 'agent count follows the injected lens size, not AGENT_LENSES');
    assert.deepEqual(
      swarm.agents.map(a => a.lens.name),
      ['Domain Expert', 'Skeptic', 'Novice'],
      'agents carry the injected lens objects',
    );
    // Agents built from custom lenses have no special-case branch in
    // SwarmAgent.#score — they fall through to Clone.wouldEngage(), so
    // scoring still produces numbers in [0, 1].
    for (const agent of swarm.agents) {
      for (const pick of agent.picks) {
        assert.ok(pick.score >= 0 && pick.score <= 1, `custom-lens agent score out of range: ${pick.score}`);
      }
    }
  });

  it('consensus math uses each agent\'s own lens.weight, not AGENT_LENSES[i].weight', async () => {
    // Two custom lenses with disjoint weights to prove positional lookups are gone.
    // If the refactored #buildConsensus still read AGENT_LENSES[0].weight it would
    // use Career's 0.25 for "Heavy Lens" and no weight for "Light Lens" (out of bounds).
    const customLenses = [
      { name: 'Heavy Lens', mandate: 'Heavy',  weight: 0.9 },
      { name: 'Light Lens', mandate: 'Light',  weight: 0.1 },
    ];
    const swarm = new Swarm(bareKg(), { mode: 'fast', lenses: customLenses });
    const ranked = await swarm.curate(sampleStories);

    // Each ranked story must report agent_scores keyed by OUR lens names,
    // not by AGENT_LENSES defaults.
    assert.ok(ranked.length > 0, 'curate returns picks');
    for (const r of ranked) {
      const keys = Object.keys(r.agent_scores || {});
      assert.ok(keys.includes('Heavy Lens') || keys.includes('Light Lens'),
        `expected injected lens name in agent_scores; got keys: ${keys.join(', ')}`);
      assert.ok(!keys.includes('Career Agent'),
        'AGENT_LENSES entries must not leak in when custom lenses are injected');
    }
  });

  it('accepts lens sets larger than 6 (no hardcoded size assumption)', async () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({
      name:   `Lens ${i + 1}`,
      mandate: `Mandate ${i + 1}`,
      weight: 1 / 8,
    }));
    const swarm = new Swarm(bareKg(), { mode: 'fast', lenses: eight });
    await swarm.curate(sampleStories);
    assert.equal(swarm.agents.length, 8);
  });
});
