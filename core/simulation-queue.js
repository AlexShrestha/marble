/**
 * Marble L3 Clone Simulation Queue
 *
 * Async multi-clone simulation engine. Each clone receives a simulation packet
 * containing L1 facts, L2 inferences, and cached world context.
 *
 * Fitness model:
 *   - Grows with each confirmed data match (+confirmWeight per match)
 *   - Decays without confirming data (decayRate per tick)
 *   - Dies below survival threshold (default 0.15)
 *
 * Survivors fold output facts back into L1 as new inferred facts.
 * Output: { clone_id, output_facts, fitness_score, simulation_timestamp }
 */

import EventEmitter from 'events';
import crypto from 'crypto';

// ─────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────

const SURVIVAL_THRESHOLD = 0.15;
const INITIAL_FITNESS = 0.5;
const CONFIRM_WEIGHT = 0.12;     // fitness gain per confirmed match
const DECAY_RATE = 0.08;         // fitness loss per simulation tick with no match
const MAX_CONCURRENT = 8;        // max parallel clone simulations

// ─────────────────────────────────────────────────────────────────
// SimulationClone — one autonomous simulation unit
// ─────────────────────────────────────────────────────────────────

class SimulationClone {
  /**
   * @param {string} cloneId
   * @param {Object} packet - { L1_facts, L2_inferences, world_context }
   * @param {Object} opts   - { confirmWeight, decayRate, survivalThreshold }
   */
  constructor(cloneId, packet, opts = {}) {
    this.clone_id = cloneId;
    this.packet = packet;
    this.fitness = INITIAL_FITNESS;
    this.confirmWeight = opts.confirmWeight ?? CONFIRM_WEIGHT;
    this.decayRate = opts.decayRate ?? DECAY_RATE;
    this.survivalThreshold = opts.survivalThreshold ?? SURVIVAL_THRESHOLD;
    this.output_facts = [];
    this.ticks = 0;
  }

  /**
   * Run the simulation.
   * Returns null if fitness drops below survival threshold (clone dies).
   * @returns {Object|null} survivor output or null
   */
  async simulate() {
    const { L1_facts, L2_inferences, world_context } = this.packet;

    // Tick 1: Scan L1 facts for self-consistency
    this.ticks++;
    const l1Matches = this._checkConsistency(L1_facts);
    this._updateFitness(l1Matches);
    if (!this._alive()) return null;

    // Tick 2: Project L2 inferences against world context
    this.ticks++;
    const l2Projections = this._projectInferences(L2_inferences, world_context);
    const l2Matches = l2Projections.filter(p => p.supported).length;
    this._updateFitness(l2Matches);
    if (!this._alive()) return null;

    // Tick 3: Generate output facts from confirmed projections
    this.ticks++;
    const confirmedProjections = l2Projections.filter(p => p.supported);
    this.output_facts = this._synthesizeFacts(confirmedProjections, L1_facts);
    this._updateFitness(this.output_facts.length > 0 ? 1 : 0);
    if (!this._alive()) return null;

    return this._buildOutput();
  }

  // ── Private ─────────────────────────────────────────────────────

  /**
   * Check L1 facts for internal consistency.
   * Returns count of non-contradicted, high-confidence facts.
   */
  _checkConsistency(facts) {
    if (!Array.isArray(facts) || facts.length === 0) return 0;
    let confirmed = 0;
    const seen = new Map();

    for (const fact of facts) {
      const key = fact.type || fact.topic || fact.id || JSON.stringify(fact).slice(0, 40);
      const confidence = typeof fact.confidence === 'number' ? fact.confidence : 0.5;

      if (seen.has(key)) {
        // Contradiction check: if same key with very different confidence, penalise
        const prev = seen.get(key);
        if (Math.abs(prev - confidence) > 0.5) {
          this.fitness -= 0.05; // contradiction penalty
          continue;
        }
      }
      seen.set(key, confidence);
      if (confidence >= 0.5) confirmed++;
    }

    return confirmed;
  }

  /**
   * Project L2 inferences against world context.
   * Returns array of { inference, supported, match_score }
   */
  _projectInferences(inferences, world_context) {
    if (!Array.isArray(inferences)) return [];
    const ctx = world_context || {};
    const ctxText = JSON.stringify(ctx).toLowerCase();

    return inferences.map(inf => {
      const question = (inf.question || '').toLowerCase();
      const source = (inf.source || '').toLowerCase();

      // Simple keyword overlap check against world context
      const keywords = question.split(/\W+/).filter(w => w.length > 3);
      const matchCount = keywords.filter(kw => ctxText.includes(kw)).length;
      const matchScore = keywords.length > 0 ? matchCount / keywords.length : 0;

      return {
        inference: inf,
        supported: matchScore >= 0.2 || inf.confidence >= 0.75,
        match_score: matchScore
      };
    });
  }

