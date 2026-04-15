/**
 * evolution.js — Archetype clone population management.
 *
 * Clones are user archetype hypotheses (gap → kgOverrides), NOT scoring weight configs.
 * Each clone extends the base KG with its own belief/preference/identity overrides
 * and makes predictions based on those. Fitness = prediction accuracy.
 *
 * Lifecycle:
 *   - Clone seeded from knowledge gap (see kg.js → seedClones)
 *   - Each incoming reaction is evaluated against clone's extended KG
 *   - Confidence rises/falls via Bayesian updating (evidence-weighted)
 *   - Revelation events: high-confidence new facts kill contradicting clones instantly
 *   - Similar clones merge to consolidate information
 *   - Clones with confidence < threshold after min evaluations are killed
 *   - Clones with confidence > breed threshold spawn neighbour variants
 */

export class ClonePopulation {
  /**
   * @param {Object} kg   - KnowledgeGraph instance
   * @param {Function} llmCall - async (prompt: string) => string  (for evaluation)
   * @param {Object} [opts]
   * @param {number} [opts.killThreshold=0.15]
   * @param {number} [opts.minEvaluationsToKill=10]
   * @param {number} [opts.breedThreshold=0.75]
   * @param {number} [opts.mergeOverlapThreshold=0.7]
   * @param {number} [opts.maxPopulation=50]
   * @param {Object} [opts.llmClient] - LLM client for breeding
   * @param {string} [opts.llmModel]  - Model name for breeding
   */
  constructor(kg, llmCall, opts = {}) {
    this.kg = kg;
    this.llmCall = llmCall;
    this.killThreshold = opts.killThreshold ?? 0.15;
    this.minEvaluationsToKill = opts.minEvaluationsToKill ?? 10;
    this.breedThreshold = opts.breedThreshold ?? 0.75;
    this.mergeOverlapThreshold = opts.mergeOverlapThreshold ?? 0.7;
    this.maxPopulation = opts.maxPopulation ?? 50;
    this._llmClient = opts.llmClient || null;
    this._llmModel = opts.llmModel || null;
  }

  /**
   * Evaluate a clone against a new reaction using Bayesian-inspired updating.
   *
   * Instead of a fixed learning rate, the update magnitude depends on:
   * - Evidence strength: how clear/unambiguous the signal is
   * - Clone maturity: younger clones update faster (fewer evaluations = more uncertainty)
   * - Streak: consecutive correct/incorrect predictions amplify updates
   */
  async evaluateFitness(clone, reaction) {
    const { item, reaction: signal } = reaction;
    if (!item) return false;

    const actualEngaged = ['up', 'share'].includes(signal);

    const overrideDesc = this._describeOverrides(clone.kgOverrides);

    const prompt = `A user with the following profile:
${overrideDesc}

Was shown this item: ${JSON.stringify({ title: item.title, domain: item.domain, tags: item.tags, metadata: item.metadata })}

Would this user engage positively with this item? Answer with ONLY "yes" or "no".`;

    let predictedEngaged = false;
    try {
      const answer = (await this.llmCall(prompt)).trim().toLowerCase();
      predictedEngaged = answer.startsWith('yes');
    } catch {
      return false;
    }

    const correct = predictedEngaged === actualEngaged;

    clone.evaluations = clone.evaluations || [];
    clone.evaluations.push({
      signal,
      predicted: predictedEngaged,
      actual: actualEngaged,
      correct,
      timestamp: Date.now(),
    });
    clone.lastScoredAt = Date.now();

    // Bayesian-inspired confidence update
    const evidenceStrength = this._computeEvidenceStrength(signal, item);
    const maturityFactor = Math.max(0.05, 1 / Math.sqrt(1 + clone.evaluations.length));
    const streak = this._computeStreak(clone.evaluations);
    const streakMultiplier = 1 + Math.min(streak, 5) * 0.1;

    const updateMag = evidenceStrength * maturityFactor * streakMultiplier;

    if (correct) {
      clone.confidence = Math.min(1, clone.confidence + updateMag * (1 - clone.confidence));
    } else {
      clone.confidence = Math.max(0, clone.confidence - updateMag * clone.confidence);
    }

    this.kg.saveClone(clone);
    return correct;
  }

  /**
   * Apply a revelation event: high-confidence new data that should
   * immediately kill all clones whose overrides contradict it.
   *
   * A revelation is a confirmed fact (e.g., "user IS an ultra-runner")
   * that makes many clone hypotheses instantly invalid.
   *
   * @param {Object} fact - { type: 'belief'|'preference'|'identity', topic, value, confidence }
   * @returns {{ killed: number, surviving: number }}
   */
  applyRevelation(fact) {
    if (!fact || !fact.topic || (fact.confidence || 0) < 0.7) {
      return { killed: 0, surviving: this.kg.getActiveClones().length };
    }

    const clones = this.kg.getActiveClones();
    let killed = 0;

    for (const clone of clones) {
      if (this._cloneContradictsFact(clone, fact)) {
        this.kg.killClone(clone.id);
        killed++;
      }
    }

    const surviving = this.kg.getActiveClones().length;
    return { killed, surviving };
  }

