/**
 * rapid-feedback.js — Accelerated Learning from User Reactions
 *
 * Designed for the Vivo use case: curate 10 stories/day → user reacts →
 * next day should be 3-10x better at understanding the user.
 *
 * Traditional recommendation: slow gradient descent over weeks.
 * Marble rapid feedback: each reaction is a HIGH-SIGNAL event because
 * the user only sees 10 curated stories. Every up/down/skip/share
 * carries massive information density.
 *
 * The key insight: when you show 10 stories and get feedback on all 10,
 * you learn not just "liked this" but the CONTRAST — "liked this BUT NOT that."
 * That contrast is worth more than 100 passive impressions.
 *
 * Flow:
 *   1. User reacts to a curated slate (10 stories)
 *   2. Extract contrastive signal: what was chosen vs what was rejected
 *   3. Infer WHY via the investigative committee (one LLM call, not per-story)
 *   4. Apply inferences as strong beliefs/preferences to KG
 *   5. Trigger revelation events to kill contradicting clones
 *   6. Re-weight scoring dimensions based on what worked
 *
 * Expected improvement trajectory:
 *   Day 1: Generic (popularity + broad interests)
 *   Day 2: 3-5x better (contrastive learning from day 1 reactions)
 *   Day 3: 5-10x better (pattern confirmation + clone convergence)
 *   Day 5+: Refined (subtle preferences, timing patterns, source trust)
 */

export class RapidFeedbackEngine {
  /**
   * @param {Object} kg - KnowledgeGraph instance
   * @param {Function} llmCall - async (prompt: string) => string
   * @param {Object} [opts]
   * @param {import('./evolution.js').ClonePopulation} [opts.clonePopulation]
   */
  constructor(kg, llmCall, opts = {}) {
    this.kg = kg;
    this.llmCall = llmCall;
    this.clonePopulation = opts.clonePopulation || null;
    this._feedbackHistory = []; // track daily feedback for trajectory analysis
  }

  /**
   * Process a full slate of reactions at once.
   * This is the key method — it extracts maximum signal from the contrast
   * between what the user engaged with vs what they rejected.
   *
   * @param {Array<{ story: Object, reaction: 'up'|'down'|'skip'|'share' }>} slateReactions
   * @returns {Promise<{ inferences: Object[], revelations: Object[], dimensionUpdates: Object }>}
   */
  async processBatch(batchReactions) {
    const slateReactions = batchReactions; // internal alias for backward compat below
    if (!slateReactions?.length) return { inferences: [], revelations: [], dimensionUpdates: {} };

    // Step 1: Separate into engaged vs rejected
    const engaged = slateReactions.map(r => ({ story: r.story || r.item, reaction: r.reaction })).filter(r => ['up', 'share'].includes(r.reaction));
    const rejected = slateReactions.map(r => ({ story: r.story || r.item, reaction: r.reaction })).filter(r => ['down', 'skip'].includes(r.reaction));
    const shared = slateReactions.map(r => ({ story: r.story || r.item, reaction: r.reaction })).filter(r => r.reaction === 'share');

    // Step 2: Record all reactions in KG
    const normalized = slateReactions.map(r => ({ story: r.story || r.item, reaction: r.reaction }));
    for (const { story, reaction } of normalized) {
      for (const topic of story.topics || []) {
        if (['up', 'share'].includes(reaction)) {
          this.kg.boostInterest(topic, reaction === 'share' ? 0.2 : 0.1);
        } else if (reaction === 'down') {
          this.kg.boostInterest(topic, -0.15);
        }
      }
      if (typeof this.kg.recordReaction === 'function') {
        this.kg.recordReaction(story.id || story.title, reaction, story.topics || [], story.source || '', story);
      }
    }

    // Step 3: Contrastive analysis — WHY did they choose these over those?
    const inferences = await this._contrastiveAnalysis(engaged, rejected, shared);

    // Step 4: Apply inferences as strong beliefs/preferences
    const revelations = [];
    for (const inf of inferences) {
      const strength = Math.min(0.9, 0.6 + inf.confidence * 0.3);

      if (inf.type === 'belief') {
        this.kg.addBelief(inf.topic, inf.value, strength);
        if (inf.confidence >= 0.8) {
          revelations.push({ type: 'belief', topic: inf.topic, value: inf.value, confidence: inf.confidence });
        }
      } else if (inf.type === 'preference') {
        this.kg.addPreference(inf.topic, inf.value, inf.isPositive ? strength : -strength);
      } else if (inf.type === 'identity') {
        this.kg.addIdentity(inf.topic, inf.value, strength);
      }

      // Tag emotions if detected
      if (inf.emotions?.length && typeof this.kg.tagEmotions === 'function') {
        const kgType = inf.type === 'decision' ? 'belief' : inf.type;
        if (['belief', 'preference', 'identity'].includes(kgType)) {
          this.kg.tagEmotions(kgType, inf.topic, inf.emotions);
        }
      }
    }

    // Step 5: Trigger revelation events on clone population
    if (this.clonePopulation && revelations.length > 0) {
      for (const rev of revelations) {
        this.clonePopulation.applyRevelation(rev);
      }
    }

    // Step 6: Compute dimension weight updates based on what predicted correctly
    const dimensionUpdates = this._computeDimensionUpdates(slateReactions);

    // Track for trajectory analysis
    this._feedbackHistory.push({
      timestamp: Date.now(),
      slateSize: slateReactions.length,
      engaged: engaged.length,
      rejected: rejected.length,
      shared: shared.length,
      inferencesGenerated: inferences.length,
      revelationsTriggered: revelations.length,
    });

    return { inferences, revelations, dimensionUpdates };
  }