  /**
   * Synthesize new L1-promotable facts from confirmed projections.
   */
  _synthesizeFacts(confirmed, existingL1) {
    const existingKeys = new Set(
      existingL1.map(f => f.type || f.topic || f.id).filter(Boolean)
    );

    return confirmed
      .filter(({ inference }) => {
        const key = inference.source || inference.question?.slice(0, 40);
        return key && !existingKeys.has(key);
      })
      .map(({ inference, match_score }) => ({
        type: 'inferred',
        source: 'l3-simulation',
        origin_question: inference.question,
        confidence: Math.min(0.9, (inference.confidence || 0.5) * (0.8 + match_score * 0.4)),
        second_order_effects: inference.second_order_effects || [],
        synthesized_at: new Date().toISOString()
      }));
  }

  _updateFitness(matches) {
    if (matches > 0) {
      this.fitness = Math.min(1.0, this.fitness + matches * this.confirmWeight);
    } else {
      this.fitness = Math.max(0, this.fitness - this.decayRate);
    }
  }

  _alive() {
    return this.fitness >= this.survivalThreshold;
  }

  _buildOutput() {
    return {
      clone_id: this.clone_id,
      output_facts: this.output_facts,
      fitness_score: parseFloat(this.fitness.toFixed(4)),
      simulation_timestamp: new Date().toISOString(),
      ticks: this.ticks
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// SimulationQueue — orchestrates concurrent clone simulation
// ─────────────────────────────────────────────────────────────────

export class SimulationQueue extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {number} [opts.maxConcurrent=8]
   * @param {number} [opts.survivalThreshold=0.15]
   * @param {number} [opts.confirmWeight=0.12]
   * @param {number} [opts.decayRate=0.08]
   */
  constructor(opts = {}) {
    super();
    this.maxConcurrent = opts.maxConcurrent ?? MAX_CONCURRENT;
    this.cloneOpts = {
      survivalThreshold: opts.survivalThreshold ?? SURVIVAL_THRESHOLD,
      confirmWeight: opts.confirmWeight ?? CONFIRM_WEIGHT,
      decayRate: opts.decayRate ?? DECAY_RATE
    };
    this._pending = [];
    this._running = 0;
    this._survivors = [];
    this._pruned = 0;
  }

  /**
   * Enqueue a simulation packet. The queue auto-drains up to maxConcurrent.
   * @param {Object} packet - { L1_facts, L2_inferences, world_context }
   * @param {string} [cloneId] - optional override; auto-generated if omitted
   * @returns {string} cloneId
   */
  enqueue(packet, cloneId) {
    const id = cloneId || `clone-${crypto.randomBytes(4).toString('hex')}`;
    this._pending.push({ id, packet });
    this._drain();
    return id;
  }

  /**
   * Enqueue multiple packets and wait for all survivors.
   * @param {Array<Object>} packets - array of simulation packets
   * @returns {Promise<Object[]>} survivor outputs
   */
  async runBatch(packets) {
    const ids = packets.map(p => this.enqueue(p));
    return this._waitForIds(new Set(ids));
  }

  /**
   * Fold survivor output_facts back into L1 via the provided KG instance.
   * @param {Object} kg - Marble KG instance (must have addBelief or addFact method)
   * @param {Object[]} survivors - survivor outputs from runBatch
   */
  foldIntoL1(kg, survivors) {
    const folded = [];
    for (const survivor of survivors) {
      for (const fact of survivor.output_facts) {
        try {
          // addBelief takes positional args: (topic, claim, strength)
          const topic = fact.origin_question || 'l3-inferred';
          const claim = `Inferred from L3 simulation (source: ${fact.source || 'clone'})`;
          const strength = Math.min(0.9, fact.confidence || 0.6);
          kg.addBelief(topic, claim, strength);
          folded.push({ clone_id: survivor.clone_id, fact });
        } catch (_) {
          // non-fatal: KG may not support all fact types
        }
      }
    }
    this.emit('folded', folded);
    return folded;
  }

  /**
   * Get current queue stats.
   */
  getStats() {
    return {
      pending: this._pending.length,
      running: this._running,
      survivors: this._survivors.length,
      pruned: this._pruned
    };
  }

  // ── Private ─────────────────────────────────────────────────────

  _drain() {
    while (this._running < this.maxConcurrent && this._pending.length > 0) {
      const { id, packet } = this._pending.shift();
      this._running++;
      this._runClone(id, packet);
    }
  }

  async _runClone(id, packet) {
    const clone = new SimulationClone(id, packet, this.cloneOpts);
    try {
      const result = await clone.simulate();
      if (result) {
        this._survivors.push(result);
        this.emit('survivor', result);
      } else {
        this._pruned++;
        this.emit('pruned', { clone_id: id, fitness: clone.fitness });
      }
    } catch (err) {
      this._pruned++;
      this.emit('error', { clone_id: id, error: err.message });
    } finally {
      this._running--;
      this._drain();
      this.emit('_cloneDone', id);
    }
  }

  _waitForIds(ids) {
    return new Promise((resolve) => {
      const collected = [];
      const remaining = new Set(ids);

      if (remaining.size === 0) return resolve([]);

      const checkDone = (cloneId) => {
        if (!remaining.has(cloneId)) return;
        remaining.delete(cloneId);

        const survivor = this._survivors.find(s => s.clone_id === cloneId);
        if (survivor) collected.push(survivor);

        if (remaining.size === 0) {
          this.removeListener('_cloneDone', checkDone);
          resolve(collected);
        }
      };

      this.on('_cloneDone', checkDone);
    });
  }
}
