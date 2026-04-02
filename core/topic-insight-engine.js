/**
 * Topic Insight Engine — Flexible, Domain-Agnostic Preference Learning
 *
 * Replaces hardcoded domain-schemas.js and question-engine.js.
 * Uses LLM to dynamically discover what dimensions of ANY item
 * are predictive of human preference, then runs gap simulation
 * to generate weighted hypotheses stored as KG nodes.
 *
 * Core flow:
 *   item + reaction → LLM dimension analysis → gap simulation → KG enrichment
 */

/**
 * TopicInsightEngine: receives an item, calls LLM to discover preference-relevant
 * dimensions, then runs GapSimulator to fill knowledge gaps.
 */
export class TopicInsightEngine {
  /**
   * @param {Object} opts
   * @param {function} opts.llmCall - async (prompt: string) => string
   * @param {string} [opts.model='claude-haiku'] - model hint (informational)
   * @param {number} [opts.maxDimensions=8] - max dimensions to extract per item
   */
  constructor(opts = {}) {
    this.llmCall = opts.llmCall || null;
    this.model = opts.model || 'claude-haiku';
    this.maxDimensions = opts.maxDimensions || 8;
    this.gapSimulator = new GapSimulator({ llmCall: opts.llmCall });
    this._dimensionCache = new Map(); // itemType → recent dimensions for dedup
  }

  /**
   * Main entry: analyse an item after a user reaction, enrich the KG.
   * @param {Object} item - Any content item with metadata
   * @param {string} reaction - 'up', 'down', 'skip', 'share'
   * @param {import('./kg.js').KnowledgeGraph} kg - The knowledge graph to enrich
   * @returns {Promise<{dimensions: Object[], hypotheses: Object[], nodesWritten: number}>}
   */
  async analyse(item, reaction, kg) {
    // Step 1: Extract dimensions (LLM or fallback)
    const dimensions = await this.extractDimensions(item);
    if (dimensions.length === 0) {
      return { dimensions: [], hypotheses: [], nodesWritten: 0 };
    }

    // Step 2: For each dimension, check if KG already has evidence
    const gaps = [];
    const knownDims = [];
    for (const dim of dimensions) {
      const existing = this.#findExistingEvidence(dim, kg);
      if (existing) {
        knownDims.push({ ...dim, existing });
      } else {
        gaps.push(dim);
      }
    }

    // Step 3: Run gap simulation on dimensions with no KG evidence
    const ratedHistory = (kg.user?.history || []).slice(-50);
    const hypotheses = await this.gapSimulator.simulate(item, gaps, ratedHistory, reaction);

    // Step 4: Write surviving hypotheses to KG as typed nodes
    let nodesWritten = 0;
    const isPositive = reaction === 'up' || reaction === 'share';
    const strengthDelta = isPositive ? 0.15 : -0.10;

    for (const h of hypotheses) {
      this.#writeHypothesisToKG(h, kg, strengthDelta, isPositive);
      nodesWritten++;
    }

    // Step 5: Also reinforce known dimensions based on reaction
    for (const dim of knownDims) {
      this.#reinforceDimension(dim, kg, strengthDelta);
      nodesWritten++;
    }

    return { dimensions, hypotheses, nodesWritten };
  }

  /**
   * Extract preference-relevant dimensions from an item using LLM.
   * Falls back to heuristic extraction if no LLM available.
   * @param {Object} item
   * @returns {Promise<Array<{id: string, label: string, value: string, kgType: string}>>}
   */
  async extractDimensions(item) {
    if (this.llmCall) {
      return this.#llmExtractDimensions(item);
    }
    return this.#heuristicExtractDimensions(item);
  }

  /**
   * LLM-powered dimension extraction — fully generic, no hardcoded domains.
   */
  async #llmExtractDimensions(item) {
    const meta = item.metadata || item;
    const itemSnapshot = JSON.stringify({
      title: item.title || meta.title,
      type: item.type || item.domain || meta.type,
      summary: item.summary || item.description || meta.summary,
      tags: item.tags || meta.tags,
      ...this.#pickRelevantMeta(meta)
    });

