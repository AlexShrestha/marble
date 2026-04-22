/**
 * Marble L2 Inference Engine
 *
 * Generates inference candidates from L1 facts (beliefs, preferences, identities, confidence).
 * Outputs candidates with: {question, supporting_L1_facts, confidence, second_order_effects}
 *
 * Gate for promotion to L3:
 * - confidence >= 0.65
 * - supporting_L1_facts.length >= 2
 *
 * Runs asynchronously, deposits candidates into a queue consumed by L3.
 * Does NOT directly prompt user — only surfaces questions internally for clone simulation.
 */

import EventEmitter from 'events';
import { getL2Seeds } from './insight-swarm.js';

export class InferenceEngine extends EventEmitter {
  constructor(kg, opts = {}) {
    super();
    this.kg = kg;
    this.candidateQueue = [];
    this.processedFacts = new Set();
    this.confidenceThreshold = opts.confidenceThreshold || 0.65;
    this.minSupportingFacts = opts.minSupportingFacts || 2;
    this.llmClient = opts.llmClient || null;
    // Pre-built L1.5 insights from the caller. When provided we skip the
    // LLM swarm — `learn()` already ran it and a second call would both
    // double the LLM spend and introduce a second failure surface.
    this.seeds = Array.isArray(opts.seeds) ? opts.seeds : null;
    this.isRunning = false;
    this.lastRunAt = null;
  }

