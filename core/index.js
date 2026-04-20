/**
 * Marble — Zero-Day Personalization Engine
 *
 * Full pipeline lifecycle:
 *   1. init()                    → load KG, attach engines
 *   2. ingestConversations(path) → mine chat exports into KG
 *   3. select(items, context)    → score + clone consensus + arc reorder
 *   4. react(item, reaction)     → record with entity extraction + TopicInsight
 *   5. reactSlate(reactions)     → contrastive analysis on full slate
 *   6. learn()                   → L1.5 insight swarm → L2 inference → L3 clone evolution
 *   7. investigate(opts)         → adaptive committee fills gaps
 */

import { KnowledgeGraph } from './kg.js';
import { Scorer } from './scorer.js';
import { ArcReranker } from './arc.js';
import { Swarm } from './swarm.js';
import { Clone } from './clone.js';
import { decayPass } from './decay.js';

// Module-level flags so missing-provider warnings fire at most once per
// process, not once per `new Marble()`. Batch workloads (one instance per
// user/request/session) would otherwise flood stderr with duplicates.
let _warnedNoLLM = false;
let _warnedNoEmbeddings = false;

/**
 * Thrown by `learn({ allowDegraded: false })` when one or more pipeline stages
 * failed. Exposes both the per-stage failures and the partial result so
 * callers can log or partially use what did succeed. Use this to distinguish
 * "healthy-but-cold" (no failures, zero counts) from "silent-degraded"
 * (failures collected, zero counts).
 */
export class LearnDegradedError extends Error {
  /**
   * @param {Array<{ stage: string, code?: string, message: string }>} failures
   * @param {Object} result - The partial learn() result that would otherwise
   *   have been returned.
   */
  constructor(failures, result) {
    const summary = failures.map(f => `${f.stage}: ${f.message}`).join('; ');
    super(`learn() completed with degraded stages — ${summary}`);
    this.name = 'LearnDegradedError';
    this.failures = failures;
    this.result = result;
  }
}

export class Marble {
  /**
   * @param {Object} opts
   * @param {string} [opts.storage='./marble-kg.json'] - KG persistence path
   * @param {Function} [opts.llm]       - async (prompt: string) => string — LLM for full pipeline
   * @param {Object}   [opts.embeddings] - Embeddings provider for semantic scoring
   * @param {number}   [opts.count=10]   - Number of items to return from select()
   * @param {string}   [opts.mode='score'] - 'score' (v1), 'swarm' (v2), or 'debate' (v2+debate)
   * @param {boolean}  [opts.arcReorder=false] - Apply narrative arc reranking (newsletter/content curation only)
   * @param {number}   [opts.coldStartThreshold=10] - Signals needed before full personalization
   * @param {number}   [opts.cloneBoostWeight=0.3] - How much clone consensus influences scoring
   * @param {boolean}  [opts.silent=false] - Suppress construction-time warnings about missing providers
   */
  constructor({
    storage = './marble-kg.json',
    llm = null,
    embeddings = null,
    count = 10,
    mode = 'score',
    arcReorder = false,
    coldStartThreshold = 10,
    cloneBoostWeight = 0.3,
    silent = false,
  } = {}) {
    this.kg = new KnowledgeGraph(storage);
    this.scorer = new Scorer(this.kg, { coldStartThreshold, embeddings });
    this.arc = new ArcReranker();
    this.count = count;
    this.mode = mode;
    this.llm = llm;
    this.embeddings = embeddings;
    this.arcReorder = arcReorder;
    this.cloneBoostWeight = Math.max(0, Math.min(1, cloneBoostWeight));
    this.ready = false;

    // Lazy-init containers
    this.clonePopulation = null;
    this.feedbackEngine = null;

    if (!silent && !llm && !_warnedNoLLM) {
      _warnedNoLLM = true;
      console.warn('[Marble] No LLM provider configured. Only L0+L1 scoring available. '
        + 'Pass { llm: yourLLMFunction } for full pipeline (L1.5, L2, L3). '
        + 'Pass { silent: true } to suppress this warning.');
    }
    if (!silent && !embeddings && !process.env.OPENAI_API_KEY && !_warnedNoEmbeddings) {
      _warnedNoEmbeddings = true;
      console.warn('[Marble] No embeddings configured. Scorer will use keyword matching only. '
        + 'Set OPENAI_API_KEY or pass { embeddings: provider } for semantic scoring. '
        + 'Pass { silent: true } to suppress this warning.');
    }
  }

