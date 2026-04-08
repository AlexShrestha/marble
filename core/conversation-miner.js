/**
 * conversation-miner.js — Ingest chat exports into KG nodes.
 *
 * Reads raw chat JSON (ChatGPT export format or Claude format), chunks by
 * message, sends each user-turn chunk to an LLM with an extraction prompt,
 * and returns an array of KG nodes (type, value, confidence).
 *
 * Usage:
 *   import { ConversationMiner } from './conversation-miner.js';
 *   const miner = new ConversationMiner(llmCall);
 *   const nodes = await miner.ingest('/path/to/export.json');
 *
 * Pluggable as a registerDataSource() adapter:
 *   loop.registerDataSource('chat_export', async (query) => {
 *     const nodes = await miner.ingest('./export.json');
 *     return nodes
 *       .filter(n => n.value.toLowerCase().includes(query.toLowerCase()))
 *       .map(n => `[${n.type}] ${n.value} (confidence: ${n.confidence})`);
 *   });
 *
 * Supported export formats:
 *   ChatGPT: { conversations: [{ title, mapping: { [id]: { message: { role, content: { parts } } } } }] }
 *   Claude:  { conversations: [{ name, chat_messages: [{ sender, text }] }] }
 *   Generic: [{ role, content }] or { messages: [{ role, content }] }
 *
 * No external dependencies beyond the LLM call.
 */

import { readFile } from 'fs/promises';

// ─── EXTRACTION PROMPT ────────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are a knowledge graph extraction engine. Analyze the following chat messages from a user and extract structured nodes about the user.

Extract nodes of these types:
- belief: Core beliefs, opinions, or worldviews the user expressed
- preference: Explicit likes, dislikes, or preferences the user mentioned
- identity: Roles, professions, identities, or self-descriptions the user gave

Return ONLY a valid JSON array of node objects with this exact shape:
[
  { "type": "belief"|"preference"|"identity", "value": "concise factual statement about user", "confidence": 0.0-1.0, "topic": "category" }
]

Rules:
- Only extract nodes clearly supported by what the user said (not the assistant)
- Use third-person phrasing about the user (e.g. "User believes...", "User prefers...", "User identifies as...")
- Confidence: 0.9 = explicit statement, 0.7 = strong implication, 0.5 = reasonable inference
- Return [] if no clear nodes can be extracted
- Do not include assistant statements as user beliefs
- Minimum 1-sentence value that would be useful in a knowledge graph