    const prompt = `You are a preference-analysis system. Given this item, identify the ${this.maxDimensions} most preference-predictive dimensions — aspects that would differ between people who love vs hate this item.

Item: ${itemSnapshot}

For each dimension return a JSON object with:
- id: snake_case identifier (e.g. "narrative_complexity", "cuisine_type", "price_point")
- label: human-readable name
- value: the item's actual value for this dimension (be specific)
- kgType: one of "belief", "preference", or "identity"
  - belief = factual/opinion (e.g. "this director is great")
  - preference = taste dimension (e.g. "likes slow-burn pacing")
  - identity = self-concept alignment (e.g. "values existential themes")

Return ONLY a JSON array, no markdown, no explanation.`;

    try {
      const response = await this.llmCall(prompt);
      const cleaned = response.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) {
        return parsed.slice(0, this.maxDimensions).map(d => ({
          id: String(d.id || '').replace(/\s+/g, '_').toLowerCase(),
          label: String(d.label || d.id || ''),
          value: String(d.value || '').toLowerCase().trim(),
          kgType: ['belief', 'preference', 'identity'].includes(d.kgType) ? d.kgType : 'preference'
        })).filter(d => d.id && d.value);
      }
    } catch (e) {
      // LLM failed — fall back to heuristic
    }
    return this.#heuristicExtractDimensions(item);
  }

  /**
   * Heuristic fallback: extract dimensions from item metadata without LLM.
   * Works for any item type by inspecting available fields.
   */
  #heuristicExtractDimensions(item) {
    const meta = item.metadata || item;
    const dims = [];

    // Map of common metadata fields to dimension types
    const fieldMap = {
      director: { kgType: 'belief', label: 'Director/Creator Style' },
      author: { kgType: 'belief', label: 'Author' },
      creator: { kgType: 'belief', label: 'Creator' },
      artist: { kgType: 'belief', label: 'Artist' },
      genre: { kgType: 'preference', label: 'Genre' },
      genres: { kgType: 'preference', label: 'Genre' },
      style: { kgType: 'preference', label: 'Style' },
      pacing: { kgType: 'preference', label: 'Pacing' },
      themes: { kgType: 'identity', label: 'Themes' },
      cuisine: { kgType: 'preference', label: 'Cuisine Type' },
      price_point: { kgType: 'preference', label: 'Price Point' },
      ambience: { kgType: 'preference', label: 'Ambience' },
      era: { kgType: 'preference', label: 'Era' },
      year: { kgType: 'preference', label: 'Era' },
      tone: { kgType: 'preference', label: 'Tone' },
      format: { kgType: 'preference', label: 'Format' },
      language: { kgType: 'preference', label: 'Language' },
      complexity: { kgType: 'preference', label: 'Complexity' },
      topic: { kgType: 'preference', label: 'Topic' },
      category: { kgType: 'preference', label: 'Category' },
      mood: { kgType: 'identity', label: 'Mood' },
      cast: { kgType: 'belief', label: 'Cast' },
    };

    for (const [field, config] of Object.entries(fieldMap)) {
      const val = meta[field];
      if (!val) continue;
      const values = Array.isArray(val) ? val : [val];
      for (const v of values) {
        dims.push({
          id: field.replace(/\s+/g, '_').toLowerCase(),
          label: config.label,
          value: String(v).toLowerCase().trim(),
          kgType: config.kgType
        });
      }
    }

    // Extract from tags
    if (item.tags && Array.isArray(item.tags)) {
      for (const tag of item.tags.slice(0, 5)) {
        dims.push({
          id: 'tag',
          label: 'Tag',
          value: String(tag).toLowerCase().trim(),
          kgType: 'preference'
        });
      }
    }

    // Year → era mapping
    const text = `${item.title || ''} ${item.summary || item.description || ''}`;
    const yearMatch = text.match(/\b(19[2-9]\d|20[0-2]\d)\b/);
    if (yearMatch && !dims.find(d => d.id === 'era' || d.id === 'year')) {
      const year = parseInt(yearMatch[1]);
      let era;
      if (year < 1970) era = 'classic_pre1970';
      else if (year < 1990) era = '1970s_1980s';
      else if (year < 2010) era = '1990s_2000s';
      else era = 'modern_2010s_plus';
      dims.push({ id: 'era', label: 'Era', value: era, kgType: 'preference' });
    }

    return dims.slice(0, this.maxDimensions);
  }

  /**
   * Pick relevant metadata fields (skip noisy ones like raw HTML).
   */
  #pickRelevantMeta(meta) {
    const skip = new Set(['id', 'url', 'html', 'raw', 'content', 'body', 'metadata']);
    const picked = {};
    for (const [k, v] of Object.entries(meta)) {
      if (skip.has(k)) continue;
      if (typeof v === 'string' && v.length > 200) continue;
      if (typeof v === 'object' && !Array.isArray(v)) continue;
      picked[k] = v;
    }
    return picked;
  }

  /**
   * Check if KG already has evidence about this dimension.
   */
  #findExistingEvidence(dim, kg) {
    if (dim.kgType === 'belief') {
      return kg.getBelief?.(dim.id) || null;
    }
    if (dim.kgType === 'preference') {
      const prefs = kg.getPreferences?.(dim.id) || [];
      return prefs.find(p => p.description?.toLowerCase() === dim.value) || null;
    }
    if (dim.kgType === 'identity') {
      const ids = kg.getIdentities?.() || [];
      return ids.find(i => i.role?.toLowerCase() === dim.id) || null;
    }
    return null;
  }

  /**
   * Write a hypothesis to the KG as a typed node.
   */
  #writeHypothesisToKG(hypothesis, kg, strengthDelta, isPositive) {
    const baseStrength = isPositive ? 0.6 : 0.3;
    const confidence = hypothesis.confidence || 0.4;
    const adjustedStrength = baseStrength * confidence;

    if (hypothesis.kgType === 'belief') {
      kg.addBelief(hypothesis.dimensionId, hypothesis.value, adjustedStrength);
    } else if (hypothesis.kgType === 'preference') {
      const existing = kg.getPreferences(hypothesis.dimensionId)
        ?.find(p => p.description?.toLowerCase() === hypothesis.value?.toLowerCase());
      const current = existing?.strength || 0.5;
      const newStrength = Math.max(-1, Math.min(1, current + strengthDelta * confidence));
      kg.addPreference(hypothesis.dimensionId, hypothesis.value, newStrength);
    } else if (hypothesis.kgType === 'identity') {
      kg.addIdentity(hypothesis.dimensionId, hypothesis.value, adjustedStrength);
    }
  }

  /**
   * Reinforce an existing dimension based on the reaction.
   */
  #reinforceDimension(dim, kg, strengthDelta) {
    if (dim.kgType === 'belief' && dim.existing) {
      const newStrength = Math.min(1, (dim.existing.strength || 0.5) + strengthDelta * 0.5);
      kg.addBelief(dim.id, dim.value, newStrength);
    } else if (dim.kgType === 'preference') {
      const current = dim.existing?.strength || 0.5;
      kg.addPreference(dim.id, dim.value, Math.max(-1, Math.min(1, current + strengthDelta)));
    } else if (dim.kgType === 'identity') {
      const current = dim.existing?.salience || 0.5;
      kg.addIdentity(dim.id, dim.value, Math.min(1, current + strengthDelta * 0.5));
    }
  }
}