  async init() {
    await this.kg.load();
    decayPass(this.kg);

    // Wire TopicInsightEngine for LLM-powered preference learning on reactions
    if (this.llm) {
      const { TopicInsightEngine } = await import('./topic-insight-engine.js');
      const engine = new TopicInsightEngine(this.llm);
      this.kg.setTopicInsightEngine(engine);
    }

    this.ready = true;
    return this;
  }

  /**
   * Score and rank ALL items without slicing or arc reordering.
   *
   * Use this when you need the full ranking distribution — AUC / MRR
   * evaluations, external rerankers, or surfacing more than `count` results.
   * For top-N-with-optional-arc-ordering, use `select()` instead.
   *
   * The returned objects preserve the scorer's wrapper shape. Each has:
   *   - `story`: the original input item (historical name, see `item` alias below)
   *   - `item`: alias for `story` — use this in new code; `story` will be
   *     deprecated in a future major
   *   - `relevance_score`: number in [0, 1], the composite ranking signal
   *   - `magic_score`: legacy alias of relevance_score kept for back-compat
   *   - plus per-dimension components (`interest_match`, `temporal_relevance`,
   *     `popularity_score`, `entity_affinity`, ...) when produced by the
   *     scorer path; swarm/debate modes may populate a different subset
   *
   * Ordered descending by `relevance_score`; ties broken by `popularity_score`.
   *
   * @param {Object[]} items - Candidate items
   * @param {Object}   [context] - Ephemeral context (calendar, projects, mood)
   * @returns {Promise<Array<{ story: Object, item: Object, relevance_score: number, magic_score: number, [key: string]: any }>>}
   */
  async score(items, context) {
    if (!this.ready) await this.init();

    if (context) {
      this.kg.setContext(context);
    }

    let scored;

    if ((this.mode === 'swarm' || this.mode === 'debate') && this.llm) {
      const swarm = new Swarm(this.kg, {
        mode: this.mode === 'debate' ? 'debate' : 'deep',
        llm: this.llm,
        topN: items.length,
      });
      scored = await swarm.curate(items);
    } else {
      scored = await this.scorer.score(items);
    }

    // Blend clone predictions when clones exist
    const clones = this.kg.getActiveClones();
    if (clones.length > 0) {
      if (!this.clonePopulation) {
        const { ClonePopulation } = await import('./evolution.js');
        this.clonePopulation = new ClonePopulation(this.kg, this.llm || (async () => 'no'));
      }

      const w = this.cloneBoostWeight;
      for (const item of scored) {
        const cloneBoost = await this.clonePopulation.predictConsensus(item.story || item, clones);
        const currentScore = item.relevance_score ?? item.magic_score ?? 0;
        const blended = currentScore * (1 - w) + cloneBoost * w;
        if (item.relevance_score != null) item.relevance_score = blended;
        if (item.magic_score != null) item.magic_score = blended;
      }

      scored.sort((a, b) =>
        (b.relevance_score ?? b.magic_score ?? 0) - (a.relevance_score ?? a.magic_score ?? 0)
      );
    }

    // Non-breaking alias: wrapper.story → wrapper.item. Callers can start using
    // `.item` immediately; `.story` is preserved for existing downstream code
    // and will be deprecated in a future major version.
    for (const entry of scored) {
      if (entry && typeof entry === 'object' && entry.story && entry.item === undefined) {
        entry.item = entry.story;
      }
    }

    return scored;
  }

