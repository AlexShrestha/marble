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
  } = {}) {
    this.kg = new KnowledgeGraph(storage);
    this.scorer = new Scorer(this.kg, { coldStartThreshold });
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

    if (!llm) {
      console.warn('[Marble] No LLM provider configured. Only L0+L1 scoring available. '
        + 'Pass { llm: yourLLMFunction } for full pipeline (L1.5, L2, L3).');
    }
    if (!embeddings && !process.env.OPENAI_API_KEY) {
      console.warn('[Marble] No embeddings configured. Scorer will use keyword matching only. '
        + 'Set OPENAI_API_KEY or pass { embeddings: provider } for semantic scoring.');
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
   * Score and rank items. Uses clone consensus when clones exist.
   *
   * @param {Object[]} items - Candidate items (~100)
   * @param {Object}   [context] - Ephemeral context (calendar, projects, mood)
   * @returns {Object[]} Top items, arc-ordered
   */
  async select(items, context) {
    if (!this.ready) await this.init();

    if (context) {
      this.kg.setContext(context);
    }

    let scored;

    if ((this.mode === 'swarm' || this.mode === 'debate') && this.llm) {
      const swarm = new Swarm(this.kg, {
        mode: this.mode === 'debate' ? 'debate' : 'deep',
        llm: this.llm,
        topN: this.count,
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
   * @returns {Promise<{ insights: number, candidates: number, clones: number }>}
   */
  async learn() {
    if (!this.llm) {
      throw new Error('learn() requires an LLM provider. Pass { llm: yourLLMFunction } in constructor.');
    }
    if (!this.ready) await this.init();

    // Seed clones if none exist
    const existingClones = this.kg.getActiveClones();
    if (existingClones.length === 0 && typeof this.kg.seedClones === 'function') {
      const { createLLMClient } = await import('./llm-provider.js');
      const client = createLLMClient();
      await this.kg.seedClones(client, client.defaultModel('fast'));
    }

    // L1.5: Insight Swarm — probe psychological dimensions
    const { runInsightSwarm } = await import('./insight-swarm.js');
    const insights = await runInsightSwarm(this.kg);

    // L2: Inference Engine — generate candidates from L1 facts + L1.5 insights
    const { InferenceEngine } = await import('./inference-engine.js');
    const inference = new InferenceEngine(this.kg);
    const candidates = await inference.run();

    // L3: Clone evolution — evaluate, merge, kill, breed
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
    }

    await this.kg.save();

    return {
      insights: insights.length,
      candidates: Array.isArray(candidates) ? candidates.length : 0,
      clones: this.kg.getActiveClones().length,
    };
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
