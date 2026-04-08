/**
 * conversation-miner.test.js
 *
 * Tests ConversationMiner.ingest() returns >= 3 typed KG nodes
 * from sample chat exports without requiring a live LLM API key.
 * Uses a mock llmCall that returns a fixed extraction JSON.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConversationMiner } from '../core/conversation-miner.js';

// ─── MOCK LLM CALL ────────────────────────────────────────────────────────────

/**
 * Returns a fixed extraction response simulating an LLM extracting nodes
 * from the user messages in the sample chat export.
 */
function mockLLMCall(prompt) {
  // Verify the prompt contains user messages (sanity check)
  assert.ok(prompt.includes('[USER]:'), 'Prompt should contain user messages');

  return Promise.resolve(JSON.stringify([
    {
      type: 'identity',
      value: 'User identifies as a software engineer who builds AI products',
      confidence: 0.9,
      topic: 'profession'
    },
    {
      type: 'belief',
      value: 'User believes that shipping fast and learning from real users is the best way to build products',
      confidence: 0.85,
      topic: 'product_philosophy'
    },
    {
      type: 'preference',
      value: 'User prefers TypeScript over JavaScript for large codebases',
      confidence: 0.8,
      topic: 'programming_language'
    },
    {
      type: 'identity',
      value: 'User is currently building a personalization engine for content curation',
      confidence: 0.9,
      topic: 'active_project'
    },
    {
      type: 'preference',
      value: 'User prefers concise, direct communication without unnecessary filler',
      confidence: 0.75,
      topic: 'communication_style'
    }
  ]));
}

// ─── SAMPLE CHAT EXPORTS ──────────────────────────────────────────────────────

const GENERIC_EXPORT = {
  messages: [
    {
      role: 'user',
      content: "I'm a software engineer building an AI personalization engine. I believe shipping fast and learning from real users is the best approach."
    },
    {
      role: 'assistant',
      content: 'That sounds like a solid product philosophy. What stack are you using?'
    },
    {
      role: 'user',
      content: 'TypeScript for most things — I find it catches too many bugs early for large codebases. The engine itself is in Node.js.'
    },
    {
      role: 'assistant',
      content: 'Typescript is indeed great for type safety at scale.'
    },
    {
      role: 'user',
      content: 'Yeah. I also prefer people to be direct with me — no fluff, just get to the point.'
    }
  ]
};

const CLAUDE_EXPORT = {
  conversations: [
    {
      name: 'Building Marble',
      chat_messages: [
        {
          sender: 'human',
          text: "I'm building a content curation engine called Marble. It personalizes articles for each user."
        },
        {
          sender: 'assistant',
          text: 'Interesting! How does it determine what content to surface?'
        },
        {
          sender: 'human',
          text: 'We model the user as a knowledge graph of beliefs, preferences and identities, then score stories against that model.'
        }
      ]
    }
  ]
};