/**
 * GapSimulator: for dimensions with no KG evidence, generates plausible
 * hypotheses about user preferences and eliminates unrealistic ones
 * by cross-checking against rated history.
 */
export class GapSimulator {
  constructor(opts = {}) {
    this.llmCall = opts.llmCall || null;
    this.hypothesesPerGap = opts.hypothesesPerGap || 3;
  }

  /**
   * For each gap dimension, generate hypotheses and filter them.
   * @param {Object} item - The item being rated
   * @param {Array} gaps - Dimensions with no KG evidence
   * @param {Array} ratedHistory - Recent rated items from KG history
   * @param {string} reaction - Current reaction
   * @returns {Promise<Array<{dimensionId: string, value: string, kgType: string, confidence: number, reasoning: string}>>}
   */
  async simulate(item, gaps, ratedHistory, reaction) {
    if (gaps.length === 0) return [];

    if (this.llmCall) {
      return this.#llmSimulate(item, gaps, ratedHistory, reaction);
    }
    return this.#heuristicSimulate(item, gaps, ratedHistory, reaction);
  }

  /**
   * LLM-powered gap simulation.
   */
  async #llmSimulate(item, gaps, ratedHistory, reaction) {
    const isPositive = reaction === 'up' || reaction === 'share';
    const reactionWord = isPositive ? 'liked' : 'disliked';

