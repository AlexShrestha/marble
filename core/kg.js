/**
 * Marble Knowledge Graph
 *
 * User-centric graph where the user is the root node.
 * Stories are scored by their distance to what matters to the user right now.
 *
 * Layer 1 - Typed Memory Nodes:
 * - belief: Core beliefs about topics/domains
 * - preference: Explicit preferences and patterns
 * - identity: Role/identity attributes about the user
 * - confidence: Confidence levels in knowledge areas
 */

import { readFile, writeFile } from 'fs/promises';
import { extractEntityAttributes } from './entity-extractor.js';

export class KnowledgeGraph {
  constructor(dataPath) {
    this.dataPath = dataPath;
    this.user = null;
    this.stories = new Map();
    this._topicInsightEngine = null;     // TopicInsightEngine for LLM-powered enrichment
    this._dimensionalPreferences = [];   // DimensionalPreference[] tracking
    this._lastInsightResult = null;      // Last enrichment result for debugging
  }

  /**
   * Attach a TopicInsightEngine to enable LLM-powered preference enrichment on every reaction.
   * @param {import('./topic-insight-engine.js').TopicInsightEngine} engine
   */
  setTopicInsightEngine(engine) {
    this._topicInsightEngine = engine;
  }

  async load() {
    try {
      const raw = await readFile(this.dataPath, 'utf-8');
      const data = JSON.parse(raw);
      this.user = data.user || this.#defaultUser();
      this._dimensionalPreferences = data._dimensionalPreferences || [];
      return this;
    } catch {
      this.user = this.#defaultUser();
      this._dimensionalPreferences = [];
      return this;
    }
  }

  async save() {
    const data = {
      user: this.user,
      _dimensionalPreferences: this._dimensionalPreferences,
      updated_at: new Date().toISOString()
    };
    await writeFile(this.dataPath, JSON.stringify(data, null, 2));
  }

  /**
   * Get interest weight for a topic. Returns 0 if no interest registered.
   */
  getInterestWeight(topic) {
    const interest = this.user.interests.find(i =>
      i.topic.toLowerCase() === topic.toLowerCase()
    );
    if (!interest) return 0;
    return this.#applyDecay(interest);
  }

  /**
   * Boost interest weight based on positive reaction
   */
  boostInterest(topic, amount = 0.1) {
    let interest = this.user.interests.find(i =>
      i.topic.toLowerCase() === topic.toLowerCase()
    );
    if (!interest) {
      interest = { topic, weight: 0, last_boost: new Date().toISOString(), trend: 'rising' };
      this.user.interests.push(interest);
    }
    interest.weight = Math.min(1, interest.weight + amount);
    interest.last_boost = new Date().toISOString();
    interest.trend = 'rising';
  }

  /**
   * Decay interest weight based on negative reaction
   */
  decayInterest(topic, amount = 0.05) {
    const interest = this.user.interests.find(i =>
      i.topic.toLowerCase() === topic.toLowerCase()
    );
    if (!interest) return;
    interest.weight = Math.max(0, interest.weight - amount);
    interest.trend = 'falling';
  }