  /**
   * Score and return the top `count` items, with optional arc reordering.
   *
   * Convenience wrapper around `score()` for the common "give me the top N"
   * case. Identical scoring pipeline; differences:
   *   - returns only the first `this.count` entries
   *   - applies narrative arc reranking when `arcReorder: true` was passed
   *     to the constructor (newsletter/content-curation use cases)
   *
   * For full-slate output (evaluations, external rerankers, large result
   * sets), use `score()` instead.
   *
   * @param {Object[]} items - Candidate items (~100 typical)
   * @param {Object}   [context] - Ephemeral context (calendar, projects, mood)
   * @returns {Promise<Array<{ story: Object, item: Object, relevance_score: number, magic_score: number, [key: string]: any }>>}
   *   Top `count` items, same wrapper shape as `score()`, optionally arc-ordered.
   */
  async select(items, context) {
    const scored = await this.score(items, context);

    // Arc reranking is opt-in: only for newsletter/content-curation use cases
    // where narrative flow matters. For search, product recs, etc., keep pure ranking.
    if (this.arcReorder) {
      return this.arc.reorder(scored, this.count);
    }
    return scored.slice(0, this.count);
  }

  /**
   * Record a single reaction. Passes full item for entity extraction + TopicInsight.
   *
   * @param {Object} item - The item that was reacted to (must have id, topics, source)
   * @param {string} reaction - 'up' | 'down' | 'skip' | 'share'
   */
  async react(item, reaction) {
    if (!this.ready) await this.init();
    const topics = item.topics || [];
    const source = item.source || 'unknown';
    this.kg.recordReaction(item.id || item.title, reaction, topics, source, item);
    await this.kg.save();
  }

  /**
   * Process a full batch of reactions with contrastive analysis.
   * This is the mechanism that makes Day 2 better than Day 1.
   *
   * @param {Array<{ item: Object, reaction: string }>} batchReactions
   * @returns {Promise<{ inferences: Object[], revelations: Object[] }>}
   */
  async feedbackBatch(batchReactions) {
    if (!this.ready) await this.init();

    if (!this.llm) {
      for (const { item, reaction } of batchReactions) {
        await this.react(item, reaction);
      }
      return { inferences: [], revelations: [] };
    }

    for (const { item, reaction } of batchReactions) {
      this.kg.recordReaction(
        item.id || item.title,
        reaction,
        item.topics || [],
        item.source || 'unknown',
        item
      );
    }

    const { RapidFeedbackEngine } = await import('./rapid-feedback.js');
    if (!this.feedbackEngine) {
      this.feedbackEngine = new RapidFeedbackEngine(this.kg, this.llm, {
        clonePopulation: this.clonePopulation,
      });
    }

    const result = await this.feedbackEngine.processBatch(batchReactions);
    await this.kg.save();
    return result;
  }

  /**
   * @deprecated Use feedbackBatch() instead. Kept for backward compatibility.
   */
  async reactSlate(slateReactions) {
    return this.feedbackBatch(slateReactions);
  }

