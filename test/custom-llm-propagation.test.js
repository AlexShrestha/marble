/**
 * custom-llm-propagation.test.js
 *
 * Regression tests proving that a user-supplied `llm` function passed to
 * `new Marble({ llm })` is honored throughout the learn() pipeline —
 * specifically at seedClones, L1.5 (insight swarm), and L2 (inference engine).
 *
 * Before the fix, each of these stages called `createLLMClient()` directly,
 * silently ignoring the user's function and falling back to env-based
 * provider discovery (defaulting to Anthropic).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Marble } from '../core/index.js';
import { wrapUserLLM } from '../core/llm-provider.js';
import { runInsightSwarm } from '../core/insight-swarm.js';
import { InferenceEngine } from '../core/inference-engine.js';
import { KnowledgeGraph } from '../core/kg.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function tmpKgPath() {
  const dir = mkdtempSync(join(tmpdir(), 'marble-custom-llm-'));
  return { path: join(dir, 'kg.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('wrapUserLLM adapter', () => {
  it('wraps a (prompt) => string function into an Anthropic-shape client', async () => {
    const calls = [];
    const fn = async (prompt) => {
      calls.push(prompt);
      return 'ok-response';
    };
    const client = wrapUserLLM(fn);

    assert.equal(client.provider, 'custom');
    assert.equal(typeof client.defaultModel, 'function');
    assert.equal(typeof client.messages.create, 'function');

    const resp = await client.messages.create({
      model: 'x',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hello world' }],
    });

    assert.equal(calls.length, 1, 'user function should be called exactly once');
    assert.equal(calls[0], 'hello world', 'user function should receive the user-turn content');
    assert.deepEqual(resp, { content: [{ type: 'text', text: 'ok-response' }] });
  });

  it('rejects non-function inputs', () => {
    assert.throws(() => wrapUserLLM(null), TypeError);
    assert.throws(() => wrapUserLLM({}), TypeError);
    assert.throws(() => wrapUserLLM('not a fn'), TypeError);
  });

  it('flattens multi-message conversations into a single prompt', async () => {
    let received = null;
    const client = wrapUserLLM(async (p) => { received = p; return ''; });
    await client.messages.create({
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'what time is it' },
      ],
    });
    assert.match(received, /be brief/);
    assert.match(received, /what time is it/);
  });
});

describe('learn() pipeline honors user-supplied llm', () => {
  it('calls the user llm at L1.5 and L2 instead of createLLMClient()', async () => {
    const { path, cleanup } = tmpKgPath();
    try {
      // Track every prompt the user fn receives. We intentionally return
      // non-JSON so insight-swarm parsing fails — but the call itself
      // proves our llm was threaded through rather than a real SDK client.
      const prompts = [];
      const userLLM = async (prompt) => {
        prompts.push(prompt);
        return 'no';
      };

      const marble = new Marble({ storage: path, llm: userLLM, silent: true });
      await marble.init();

      // Pre-seed a clone so learn() skips the seedClones stage
      // (we test seedClones-routing separately below).
      marble.kg.saveClone({
        id: 'test_clone_1', gap: 'x', hypothesis: 'h',
        kgOverrides: { beliefs: [], preferences: [], identities: [] },
        confidence: 0.6, evaluations: [], spawnedFrom: null, generation: 0,
        createdAt: Date.now(), lastScoredAt: Date.now(), status: 'active',
      });
      // Add some beliefs/prefs so L1.5 has material to probe
      marble.kg.user.beliefs = [{ topic: 'running', claim: 'enjoys long runs', confidence: 0.7 }];
      marble.kg.user.preferences = [{ category: 'pace', value: 'slow', strength: 0.7 }];

      const priorCount = prompts.length;
      await marble.learn();

      assert.ok(
        prompts.length > priorCount,
        `user-supplied llm should be called during learn(); got ${prompts.length} total calls`,
      );
    } finally {
      cleanup();
    }
  });

  it('routes seedClones through the user llm when no clones exist yet', async () => {
    const { path, cleanup } = tmpKgPath();
    try {
      let seedClonesPrompt = null;
      const userLLM = async (prompt) => {
        // Mark seedClones prompts by the archetype keyword it uses
        if (/archetype/i.test(prompt)) seedClonesPrompt = prompt;
        return JSON.stringify([
          { gap: 'x', hypothesis: 'h',
            kgOverrides: { beliefs: [], preferences: [], identities: [] },
            confidence: 0.5 },
        ]);
      };

      const marble = new Marble({ storage: path, llm: userLLM, silent: true });
      await marble.init();
      marble.kg.user.interests = [{ topic: 'running', weight: 0.8 }];
      marble.kg.user.preferences = [{ category: 'pace', value: 'slow', strength: 0.7 }];

      await marble.learn();

      assert.ok(
        seedClonesPrompt && seedClonesPrompt.length > 0,
        'seedClones should invoke the user llm (expected an archetype-building prompt)',
      );
    } finally {
      cleanup();
    }
  });
});

describe('runInsightSwarm honors opts.llmClient', () => {
  it('calls opts.llmClient.messages.create instead of env-based default', async () => {
    const { path, cleanup } = tmpKgPath();
    try {
      const kg = new KnowledgeGraph(path);
      await kg.load();
      kg.user.beliefs = [{ topic: 'coffee', claim: 'likes dark roast', confidence: 0.8 }];

      let called = false;
      const stubClient = {
        provider: 'stub',
        defaultModel: () => 'stub-model',
        messages: {
          create: async () => {
            called = true;
            return { content: [{ type: 'text', text: '[]' }] };
          },
        },
      };

      await runInsightSwarm(kg, { llmClient: stubClient });
      assert.ok(called, 'runInsightSwarm should invoke the supplied llmClient');
    } finally {
      cleanup();
    }
  });
});

describe('InferenceEngine forwards llmClient to L1.5', () => {
  it('passes constructor opts.llmClient down to getL2Seeds', async () => {
    const { path, cleanup } = tmpKgPath();
    try {
      const kg = new KnowledgeGraph(path);
      await kg.load();
      kg.user.beliefs = [{ topic: 'coffee', claim: 'likes dark roast', confidence: 0.8 }];

      let called = false;
      const stubClient = {
        provider: 'stub',
        defaultModel: () => 'stub-model',
        messages: {
          create: async () => {
            called = true;
            return { content: [{ type: 'text', text: '[]' }] };
          },
        },
      };

      const inference = new InferenceEngine(kg, { llmClient: stubClient });
      await inference.run();
      assert.ok(called, 'InferenceEngine should forward llmClient through to getL2Seeds');
    } finally {
      cleanup();
    }
  });
});