  /**
   * Merge similar clones to consolidate knowledge and reduce population.
   * Two clones merge if their kgOverrides overlap above the threshold.
   * The merged clone keeps the highest-confidence trait from each source.
   *
   * @returns {{ merged: number, remaining: number }}
   */
  mergeClones() {
    const clones = this.kg.getActiveClones();
    if (clones.length < 2) return { merged: 0, remaining: clones.length };

    const mergedIds = new Set();
    let mergeCount = 0;

    for (let i = 0; i < clones.length; i++) {
      if (mergedIds.has(clones[i].id)) continue;

      for (let j = i + 1; j < clones.length; j++) {
        if (mergedIds.has(clones[j].id)) continue;

        const overlap = this._computeOverlap(clones[i], clones[j]);
        if (overlap >= this.mergeOverlapThreshold) {
          this._mergeInto(clones[i], clones[j]);
          this.kg.killClone(clones[j].id);
          this.kg.saveClone(clones[i]);
          mergedIds.add(clones[j].id);
          mergeCount++;
        }
      }
    }

    return { merged: mergeCount, remaining: this.kg.getActiveClones().length };
  }

  /**
   * Run full evolution step: evaluate, apply revelations, merge, kill, breed.
   *
   * @param {Array} reactions - Array of reaction objects
   * @param {Object[]} [revelations] - High-confidence new facts to apply as revelations
   * @returns {Promise<{ killed: number, bred: number, merged: number, active: number, revelationKills: number }>}
   */
  async evolve(reactions, revelations = []) {
    const clones = this.kg.getActiveClones();

    // Step 1: Apply revelations (instant kills for contradicting clones)
    let revelationKills = 0;
    for (const fact of revelations) {
      const result = this.applyRevelation(fact);
      revelationKills += result.killed;
    }

    // Step 2: Evaluate remaining clones against reactions
    const activeAfterRevelations = this.kg.getActiveClones();
    for (const clone of activeAfterRevelations) {
      for (const reaction of reactions) {
        await this.evaluateFitness(clone, reaction);
      }
    }

    // Step 3: Merge similar clones
    const { merged } = this.mergeClones();

    // Step 4: Kill weak clones
    let killed = 0;
    for (const clone of this.kg.getActiveClones()) {
      if (
        clone.evaluations?.length >= this.minEvaluationsToKill &&
        clone.confidence < this.killThreshold
      ) {
        this.kg.killClone(clone.id);
        killed++;
      }
    }

    // Step 5: Breed strong clones (capped by maxPopulation)
    let bred = 0;
    try {
      const activeNow = this.kg.getActiveClones();
      const strong = activeNow.filter(c => c.confidence > this.breedThreshold);
      if (strong.length > 0 && activeNow.length < this.maxPopulation &&
          typeof this.kg.breedStrongClones === 'function' && this._llmClient) {
        await this.kg.breedStrongClones(this._llmClient, this._llmModel);
        bred = strong.length;
      }
    } catch {
      // breeding failure is non-fatal
    }

    const active = this.kg.getActiveClones().length;

    return { killed, bred, merged, active, revelationKills };
  }

  /**
   * Get the highest-confidence active clone.
   * @returns {import('./types.js').UserClone|null}
   */
  getBestClone() {
    const clones = this.kg.getActiveClones();
    if (!clones.length) return null;
    return clones.reduce((best, c) => c.confidence > best.confidence ? c : best);
  }

  /**
   * Get population health stats.
   */
  getPopulationStats() {
    const clones = this.kg.getActiveClones();
    if (!clones.length) return { count: 0, avgConfidence: 0, diversity: 0 };

    const confidences = clones.map(c => c.confidence);
    const avgConfidence = confidences.reduce((s, c) => s + c, 0) / clones.length;

    // Diversity: count unique gap topics
    const gaps = new Set(clones.map(c => c.gap).filter(Boolean));

    return {
      count: clones.length,
      avgConfidence: parseFloat(avgConfidence.toFixed(3)),
      diversity: gaps.size,
      topClone: this.getBestClone()?.id || null,
    };
  }

  // ── Private ──────────────────────────────────────────

  /**
   * Compute evidence strength from a reaction signal.
   * Strong signals (share, explicit down) = high strength.
   * Weak signals (skip) = low strength.
   */
  _computeEvidenceStrength(signal, item) {
    const signalWeights = { share: 0.9, up: 0.6, down: 0.7, skip: 0.3 };
    const base = signalWeights[signal] || 0.5;

    // Items with more metadata provide stronger evidence
    const metaRichness = item.metadata ? Math.min(1, Object.keys(item.metadata).length / 5) : 0;

    return Math.min(1, base + metaRichness * 0.2);
  }

  /**
   * Count the current streak of correct or incorrect predictions.
   * Returns positive for correct streaks, negative for incorrect.
   */
  _computeStreak(evaluations) {
    if (!evaluations.length) return 0;
    const lastResult = evaluations[evaluations.length - 1].correct;
    let streak = 0;
    for (let i = evaluations.length - 1; i >= 0; i--) {
      if (evaluations[i].correct === lastResult) streak++;
      else break;
    }
    return lastResult ? streak : -streak;
  }

