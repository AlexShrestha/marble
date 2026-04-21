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

/**
 * Best-effort extraction of a conversation's real-world creation time.
 * ChatGPT exports carry `create_time` as unix seconds; Claude exports carry
 * `created_at` as ISO. Fall back to the latest per-message timestamp, then to
 * null — callers must treat null as "unknown" rather than silently stamping
 * the current wall-clock time.
 *
 * @param {Object} conv - Raw conversation object from the export
 * @returns {string|null} ISO-8601 timestamp or null
 */
function extractConversationDate(conv) {
  if (!conv || typeof conv !== 'object') return null;
  if (typeof conv.create_time === 'number' && Number.isFinite(conv.create_time)) {
    return new Date(conv.create_time * 1000).toISOString();
  }
  if (typeof conv.created_at === 'string' && conv.created_at) {
    const d = new Date(conv.created_at);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof conv.update_time === 'number' && Number.isFinite(conv.update_time)) {
    return new Date(conv.update_time * 1000).toISOString();
  }
  // Walk messages looking for a per-message timestamp (ChatGPT mapping nodes
  // often carry `create_time`). This catches exports where the conversation
  // header is missing a top-level time.
  if (conv.mapping) {
    for (const node of Object.values(conv.mapping)) {
      const t = node?.message?.create_time;
      if (typeof t === 'number' && Number.isFinite(t)) {
        return new Date(t * 1000).toISOString();
      }
    }
  }
  if (Array.isArray(conv.chat_messages)) {
    for (const m of conv.chat_messages) {
      if (m?.created_at) {
        const d = new Date(m.created_at);
        if (!Number.isNaN(d.getTime())) return d.toISOString();
      }
    }
  }
  return null;
}

function parseChatGPTFormat(data) {
  const conversations = data.conversations || (Array.isArray(data) ? data : [data]);
  const result = [];

  for (const [idx, conv] of conversations.entries()) {
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
      result.push({
        messages,
        source_date: extractConversationDate(conv),
        title: conv.title || conv.name || `conversation_${idx}`,
        id: conv.id || conv.uuid || null,
      });
    }
  }

  return result;
}

/**
 * Returns an array of `{ messages, source_date, title, id }` objects. Every
 * supported export format is normalised to this shape so downstream code can
 * carry source timestamps without branching per-format. `source_date` may be
 * null — the caller must handle that rather than silently substituting now.
 *
 * @param {any} data - Raw parsed JSON from an export file
 * @returns {Array<{ messages: Array, source_date: string|null, title: string, id: string|null }>}
 */