  /**
   * Run deep learning: L1.5 insight swarm → L2 inference → L3 clone evolution.
   * Call daily or after N reactions accumulate.
   *
   * Each stage runs inside its own try/catch so a failure in one layer does
   * not abort the pipeline — the remaining stages still execute on whatever
   * data is available. Per-stage outcomes are surfaced in `stages`; any
   * thrown errors are collected in `failures`. Callers that want the old
   * "throw on any degradation" behaviour should pass `{ allowDegraded: false }`
   * and check `failures.length === 0`.
   *
   * Distinguishes healthy-but-cold from silent-degraded:
   *   - `{ insights: 0, candidates: 0, clones: 0, failures: [] }` → healthy cold start
   *   - `{ insights: 0, candidates: 0, clones: 0, failures: [ ... ] }` → degraded; inspect failures
   *
   * @param {Object} [opts]
   * @param {boolean} [opts.allowDegraded=true] - When false, throws
   *   LearnDegradedError if any stage fails. Default true so callers that
   *   don't read `failures` still get a usable result.
   * @returns {Promise<{
   *   insights: number,
   *   candidates: number,
   *   clones: number,
   *   stages: { seedClones: 'skipped'|'ok'|'failed', insightSwarm: 'ok'|'failed', inference: 'ok'|'failed', cloneEvolution: 'skipped'|'ok'|'failed' },
   *   failures: Array<{ stage: string, code?: string, message: string }>
   * }>}
   */
  async learn(opts = {}) {
    const { allowDegraded = true } = opts;
    if (!this.llm) {
      throw new Error('learn() requires an LLM provider. Pass { llm: yourLLMFunction } in constructor.');
    }
    if (!this.ready) await this.init();

    const stages = {
      seedClones: 'skipped',
      insightSwarm: 'skipped',
      inference: 'skipped',
      cloneEvolution: 'skipped',
    };
    const failures = [];
    const pushFailure = (stage, err) => {
      failures.push({
        stage,
        code: err?.code,
        message: err?.message || String(err),
      });
    };

    // Seed clones if none exist. Persist the returned array — historically
    // the result was discarded, so seeded clones never reached `user.clones`
    // and every downstream `clones === 0` check looked identical to a cold
    // start. Now we save each clone and the seed failure (if any) shows up
    // in `failures` instead of being buried in stderr.
    const existingClones = this.kg.getActiveClones();
    if (existingClones.length === 0 && typeof this.kg.seedClones === 'function') {
      try {
        const { createLLMClient } = await import('./llm-provider.js');
        const client = createLLMClient();
        const seeded = await this.kg.seedClones(client, client.defaultModel('fast'));
        if (Array.isArray(seeded) && seeded.length > 0) {
          for (const clone of seeded) this.kg.saveClone(clone);
          stages.seedClones = 'ok';
        } else {
          // Empty return can mean either "nothing to seed" (no known data)
          // or a parse failure captured as `_lastSeedCloneError`. Only the
          // latter counts as a failure.
          const seedErr = this.kg._lastSeedCloneError;
          if (seedErr) {
            stages.seedClones = 'failed';
            pushFailure('seedClones', seedErr);
          } else {
            stages.seedClones = 'ok';
          }
        }
      } catch (err) {
        stages.seedClones = 'failed';
        pushFailure('seedClones', err);
      }
    } else {
      stages.seedClones = 'ok';
    }

    // L1.5: Insight Swarm — probe psychological dimensions
    let insights = [];
    try {
      const { runInsightSwarm } = await import('./insight-swarm.js');
      insights = await runInsightSwarm(this.kg);
      stages.insightSwarm = 'ok';
    } catch (err) {
      stages.insightSwarm = 'failed';
      pushFailure('insightSwarm', err);
    }

    // L2: Inference Engine — generate candidates from L1 facts + L1.5 insights
    let candidates = [];
    try {
      const { InferenceEngine } = await import('./inference-engine.js');
      const inference = new InferenceEngine(this.kg);
      candidates = await inference.run();
      stages.inference = 'ok';
    } catch (err) {
      stages.inference = 'failed';
      pushFailure('inference', err);
    }

    // L3: Clone evolution — evaluate, merge, kill, breed
    try {
      const { ClonePopulation } = await import('./evolution.js');
      if (!this.clonePopulation) {
        this.clonePopulation = new ClonePopulation(this.kg, this.llm);
      }

      const recentReactions = (this.kg.user.history || []).slice(-10).map(h => ({
        item: { title: h.item_id || h.story_id, topics: h.topics, id: h.item_id || h.story_id },
        reaction: h.reaction,
      }));

      if (recentReactions.length > 0) {
        await this.clonePopulation.evolve(recentReactions);
        stages.cloneEvolution = 'ok';
      }
    } catch (err) {
      stages.cloneEvolution = 'failed';
      pushFailure('cloneEvolution', err);
    }

    await this.kg.save();

    const result = {
      insights: Array.isArray(insights) ? insights.length : 0,
      candidates: Array.isArray(candidates) ? candidates.length : 0,
      clones: this.kg.getActiveClones().length,
      stages,
      failures,
    };

    if (!allowDegraded && failures.length > 0) {
      const err = new LearnDegradedError(failures, result);
      throw err;
    }

    return result;
  }

