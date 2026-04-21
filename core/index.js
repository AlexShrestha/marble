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

import { KnowledgeGraph, DEFAULT_RECONCILIATION_RULES, DEFAULT_DECAY_CONFIG, DEFAULT_ENTITY_RESOLUTION } from './kg.js';
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
   * @param {Object}   [opts.reconciliationRules] - Per-slot cardinality rules
   *   for post-ingest reconciliation. Shape:
   *   `{ beliefs: { topic: 'one'|'many' }, preferences: { type: 'one'|'many' }, identities: { role: 'one'|'many' } }`
   *   Slots marked 'one' are collapsed to a single active fact after every
   *   `ingestEpisodes()` / `ingestConversations()` call — older versions are
   *   closed via `valid_to`. Unlisted slots retain 'many' (no forced
   *   uniqueness). Pass `null` to fully disable reconciliation. Defaults to
   *   `DEFAULT_RECONCILIATION_RULES` (a conservative starter set).
   * @param {Object}   [opts.decayConfig] - Temporal-decay parameters for
   *   `getActiveBeliefs/Preferences/Identities`. Shape:
   *   `{ halfLifeDays, minEffectiveStrength }`. Defaults to half-life 365
   *   days, threshold 0 (no filtering — back-compat preserved). Raise the
   *   threshold to drop stale facts from the active view.
   * @param {Object}   [opts.entityResolution] - Alias-clustering config.
   *   Shape: `{ enabled, threshold }`. Opt-in (default `enabled: false`).
   *   When enabled, ingest pipelines call `kg.resolveEntity()` on every
   *   extracted value and stamp `entity_id` on the resulting fact, so
   *   "BSB" and "British School Barcelona" under the same slot collapse
   *   into a single active fact with three aliases instead of three
   *   separate facts. Embedding similarity is used when an embeddings
   *   provider is available; exact + acronym tiers work without one.
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
    reconciliationRules = DEFAULT_RECONCILIATION_RULES,
    decayConfig = DEFAULT_DECAY_CONFIG,
    entityResolution = DEFAULT_ENTITY_RESOLUTION,
  } = {}) {
    this.kg = new KnowledgeGraph(storage, { decayConfig, entityResolution });
    this.scorer = new Scorer(this.kg, { coldStartThreshold, embeddings });
    this.arc = new ArcReranker();
    this.count = count;
    this.mode = mode;
    this.llm = llm;
    this.embeddings = embeddings;
    this.arcReorder = arcReorder;
    this.cloneBoostWeight = Math.max(0, Math.min(1, cloneBoostWeight));
    this.reconciliationRules = reconciliationRules;
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
   *   failures: Array<{ stage: string, code?: string, message: string }>,
   *   changes: {
   *     beliefs_added: number, beliefs_invalidated: number,
   *     preferences_added: number, preferences_invalidated: number,
   *     identities_added: number, identities_invalidated: number,
   *     clones_seeded: number, clones_bred: number, clones_killed: number,
   *     insights_generated: number, candidates_generated: number
   *   }
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

    // Change tracking. Snapshot per-id clone status (not just counts) so
    // `clones_killed` can distinguish "killed this run" from "already killed".
    // Counting valid_to-set facts before/after gives us invalidation deltas
    // that are otherwise invisible once they're merged into the KG.
    const snapshotCounts = () => ({
      beliefs_total: this.kg.user.beliefs.length,
      beliefs_invalidated: this.kg.user.beliefs.filter(b => b.valid_to).length,
      preferences_total: this.kg.user.preferences.length,
      preferences_invalidated: this.kg.user.preferences.filter(p => p.valid_to).length,
      identities_total: this.kg.user.identities.length,
      identities_invalidated: this.kg.user.identities.filter(i => i.valid_to).length,
    });
    const before = snapshotCounts();
    const cloneStatusBefore = new Map();
    for (const c of this.kg.user.clones || []) cloneStatusBefore.set(c.id, c.status);

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

    // Stamp before save so the timestamp hits disk.
    this.kg.user._last_learn_at = new Date().toISOString();
    await this.kg.save();

    // Compute change deltas. Separating seed vs bred requires looking at
    // `spawnedFrom` on the new clones, and counting kills means diffing the
    // status map per-id. Plain count subtraction can't distinguish these.
    const after = snapshotCounts();
    const allClonesAfter = this.kg.user.clones || [];
    const newClones = allClonesAfter.filter(c => !cloneStatusBefore.has(c.id));
    const clones_seeded = newClones.filter(c => !c.spawnedFrom).length;
    const clones_bred = newClones.filter(c => c.spawnedFrom).length;
    const clones_killed = allClonesAfter.filter(c =>
      c.status === 'killed' &&
      cloneStatusBefore.has(c.id) &&
      cloneStatusBefore.get(c.id) !== 'killed'
    ).length;

    const changes = {
      beliefs_added: Math.max(0, after.beliefs_total - before.beliefs_total),
      beliefs_invalidated: Math.max(0, after.beliefs_invalidated - before.beliefs_invalidated),
      preferences_added: Math.max(0, after.preferences_total - before.preferences_total),
      preferences_invalidated: Math.max(0, after.preferences_invalidated - before.preferences_invalidated),
      identities_added: Math.max(0, after.identities_total - before.identities_total),
      identities_invalidated: Math.max(0, after.identities_invalidated - before.identities_invalidated),
      clones_seeded,
      clones_bred,
      clones_killed,
      insights_generated: Array.isArray(insights) ? insights.length : 0,
      candidates_generated: Array.isArray(candidates) ? candidates.length : 0,
    };

    const result = {
      insights: changes.insights_generated,
      candidates: changes.candidates_generated,
      clones: this.kg.getActiveClones().length,
      stages,
      failures,
      changes,
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
    this.kg.user._last_investigate_at = new Date().toISOString();
    await this.kg.save();
    return result;
  }

  /**
   * Summarise KG health — counts, provenance coverage, decay distribution,
   * last-run timestamps. Answers the question "did the pipeline actually do
   * anything useful?" without requiring consumers to poke at internals.
   *
   * Returns a plain object; no side effects.
   *
   * @returns {{
   *   version: number,
   *   facts: {
   *     beliefs: { total: number, active: number, invalidated: number, with_evidence: number, with_valid_from: number },
   *     preferences: { total: number, active: number, invalidated: number, with_evidence: number, with_valid_from: number },
   *     identities: { total: number, active: number, invalidated: number, with_evidence: number, with_valid_from: number }
   *   },
   *   episodes: { total: number },
   *   clones: { active: number, killed: number, total: number },
   *   decay: { threshold: number, half_life_days: number, below_threshold: number },
   *   gaps: { open: number },
   *   last_learn_at: string|null,
   *   last_investigate_at: string|null,
   *   days_since_last_learn: number|null,
   *   days_since_last_investigate: number|null
   * }}
   */
  diagnose() {
    const kg = this.kg;
    if (!kg.user) {
      throw new Error('diagnose() called before init(). Call marble.init() first.');
    }

    const summariseCollection = (arr, keyFn) => {
      const active = arr.filter(f => !f.valid_to);
      return {
        total: arr.length,
        active: active.length,
        invalidated: arr.length - active.length,
        with_evidence: arr.filter(f => Array.isArray(f.evidence) && f.evidence.length > 0).length,
        with_valid_from: arr.filter(f => f.valid_from).length,
      };
    };

    const beliefs = kg.user.beliefs || [];
    const preferences = kg.user.preferences || [];
    const identities = kg.user.identities || [];
    const clones = kg.user.clones || [];
    const episodes = kg.user.episodes || [];

    // Decay: how many active facts would be filtered out if the threshold
    // were raised to the configured `minEffectiveStrength`. This compares
    // "nothing filtered" (threshold=0) to "default threshold applied" to
    // tell consumers what fraction of their active view is effectively stale.
    const allActiveNow = [
      ...kg.getActiveBeliefs(null, { minEffectiveStrength: 0 }),
      ...kg.getActivePreferences(null, { minEffectiveStrength: 0 }),
      ...kg.getActiveIdentities(null, { minEffectiveStrength: 0 }),
    ];
    const threshold = kg.decayConfig?.minEffectiveStrength ?? 0;
    const below_threshold = allActiveNow.filter(f =>
      typeof f.effective_strength === 'number' && f.effective_strength < threshold
    ).length;

    const openGaps = beliefs.filter(b => !b.valid_to && typeof b.topic === 'string' && b.topic.startsWith('gap:')).length;

    const lastLearn = kg.user._last_learn_at || null;
    const lastInvestigate = kg.user._last_investigate_at || null;
    const daysSince = (iso) => {
      if (!iso) return null;
      const t = new Date(iso).getTime();
      if (!Number.isFinite(t)) return null;
      return (Date.now() - t) / 86_400_000;
    };

    return {
      version: kg.version ?? 0,
      facts: {
        beliefs: summariseCollection(beliefs),
        preferences: summariseCollection(preferences),
        identities: summariseCollection(identities),
      },
      episodes: { total: episodes.length },
      clones: {
        active: clones.filter(c => c.status === 'active').length,
        killed: clones.filter(c => c.status === 'killed').length,
        total: clones.length,
      },
      decay: {
        threshold,
        half_life_days: kg.decayConfig?.halfLifeDays ?? null,
        below_threshold,
      },
      gaps: { open: openGaps },
      last_learn_at: lastLearn,
      last_investigate_at: lastInvestigate,
      days_since_last_learn: daysSince(lastLearn),
      days_since_last_investigate: daysSince(lastInvestigate),
    };
  }

  /**
   * Ingest a chat export (ChatGPT, Claude, generic) into the KG.
   * Extracts beliefs, preferences, identities, then runs inference pass.
   *
   * This is a format-specific convenience wrapper. For arbitrary sources
   * (journals, email, notes, anything textual), use `ingestEpisodes()` — it
   * accepts a generic `Episode` shape you can produce from any adapter.
   *
   * @param {string} filePath - Path to export JSON
   * @param {Object} [opts]
   * @param {boolean} [opts.runInference=true] - Run psychological inference pass
   * @param {string}  [opts.sourceLabel] - Override the episode `source` label
   *   (default: 'chat-export').
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
      sourceLabel: opts.sourceLabel,
    });

    const reconciled = this._reconcile();
    if (reconciled) result.reconciled = reconciled;

    await this.kg.save();
    return result;
  }

  /**
   * Ingest generic episodes into the KG — the format-agnostic entry point.
   *
   * An `Episode` is the minimal shape Marble needs to build provenance:
   *   { id?, source, source_date, content, metadata? }
   *
   * Pass whatever you can produce from your own sources. Marble will:
   *   1. Record each episode in `kg.user.episodes[]` (dedup by id+content_hash)
   *   2. Extract beliefs/preferences/identities from `content` via the LLM
   *   3. Stamp every extracted fact with `valid_from = source_date`
   *   4. Link each fact to its origin episode(s) via `evidence: [episode_id]`
   *
   * @param {Array<{id?: string, source?: string, source_date?: string, content: string, metadata?: object}>} episodes
   * @param {Object} [opts]
   * @param {boolean} [opts.runInference=true]
   * @returns {Promise<Object>} Same stats shape as `ingestConversations()`
   */
  async ingestEpisodes(episodes, opts = {}) {
    if (!this.llm) {
      throw new Error('ingestEpisodes() requires an LLM provider.');
    }
    if (!this.ready) await this.init();

    const { ConversationMiner } = await import('./conversation-miner.js');
    const miner = new ConversationMiner(this.llm, {
      onProgress: opts.onProgress || null,
    });

    const result = await miner.ingestEpisodesIntoKG(episodes, this.kg, {
      runInference: opts.runInference !== false,
    });

    const reconciled = this._reconcile();
    if (reconciled) result.reconciled = reconciled;

    await this.kg.save();
    return result;
  }

  /**
   * Run the configured reconciliation rules against the KG.
   * Returns the counts or null if reconciliation is disabled (rules === null).
   * Callers that ingest via the miner directly can opt into reconciliation by
   * calling `kg.reconcile()` themselves.
   * @private
   */
  _reconcile() {
    if (this.reconciliationRules === null) return null;
    return this.kg.reconcile(this.reconciliationRules);
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
export { KnowledgeGraph, KG_VERSION, DEFAULT_RECONCILIATION_RULES, DEFAULT_DECAY_CONFIG, DEFAULT_ENTITY_RESOLUTION } from './kg.js';
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