const CHATGPT_EXPORT = {
  conversations: [
    {
      title: 'Tech discussion',
      mapping: {
        'msg-1': {
          message: {
            role: 'user',
            content: {
              parts: ['I prefer React over Vue for frontend work. The ecosystem is just better.']
            }
          }
        },
        'msg-2': {
          message: {
            role: 'assistant',
            content: {
              parts: ['Both have their merits. What kind of projects do you typically build?']
            }
          }
        },
        'msg-3': {
          message: {
            role: 'user',
            content: {
              parts: ['Mostly SaaS products. I am a founder — I wear many hats.']
            }
          }
        }
      }
    }
  ]
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

async function writeTmp(data) {
  const path = join(tmpdir(), `miner-test-${Date.now()}.json`);
  await writeFile(path, JSON.stringify(data));
  return path;
}

// ─── TESTS ────────────────────────────────────────────────────────────────────

describe('ConversationMiner', () => {
  it('ingest() returns >= 3 valid KG nodes from a generic chat export', async () => {
    const path = await writeTmp(GENERIC_EXPORT);
    try {
      const miner = new ConversationMiner(mockLLMCall);
      const nodes = await miner.ingest(path);

      assert.ok(nodes.length >= 3, `Expected >= 3 nodes, got ${nodes.length}`);

      for (const node of nodes) {
        assert.ok(['belief', 'preference', 'identity'].includes(node.type),
          `Invalid node type: ${node.type}`);
        assert.ok(typeof node.value === 'string' && node.value.length > 0,
          'Node value must be non-empty string');
        assert.ok(typeof node.confidence === 'number',
          'Node confidence must be a number');
        assert.ok(node.confidence >= 0 && node.confidence <= 1,
          `Confidence out of range: ${node.confidence}`);
        assert.ok(typeof node.topic === 'string' && node.topic.length > 0,
          'Node topic must be non-empty string');
      }
    } finally {
      await unlink(path).catch(() => {});
    }
  });

  it('ingest() parses Claude export format', async () => {
    const path = await writeTmp(CLAUDE_EXPORT);
    try {
      const miner = new ConversationMiner(mockLLMCall);
      const nodes = await miner.ingest(path);
      assert.ok(nodes.length >= 3, `Expected >= 3 nodes from Claude format, got ${nodes.length}`);
    } finally {
      await unlink(path).catch(() => {});
    }
  });

  it('ingest() parses ChatGPT mapping export format', async () => {
    const path = await writeTmp(CHATGPT_EXPORT);
    try {
      const miner = new ConversationMiner(mockLLMCall);
      const nodes = await miner.ingest(path);
      assert.ok(nodes.length >= 3, `Expected >= 3 nodes from ChatGPT format, got ${nodes.length}`);
    } finally {
      await unlink(path).catch(() => {});
    }
  });

  it('nodes have correct types (belief | preference | identity)', async () => {
    const path = await writeTmp(GENERIC_EXPORT);
    try {
      const miner = new ConversationMiner(mockLLMCall);
      const nodes = await miner.ingest(path);

      const types = new Set(nodes.map(n => n.type));
      // Should have all three types from our mock response
      assert.ok(types.has('belief'), 'Should have at least one belief node');
      assert.ok(types.has('preference'), 'Should have at least one preference node');
      assert.ok(types.has('identity'), 'Should have at least one identity node');
    } finally {
      await unlink(path).catch(() => {});
    }
  });

  it('asDataSource() returns a searchable data source function', async () => {
    const path = await writeTmp(GENERIC_EXPORT);
    try {
      const miner = new ConversationMiner(mockLLMCall);
      const searchFn = miner.asDataSource(path);

      assert.equal(typeof searchFn, 'function', 'asDataSource should return a function');

      const results = await searchFn('TypeScript');
      assert.ok(Array.isArray(results), 'Search results should be an array');
      assert.ok(results.length > 0, 'Should find TypeScript-related nodes');
      assert.ok(results[0].includes('[preference|'), 'Results should be formatted strings');
    } finally {
      await unlink(path).catch(() => {});
    }
  });

  it('asDataSource() caches nodes across calls', async () => {
    const path = await writeTmp(GENERIC_EXPORT);
    let callCount = 0;
    const countingLLMCall = (prompt) => {
      callCount++;
      return mockLLMCall(prompt);
    };

    try {
      const miner = new ConversationMiner(countingLLMCall);
      const searchFn = miner.asDataSource(path);

      await searchFn('engineer');
      const firstCallCount = callCount;
      await searchFn('belief');
      // Second call should not trigger new LLM calls
      assert.equal(callCount, firstCallCount, 'Cached nodes should not require new LLM calls');
    } finally {
      await unlink(path).catch(() => {});
    }
  });

  it('ingest() handles LLM failure gracefully and still returns nodes from other chunks', async () => {
    const path = await writeTmp(GENERIC_EXPORT);
    let callCount = 0;
    const partiallyFailingLLM = (prompt) => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error('LLM timeout'));
      return mockLLMCall(prompt);
    };

    // With only 1 chunk in the generic export, a failing LLM returns 0 nodes — that's expected.
    // Test with 2 conversations (2 chunks) to verify graceful degradation.
    const twoConvExport = {
      conversations: [
        GENERIC_EXPORT,
        { messages: GENERIC_EXPORT.messages }
      ]
    };
    const path2 = await writeTmp(twoConvExport);

    try {
      const miner = new ConversationMiner(partiallyFailingLLM);
      const nodes = await miner.ingest(path2);
      // First chunk fails, second succeeds → should still get nodes
      assert.ok(nodes.length >= 3, `Expected nodes from successful chunk, got ${nodes.length}`);
    } finally {
      await unlink(path).catch(() => {});
      await unlink(path2).catch(() => {});
    }
  });
});
