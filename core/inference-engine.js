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
   * Run L2 inference: read L1 facts, generate candidates, queue them.
   * Returns array of candidates that passed the gate (confidence >= 0.65, >=2 supporting facts)
   */
  async run() {
    if (this.isRunning) return [];
    this.isRunning = true;
    this.lastRunAt = new Date().toISOString();

    try {
      const summary = this.kg.getMemoryNodesSummary();
      const candidates = [];

      // Seed from L1.5 insight-swarm output (cross-dimensional analysis).
      // Prefer caller-supplied seeds (from `learn()`) to avoid re-running the
      // swarm. Fall back to `getL2Seeds` for callers that instantiate the
      // engine standalone.
      const l1_5_seeds = this.seeds
        ? this.seeds.filter(i => i.l2_seed)
        : await getL2Seeds(this.kg, this.llmClient ? { llmClient: this.llmClient } : {});
      candidates.push(...l1_5_seeds.map(seed => ({
        question: seed.insight,
        supporting_L1_facts: seed.supporting_facts || [],
        confidence: seed.confidence,
        second_order_effects: seed.derived_predictions || [],
        source: 'l1.5-insight-swarm',
        generated_at: new Date().toISOString()
      })));

      // Generate candidates from belief-belief relationships
      candidates.push(...this._inferFromBelief(summary.beliefs));

      // Generate candidates from preference-identity relationships
      candidates.push(...this._inferFromPreferenceIdentity(summary.preferences, summary.identities));

      // Generate candidates from temporal patterns
      candidates.push(...this._inferFromTemporalPatterns(summary.beliefs, summary.preferences));

      // Generate candidates from confidence gaps
      candidates.push(...this._inferFromConfidenceGaps(summary));

      // Filter by gate criteria
      const gatedCandidates = candidates.filter(c =>
        c.confidence >= this.confidenceThreshold &&
        c.supporting_L1_facts.length >= this.minSupportingFacts
      );

      // Queue and emit
      for (const candidate of gatedCandidates) {
        this.candidateQueue.push(candidate);
        this.emit('candidate', candidate);
      }

      return gatedCandidates;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Infer second-order questions from pairs of beliefs
   * @private
   */
  _inferFromBelief(beliefs) {
    const candidates = [];
    if (beliefs.length < 2) return candidates;

    for (let i = 0; i < beliefs.length - 1; i++) {
      for (let j = i + 1; j < beliefs.length; j++) {
        const b1 = beliefs[i];
        const b2 = beliefs[j];

        const factKey = `belief:${b1.topic}:${b2.topic}`;
        if (this.processedFacts.has(factKey)) continue;
        this.processedFacts.add(factKey);

        // Question: how do these beliefs interact?
        const question = `Given your belief about ${b1.topic} (${b1.claim}) and ${b2.topic} (${b2.claim}), how might they be related?`;
        const confidence = (b1.strength + b2.strength) / 2 * 0.8; // Reduce for inference uncertainty
        const secondOrderEffects = [
          `May create a unified mental model across ${b1.topic} and ${b2.topic}`,
          `Potential conflict resolution or integration point`,
          `Could influence decision-making in domains spanning both topics`
        ];

        candidates.push({
          question,
          supporting_L1_facts: [
            { type: 'belief', topic: b1.topic, claim: b1.claim, strength: b1.strength },
            { type: 'belief', topic: b2.topic, claim: b2.claim, strength: b2.strength }
          ],
          confidence: Math.min(0.95, confidence),
          second_order_effects: secondOrderEffects,
          source: 'belief-belief-relationship',
          generated_at: new Date().toISOString()
        });
      }
    }

    return candidates;
  }

  /**
   * Infer from preference-identity relationships
   * @private
   */
  _inferFromPreferenceIdentity(preferences, identities) {
    const candidates = [];
    if (preferences.length === 0 || identities.length === 0) return candidates;

    for (const pref of preferences) {
      for (const identity of identities) {
        const factKey = `pref-identity:${pref.type}:${identity.role}`;
        if (this.processedFacts.has(factKey)) continue;
        this.processedFacts.add(factKey);

        const prefStr = pref.strength > 0 ? 'prefer' : 'dislike';
        const question = `As a ${identity.role}, does your ${prefStr} for ${pref.description} align with your identity in ${identity.context}?`;
        const confidence = Math.abs(pref.strength) * identity.salience * 0.85;
        const secondOrderEffects = [
          `May reinforce or challenge your ${identity.role} identity`,
          `Could influence behavior patterns in roles requiring this identity`,
          `Potential for identity-driven preference evolution`
        ];

        candidates.push({
          question,
          supporting_L1_facts: [
            { type: 'preference', pref_type: pref.type, description: pref.description, strength: pref.strength },
            { type: 'identity', role: identity.role, context: identity.context, salience: identity.salience }
          ],
          confidence: Math.min(0.95, confidence),
          second_order_effects: secondOrderEffects,
          source: 'preference-identity-alignment',
          generated_at: new Date().toISOString()
        });
      }
    }

    return candidates;
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
   * Infer from confidence gaps: domains with low confidence but relevant beliefs
   * @private
   */
  _inferFromConfidenceGaps(summary) {
    const candidates = [];

    // Map beliefs to domains
    const beliefsByDomain = new Map();
    for (const belief of summary.beliefs) {
      if (!beliefsByDomain.has(belief.topic)) {
        beliefsByDomain.set(belief.topic, []);
      }
      beliefsByDomain.get(belief.topic).push(belief);
    }

    // Find domains with high belief strength but low confidence
    for (const [domain, beliefs] of beliefsByDomain) {
      const avgStrength = beliefs.reduce((s, b) => s + b.strength, 0) / beliefs.length;
      const confidence = summary.confidence[domain] ?? 0.5;

      if (avgStrength > 0.6 && confidence < 0.5) {
        const factKey = `gap:${domain}`;
        if (this.processedFacts.has(factKey)) continue;
        this.processedFacts.add(factKey);

        const question = `You have strong beliefs about ${domain} but express low confidence. Should we strengthen your confidence in this area?`;
        const inferenceConfidence = Math.abs(avgStrength - confidence) * 0.9;
        const secondOrderEffects = [
          `May reveal imposter syndrome or domain expertise underestimation`,
          `Could lead to calibrated confidence scoring`,
          `May increase decision-making authority in this domain`
        ];

        candidates.push({
          question,
          supporting_L1_facts: beliefs.slice(0, 2).map(b => ({
            type: 'belief',
            topic: b.topic,
            claim: b.claim,
            strength: b.strength
          })).concat({
            type: 'confidence',
            domain,
            confidence: confidence
          }),
          confidence: Math.min(0.95, inferenceConfidence),
          second_order_effects: secondOrderEffects,
          source: 'confidence-gap-detection',
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