Chat messages:
`;

// ─── FORMAT PARSERS ───────────────────────────────────────────────────────────

/**
 * Parse ChatGPT export format.
 * ChatGPT exports: { conversations: [{ mapping: { [id]: { message: { role, content: { parts } } } } }] }
 */
function parseChatGPTFormat(data) {
  const conversations = data.conversations || (Array.isArray(data) ? data : [data]);
  const chunks = [];

  for (const conv of conversations) {
    const messages = [];

    if (conv.mapping) {
      // ChatGPT mapping format: tree structure
      for (const node of Object.values(conv.mapping)) {
        const msg = node.message;
        if (!msg || !msg.role || msg.role === 'system') continue;

        let text = '';
        if (typeof msg.content === 'string') {
          text = msg.content;
        } else if (msg.content?.parts) {
          text = msg.content.parts.filter(p => typeof p === 'string').join('\n');
        }

        if (text.trim()) {
          messages.push({ role: msg.role, content: text.trim() });
        }
      }
    } else if (conv.chat_messages) {
      // Claude export format: { chat_messages: [{ sender, text }] }
      for (const msg of conv.chat_messages) {
        const role = msg.sender === 'human' ? 'user' : 'assistant';
        const text = msg.text || msg.content || '';
        if (text.trim()) {
          messages.push({ role, content: text.trim() });
        }
      }
    } else if (Array.isArray(conv.messages)) {
      // Generic: { messages: [{ role, content }] }
      for (const msg of conv.messages) {
        if (msg.role && msg.content) {
          messages.push({ role: msg.role, content: String(msg.content).trim() });
        }
      }
    }

    if (messages.length > 0) {
      chunks.push(messages);
    }
  }

  return chunks;
}

/**
 * Parse any supported chat export format into an array of message-chunk arrays.
 * Each chunk is [{ role, content }].
 */
function parseExport(data) {
  // Already an array of messages (flat format)
  if (Array.isArray(data) && data[0]?.role) {
    return [data];
  }

  // Has conversations key → ChatGPT or Claude bulk export
  if (data.conversations || (Array.isArray(data) && data[0]?.mapping)) {
    return parseChatGPTFormat(data);
  }

  // Single conversation with chat_messages (Claude single-convo export)
  if (data.chat_messages) {
    return parseChatGPTFormat({ conversations: [data] });
  }

  // Single conversation with mapping (ChatGPT single-convo)
  if (data.mapping) {
    return parseChatGPTFormat({ conversations: [data] });
  }

  // Generic single conversation
  if (Array.isArray(data.messages)) {
    return [data.messages];
  }

  return [];
}

// ─── CHUNK BUILDER ────────────────────────────────────────────────────────────

/**
 * Group messages into chunks for LLM extraction.
 * Each chunk contains up to maxMessages turns to stay within token limits.
 */
function buildChunks(messages, maxMessages = 20) {
  const userMessages = messages.filter(m => m.role === 'user');
  const chunks = [];

  for (let i = 0; i < userMessages.length; i += maxMessages) {
    chunks.push(userMessages.slice(i, i + maxMessages));
  }

  return chunks;
}

/**
 * Format a chunk of messages into a text block for the extraction prompt.
 */
function formatChunk(messages) {
  return messages
    .map(m => `[${m.role.toUpperCase()}]: ${m.content}`)
    .join('\n\n');
}

// ─── RESPONSE PARSER ──────────────────────────────────────────────────────────

/**
 * Parse LLM response to extract JSON array of KG nodes.
 * Handles cases where the LLM wraps JSON in markdown code blocks.
 */
function parseNodes(responseText) {
  let text = responseText.trim();

  // Strip markdown code fences
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');

  // Find the JSON array
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1) return [];

  try {
    const nodes = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(nodes) ? nodes : [];
  } catch {
    return [];
  }
}

/**
 * Validate and normalize a KG node.
 * Returns null if invalid.
 */
function normalizeNode(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const type = String(raw.type || '').toLowerCase();
  if (!['belief', 'preference', 'identity'].includes(type)) return null;

  const value = String(raw.value || '').trim();
  if (!value) return null;

  const confidence = Math.max(0, Math.min(1, parseFloat(raw.confidence) || 0.5));
  const topic = String(raw.topic || type).trim();

  return { type, value, confidence, topic };
}

// ─── CONVERSATION MINER ───────────────────────────────────────────────────────

export class ConversationMiner {
  /**
   * @param {Function} llmCall - async (prompt: string) => string
   *   Must return the LLM's text response.
   * @param {Object} [opts]
   * @param {number} [opts.chunkSize=20]   - Max user messages per LLM call
   * @param {number} [opts.maxChunks=10]   - Max chunks to process per export
   */
  constructor(llmCall, opts = {}) {
    this.llmCall = llmCall;
    this.chunkSize = opts.chunkSize || 20;
    this.maxChunks = opts.maxChunks || 10;
  }

  /**
   * Ingest a chat export file and return KG nodes extracted from it.
   *
   * @param {string} chatExportPath - Absolute or relative path to export JSON
   * @returns {Promise<Array<{ type: string, value: string, confidence: number, topic: string }>>}
   */
  async ingest(chatExportPath) {
    const raw = await readFile(chatExportPath, 'utf-8');
    const data = JSON.parse(raw);
    const conversations = parseExport(data);

    if (conversations.length === 0) {
      throw new Error(`[ConversationMiner] No parseable conversations found in ${chatExportPath}`);
    }

    const allNodes = [];
    let chunksProcessed = 0;

    for (const messages of conversations) {
      if (chunksProcessed >= this.maxChunks) break;

      const chunks = buildChunks(messages, this.chunkSize);

      for (const chunk of chunks) {
        if (chunksProcessed >= this.maxChunks) break;
        if (chunk.length === 0) continue;

        const prompt = EXTRACTION_PROMPT + formatChunk(chunk);

        let responseText;
        try {
          responseText = await this.llmCall(prompt);
        } catch (err) {
          console.warn(`[ConversationMiner] LLM call failed for chunk ${chunksProcessed}: ${err.message}`);
          continue;
        }

        const rawNodes = parseNodes(responseText);
        for (const raw of rawNodes) {
          const node = normalizeNode(raw);
          if (node) allNodes.push(node);
        }

        chunksProcessed++;
      }
    }

    return allNodes;
  }

  /**
   * Build a registerDataSource()-compatible search function.
   *
   * Usage:
   *   loop.registerDataSource('my_chat', miner.asDataSource('./export.json'));
   *
   * @param {string} chatExportPath
   * @returns {Function} async (query: string) => string[]
   */
  asDataSource(chatExportPath) {
    let cachedNodes = null;

    return async (query) => {
      if (!cachedNodes) {
        cachedNodes = await this.ingest(chatExportPath);
      }

      const q = query.toLowerCase();
      return cachedNodes
        .filter(n => n.value.toLowerCase().includes(q) || n.topic.toLowerCase().includes(q))
        .map(n => `[${n.type}|${n.topic}] ${n.value} (confidence: ${n.confidence})`);
    };
  }
}
