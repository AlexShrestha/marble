/**
 * test-conversation-miner.js
 *
 * Tests ConversationMiner.ingest() against a sample ChatGPT export.
 * Verifies >= 3 typed KG nodes with valid format (type, value, confidence).
 *
 * Run: node test/test-conversation-miner.js
 *
 * Requires ANTHROPIC_API_KEY (or set LLM_PROVIDER + matching key).
 */

import { ConversationMiner } from '../core/conversation-miner.js';
import { createLLMClient, defaultModel } from '../core/llm-provider.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, 'fixtures', 'sample-chat-export.json');

// ─── LLM CALL WRAPPER ────────────────────────────────────────────────────────

async function makeLLMCall() {
  const client = createLLMClient();
  const model = defaultModel('fast');

  return async (prompt) => {
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });
    return response.content[0]?.text || '';
  };
}

// ─── VALIDATION ───────────────────────────────────────────────────────────────

function validateNode(node) {
  const VALID_TYPES = ['belief', 'preference', 'identity'];
  const errors = [];

  if (!VALID_TYPES.includes(node.type)) {
    errors.push(`invalid type "${node.type}"`);
  }
  if (typeof node.value !== 'string' || node.value.trim().length === 0) {
    errors.push('missing or empty value');
  }
  if (typeof node.confidence !== 'number' || node.confidence < 0 || node.confidence > 1) {
    errors.push(`confidence out of range: ${node.confidence}`);
  }
  if (typeof node.topic !== 'string' || node.topic.trim().length === 0) {
    errors.push('missing topic');
  }

  return errors;
}

// ─── TEST ─────────────────────────────────────────────────────────────────────

async function run() {
  console.log('=== ConversationMiner Test ===\n');

  let llmCall;
  try {
    llmCall = await makeLLMCall();
  } catch (err) {
    console.error('FAIL: Could not initialize LLM client:', err.message);
    process.exit(1);
  }

  const miner = new ConversationMiner(llmCall);

  let nodes;
  try {
    nodes = await miner.ingest(FIXTURE);
  } catch (err) {
    console.error('FAIL: ingest() threw:', err.message);
    process.exit(1);
  }

  console.log(`Extracted ${nodes.length} nodes:\n`);
  for (const node of nodes) {
    console.log(`  [${node.type}] (${node.confidence.toFixed(2)}) ${node.value}`);
    console.log(`    topic: ${node.topic}\n`);
  }

  // ── Validate ──
  let passed = true;

  if (nodes.length < 3) {
    console.error(`FAIL: Expected >= 3 nodes, got ${nodes.length}`);
    passed = false;
  }

  for (let i = 0; i < nodes.length; i++) {
    const errors = validateNode(nodes[i]);
    if (errors.length > 0) {
      console.error(`FAIL: Node ${i} invalid: ${errors.join(', ')}`);
      passed = false;
    }
  }

  if (passed) {
    console.log(`PASS: ${nodes.length} valid KG nodes extracted.`);
  } else {
    process.exit(1);
  }
}

run();