  /**
   * Record a reaction and update interest weights
   * @param {string} storyId - ID of the story being rated
   * @param {string} reaction - Reaction type: 'up', 'down', 'skip', 'share'
   * @param {string[]} topics - Topic tags for the story
   * @param {string} source - Source of the story
   * @param {Object} [item=null] - Optional item metadata for secondary context extraction
   */
  recordReaction(storyId, reaction, topics, source, item = null) {
    const historyEntry = {
      story_id: storyId,
      reaction,
      date: new Date().toISOString(),
      topics,
      source
    };

    // Extract and store secondary context if item metadata provided
    if (item) {
      const { domain, attributes } = extractEntityAttributes(item);
      if (domain && Object.keys(attributes).length > 0) {
        this.#extractSecondaryContext(attributes, reaction);
        historyEntry.entity_attributes = attributes;
        historyEntry.context_collected = true;

        // Track dimensional preferences from extracted attributes
        this.#trackDimensionalPreferences(domain, attributes, reaction);
      }

      // Run TopicInsightEngine for LLM-powered enrichment (async, fire-and-forget)
      if (this._topicInsightEngine) {
        this._topicInsightEngine.analyse(item, reaction, this)
          .then(result => { this._lastInsightResult = result; })
          .catch(() => {}); // Silently ignore enrichment failures
      }
    }

    this.user.history.push(historyEntry);

    // Update interest weights based on reaction
    for (const topic of topics) {
      if (reaction === 'up' || reaction === 'share') {
        this.boostInterest(topic, reaction === 'share' ? 0.15 : 0.1);
      } else if (reaction === 'down') {
        this.decayInterest(topic, 0.05);
      }
    }

    // Update source trust
    this.#updateSourceTrust(source, reaction);

    // Feed wired QuestionEngine (implicit context extraction)
    if (this._questionEngine && item) {
      const rating = reaction === 'up' || reaction === 'share' ? 5 : reaction === 'down' ? 1 : 3;
      const domain = item?.domain ?? (item?.metadata?.domain ?? 'general');
      this._questionEngine.ratingHistory.push({ item, rating, domain, timestamp: new Date().toISOString() });
      const threshold = this._qeOpts?.batchedQuestionThreshold ?? 5;
      if (this._questionEngine.ratingHistory.length % threshold === 0) {
        // Generate batched questions placeholder
        this._pendingQuestions = [{ type: 'implicit_pattern', generatedAt: new Date().toISOString() }];
      }
    }

    // Note: CF integration should be handled at application layer
    // to avoid circular dependencies and keep KG focused on core knowledge

    // Trim history to last 500 entries
    if (this.user.history.length > 500) {
      this.user.history = this.user.history.slice(-500);
    }

    // Persist to disk (fire-and-forget — prevents _dimensionalPreferences loss on restart)
    this.save();
  }

  /**
   * Extract and store secondary context from rated item attributes
   * Writes typed KG nodes (beliefs, preferences, identities) based on extracted attributes
   * @private
   * @param {Object} attributes - Extracted entity attributes from entity-extractor
   * @param {string} reaction - User's reaction to the item
   */
  #extractSecondaryContext(attributes, reaction) {
    const isPositive = reaction === 'up' || reaction === 'share';

    // Determine strength modifiers based on reaction
    const strengthDelta = isPositive ? 0.15 : -0.10;
    const beliefStrength = isPositive ? 0.6 : 0.3;
    const identityStrength = isPositive ? 0.6 : 0.3;

