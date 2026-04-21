/**
 * chat-export-parser.test.js — Regression tests for real-world chat export
 * edge cases (feedback #12). Every fixture in chat-export-edge-cases.json
 * corresponds to a shape that once broke the miner in production:
 *
 *   - Null `node.message` entries in ChatGPT mapping (structural nodes)
 *     — fixed in 25213c1
 *   - `msg.author.role` rather than `msg.role` directly — also 25213c1
 *   - Legacy exports with `msg.role` only
 *   - Claude export format (`chat_messages[]` with `sender`)
 *   - Mixed-type `content.parts` arrays (image + text)
 *   - Empty `parts: []` arrays
 *   - String-valued `content` (rather than `{ parts: [...] }`)
 *   - Top-level `create_time` and `created_at` for source timestamps
 *
 * The test exercises the public miner entry points rather than private
 * parsers so that any regression — including in the episode/source-date
 * wiring from PR 1 — surfaces here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink } from 'fs/promises';
import { readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ConversationMiner, KnowledgeGraph } from '../core/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, 'fixtures', 'chat-export-edge-cases.json');

function mockLLMAlwaysEmpty() {
  // `[]` parses fine so each chunk is processed, but no nodes emerge —
  // isolating the test to parser behaviour, not extraction behaviour.
  return async () => '[]';
}

function mockLLMAlwaysNodes() {
  // Returns one unique belief per chunk. Using an incrementing counter for
  // the topic prevents the miner's dedup (which merges on same type+topic +
  // similar value) from collapsing facts across conversations — we need
  // one belief per conversation to verify per-conversation source_date
  // stamping.
  let n = 0;
  return async () => {
    const i = n++;
    return JSON.stringify([
      { type: 'belief', value: `belief_${i}_distinct_phrase_${i}`, confidence: 0.7, topic: `slot_${i}` },
    ]);
  };
}

describe('chat export parser — production edge cases', () => {
  it('fixture file is parseable JSON and has expected shape', async () => {
    const raw = await readFile(FIXTURE, 'utf-8');
    const data = JSON.parse(raw);
    assert.ok(Array.isArray(data.conversations));
    assert.ok(data.conversations.length >= 4, 'covers multiple export shapes');
  });

  it('miner.ingest survives null message nodes, author.role, legacy role, mixed parts', async () => {
    const miner = new ConversationMiner(mockLLMAlwaysEmpty(), { chunkSize: 50 });
    // ingest() calls through parseFile → parseExport → parseChatGPTFormat.
    // Null messages, system roles, and empty parts should all be filtered
    // without throwing. Any unhandled shape causes an exception here.
    const nodes = await miner.ingest(FIXTURE);
    assert.ok(Array.isArray(nodes));
    // No LLM content means no nodes extracted; the test is that we reached
    // dedup without the parser throwing.
    assert.equal(nodes.length, 0);
  });

  it('parseFile returns one entry per conversation with source_date attached', async () => {
    const miner = new ConversationMiner(mockLLMAlwaysEmpty());
    const conversations = await miner.parseFile(FIXTURE);
    assert.equal(conversations.length, 4);

    // 1. Modern ChatGPT export — source_date from create_time (unix seconds → ISO)
    const modern = conversations[0];
    assert.equal(modern.title, 'modern ChatGPT export with author.role');
    assert.equal(modern.source_date, '2024-01-01T00:00:00.000Z');
    // System role is filtered; null-message structural nodes are filtered;
    // user + assistant messages survive.
    const roles = modern.messages.map(m => m.role);
    assert.ok(roles.includes('user'));
    assert.ok(roles.includes('assistant'));
    assert.ok(!roles.includes('system'));

    // 2. Legacy ChatGPT export — msg.role directly
    const legacy = conversations[1];
    assert.equal(legacy.source_date, '2020-01-01T00:00:00.000Z');
    const legacyUserMessages = legacy.messages.filter(m => m.role === 'user');
    assert.equal(legacyUserMessages.length, 2, 'both user messages survive the null-message gap');

    // 3. Claude format — created_at string
    const claude = conversations[2];
    assert.equal(claude.source_date, '2023-08-15T12:00:00.000Z');
    assert.equal(claude.messages.length, 3);

    // 4. Unusual shapes — string content, non-string parts, empty parts
    const unusual = conversations[3];
    const unusualContent = unusual.messages.map(m => m.content).join(' | ');
    assert.ok(unusualContent.includes('deep work'), 'string content preserved');
    assert.ok(unusualContent.includes('write every morning'), 'text parts filtered out of mixed-type array');
  });

  it('ingestIntoKG threads source timestamps from fixture onto every fact', async () => {
    const storage = join(tmpdir(), `parser-regression-${Date.now()}.json`);
    const kg = new KnowledgeGraph(storage);
    await kg.load();

    const miner = new ConversationMiner(mockLLMAlwaysNodes(), { chunkSize: 50 });
    const stats = await miner.ingestIntoKG(FIXTURE, kg, { exchangeMode: false, runInference: false });

    // Four conversations, each with at least one user chunk → ≥ 4 beliefs.
    assert.ok(stats.beliefs >= 4, `expected at least 4 beliefs, got ${stats.beliefs}`);

    // Every emitted belief must have a valid_from matching one of the four
    // known source dates — never a wall-clock "now" substitution.
    const knownDates = new Set([
      '2024-01-01T00:00:00.000Z',
      '2020-01-01T00:00:00.000Z',
      '2023-08-15T12:00:00.000Z',
      '2022-01-01T00:00:00.000Z',
    ]);
    for (const belief of kg.user.beliefs) {
      assert.ok(knownDates.has(belief.valid_from),
        `belief valid_from ${belief.valid_from} should match fixture source_date`);
    }

    // Episodes created: one per conversation
    assert.equal(kg.user.episodes.length, 4);
    const episodeDates = new Set(kg.user.episodes.map(e => e.source_date));
    for (const d of knownDates) assert.ok(episodeDates.has(d));

    await unlink(storage).catch(() => {});
  });
});