  /**
   * @deprecated Use processBatch() instead. Kept for backward compatibility.
   */
  async processSlate(slateReactions) {
    return this.processBatch(slateReactions);
  }

  /**
   * Get the learning trajectory — how much has the model improved?
   * @returns {Object} trajectory stats
   */
  getLearningTrajectory() {
    const history = this._feedbackHistory;
    if (history.length === 0) return { days: 0, totalReactions: 0, engagementTrend: [] };

    // Group by day
    const byDay = new Map();
    for (const entry of history) {
      const day = new Date(entry.timestamp).toISOString().slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(entry);
    }

    const engagementTrend = [];
    for (const [day, entries] of byDay) {
      const totalItems = entries.reduce((s, e) => s + e.slateSize, 0);
      const totalEngaged = entries.reduce((s, e) => s + e.engaged, 0);
      engagementTrend.push({
        day,
        engagementRate: totalItems > 0 ? totalEngaged / totalItems : 0,
        inferences: entries.reduce((s, e) => s + e.inferencesGenerated, 0),
        revelations: entries.reduce((s, e) => s + e.revelationsTriggered, 0),
      });
    }

    return {
      days: byDay.size,
      totalReactions: history.reduce((s, e) => s + e.slateSize, 0),
      engagementTrend,
      improvementEstimate: this._estimateImprovement(engagementTrend),
    };
  }

  // ── Private ──────────────────────────────────────────