    // Build history context (compact)
    const historyContext = ratedHistory
      .filter(h => h.reaction === 'up' || h.reaction === 'down' || h.reaction === 'share')
      .slice(-20)
      .map(h => `${h.reaction === 'down' ? 'disliked' : 'liked'}: ${h.topics?.join(', ') || h.story_id}`)
      .join('\n');

    const gapDescriptions = gaps.map(g => `- ${g.id} (${g.label}): item's value = "${g.value}"`).join('\n');

    const prompt = `A user ${reactionWord} this item: "${item.title || 'unknown'}"

Unknown preference dimensions (no prior data):
${gapDescriptions}

User's recent reaction history:
${historyContext || '(no history yet)'}

For each dimension, generate ${this.hypothesesPerGap} hypotheses about WHY the user might ${reactionWord.slice(0, -1)} items with that dimension value. Then eliminate hypotheses that contradict the reaction history.

Return ONLY a JSON array of surviving hypotheses:
[{"dimensionId": "...", "value": "...", "kgType": "belief|preference|identity", "confidence": 0.0-1.0, "reasoning": "..."}]

Rules:
- confidence should be lower (0.2-0.4) with little history, higher (0.5-0.8) with corroborating evidence
- Eliminate hypotheses that contradict the user's history
- Keep only hypotheses that survive cross-checking`;

    try {
      const response = await this.llmCall(prompt);
      const cleaned = response.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) {
        return parsed.map(h => ({
          dimensionId: String(h.dimensionId || ''),
          value: String(h.value || '').toLowerCase().trim(),
          kgType: ['belief', 'preference', 'identity'].includes(h.kgType) ? h.kgType : 'preference',
          confidence: Math.max(0, Math.min(1, Number(h.confidence) || 0.3)),
          reasoning: String(h.reasoning || '')
        })).filter(h => h.dimensionId && h.value);
      }
    } catch (e) {
      // LLM failed — fall back
    }
    return this.#heuristicSimulate(item, gaps, ratedHistory, reaction);
  }

  /**
   * Heuristic gap simulation without LLM.
   * Generates simple hypotheses based on the reaction direction.
   */
  #heuristicSimulate(item, gaps, ratedHistory, reaction) {
    const isPositive = reaction === 'up' || reaction === 'share';
    const hypotheses = [];

    // Count corroborating evidence from history
    const topicCounts = {};
    for (const h of ratedHistory) {
      const hPositive = h.reaction === 'up' || h.reaction === 'share';
      for (const t of (h.topics || [])) {
        const key = t.toLowerCase();
        topicCounts[key] = (topicCounts[key] || 0) + (hPositive === isPositive ? 1 : -1);
      }
    }

    for (const gap of gaps) {
      // Base confidence from history corroboration
      const corroboration = topicCounts[gap.value] || 0;
      const confidence = Math.min(0.7, Math.max(0.15, 0.3 + corroboration * 0.1));

      hypotheses.push({
        dimensionId: gap.id,
        value: gap.value,
        kgType: gap.kgType,
        confidence,
        reasoning: isPositive
          ? `User liked item with ${gap.id}="${gap.value}" — possible preference`
          : `User disliked item with ${gap.id}="${gap.value}" — possible aversion`
      });
    }

    return hypotheses;
  }
}