    for (const [kgKey, attrList] of Object.entries(attributes)) {
      for (const attr of attrList) {
        if (attr.kgType === 'belief') {
          // Store as belief with confidence based on reaction
          this.addBelief(kgKey, attr.value, beliefStrength);
        } else if (attr.kgType === 'preference') {
          // Get existing preference strength or start at 0.5 (neutral)
          const existing = this.getPreferences(kgKey)
            .find(p => p.description.toLowerCase() === attr.value.toLowerCase());
          const currentStrength = existing?.strength || 0.5;
          const newStrength = Math.max(-1, Math.min(1, currentStrength + strengthDelta));
          this.addPreference(kgKey, attr.value, newStrength);
        } else if (attr.kgType === 'identity') {
          // Store as identity attribute with salience based on reaction
          this.addIdentity(kgKey, attr.value, identityStrength);
        }
      }
    }
  }

  /**
   * Set today's ephemeral context
   */
  setContext(context) {
    this.user.context = { ...this.user.context, ...context };
  }

  /**
   * Get source trust score (0-1)
   */
  getSourceTrust(source) {
    return this.user.source_trust[source] ?? 0.5; // neutral default
  }

  /**
   * Check if user has seen a story recently
   */
  hasSeen(storyId) {
    return this.user.history.some(h => h.story_id === storyId);
  }

  // ── Layer 1: Typed Memory Node Methods ─────────────

  /**
   * Add a belief with bi-temporal validity.
   * If an active belief on the same topic exists with a different claim,
   * it is closed (contradiction detection) and a new fact is created.
   * @param {string} topic - Topic or domain
   * @param {string} claim - The belief statement
   * @param {number} strength - Belief strength (0-1)
   */
  addBelief(topic, claim, strength = 0.7) {
    const now = new Date().toISOString();
    const active = this.user.beliefs.find(b =>
      b.topic.toLowerCase() === topic.toLowerCase() && !b.valid_to
    );

    if (active) {
      if (active.claim === claim) {
        // Reinforce existing belief
        active.strength = Math.min(1, strength);
        active.evidence_count = (active.evidence_count || 0) + 1;
        active.recorded_at = now;
        return;
      }
      // Contradiction: close old fact
      active.valid_to = now;
    }

    this.user.beliefs.push({
      topic, claim,
      strength: Math.min(1, strength),
      evidence_count: 1,
      valid_from: now,
      valid_to: null,
      recorded_at: now
    });
  }

  /**
   * Get the currently active belief about a topic (or as-of a point in time).
   * @param {string} topic - Topic to search for
   * @param {string} [asOf] - ISO date; defaults to now
   * @returns {Object|null} Belief object or null
   */
  getBelief(topic, asOf) {
    return this.getActiveBeliefs(asOf).find(
      b => b.topic.toLowerCase() === topic.toLowerCase()
    ) || null;
  }

  /**
   * Return all beliefs that are active (valid_to is null or > asOf).
   * @param {string} [asOf] - ISO date; defaults to now
   * @returns {Array} Active beliefs
   */
  getActiveBeliefs(asOf) {
    const ts = asOf ? new Date(asOf).getTime() : Date.now();
    return this.user.beliefs.filter(b => {
      const from = b.valid_from ? new Date(b.valid_from).getTime() : 0;
      const to = b.valid_to ? new Date(b.valid_to).getTime() : Infinity;
      return from <= ts && ts < to;
    });
  }

  /**
   * Add a preference with bi-temporal validity.
   * Contradictions on same type+description close the old fact.
   * @param {string} type - Preference type (e.g., "content_style", "format", "tone")
   * @param {string} description - What the preference is
   * @param {number} strength - Preference strength (-1 to 1)
   */
  addPreference(type, description, strength = 0.7) {
    const now = new Date().toISOString();
    const active = this.user.preferences.find(p =>
      p.type.toLowerCase() === type.toLowerCase() &&
      p.description.toLowerCase() === description.toLowerCase() &&
      !p.valid_to
    );

    if (active) {
      // Reinforce — update strength in place
      active.strength = Math.max(-1, Math.min(1, strength));
      active.recorded_at = now;
      return;
    }

    this.user.preferences.push({
      type, description,
      strength: Math.max(-1, Math.min(1, strength)),
      valid_from: now,
      valid_to: null,
      recorded_at: now
    });
  }

  /**
   * Get active preferences, optionally filtered by type.
   * @param {string} [type] - Preference type to filter by
   * @param {string} [asOf] - ISO date; defaults to now
   * @returns {Array} Active preferences
   */
  getPreferences(type = null, asOf) {
    const active = this.getActivePreferences(asOf);
    if (!type) return active;
    return active.filter(p => p.type.toLowerCase() === type.toLowerCase());
  }

  /**
   * Return all preferences that are currently active.
   * @param {string} [asOf] - ISO date; defaults to now
   * @returns {Array} Active preferences
   */
  getActivePreferences(asOf) {
    const ts = asOf ? new Date(asOf).getTime() : Date.now();
    return this.user.preferences.filter(p => {
      const from = p.valid_from ? new Date(p.valid_from).getTime() : 0;
      const to = p.valid_to ? new Date(p.valid_to).getTime() : Infinity;
      return from <= ts && ts < to;
    });
  }

  /**
   * Add an identity attribute with bi-temporal validity.
   * If an active identity with the same role exists but different context, close old.
   * @param {string} role - Identity role (e.g., "engineer", "founder", "investor")
   * @param {string} context - Context for this identity
   * @param {number} salience - How central this identity is (0-1)
   */
  addIdentity(role, context = '', salience = 0.8) {
    const now = new Date().toISOString();
    const active = this.user.identities.find(i =>
      i.role.toLowerCase() === role.toLowerCase() && !i.valid_to
    );

    if (active) {
      if (active.context === context) {
        // Reinforce
        active.salience = Math.min(1, salience);
        active.recorded_at = now;
        return;
      }
      // Role context changed — close old
      active.valid_to = now;
    }

    this.user.identities.push({
      role, context,
      salience: Math.min(1, salience),
      valid_from: now,
      valid_to: null,
      recorded_at: now
    });
  }

  /**
   * Get active identity attributes
   * @param {string} [asOf] - ISO date; defaults to now
   * @returns {Array} Active identity attributes
   */
  getIdentities(asOf) {
    return this.getActiveIdentities(asOf);
  }

  /**
   * Return all identities that are currently active.
   * @param {string} [asOf] - ISO date; defaults to now
   * @returns {Array} Active identities
   */
  getActiveIdentities(asOf) {
    const ts = asOf ? new Date(asOf).getTime() : Date.now();
    return this.user.identities.filter(i => {
      const from = i.valid_from ? new Date(i.valid_from).getTime() : 0;
      const to = i.valid_to ? new Date(i.valid_to).getTime() : Infinity;
      return from <= ts && ts < to;
    });
  }

  /**
   * Set confidence in a domain (how sure user is about their knowledge)
   * @param {string} domain - Domain (e.g., "AI", "finance", "biology")
   * @param {number} confidence - Confidence level (0-1)
   */
  setDomainConfidence(domain, confidence) {
    this.user.confidence[domain] = Math.max(0, Math.min(1, confidence));
  }

  /**
   * Get confidence in a domain
   * @param {string} domain - Domain to query
   * @returns {number} Confidence level (0-1, defaults to 0.5)
   */
  getDomainConfidence(domain) {
    return this.user.confidence[domain] ?? 0.5;
  }

  /**
   * Get all typed memory nodes as a summary
   * @returns {Object} Summary of beliefs, preferences, identities, confidence
   */
  getMemoryNodesSummary() {
    const activeBeliefs = this.getActiveBeliefs();
    const activePreferences = this.getActivePreferences();
    const activeIdentities = this.getActiveIdentities();
    return {
      beliefs: activeBeliefs,
      preferences: activePreferences,
      identities: activeIdentities,
      confidence: this.user.confidence,
      total_beliefs: activeBeliefs.length,
      total_beliefs_all: this.user.beliefs.length,
      total_preferences: activePreferences.length,
      total_preferences_all: this.user.preferences.length,
      total_identities: activeIdentities.length,
      total_identities_all: this.user.identities.length,
      domains_with_confidence: Object.keys(this.user.confidence).length
    };
  }

  /**
   * Get the last insight enrichment result (for debugging/monitoring).
   * @returns {Object|null} Last TopicInsightEngine result
   */
  getLastInsightResult() {
    return this._lastInsightResult;
  }

  /**
   * Get tracked dimensional preferences
   * @param {string} [domain] - Optional domain filter
   * @returns {Array} DimensionalPreference objects
   */
  getDimensionalPreferences(domain) {
    if (!domain) return this._dimensionalPreferences;
    return this._dimensionalPreferences.filter(p => p.domain === domain);
  }

  /**
   * Wire a QuestionEngine instance into the KG so recordReaction feeds it.
   * @param {Object} qe - QuestionEngine instance
   * @param {Object} [opts] - Options (batchedQuestionThreshold, etc.)
   */
  setQuestionEngine(qe, opts = {}) {
    this._questionEngine = qe;
    this._qeOpts = opts;
    this._pendingQuestions = [];
  }

  /**
   * Return pending questions generated by the wired QuestionEngine.
   * @returns {Array}
   */
  getPendingQuestions() {
    return this._pendingQuestions ?? [];
  }

  // ── Private ──────────────────────────────────────────

  #applyDecay(interest) {
    const daysSinceBoost = (Date.now() - new Date(interest.last_boost).getTime()) / 86400000;
    const halfLife = 14; // 2 weeks half-life
    const decayFactor = Math.pow(0.5, daysSinceBoost / halfLife);
    return interest.weight * decayFactor;
  }

  /**
   * Track dimensional preferences from entity attributes (DimensionalPreference type)
   * @private
   */
  #trackDimensionalPreferences(domain, attributes, reaction) {
    const isPositive = reaction === 'up' || reaction === 'share';
    const strengthDelta = isPositive ? 0.15 : -0.10;

    for (const [kgKey, attrList] of Object.entries(attributes)) {
      for (const attr of attrList) {
        const existing = this._dimensionalPreferences.find(
          p => p.domain === domain && p.dimensionId === kgKey && p.value === attr.value
        );
        if (existing) {
          existing.strength = Math.max(-1, Math.min(1, existing.strength + strengthDelta));
          existing.evidenceCount++;
          existing.confidence = Math.min(1, existing.evidenceCount * 0.2);
        } else {
          this._dimensionalPreferences.push({
            domain,
            dimensionId: kgKey,
            value: attr.value,
            strength: isPositive ? 0.6 : -0.3,
            source: 'implicit',
            confidence: 0.2,
            evidenceCount: 1,
            collectedAt: new Date().toISOString()
          });
        }
      }
    }
  }

  #updateSourceTrust(source, reaction) {
    const current = this.user.source_trust[source] ?? 0.5;
    if (reaction === 'up' || reaction === 'share') {
      this.user.source_trust[source] = Math.min(1, current + 0.02);
    } else if (reaction === 'down') {
      this.user.source_trust[source] = Math.max(0, current - 0.03);
    }
  }

  #defaultUser() {
    return {
      id: 'default',
      interests: [],
      context: {
        calendar: [],
        active_projects: [],
        recent_conversations: [],
        mood_signal: null
      },
      history: [],
      source_trust: {},
      // Layer 1: Typed Memory Nodes
      beliefs: [],        // Core beliefs: { topic, claim, strength (0-1), evidence_count }
      preferences: [],    // Explicit preferences: { type, description, strength (0-1) }
      identities: [],     // Identity attributes: { role, context, salience (0-1) }
      confidence: {},     // Confidence by domain: { domain: confidence_score (0-1) }
      clones: []          // UserClone hypothesis array
    };
  }

  // ── UserClone: competing hypothesis layer ────────────────────────────────

  /** @returns {import('./types.js').UserClone[]} */
  getActiveClones() {
    return this.user.clones?.filter(c => c.status === 'active') || [];
  }

  /** @param {import('./types.js').UserClone} clone */
  saveClone(clone) {
    if (!this.user.clones) this.user.clones = [];
    const idx = this.user.clones.findIndex(c => c.id === clone.id);
    if (idx !== -1) {
      this.user.clones[idx] = clone;
    } else {
      this.user.clones.push(clone);
    }
  }

  killClone(cloneId) {
    const clone = this.user.clones?.find(c => c.id === cloneId);
    if (clone) clone.status = 'killed';
  }

  /**
   * Seed initial UserClone hypotheses via LLM based on known KG data.
   * @param {Object} llm - LLM client from llm-provider.js
   * @param {string} model
   * @returns {Promise<import('./types.js').UserClone[]>}
   */
  async seedClones(llm, model) {
    const known = {
      interests: this.user.interests?.slice(0, 5),
      beliefs: this.user.beliefs?.slice(0, 3),
      preferences: this.user.preferences?.slice(0, 3),
    };
    const prompt = `You are seeding a user model. Based on what is KNOWN about this user, generate 5 hypotheses about UNKNOWN preference dimensions we have not yet observed.

Known: ${JSON.stringify(known, null, 2)}

Return a JSON array of 5 objects: { hypothesis: string, confidence: number (0.4–0.6) }`;

    const resp = await llm.messages.create({
      model,
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = resp.content[0].text;
    const raw = JSON.parse(text.match(/\[[\s\S]*\]/)[0]);
    const now = Date.now();
    return raw.map((h, i) => ({
      id: `clone_seed_${now}_${i}`,
      hypothesis: h.hypothesis,
      confidence: h.confidence ?? 0.5,
      evaluations: [],
      spawnedFrom: null,
      generation: 0,
      createdAt: now,
      lastScoredAt: now,
      status: 'active',
    }));
  }

  updateCloneConfidence(cloneId, predictionCorrect) {
    const clone = this.user.clones?.find(c => c.id === cloneId);
    if (!clone) return;
    const lr = 0.1;
    clone.confidence = predictionCorrect
      ? Math.min(1, clone.confidence + lr * (1 - clone.confidence))
      : Math.max(0, clone.confidence - lr * clone.confidence);
    clone.lastScoredAt = Date.now();
  }

  killWeakClones() {
    for (const clone of this.user.clones || []) {
      if (clone.status === 'active' && clone.evaluations.length >= 10 && clone.confidence < 0.15) {
        clone.status = 'killed';
      }
    }
  }

  async breedStrongClones(llm, model) {
    const strong = this.getActiveClones().filter(c => c.confidence > 0.75);
    for (const parent of strong) {
      const resp = await llm.messages.create({
        model,
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `Generate 1 variant hypothesis derived from: "${parent.hypothesis}". Return JSON: { hypothesis: string, confidence: number }`,
        }],
      });
      const raw = JSON.parse(resp.content[0].text.match(/\{[\s\S]*\}/)[0]);
      this.saveClone({
        id: `clone_bred_${Date.now()}`,
        hypothesis: raw.hypothesis,
        confidence: raw.confidence ?? 0.5,
        evaluations: [],
        spawnedFrom: parent.id,
        generation: (parent.generation || 0) + 1,
        createdAt: Date.now(),
        lastScoredAt: Date.now(),
        status: 'active',
      });
    }
  }
}
