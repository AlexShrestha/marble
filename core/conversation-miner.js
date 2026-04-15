/**
 * conversation-miner.js — Ingest chat exports into KG nodes.
 *
 * Reads raw chat JSON (ChatGPT export format or Claude format), chunks by
 * message, sends each user-turn chunk to an LLM with an extraction prompt,
 * and returns an array of KG nodes (type, value, confidence).
 *
 * Pipeline:
 *   Phase 1: Extract raw nodes from all conversations (no cap)
 *   Phase 2: Dedup across chunks — same fact seen 5× → evidence_count: 5
 *   Phase 3: Inference pass — clusters of facts → psychological meaning
 *
 * Usage:
 *   import { ConversationMiner } from './conversation-miner.js';
 *   const miner = new ConversationMiner(llmCall);
 *   const nodes = await miner.ingest('/path/to/export.json');
 *
 * Supported export formats:
 *   ChatGPT: { conversations: [{ title, mapping: { [id]: { message: { role, content: { parts } } } } }] }
 *   Claude:  { conversations: [{ name, chat_messages: [{ sender, text }] }] }
 *   Generic: [{ role, content }] or { messages: [{ role, content }] }
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

const EXCHANGE_EXTRACTION_PROMPT = `You are a deep knowledge graph extraction engine. Analyze the following user-assistant exchange pair and extract structured nodes about the user.

For each exchange, consider:
1. What the user explicitly asked or stated
2. What the user's question/request reveals about their situation, goals, knowledge level
3. What emotional signals are present in the user's language

Extract nodes of these types:
- belief: Core beliefs, opinions, or worldviews the user expressed
- preference: Explicit likes, dislikes, or preferences the user mentioned
- identity: Roles, professions, identities, or self-descriptions the user gave
- decision: Choices or decisions the user made or is considering
- emotion: Emotional states detected in the user's messages

Return ONLY a valid JSON array of node objects with this exact shape:
[
  { "type": "belief"|"preference"|"identity"|"decision"|"emotion", "value": "concise factual statement about user", "confidence": 0.0-1.0, "topic": "category", "emotions": ["joy"|"fear"|"trust"|"frustration"|"hope"|"anxiety"|"pride"|"shame"|"curiosity"|"boredom"|"anger"|"love"|"grief"|"wonder"|"peace"] }
]

The "emotions" array should contain detected emotions in the user's messages for THIS exchange.
Return [] if no clear nodes can be extracted.

Exchange:
`;

const INFERENCE_PROMPT = `You are a psychological profiler. Given these raw facts extracted from a person's conversations, derive DEEPER inferences about who they really are.

EXTRACTED FACTS:
{FACTS}

For each inference:
1. Identify PATTERNS across multiple facts (not just restate individual ones)
2. Go from SURFACE behavior to UNDERLYING motivation
3. Name CONTRADICTIONS or TENSIONS between facts
4. Predict CONTENT IMPLICATIONS — what would resonate or repel this person?

Return ONLY a JSON array:
[
  {
    "type": "belief"|"preference"|"identity",
    "value": "the deeper inference (1-2 sentences)",
    "confidence": 0.5-0.8,
    "topic": "psychological_category",
    "source_facts": ["which extracted facts led to this"],
    "emotions": []
  }
]

Rules:
- Each inference must cite 2+ source facts
- Confidence maxes at 0.8 (these are interpretations, not direct observations)
- Focus on what the COMBINATION of facts reveals, not what any single fact says
- "User has a prayer practice" + "User values data-driven decisions" → tension worth naming`;

// ─── FORMAT PARSERS ───────────────────────────────────────────────────────────

function parseChatGPTFormat(data) {
  const conversations = data.conversations || (Array.isArray(data) ? data : [data]);
  const chunks = [];

  for (const conv of conversations) {
    const messages = [];

    if (conv.mapping) {
      for (const node of Object.values(conv.mapping)) {
        const msg = node.message;
        if (!msg) continue;
        const role = msg.role || msg.author?.role;
        if (!role || role === 'system') continue;

        let text = '';
        if (typeof msg.content === 'string') {
          text = msg.content;
        } else if (msg.content?.parts) {
          text = msg.content.parts.filter(p => typeof p === 'string').join('\n');
        }

        if (text.trim()) {
          messages.push({ role, content: text.trim() });
        }
      }
    } else if (conv.chat_messages) {
      for (const msg of conv.chat_messages) {
        const role = msg.sender === 'human' ? 'user' : 'assistant';
        const text = msg.text || msg.content || '';
        if (text.trim()) {
          messages.push({ role, content: text.trim() });
        }
      }
    } else if (Array.isArray(conv.messages)) {
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

function parseExport(data) {
  if (Array.isArray(data) && data[0]?.role) return [data];
  if (data.conversations || (Array.isArray(data) && data[0]?.mapping)) return parseChatGPTFormat(data);
  if (data.chat_messages) return parseChatGPTFormat({ conversations: [data] });
  if (data.mapping) return parseChatGPTFormat({ conversations: [data] });
  if (Array.isArray(data.messages)) return [data.messages];
  return [];
}

// ─── CHUNK BUILDER ────────────────────────────────────────────────────────────

function buildChunks(messages, maxMessages = 20) {
  const userMessages = messages.filter(m => m.role === 'user');
  const chunks = [];
  for (let i = 0; i < userMessages.length; i += maxMessages) {
    chunks.push(userMessages.slice(i, i + maxMessages));
  }
  return chunks;
}

function buildExchangePairs(messages) {
  const exchanges = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') {
      const userMsg = messages[i];
      const assistantMsg = (i + 1 < messages.length && messages[i + 1].role === 'assistant')
        ? messages[i + 1] : null;
      const combined = (userMsg.content || '') + (assistantMsg?.content || '');
      if (combined.length >= 30) {
        exchanges.push({ user: userMsg.content, assistant: assistantMsg?.content || '' });
      }
    }
  }
  return exchanges;
}

function formatChunk(messages) {
  return messages.map(m => `[${m.role.toUpperCase()}]: ${m.content}`).join('\n\n');
}

// ─── RESPONSE PARSER ──────────────────────────────────────────────────────────

function parseNodes(responseText) {
  let text = responseText.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
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

function normalizeNode(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type || '').toLowerCase();
  if (!['belief', 'preference', 'identity', 'decision', 'emotion'].includes(type)) return null;
  const value = String(raw.value || '').trim();
  if (!value) return null;
  const confidence = Math.max(0, Math.min(1, parseFloat(raw.confidence) || 0.5));
  const topic = String(raw.topic || type).trim();
  const emotions = Array.isArray(raw.emotions) ? raw.emotions.filter(e => typeof e === 'string') : [];
  return { type, value, confidence, topic, emotions };
}

// ─── DEDUP ENGINE ─────────────────────────────────────────────────────────────

/**
 * Deduplicate nodes across chunks. Same type+topic+similar value → merge,
 * incrementing evidence_count and boosting confidence.
 *
 * Two values are "similar" if they share 60%+ of significant words (>3 chars).
 */