  /**
   * Check if a clone's overrides contradict a confirmed fact.
   */
  _cloneContradictsFact(clone, fact) {
    const overrides = clone.kgOverrides;
    if (!overrides) return false;

    const topicLower = fact.topic.toLowerCase();

    // Check beliefs
    for (const b of overrides.beliefs || []) {
      if (b.topic?.toLowerCase() === topicLower) {
        // Same topic but different value → contradiction
        if (fact.value && b.value && b.value.toLowerCase() !== fact.value.toLowerCase()) {
          return true;
        }
      }
    }

    // Check preferences
    for (const p of overrides.preferences || []) {
      if (p.category?.toLowerCase() === topicLower || p.type?.toLowerCase() === topicLower) {
        if (fact.value && p.value && p.value.toLowerCase() !== fact.value.toLowerCase()) {
          return true;
        }
      }
    }

    // Check identities
    for (const id of overrides.identities || []) {
      if (id.role?.toLowerCase() === topicLower) {
        if (fact.value && id.value && id.value.toLowerCase() !== fact.value.toLowerCase()) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Compute trait overlap between two clones (0-1).
   */
  _computeOverlap(cloneA, cloneB) {
    const traitsA = this._extractTraitKeys(cloneA.kgOverrides);
    const traitsB = this._extractTraitKeys(cloneB.kgOverrides);

    if (traitsA.size === 0 && traitsB.size === 0) return 1;
    if (traitsA.size === 0 || traitsB.size === 0) return 0;

    let shared = 0;
    for (const key of traitsA) {
      if (traitsB.has(key)) shared++;
    }

    const union = new Set([...traitsA, ...traitsB]).size;
    return union > 0 ? shared / union : 0;
  }

  /**
   * Extract normalized trait keys from kgOverrides for overlap comparison.
   */
  _extractTraitKeys(overrides) {
    const keys = new Set();
    if (!overrides) return keys;

    for (const b of overrides.beliefs || [])     keys.add(`b:${(b.topic || '').toLowerCase()}`);
    for (const p of overrides.preferences || []) keys.add(`p:${(p.category || p.type || '').toLowerCase()}`);
    for (const id of overrides.identities || []) keys.add(`i:${(id.role || '').toLowerCase()}`);

    return keys;
  }

  /**
   * Merge clone B into clone A, keeping highest-confidence traits from each.
   */
  _mergeInto(target, source) {
    const tOverrides = target.kgOverrides || {};
    const sOverrides = source.kgOverrides || {};

    // Merge beliefs: keep both, deduplicate by topic (keep higher confidence source)
    const mergedBeliefs = new Map();
    for (const b of [...(tOverrides.beliefs || []), ...(sOverrides.beliefs || [])]) {
      const key = (b.topic || '').toLowerCase();
      const existing = mergedBeliefs.get(key);
      if (!existing || (b.confidence || 0.5) > (existing.confidence || 0.5)) {
        mergedBeliefs.set(key, b);
      }
    }

    // Merge preferences
    const mergedPrefs = new Map();
    for (const p of [...(tOverrides.preferences || []), ...(sOverrides.preferences || [])]) {
      const key = (p.category || p.type || '').toLowerCase();
      const existing = mergedPrefs.get(key);
      if (!existing || Math.abs(p.strength || 0) > Math.abs(existing.strength || 0)) {
        mergedPrefs.set(key, p);
      }
    }

    // Merge identities
    const mergedIds = new Map();
    for (const id of [...(tOverrides.identities || []), ...(sOverrides.identities || [])]) {
      const key = (id.role || '').toLowerCase();
      if (!mergedIds.has(key)) mergedIds.set(key, id);
    }

    target.kgOverrides = {
      beliefs: [...mergedBeliefs.values()],
      preferences: [...mergedPrefs.values()],
      identities: [...mergedIds.values()],
    };

    // Weighted average confidence (favor the more evaluated clone)
    const tEvals = target.evaluations?.length || 1;
    const sEvals = source.evaluations?.length || 1;
    const totalEvals = tEvals + sEvals;
    target.confidence = (target.confidence * tEvals + source.confidence * sEvals) / totalEvals;

    // Combine evaluation history
    target.evaluations = [
      ...(target.evaluations || []),
      ...(source.evaluations || []),
    ].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    target.mergedFrom = [...(target.mergedFrom || []), source.id];
  }

  _describeOverrides(kgOverrides) {
    if (!kgOverrides) return '(no overrides)';
    const lines = [];
    for (const b of kgOverrides.beliefs || [])     lines.push(`Belief: ${b.topic} = ${b.value}`);
    for (const p of kgOverrides.preferences || []) lines.push(`Preference: ${p.category} = ${p.value}`);
    for (const id of kgOverrides.identities || []) lines.push(`Identity: ${id.role} = ${id.value}`);
    return lines.join('\n') || '(no overrides)';
  }
}