  /**
   * Contrastive analysis: one LLM call to understand WHY engaged > rejected.
   * This is where the magic happens — the contrast between choices reveals
   * deep preferences that individual reactions can't.
   */
  async _contrastiveAnalysis(engaged, rejected, shared) {
    if (engaged.length === 0 && rejected.length === 0) return [];

    const engagedDesc = engaged.map(r =>
      `[${r.reaction.toUpperCase()}] "${r.story.title}" — Topics: ${(r.story.topics || []).join(', ')} | Source: ${r.story.source || '?'}`
    ).join('\n');

    const rejectedDesc = rejected.map(r =>
      `[${r.reaction.toUpperCase()}] "${r.story.title}" — Topics: ${(r.story.topics || []).join(', ')} | Source: ${r.story.source || '?'}`
    ).join('\n');

    const sharedDesc = shared.length > 0
      ? `\nSHARED (highest signal — user found these worth sending to others):\n${shared.map(r => `"${r.story.title}"`).join('\n')}`
      : '';

    // Include current KG state for context
    const beliefs = this.kg.getActiveBeliefs?.() || [];
    const prefs = this.kg.getActivePreferences?.() || [];
    const ids = this.kg.getActiveIdentities?.() || [];

    const kgContext = [
      beliefs.length > 0 ? `Known beliefs: ${beliefs.slice(0, 5).map(b => b.topic).join(', ')}` : '',
      prefs.length > 0 ? `Known preferences: ${prefs.slice(0, 5).map(p => `${p.type}: ${p.description}`).join(', ')}` : '',
      ids.length > 0 ? `Known identity: ${ids.slice(0, 3).map(i => i.role).join(', ')}` : '',
    ].filter(Boolean).join('\n');

    const prompt = `You are analyzing a user's reactions to a curated news slate to understand them deeply.

${kgContext ? `WHAT WE ALREADY KNOW:\n${kgContext}\n` : ''}
ENGAGED WITH (user liked or shared these):
${engagedDesc || '(none)'}

REJECTED (user skipped or disliked these):
${rejectedDesc || '(none)'}
${sharedDesc}

Analyze the CONTRAST between what they chose and what they rejected. What does this reveal about:
1. Their actual interests (not surface topics — the underlying WHY)
2. Their content preferences (style, depth, source type, tone)
3. Their current priorities (what matters to them RIGHT NOW)
4. Any identity signals (who they see themselves as)

Return ONLY a JSON array of inferences:
[
  {
    "type": "belief"|"preference"|"identity",
    "topic": "category/topic name",
    "value": "concise inference about the user",
    "isPositive": true|false,
    "confidence": 0.0-1.0,
    "evidence": "which stories/contrast led to this inference",
    "emotions": ["emotion1", "emotion2"]
  }
]

Rules:
- Focus on CONTRASTS, not individual items
- High confidence (0.8+) only for clear, repeated patterns
- Prefer deep inferences over surface-level observations
- If shared: these are the STRONGEST signals — what made them share-worthy?`;

    try {
      const raw = await this.llmCall(prompt);
      return this._parseInferences(raw);
    } catch (err) {
      console.warn('[RapidFeedback] Contrastive analysis failed:', err.message);
      return [];
    }
  }

  /**
   * Compute scoring dimension weight updates based on which dimensions
   * predicted engagement correctly.
   */
  _computeDimensionUpdates(slateReactions) {
    const updates = {};

    for (const r of slateReactions) {
      const story = r.story || r.item;
      const reaction = r.reaction;
      const wasEngaged = ['up', 'share'].includes(reaction);
      const scores = story._marble_scores || story.agent_scores || {};

      for (const [dimension, score] of Object.entries(scores)) {
        if (!updates[dimension]) updates[dimension] = { correct: 0, total: 0 };
        updates[dimension].total++;

        const predicted = score > 0.5;
        if (predicted === wasEngaged) updates[dimension].correct++;
      }
    }

    // Convert to accuracy and weight adjustment
    for (const [dim, data] of Object.entries(updates)) {
      data.accuracy = data.total > 0 ? data.correct / data.total : 0.5;
      // Dimensions that predicted well should get more weight
      data.weightDelta = (data.accuracy - 0.5) * 0.1; // ±5% adjustment
    }

    return updates;
  }

  /**
   * Estimate improvement multiplier from engagement trend.
   */
  _estimateImprovement(trend) {
    if (trend.length < 2) return '1x (insufficient data)';

    const firstDay = trend[0].engagementRate;
    const lastDay = trend[trend.length - 1].engagementRate;

    if (firstDay === 0) return lastDay > 0 ? 'improved from zero' : '1x';

    const multiplier = lastDay / firstDay;
    return `${multiplier.toFixed(1)}x`;
  }

  _parseInferences(raw) {
    try {
      const s = String(raw).trim();
      // Try direct parse
      try { return this._validateInferences(JSON.parse(s)); } catch {}
      // Fence extraction
      const fence = s.match(/```json?\s*\n?([\s\S]*?)\n?\s*```/);
      if (fence) { try { return this._validateInferences(JSON.parse(fence[1].trim())); } catch {} }
      // Bracket extraction
      const arr = s.indexOf('['), arrE = s.lastIndexOf(']');
      if (arr !== -1 && arrE > arr) { try { return this._validateInferences(JSON.parse(s.slice(arr, arrE + 1))); } catch {} }
      return [];
    } catch {
      return [];
    }
  }

  _validateInferences(parsed) {
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(inf =>
      inf && typeof inf === 'object' &&
      ['belief', 'preference', 'identity'].includes(inf.type) &&
      inf.topic && inf.value
    ).map(inf => ({
      ...inf,
      confidence: Math.max(0, Math.min(1, inf.confidence || 0.6)),
      emotions: Array.isArray(inf.emotions) ? inf.emotions : [],
    }));
  }
}