  /**
   * Run deep investigation of the user profile.
   * Assembles a per-user committee, generates questions, answers from data sources,
   * cross-references findings, debates.
   *
   * @param {Object} [options]
   * @param {number} [options.maxRounds=3]
   * @param {Object} [options.sources] - { name: async (query) => string[] }
   * @returns {Promise<Object>} Investigation results
   */
  async investigate(options = {}) {
    if (!this.llm) {
      throw new Error('investigate() requires an LLM provider.');
    }
    if (!this.ready) await this.init();

    const { InvestigativeCommittee } = await import('./investigative-committee.js');
    const committee = new InvestigativeCommittee(this.kg, this.llm, {
      maxRounds: options.maxRounds || 3,
      enableDebate: true,
      enablePsychInference: true,
      enableCrossRef: true,
    });

    if (options.sources) {
      for (const [name, fn] of Object.entries(options.sources)) {
        committee.registerSource(name, fn);
      }
    }

    const result = await committee.investigate();
    await this.kg.save();
    return result;
  }

  /**
   * Ingest a chat export (ChatGPT, Claude, generic) into the KG.
   * Extracts beliefs, preferences, identities, then runs inference pass.
   *
   * @param {string} filePath - Path to export JSON
   * @param {Object} [opts]
   * @param {boolean} [opts.runInference=true] - Run psychological inference pass
   * @returns {Promise<Object>} Ingestion stats
   */
  async ingestConversations(filePath, opts = {}) {
    if (!this.llm) {
      throw new Error('ingestConversations() requires an LLM provider.');
    }
    if (!this.ready) await this.init();

    const { ConversationMiner } = await import('./conversation-miner.js');
    const miner = new ConversationMiner(this.llm, {
      onProgress: opts.onProgress || null,
    });

    const result = await miner.ingestIntoKG(filePath, this.kg, {
      exchangeMode: opts.exchangeMode !== false,
      runInference: opts.runInference !== false,
    });

    await this.kg.save();
    return result;
  }

  /**
   * Update user context (calendar, projects, etc.)
   */
  setContext(context) {
    this.kg.setContext(context);
  }

  /**
   * Save KG state to disk
   */
  async save() {
    await this.kg.save();
  }
}

// ═══════════════════════════════════════════════════════════
// TIER 1: Public API (99% of developers only need this)
// ═══════════════════════════════════════════════════════════
// export { Marble } // already exported above

// ═══════════════════════════════════════════════════════════
// TIER 2: Core components (direct access for advanced use)
// ═══════════════════════════════════════════════════════════
export { KnowledgeGraph } from './kg.js';
export { Scorer } from './scorer.js';
export { ArcReranker } from './arc.js';

// ═══════════════════════════════════════════════════════════
// TIER 3: Individual pipeline layers (for composition)
// ═══════════════════════════════════════════════════════════
export { Swarm, Clone } from './swarm.js';
export { ClonePopulation } from './evolution.js';
export { InferenceEngine } from './inference-engine.js';
export { InvestigativeCommittee } from './investigative-committee.js';
export { RapidFeedbackEngine } from './rapid-feedback.js';
export { ConversationMiner } from './conversation-miner.js';
export { MemoryLayers } from './memory-layers.js';

// ═══════════════════════════════════════════════════════════
// TIER 4: Types & utilities
// ═══════════════════════════════════════════════════════════
export { SCORE_WEIGHTS, ARC_SLOTS } from './types.js';
export { USE_CASE_PROFILES, createProfileConfig } from './use-case-profiles.js';
