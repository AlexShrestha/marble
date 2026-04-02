/**
 * Marblism — World → You
 *
 * Hyper-personalized story curation engine.
 * 100 stories in, 10 magical ones out.
 */

import { KnowledgeGraph } from './kg.js';
import { Scorer } from './scorer.js';
import { ArcReranker } from './arc.js';
import { Swarm } from './swarm.js';
import { Clone } from './clone.js';
import { decayPass } from './decay.js';

export class Marblism {
  constructor({ dataPath = './marblism-kg.json', count = 10, mode = 'score', llm = null } = {}) {
    this.kg = new KnowledgeGraph(dataPath);
    this.scorer = new Scorer(this.kg);
    this.arc = new ArcReranker();
    this.count = count;
    this.mode = mode; // 'score' (v1) or 'swarm' (v2)
    this.llm = llm;   // LLM function for deep swarm mode
    this.ready = false;
  }

  async init() {
    await this.kg.load();
    decayPass(this.kg);
    this.ready = true;
    return this;
  }

  /**
   * The main function. Feed stories, get magic.
   * @param {Story[]} stories - Raw stories (~100)
   * @param {Object} [context] - Optional today's context override
   * @returns {ScoredStory[]} - Top stories, arc-ordered
   */
  async select(stories, context) {
    if (!this.ready) await this.init();

    // Set ephemeral context if provided
    if (context) {
      this.kg.setContext(context);
    }

    if (this.mode === 'swarm') {
      // v2: Multi-agent swarm curation
      const swarm = new Swarm(this.kg, {
        mode: this.llm ? 'deep' : 'fast',
        llm: this.llm,
        topN: this.count
      });
      const curated = await swarm.curate(stories);
      // Re-order through arc for narrative flow
      return this.arc.reorder(curated, this.count);
    }

    // v1: Direct scoring
    const scored = this.scorer.score(stories);
    return this.arc.reorder(scored, this.count);
  }

  /**
   * Record user feedback on a story
   */
  async react(storyId, reaction, topics, source) {
    this.kg.recordReaction(storyId, reaction, topics, source);
    await this.kg.save();
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

export { KnowledgeGraph } from './kg.js';
export { Scorer } from './scorer.js';
export { ArcReranker } from './arc.js';
export {
  Swarm, Clone, SwarmAgent, AGENT_LENSES,
  computeDynamicWeights,
  detectDomain,
  generateAgentFleet, invalidateFleetCache, getFleetCacheStats,
  explodeAgentQuestions,
} from './swarm.js';
export { ClonePopulation, evaluateFitness } from './evolution.js';
export { SignalProcessor } from './signals.js';
export { Observer } from './observer.js';
export { SCORE_WEIGHTS, ARC_SLOTS } from './types.js';

// Collaborative filtering
export { CollaborativeFilter } from './collaborative-filter.js';

// Domain-agnostic knowledge extraction
export { extractEntityAttributes, attributeCount } from './entity-extractor.js';
export { detectDomain as detectItemDomain, getDomainSchema, getDomainDimensions, getDimension, DOMAINS } from './domain-schemas.js';

// L1.5 Insight Mining Swarm
export { runInsightSwarm, getL2Seeds } from './insight-swarm.js';

// L2 Inference Engine
export { InferenceEngine } from './inference-engine.js';

// L3 Clone Simulation Queue
export { SimulationQueue } from './simulation-queue.js';

// Topic Insight Engine (LLM-powered preference learning)
export { TopicInsightEngine, GapSimulator } from './topic-insight-engine.js';

// Secondary context collection (question-driven)
export { QuestionEngine } from './question-engine.js';

// Use-case profiles and scorer factory
export { USE_CASE_PROFILES, createProfileConfig, createScorerForUseCase } from './use-case-profiles.js';

// World context cache (KG-backed)
export { cacheWorldContext, getWorldContextCache, checkCacheValidity, getWorldContextOrFallback, invalidateWorldContextCache, getCacheStats } from './world-context-cache.js';

// Lightweight scorer (mobile/edge)
export { default as LightweightScorer } from './lightweight-scorer.js';

// WorldSim bridge (neutral adapter: WorldSim archetypes → Marble KG)
export { readWorldContext, writeWorldContext, syncBatch, writeSystemAOutput, getSystemAFromCache, getWorldContextFromCache, toWorldSimContext } from './worldsim-bridge.js';

// World context scheduler (nightly cache refresh, user data ingest)
export { scheduleNightlyCacheRefresh, handleUserDataIngest, getCacheRefreshStatus } from './world-context-scheduler.js';