  /**
   * Run L2 inference.
   *
   * Reads L1.5 insights + top-salient L1 facts (capped via `getTopSalient`),
   * runs the remaining linear generators (temporal patterns), gates, queues.
   *
   * The old quadratic generators (`_inferFromBelief`, `_inferFromPreferenceIdentity`,
   * `_inferFromConfidenceGaps`) were removed — they emitted template strings
   * with no semantic content and blew up on real-sized KGs. Cross-L1 pattern
   * discovery now lives in `runTraitSynthesis()` (LLM-directed, bounded).
   *
   * Returns candidates that passed the gate (confidence >= 0.65, >=2 supporting facts).
   */
  async run() {
    if (this.isRunning) return [];
    this.isRunning = true;
    this.lastRunAt = new Date().toISOString();

    try {
      const candidates = [];

      // L1.5 passthrough (cross-dimensional analysis from the swarm).
      // Caller-supplied `seeds` (from learn()) take precedence so we don't
      // re-invoke the LLM swarm — see `runTraitSynthesis` for the real
      // cross-L1 pattern discovery path.
      const l1_5_seeds = this.seeds
        ? this.seeds.filter(i => i.l2_seed)
        : await getL2Seeds(this.kg, this.llmClient ? { llmClient: this.llmClient } : {});
      for (const seed of l1_5_seeds) {
        const candidate = {
          question: seed.insight,
          supporting_L1_facts: seed.supporting_facts || [],
          confidence: seed.confidence,
          second_order_effects: seed.derived_predictions || [],
          source: 'l1.5-insight-swarm',
          generated_at: new Date().toISOString(),
        };
        // Inline gate — never allocate what we'll drop at the end.
        if (
          candidate.confidence >= this.confidenceThreshold &&
          candidate.supporting_L1_facts.length >= this.minSupportingFacts
        ) {
          candidates.push(candidate);
        }
      }

      // Temporal patterns — linear O(N) scan over top-salient nodes only.
      // Works on a bounded population so it can't blow up regardless of KG size.
      const topBeliefs = (typeof this.kg.getTopSalient === 'function')
        ? this.kg.getTopSalient({ types: ['belief'], limit: 100 }).map(a => a.node)
        : (this.kg.getActiveBeliefs?.() || []).slice(0, 100);
      const topPrefs = (typeof this.kg.getTopSalient === 'function')
        ? this.kg.getTopSalient({ types: ['preference'], limit: 100 }).map(a => a.node)
        : (this.kg.getActivePreferences?.() || []).slice(0, 100);

      for (const candidate of this._inferFromTemporalPatterns(topBeliefs, topPrefs)) {
        if (
          candidate.confidence >= this.confidenceThreshold &&
          candidate.supporting_L1_facts.length >= this.minSupportingFacts
        ) {
          candidates.push(candidate);
        }
      }

      for (const candidate of candidates) {
        this.candidateQueue.push(candidate);
        this.emit('candidate', candidate);
      }

      return candidates;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Run L2 trait synthesis — third inference mode alongside L1.5 passthrough
   * and pairwise L1. Derives psychological/behavioral traits from individual
   * facts, checks replication across domains, surfaces contradictions, and
   * runs a small K-way fusion pass on top. Persists results via
   * `kg.addSynthesis()`.
   *
   * The heavy logic lives in `trait-synthesis.js` — this method is a thin
   * wrapper that threads `llmClient` through and writes the results back
   * into the KG.
   *
   * @param {Object} [opts] — see `runTraitSynthesis` in trait-synthesis.js
   * @returns {Promise<Object[]>} persisted syntheses (with ids)
   */
  async runTraitSynthesis(opts = {}) {
    const { runTraitSynthesis } = await import('./trait-synthesis.js');
    const syntheses = await runTraitSynthesis(this.kg, {
      ...opts,
      llmClient: opts.llmClient || this.llmClient || undefined,
    });
    const persisted = [];
    for (const s of syntheses) {
      persisted.push(this.kg.addSynthesis(s));
    }
    return persisted;
  }

  /**
   * Infer from temporal patterns: beliefs/preferences that haven't been reinforced recently
   * @private
   */
  _inferFromTemporalPatterns(beliefs, preferences) {
    const candidates = [];
    const now = Date.now();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

    // Check stale beliefs
    for (const belief of beliefs) {
      const recordedAt = new Date(belief.recorded_at).getTime();
      const staleness = (now - recordedAt) / thirtyDaysMs;

      if (staleness > 1) { // More than 30 days old
        const factKey = `stale:belief:${belief.topic}`;
        if (this.processedFacts.has(factKey)) continue;
        this.processedFacts.add(factKey);

        const question = `Your belief about ${belief.topic} (${belief.claim}) was last reinforced ${Math.round(staleness)} months ago. Is this still true?`;
        const confidence = belief.strength * (1 - Math.min(0.5, staleness / 10)); // Decay confidence over time
        const secondOrderEffects = [
          `Belief may be outdated or needs refreshing`,
          `Opportunity to update user model with current state`,
          `May reveal shifts in user thinking`
        ];

        candidates.push({
          question,
          supporting_L1_facts: [
            { type: 'belief', topic: belief.topic, claim: belief.claim, strength: belief.strength },
            { type: 'temporal_signal', signal: 'staleness', staleness_months: Math.round(staleness), threshold: 1 }
          ],
          confidence: Math.max(0.5, confidence),
          second_order_effects: secondOrderEffects,
          source: 'stale-belief-detection',
          generated_at: new Date().toISOString()
        });
      }
    }

    // Check evolving preferences
    for (const pref of preferences) {
      const recordedAt = new Date(pref.recorded_at).getTime();
      const days = (now - recordedAt) / (24 * 60 * 60 * 1000);

      if (days > 60 && Math.abs(pref.strength) > 0.3) { // Strong recent preference
        const factKey = `evolving:pref:${pref.type}`;
        if (this.processedFacts.has(factKey)) continue;
        this.processedFacts.add(factKey);

        const direction = pref.strength > 0 ? 'preference' : 'aversion';
        const question = `Your ${direction} for ${pref.description} seems to be developing. What's driving this evolution?`;
        const confidence = Math.abs(pref.strength) * 0.8;
        const secondOrderEffects = [
          `Preference may be stabilizing into a longer-term pattern`,
          `Could inform identity or belief formation`,
          `May trigger correlated preference changes`
        ];

        candidates.push({
          question,
          supporting_L1_facts: [
            { type: 'preference', pref_type: pref.type, description: pref.description, strength: pref.strength },
            { type: 'temporal_signal', signal: 'preference_age', age_days: Math.round(days), threshold: 60 }
          ],
          confidence: Math.min(0.95, confidence),
          second_order_effects: secondOrderEffects,
          source: 'evolving-preference-detection',
          generated_at: new Date().toISOString()
        });
      }
    }

    return candidates;
  }

  /**
   * Peek at the next candidate without removing it
   */
  peek() {
    return this.candidateQueue[0] || null;
  }

  /**
   * Dequeue the next candidate
   */
  dequeue() {
    return this.candidateQueue.shift() || null;
  }

  /**
   * Get all queued candidates
   */
  getQueue() {
    return [...this.candidateQueue];
  }

  /**
   * Clear the queue
   */
  clearQueue() {
    this.candidateQueue = [];
  }

  /**
   * Get statistics about inference runs
   */
  getStats() {
    return {
      lastRunAt: this.lastRunAt,
      queueLength: this.candidateQueue.length,
      processedFacts: this.processedFacts.size,
      confidenceThreshold: this.confidenceThreshold,
      minSupportingFacts: this.minSupportingFacts
    };
  }
}
