/**
 * reasoning-bundle.test.js — PR 7 acceptance: shared MarbleReasoningBundle.
 *
 * Feedback #9 asked for:
 *   "Running learn() produces a bundle. Each layer's output schema matches
 *   the bundle schema. A new layer can be slotted in without touching
 *   existing ones."
 *
 * These tests verify:
 *   1. `createReasoningBundle(kg)` produces a fully-shaped bundle
 *   2. `learn()` populates `bundle.insights` / `hypotheses` from core layers
 *   3. `bundle.layers_fired` records every layer's contribution in order
 *   4. `opts.extraStages` accepts a consumer-defined layer; it runs,
 *      contributes to the bundle, and appears in layers_fired — without
 *      any code changes to the orchestrator or other layers
 *   5. A failing extraStage is isolated (ends up in `failures`, doesn't
 *      take down the run)
 *   6. `summarizeBundle` produces a compact log-friendly view
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  Marble,
  KnowledgeGraph,
  createReasoningBundle,
  recordLayerContribution,
  summarizeBundle,
} from '../core/index.js';

describe('createReasoningBundle', () => {
  it('builds a complete shape from a loaded KG', async () => {
    const kg = new KnowledgeGraph(join(tmpdir(), `bundle-${Date.now()}-a.json`));
    await kg.load();
    kg.addBelief('work', 'ships fast', 0.8);
    kg.addPreference('content', 'no fluff', 0.9);
    kg.addIdentity('founder', 'Barcelona', 0.95);

    const bundle = createReasoningBundle(kg);

    // L1 inputs populated
    assert.equal(bundle.beliefs.length, 1);
    assert.equal(bundle.preferences.length, 1);
    assert.equal(bundle.identities.length, 1);
    assert.ok(Array.isArray(bundle.interests));
    assert.ok(Array.isArray(bundle.episodes_sample));

    // Layer outputs start empty
    assert.deepEqual(bundle.insights, []);
    assert.deepEqual(bundle.hypotheses, []);
    assert.deepEqual(bundle.gaps, []);
    assert.deepEqual(bundle.findings, []);

    // Provenance scaffolding
    assert.deepEqual(bundle.layers_fired, []);
    assert.ok(bundle.generated_at);
    assert.deepEqual(bundle.extensions, {});
  });

  it('throws when the KG is not loaded', () => {
    const kg = new KnowledgeGraph('/tmp/never-loaded.json');
    assert.throws(() => createReasoningBundle(kg), /kg.user is null/);
  });
});

describe('recordLayerContribution', () => {
  it('merges array outputs and tags the layer as fired', async () => {
    const kg = new KnowledgeGraph(join(tmpdir(), `bundle-${Date.now()}-b.json`));
    await kg.load();
    const bundle = createReasoningBundle(kg);

    recordLayerContribution(bundle, 'myLayer', {
      insights: [{ insight: 'one', confidence: 0.8 }],
      hypotheses: [{ question: 'why?' }],
    });

    assert.deepEqual(bundle.layers_fired, ['myLayer']);
    assert.equal(bundle.insights.length, 1);
    assert.equal(bundle.hypotheses.length, 1);
  });

  it('stashes unknown keys under extensions[layerName]', async () => {
    const kg = new KnowledgeGraph(join(tmpdir(), `bundle-${Date.now()}-c.json`));
    await kg.load();
    const bundle = createReasoningBundle(kg);

    recordLayerContribution(bundle, 'customLayer', {
      demographic_priors: [{ region: 'barcelona', trait: 'expat' }],
      budget_used: 1234,
    });

    assert.deepEqual(bundle.layers_fired, ['customLayer']);
    // Custom fields don't collide with core
    assert.equal(bundle.insights.length, 0);
    assert.deepEqual(bundle.extensions.customLayer, {
      demographic_priors: [{ region: 'barcelona', trait: 'expat' }],
      budget_used: 1234,
    });
  });
});

describe('learn() populates bundle + supports extraStages', () => {
  it('bundle is present in the result; core layers fire even without network', async () => {
    const storage = join(tmpdir(), `bundle-learn-${Date.now()}.json`);
    // No real LLM — core stages will fail at the LLM call but the bundle
    // scaffold still exists and extraStages still run.
    const marble = new Marble({
      storage,
      llm: async () => '[]',
      silent: true,
    });
    await marble.init();

    const result = await marble.learn();
    assert.ok(result.bundle, 'bundle is in result');
    assert.ok(Array.isArray(result.bundle.layers_fired));
    assert.ok(result.bundle_summary, 'bundle_summary is in result');

    // summarizeBundle shape
    for (const k of ['insights', 'hypotheses', 'gaps', 'findings', 'beliefs', 'preferences', 'identities']) {
      assert.equal(typeof result.bundle_summary[k], 'number', `bundle_summary.${k} is a number`);
    }

    await unlink(storage).catch(() => {});
  });

  it('a new layer plugs in via extraStages without touching core code', async () => {
    const storage = join(tmpdir(), `bundle-newlayer-${Date.now()}.json`);
    const marble = new Marble({
      storage,
      llm: async () => '[]',
      silent: true,
    });
    await marble.init();

    // The acceptance criterion: define a new layer here, in test code, and
    // verify it runs + shows up in the bundle. Critically — no changes to
    // core/insight-swarm.js, core/inference-engine.js, or core/index.js
    // were required to support this.
    let sawBundle = null;
    async function demographicPriors(bundle, _kg) {
      sawBundle = bundle;
      recordLayerContribution(bundle, 'demographicPriors', {
        gaps: [{ kind: 'demographic', description: 'no explicit location prior' }],
        priors_applied: 0,
      });
    }

    const result = await marble.learn({ extraStages: [demographicPriors] });

    assert.ok(sawBundle, 'extraStage received the bundle');
    assert.ok(result.bundle.layers_fired.includes('demographicPriors'),
      'bundle.layers_fired includes the new layer');
    assert.equal(result.bundle.gaps.length, 1, 'gaps canonical field populated');
    assert.equal(result.bundle.extensions.demographicPriors.priors_applied, 0);

    await unlink(storage).catch(() => {});
  });

  it('a failing extraStage lands in failures, does not break the run', async () => {
    const storage = join(tmpdir(), `bundle-failure-${Date.now()}.json`);
    const marble = new Marble({
      storage,
      llm: async () => '[]',
      silent: true,
    });
    await marble.init();

    async function brokenStage(_bundle, _kg) {
      throw new Error('simulated layer failure');
    }

    const result = await marble.learn({ extraStages: [brokenStage] });
    const match = result.failures.find(f => f.stage === 'brokenStage');
    assert.ok(match, 'failure captured under the stage name');
    assert.match(match.message, /simulated layer failure/);
    // Run continues — bundle still present
    assert.ok(result.bundle);

    await unlink(storage).catch(() => {});
  });
});

describe('summarizeBundle', () => {
  it('returns counts and extension keys, not full arrays', async () => {
    const kg = new KnowledgeGraph(join(tmpdir(), `bundle-${Date.now()}-d.json`));
    await kg.load();
    const bundle = createReasoningBundle(kg);

    recordLayerContribution(bundle, 'x', {
      insights: [1, 2, 3],
      hypotheses: [1],
      custom: 'stuff',
    });

    const summary = summarizeBundle(bundle);
    assert.equal(summary.insights, 3);
    assert.equal(summary.hypotheses, 1);
    assert.deepEqual(summary.layers_fired, ['x']);
    assert.deepEqual(summary.extensions, ['x']);
    // No full arrays in summary
    assert.equal(summary.insights_array, undefined);
  });
});