function dedup(nodes) {
  const merged = new Map(); // key → node with evidence_count

  for (const node of nodes) {
    const key = `${node.type}:${node.topic.toLowerCase()}`;
    const existing = merged.get(key);

    if (existing && _valueSimilar(existing.value, node.value)) {
      // Same fact seen again — boost evidence
      existing.evidence_count = (existing.evidence_count || 1) + 1;
      existing.confidence = Math.min(0.95, existing.confidence + 0.03);
      // Keep the longer (more detailed) value
      if (node.value.length > existing.value.length) {
        existing.value = node.value;
      }
      // Merge emotions
      if (node.emotions?.length) {
        existing.emotions = [...new Set([...(existing.emotions || []), ...node.emotions])];
      }
    } else if (existing) {
      // Same topic but different value — store under extended key
      const extKey = `${key}:${merged.size}`;
      merged.set(extKey, { ...node, evidence_count: 1 });
    } else {
      merged.set(key, { ...node, evidence_count: 1 });
    }
  }

  return [...merged.values()];
}

function _valueSimilar(a, b) {
  const wordsA = new Set(a.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const wordsB = new Set(b.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return false;
  let shared = 0;
  for (const w of wordsA) { if (wordsB.has(w)) shared++; }
  const smaller = Math.min(wordsA.size, wordsB.size);
  return shared / smaller >= 0.6;
}

// ─── CONVERSATION MINER ───────────────────────────────────────────────────────

export class ConversationMiner {
  /**
   * @param {Function} llmCall - async (prompt: string) => string
   * @param {Object} [opts]
   * @param {number} [opts.chunkSize=20]   - Max user messages per LLM call
   * @param {number} [opts.maxChunks]      - Max chunks to process (default: no limit)
   * @param {number} [opts.inferBatchSize=20] - Nodes per inference pass batch
   * @param {Function} [opts.onProgress]   - (stats) => void — progress callback
   */
  constructor(llmCall, opts = {}) {
    this.llmCall = llmCall;
    this.chunkSize = opts.chunkSize || 20;
    this.maxChunks = opts.maxChunks ?? Infinity;
    this.inferBatchSize = opts.inferBatchSize || 20;
    this._onProgress = opts.onProgress || null;
  }

  /**
   * Ingest a chat export file and return KG nodes extracted from it.
   * No cap by default — processes ALL conversations.
   * Deduplicates across chunks automatically.
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
        if (this._onProgress) {
          this._onProgress({ chunksProcessed, nodesExtracted: allNodes.length, phase: 'extract' });
        }
      }
    }

    // Dedup across all chunks
    return dedup(allNodes);
  }

  /**
   * Ingest using exchange-mode (user+assistant pairs).
   * No cap by default. Deduplicates automatically.
   */
  async ingestExchanges(chatExportPath) {
    const raw = await readFile(chatExportPath, 'utf-8');
    const data = JSON.parse(raw);
    const conversations = parseExport(data);

    if (conversations.length === 0) {
      throw new Error(`[ConversationMiner] No parseable conversations found in ${chatExportPath}`);
    }

    const allNodes = [];
    let exchangesProcessed = 0;
    const maxExchanges = this.maxChunks === Infinity ? Infinity : this.maxChunks * this.chunkSize;

    for (const messages of conversations) {
      const exchanges = buildExchangePairs(messages);

      for (const exchange of exchanges) {
        if (exchangesProcessed >= maxExchanges) break;

        const text = `[USER]: ${exchange.user}\n\n[ASSISTANT]: ${exchange.assistant}`;
        const prompt = EXCHANGE_EXTRACTION_PROMPT + text;

        let responseText;
        try {
          responseText = await this.llmCall(prompt);
        } catch (err) {
          console.warn(`[ConversationMiner] LLM call failed for exchange ${exchangesProcessed}: ${err.message}`);
          continue;
        }

        const rawNodes = parseNodes(responseText);
        for (const raw of rawNodes) {
          const node = normalizeNode(raw);
          if (node) allNodes.push(node);
        }

        exchangesProcessed++;
        if (this._onProgress) {
          this._onProgress({ exchangesProcessed, nodesExtracted: allNodes.length, phase: 'extract' });
        }
      }
    }

    return dedup(allNodes);
  }

  /**
   * Run inference pass: take clusters of extracted facts and derive
   * psychological meaning, patterns, contradictions.
   *
   * "Has a daily prayer" + "Values data-driven decisions" →
   * "Navigates uncertainty by hedging across rational and spiritual paradigms"
   *
   * @param {Array} nodes - Deduplicated nodes from ingest()
   * @returns {Promise<Array>} Additional inference nodes
   */
  async inferFromNodes(nodes) {
    if (nodes.length < 3) return []; // too few to infer patterns

    const inferences = [];
    const batchSize = this.inferBatchSize;

    for (let i = 0; i < nodes.length; i += batchSize) {
      const batch = nodes.slice(i, i + batchSize);
      const factsText = batch.map(n =>
        `- [${n.type}/${n.topic}] ${n.value} (confidence: ${n.confidence}, seen: ${n.evidence_count || 1}x)`
      ).join('\n');

      const prompt = INFERENCE_PROMPT.replace('{FACTS}', factsText);

      try {
        const responseText = await this.llmCall(prompt);
        const rawNodes = parseNodes(responseText);
        for (const raw of rawNodes) {
          const node = normalizeNode(raw);
          if (node) {
            node.source_layer = 'inference';
            node.source_facts = raw.source_facts || [];
            inferences.push(node);
          }
        }
      } catch (err) {
        console.warn(`[ConversationMiner] Inference pass failed for batch ${i}: ${err.message}`);
      }

      if (this._onProgress) {
        this._onProgress({ inferBatch: Math.floor(i / batchSize) + 1, inferencesGenerated: inferences.length, phase: 'infer' });
      }
    }

    return dedup(inferences);
  }

  /**
   * Full pipeline: extract → dedup → infer → merge → write to KG.
   *
   * @param {string} chatExportPath
   * @param {Object} kg - KnowledgeGraph instance
   * @param {Object} [opts]
   * @param {boolean} [opts.exchangeMode=true]
   * @param {boolean} [opts.runInference=true]
   * @returns {Promise<Object>} stats
   */
  async ingestIntoKG(chatExportPath, kg, opts = {}) {
    const useExchanges = opts.exchangeMode !== false;
    const runInference = opts.runInference !== false;

    // Phase 1: Extract
    const nodes = useExchanges
      ? await this.ingestExchanges(chatExportPath)
      : await this.ingest(chatExportPath);

    // Phase 2: Inference pass
    let inferenceNodes = [];
    if (runInference && nodes.length >= 3) {
      inferenceNodes = await this.inferFromNodes(nodes);
    }

    const allNodes = [...nodes, ...inferenceNodes];

    // Phase 3: Write to KG
    const stats = { ingested: 0, beliefs: 0, preferences: 0, identities: 0, emotions: 0, inferences: inferenceNodes.length, duplicates_merged: nodes.reduce((s, n) => s + ((n.evidence_count || 1) - 1), 0) };

    for (const node of allNodes) {
      try {
        if (node.type === 'belief' || node.type === 'decision') {
          kg.addBelief(node.topic, node.value, node.confidence);
          stats.beliefs++;
        } else if (node.type === 'preference') {
          kg.addPreference(node.topic, node.value, node.confidence);
          stats.preferences++;
        } else if (node.type === 'identity') {
          kg.addIdentity(node.topic, node.value, node.confidence);
          stats.identities++;
        }

        if (node.emotions?.length && typeof kg.tagEmotions === 'function') {
          const kgType = (node.type === 'decision') ? 'belief' : node.type;
          if (['belief', 'preference', 'identity'].includes(kgType)) {
            kg.tagEmotions(kgType, node.topic, node.emotions);
            stats.emotions += node.emotions.length;
          }
        }

        stats.ingested++;
      } catch {
        // non-fatal
      }
    }

    return stats;
  }

  /**
   * Build a registerDataSource()-compatible search function.
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
