/**
 * memory-layers.js — Signal Compression Stack for LLM Context Injection
 *
 * Marble's KG can contain hundreds of facts about a user. LLM prompts have
 * finite token budgets. This module compresses the user's signal into the
 * right amount of context for each call — identity core first, then
 * strongest signals, then topic-specific data, then deep semantic search.
 *
 * Layers:
 *   L0 (Identity):   ~100 tokens — core user identity, always injected
 *   L1 (Signal):     ~500 tokens — top beliefs, strongest preferences, key identities
 *   L2 (Topical):    ~200-500 tokens — loaded when specific topic is mentioned
 *   L3 (Deep):       unlimited — full semantic search, used only when L0-L2 insufficient
 *
 * Usage:
 *   import { MemoryLayers } from './memory-layers.js';
 *   const layers = new MemoryLayers(kg);
 *   const context = await layers.buildContext({ topic: 'running', maxTokens: 800 });
 */

export class MemoryLayers {
  /**
   * @param {import('./kg.js').KnowledgeGraph} kg
   * @param {Object} [opts]
   * @param {Object} [opts.embeddingsProvider] - For L3 semantic search
   */
  constructor(kg, opts = {}) {
    this.kg = kg;
    this._embeddingsProvider = opts.embeddingsProvider || null;
  }

  /**
   * Build a context string assembling the right memory layers.
   *
   * @param {Object} [opts]
   * @param {string} [opts.topic] - Topic to load on-demand context for
   * @param {number} [opts.maxTokens=800] - Approximate token budget
   * @param {boolean} [opts.includeL3=false] - Whether to include deep search
   * @param {string} [opts.query] - Free-text query for L3 semantic search
   * @returns {Promise<{ text: string, layers: string[], estimatedTokens: number }>}
   */
  async buildContext(opts = {}) {
    const maxTokens = opts.maxTokens ?? 800;
    const layers = [];
    let totalTokens = 0;

    // L0: Identity — always loaded (~100 tokens)
    const l0 = this._buildL0();
    if (l0) {
      const l0Tokens = this._estimateTokens(l0);
      layers.push({ level: 'L0', text: l0, tokens: l0Tokens });
      totalTokens += l0Tokens;
    }

    // L1: Essential — top memory nodes (~500 tokens)
    if (totalTokens < maxTokens) {
      const budget = Math.min(500, maxTokens - totalTokens);
      const l1 = this._buildL1(budget);
      if (l1) {
        const l1Tokens = this._estimateTokens(l1);
        layers.push({ level: 'L1', text: l1, tokens: l1Tokens });
        totalTokens += l1Tokens;
      }
    }

    // L2: On-demand — topic-specific (~200-500 tokens)
    if (opts.topic && totalTokens < maxTokens) {
      const budget = Math.min(500, maxTokens - totalTokens);
      const l2 = this._buildL2(opts.topic, budget);
      if (l2) {
        const l2Tokens = this._estimateTokens(l2);
        layers.push({ level: 'L2', text: l2, tokens: l2Tokens });
        totalTokens += l2Tokens;
      }
    }

    // L3: Deep search — semantic search (only if explicitly requested)
    if (opts.includeL3 && opts.query && totalTokens < maxTokens) {
      const budget = maxTokens - totalTokens;
      const l3 = await this._buildL3(opts.query, budget);
      if (l3) {
        const l3Tokens = this._estimateTokens(l3);
        layers.push({ level: 'L3', text: l3, tokens: l3Tokens });
        totalTokens += l3Tokens;
      }
    }

    const text = layers.map(l => l.text).join('\n\n');

    return {
      text,
      layers: layers.map(l => l.level),
      estimatedTokens: totalTokens,
    };
  }

  // ── Layer Builders ──────────────────────────────────────

  /**
   * L0: Core identity — who is this user?
   * Compact: roles, location, key attributes.
   */
  _buildL0() {
    const identities = this.kg.getActiveIdentities?.() || [];
    if (identities.length === 0) return null;

    const topIdentities = identities
      .sort((a, b) => (b.salience || 0) - (a.salience || 0))
      .slice(0, 5);

    const lines = ['[Identity]'];
    for (const id of topIdentities) {
      lines.push(`${id.role}${id.context ? ': ' + id.context : ''}`);
    }

    return lines.join('\n');
  }