function parseExport(data) {
  if (Array.isArray(data) && data[0]?.role) {
    return [{ messages: data, source_date: null, title: 'conversation_0', id: null }];
  }
  if (data.conversations || (Array.isArray(data) && data[0]?.mapping)) return parseChatGPTFormat(data);
  if (data.chat_messages) return parseChatGPTFormat({ conversations: [data] });
  if (data.mapping) return parseChatGPTFormat({ conversations: [data] });
  if (Array.isArray(data.messages)) {
    return [{ messages: data.messages, source_date: null, title: 'conversation_0', id: null }];
  }
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
   * Parse an export file into the normalised conversation list used
   * internally. Callers that want to build episodes before extraction (like
   * `ingestIntoKG`) use this directly so they don't re-read the file.
   *
   * @param {string} chatExportPath
   * @returns {Promise<Array<{ messages, source_date, title, id }>>}
   */
  async parseFile(chatExportPath) {
    const raw = await readFile(chatExportPath, 'utf-8');
    const data = JSON.parse(raw);
    const conversations = parseExport(data);
    if (conversations.length === 0) {
      throw new Error(`[ConversationMiner] No parseable conversations found in ${chatExportPath}`);
    }
    return conversations;
  }

  /**
   * Chunk-mode extraction over already-parsed conversations.
   * Nodes carry `source_date` and `source_conversation_index` back-pointers.
   * @private
   */
  async _extractFromConversations(conversations) {
    const allNodes = [];
    let chunksProcessed = 0;
    let capHit = false;

    for (const [convIdx, conv] of conversations.entries()) {
      if (chunksProcessed >= this.maxChunks) { capHit = true; break; }

      const chunks = buildChunks(conv.messages, this.chunkSize);

      for (const chunk of chunks) {
        if (chunksProcessed >= this.maxChunks) { capHit = true; break; }
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
          if (node) {
            node.source_date = conv.source_date;
            node.source_conversation_index = convIdx;
            allNodes.push(node);
          }
        }

        chunksProcessed++;
        if (this._onProgress) {
          this._onProgress({ chunksProcessed, nodesExtracted: allNodes.length, phase: 'extract' });
        }
      }
    }

    if (capHit) {
      console.warn(
        `[ConversationMiner] maxChunks cap of ${this.maxChunks} reached — ` +
        'remaining conversations were NOT processed. ' +
        'Raise or remove `maxChunks` to process the entire file.'
      );
    }

    // Dedup across all chunks. Dedup preserves the first-seen `source_date`
    // and `source_conversation_index` — keeping them lets the downstream
    // episode wiring work on the merged fact.
    return dedup(allNodes);
  }

  /**
   * Exchange-mode extraction over already-parsed conversations.
   * @private
   */
  async _extractExchangesFromConversations(conversations) {
    const allNodes = [];
    let exchangesProcessed = 0;
    const maxExchanges = this.maxChunks === Infinity ? Infinity : this.maxChunks * this.chunkSize;
    let capHit = false;

    for (const [convIdx, conv] of conversations.entries()) {
      if (exchangesProcessed >= maxExchanges) { capHit = true; break; }
      const exchanges = buildExchangePairs(conv.messages);

      for (const exchange of exchanges) {
        if (exchangesProcessed >= maxExchanges) { capHit = true; break; }

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
          if (node) {
            node.source_date = conv.source_date;
            node.source_conversation_index = convIdx;
            allNodes.push(node);
          }
        }

        exchangesProcessed++;
        if (this._onProgress) {
          this._onProgress({ exchangesProcessed, nodesExtracted: allNodes.length, phase: 'extract' });
        }
      }
    }

    if (capHit) {
      console.warn(
        `[ConversationMiner] maxExchanges cap reached — remaining exchanges were NOT processed. ` +
        'Raise or remove `maxChunks` to process the entire file.'
      );
    }

    return dedup(allNodes);
  }

  /**
   * Ingest a chat export file and return KG nodes extracted from it.
   *
   * Nodes carry the source conversation's real-world timestamp (`source_date`)
   * and a back-pointer (`source_conversation_index`) that `ingestIntoKG()`
   * uses to pair each node with an episode record. No wall-clock substitution
   * happens here — when a conversation has no extractable date, nodes get a
   * null `source_date` and the caller decides how to handle that.
   */
  async ingest(chatExportPath) {
    const conversations = await this.parseFile(chatExportPath);
    return this._extractFromConversations(conversations);
  }

  /**
   * Ingest using exchange-mode (user+assistant pairs).
   * Same source-timestamp handling as `ingest()`.
   */
  async ingestExchanges(chatExportPath) {
    const conversations = await this.parseFile(chatExportPath);
    return this._extractExchangesFromConversations(conversations);
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
   * Full pipeline: extract → dedup → infer → episodes → write to KG.
   *
   * Before extraction runs, one episode is created per source conversation
   * (via `kg.addEpisode()`). Every extracted fact is written to the KG with
   * `validFrom = source_date` and `episodeId` pointing to the conversation it
   * came from — so provenance survives through dedup and facts age from the
   * date the user actually said the thing, not the date the miner ran.
   *
   * Inference facts inherit provenance from their source facts (all referenced
   * source_conversation_indexes merge into the inference's evidence array).
   *
   * @param {string} chatExportPath
   * @param {Object} kg - KnowledgeGraph instance
   * @param {Object} [opts]
   * @param {boolean} [opts.exchangeMode=true]
   * @param {boolean} [opts.runInference=true]
   * @param {string} [opts.sourceLabel] - Episode `source` field. Defaults to
   *   'chat-export' — override when ingesting a specific provider so
   *   downstream provenance queries can filter by source.
   * @returns {Promise<Object>} stats
   */
  async ingestIntoKG(chatExportPath, kg, opts = {}) {
    const sourceLabel = opts.sourceLabel || 'chat-export';
    const conversations = await this.parseFile(chatExportPath);
    return this._runPipeline(conversations, kg, {
      exchangeMode: opts.exchangeMode !== false,
      runInference: opts.runInference !== false,
      episodeMeta: (idx, conv) => ({
        source: sourceLabel,
        source_date: conv.source_date,
        content_summary: conv.title,
        metadata: {
          file: chatExportPath,
          conversation_index: idx,
          message_count: (conv.messages || []).length,
          ...(conv.id ? { conversation_id: conv.id } : {}),
        },
      }),
    });
  }

  /**
   * Ingest generic `Episode` objects — the format-agnostic entry point.
   *
   * An episode is `{ id?, source, source_date, content, metadata? }`. This is
   * the contract consumers reach for when their source isn't a ChatGPT/Claude
   * export: journals, emails, meeting notes, Slack, anything textual.
   * Extraction, dedup, inference, and provenance wiring are identical to
   * `ingestIntoKG()` — the only difference is that the "conversation" is a
   * single user-role message with the episode's raw text.
   *
   * @param {Array<{id?: string, source?: string, source_date?: string, content: string, metadata?: object}>} episodes
   * @param {Object} kg - KnowledgeGraph instance
   * @param {Object} [opts]
   * @param {boolean} [opts.runInference=true]
   * @returns {Promise<Object>} Same stats shape as `ingestIntoKG()`
   */
  async ingestEpisodesIntoKG(episodes, kg, opts = {}) {
    if (!Array.isArray(episodes) || episodes.length === 0) {
      throw new Error('[ConversationMiner] ingestEpisodesIntoKG requires a non-empty episodes array');
    }

    const conversations = episodes.map((ep, idx) => ({
      // Each episode becomes a single-message conversation so the extraction
      // prompt sees user text to mine. The assistant side is empty — exchange
      // mode degrades to chunk mode automatically.
      messages: [{ role: 'user', content: String(ep.content || '') }],
      source_date: ep.source_date || null,
      title: ep.id || `episode_${idx}`,
      id: ep.id || null,
      _original: ep,
    }));

    return this._runPipeline(conversations, kg, {
      // Exchange mode requires an assistant turn; force chunk mode for
      // episodes so the extraction prompt receives the single user message.
      exchangeMode: false,
      runInference: opts.runInference !== false,
      episodeMeta: (idx, conv) => ({
        id: conv._original.id,
        source: conv._original.source || 'generic',
        source_date: conv._original.source_date || null,
        content: conv._original.content || '',
        content_summary: conv._original.content_summary,
        metadata: conv._original.metadata,
      }),
    });
  }

  /**
   * Shared pipeline used by `ingestIntoKG` and `ingestEpisodesIntoKG`:
   * create episodes, extract, infer, write back with provenance.
   * @private
   */
  async _runPipeline(conversations, kg, opts) {
    const { exchangeMode, runInference, episodeMeta } = opts;

    // Phase 0: one episode per conversation. Skip if the KG predates the
    // episode schema — keeps legacy in-memory KG mocks working.
    const supportsEpisodes = typeof kg.addEpisode === 'function';
    const convEpisodeIds = new Array(conversations.length).fill(null);
    if (supportsEpisodes) {
      for (const [idx, conv] of conversations.entries()) {
        const meta = episodeMeta(idx, conv);
        const messages = conv.messages || [];
        const previewFallback = messages.slice(0, 3)
          .map(m => `[${m.role}] ${String(m.content || '').slice(0, 200)}`)
          .join('\n') + (messages.length > 3 ? `\n… +${messages.length - 3} more messages` : '');
        const ep = kg.addEpisode({
          id: meta.id,
          source: meta.source,
          source_date: meta.source_date,
          content: meta.content ?? previewFallback,
          content_summary: meta.content_summary,
          metadata: meta.metadata,
        });
        convEpisodeIds[idx] = ep.id;
      }
    }

    // Phase 1: extract
    const nodes = exchangeMode
      ? await this._extractExchangesFromConversations(conversations)
      : await this._extractFromConversations(conversations);

    // Phase 2: inference
    let inferenceNodes = [];
    if (runInference && nodes.length >= 3) {
      inferenceNodes = await this.inferFromNodes(nodes);
      const allEpisodeIds = [...new Set(
        nodes.map(n => convEpisodeIds[n.source_conversation_index]).filter(Boolean)
      )];
      const latest = nodes.map(n => n.source_date).filter(Boolean).sort().pop();
      for (const inf of inferenceNodes) {
        inf._episode_ids = allEpisodeIds;
        inf.source_date = latest || null;
      }
    }

    // Phase 3: write back with provenance
    const stats = {
      ingested: 0,
      beliefs: 0,
      preferences: 0,
      identities: 0,
      emotions: 0,
      inferences: inferenceNodes.length,
      duplicates_merged: nodes.reduce((s, n) => s + ((n.evidence_count || 1) - 1), 0),
      episodes: supportsEpisodes ? convEpisodeIds.filter(Boolean).length : 0,
    };

    const resolveEpisodeId = (node) => {
      if (node._episode_ids?.length) return node._episode_ids[0];
      const idx = node.source_conversation_index;
      return (idx != null && convEpisodeIds[idx]) || null;
    };

    for (const node of [...nodes, ...inferenceNodes]) {
      try {
        const addOpts = {
          validFrom: node.source_date || undefined,
          episodeId: resolveEpisodeId(node),
        };

        if (node.type === 'belief' || node.type === 'decision') {
          kg.addBelief(node.topic, node.value, node.confidence, addOpts);
          if (node._episode_ids?.length > 1) {
            this.#linkAdditionalEpisodes(kg, 'belief', node.topic, node._episode_ids);
          }
          stats.beliefs++;
        } else if (node.type === 'preference') {
          kg.addPreference(node.topic, node.value, node.confidence, addOpts);
          if (node._episode_ids?.length > 1) {
            this.#linkAdditionalEpisodes(kg, 'preference', node.topic, node._episode_ids);
          }
          stats.preferences++;
        } else if (node.type === 'identity') {
          kg.addIdentity(node.topic, node.value, node.confidence, addOpts);
          if (node._episode_ids?.length > 1) {
            this.#linkAdditionalEpisodes(kg, 'identity', node.topic, node._episode_ids);
          }
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
   * Append extra episode ids to the most recent active fact of (type, topic).
   * Used for inference nodes that trace to multiple source episodes — the
   * first id is linked via `addBelief/Preference/Identity({ episodeId })`,
   * the rest are appended here.
   * @private
   */
  #linkAdditionalEpisodes(kg, type, topic, episodeIds) {
    const collection = type === 'belief' ? kg.user?.beliefs
      : type === 'preference' ? kg.user?.preferences
      : type === 'identity' ? kg.user?.identities
      : null;
    if (!collection) return;
    const key = (topic || '').toLowerCase();
    const fact = collection
      .filter(f => !f.valid_to)
      .reverse()
      .find(f => (f.topic || f.type || f.role || '').toLowerCase() === key);
    if (!fact) return;
    if (!Array.isArray(fact.evidence)) fact.evidence = [];
    for (const id of episodeIds) {
      if (!fact.evidence.includes(id)) fact.evidence.push(id);
    }
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