  /**
   * L1: Essential story — highest-importance beliefs, preferences, interests.
   * Always loaded after L0.
   */
  _buildL1(tokenBudget) {
    const beliefs = this.kg.getActiveBeliefs?.() || [];
    const prefs = this.kg.getActivePreferences?.() || [];
    const interests = this.kg.user?.interests || [];

    const lines = [];

    // Top interests by weight
    const topInterests = interests
      .map(i => ({ topic: i.topic, weight: this.kg.getInterestWeight(i.topic) }))
      .filter(i => i.weight > 0.1)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 8);

    if (topInterests.length) {
      lines.push('[Interests]');
      lines.push(topInterests.map(i => `${i.topic}(${(i.weight * 100).toFixed(0)}%)`).join(', '));
    }

    // Strongest beliefs
    const topBeliefs = beliefs
      .sort((a, b) => (b.strength || 0) - (a.strength || 0))
      .slice(0, 5);

    if (topBeliefs.length) {
      lines.push('[Beliefs]');
      for (const b of topBeliefs) {
        lines.push(`${b.topic}: ${b.claim}`);
      }
    }

    // Strongest preferences
    const topPrefs = prefs
      .sort((a, b) => Math.abs(b.strength || 0) - Math.abs(a.strength || 0))
      .slice(0, 5);

    if (topPrefs.length) {
      lines.push('[Preferences]');
      for (const p of topPrefs) {
        const dir = p.strength > 0 ? '+' : '-';
        lines.push(`${dir} ${p.type}: ${p.description}`);
      }
    }

    const text = lines.join('\n');
    // Trim to budget
    const tokens = this._estimateTokens(text);
    if (tokens <= tokenBudget) return text;

    // Truncate by removing last entries
    return text.slice(0, tokenBudget * 4); // rough: 4 chars ≈ 1 token
  }

  /**
   * L2: On-demand — beliefs/preferences/interests related to a specific topic.
   */
  _buildL2(topic, tokenBudget) {
    const topicLower = topic.toLowerCase();
    const beliefs = this.kg.getActiveBeliefs?.() || [];
    const prefs = this.kg.getActivePreferences?.() || [];
    const dimPrefs = this.kg.getDimensionalPreferences?.() || [];

    const lines = [`[Context: ${topic}]`];

    // Beliefs mentioning this topic
    const relBeliefs = beliefs.filter(b =>
      b.topic?.toLowerCase().includes(topicLower) ||
      b.claim?.toLowerCase().includes(topicLower)
    );
    for (const b of relBeliefs.slice(0, 5)) {
      lines.push(`Belief: ${b.topic} — ${b.claim} (${(b.strength * 100).toFixed(0)}%)`);
    }

    // Preferences mentioning this topic
    const relPrefs = prefs.filter(p =>
      p.type?.toLowerCase().includes(topicLower) ||
      p.description?.toLowerCase().includes(topicLower)
    );
    for (const p of relPrefs.slice(0, 5)) {
      const dir = p.strength > 0 ? 'likes' : 'dislikes';
      lines.push(`Pref: ${dir} ${p.description}`);
    }

    // Dimensional preferences in this domain
    const relDim = dimPrefs.filter(d =>
      d.domain?.toLowerCase().includes(topicLower) ||
      d.dimensionId?.toLowerCase().includes(topicLower)
    );
    for (const d of relDim.slice(0, 5)) {
      lines.push(`Taste: ${d.dimensionId}=${d.value} (${d.strength?.toFixed(2)})`);
    }

    if (lines.length <= 1) return null; // only header, no relevant data

    const text = lines.join('\n');
    const tokens = this._estimateTokens(text);
    if (tokens <= tokenBudget) return text;
    return text.slice(0, tokenBudget * 4);
  }

  /**
   * L3: Deep search — semantic search over the entire KG.
   */
  async _buildL3(query, tokenBudget) {
    if (!this.kg.semanticSearch || this.kg._vectorIndex?.size === 0) return null;

    try {
      const results = await this.kg.semanticSearch(query, 10, this._embeddingsProvider);
      if (!results.length) return null;

      const lines = [`[Deep search: "${query}"]`];
      for (const r of results) {
        const line = `[${r.type}] ${r.text} (sim: ${r.similarity.toFixed(2)})`;
        lines.push(line);
        if (this._estimateTokens(lines.join('\n')) > tokenBudget) {
          lines.pop();
          break;
        }
      }

      return lines.length > 1 ? lines.join('\n') : null;
    } catch {
      return null;
    }
  }

  // ── Utilities ───────────────────────────────────────────

  /**
   * Rough token estimation (~4 chars per token for English text).
   */
  _estimateTokens(text) {
    return Math.ceil(text.length / 4);
  }
}
