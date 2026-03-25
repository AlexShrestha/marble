/**
 * Prism Metric-Agnostic Scorer
 *
 * Computes magic_score for content using pluggable business metrics.
 * Clone fitness evolves against REAL metrics, not just engagement.
 * Supports auto-tuning weights via calibration API.
 */

import { SCORE_WEIGHTS } from './types.js';
import { embeddings } from './embeddings.js';
import { MetricConfig, USE_CASE_CONFIGS } from './metric-config.js';
import { DynamicWeights } from './dynamic-weights.js';
import { CalibrationAPI } from './calibration-api.js';

export class Scorer {
  constructor(kg, config = {}) {
    this.kg = kg;

    // Metric-agnostic configuration
    this.useCase = config.useCase || 'content_curation';
    this.targetMetrics = config.targetMetrics || ['engagement_time'];
    this.metricConfig = new MetricConfig(this.useCase);

    // Dynamic weights system (auto-tuning)
    const initialWeights = config.initialWeights ||
      USE_CASE_CONFIGS[this.useCase]?.initialWeights ||
      SCORE_WEIGHTS;
    this.dynamicWeights = new DynamicWeights(initialWeights);

    // Calibration API for feedback
    this.calibrationAPI = new CalibrationAPI(this);

    // Decision compression configuration
    this.decisionCompressionEnabled = config.decisionCompressionEnabled || false;
    this.swarmInstance = config.swarmInstance || null; // Optional swarm for enhanced reasoning

    // Backward compatibility
    this.legacyMode = config.legacyMode !== false; // Default to true for VIVO compatibility
    this.weights = this; // Expose weights interface for calibration
  }

  /**
   * Score a batch of stories against the user's KG
   * @param {Story[]} stories - Raw stories to score
   * @returns {Promise<ScoredStory[]>} - Stories with computed scores, sorted descending
   */
  async score(stories) {
    const scored = await Promise.all(stories.map(story => this.#scoreOne(story)));
    return scored.sort((a, b) => b.magic_score - a.magic_score);
  }

  /**
   * Score content with business metrics (metric-agnostic interface)
   * @param {Object} content - Content to score
   * @param {Object} options - Scoring options
   * @returns {Promise<Object>} - Enhanced scoring results
   */
  async scoreContentWithMetrics(content, options = {}) {
    // Convert content format to story format for compatibility
    const story = {
      id: content.id || `story_${Date.now()}`,
      title: content.title || '',
      summary: content.summary || content.description || '',
      source: content.source || 'unknown',
      url: content.url || '',
      topics: content.topics || content.categories || [],
      published_at: content.published_at || new Date(),
      actionability: content.actionability
    };

    // Use metric-agnostic scoring (disable legacy mode for this call)
    const originalLegacyMode = this.legacyMode;
    this.legacyMode = false;

    try {
      const result = await this.#scoreOne(story);
      return {
        ...result,
        session_id: this.#generateSessionId(),
        timestamp: new Date().toISOString()
      };
    } finally {
      this.legacyMode = originalLegacyMode;
    }
  }

  /**
   * Calibrate scoring weights based on business outcomes
   * @param {Object[]} validationBatch - Outcome data for calibration
   * @returns {Promise<Object>} - Calibration results
   */
  async calibrateFromOutcomes(validationBatch) {
    return await this.calibrationAPI.calibrateWeights(validationBatch);
  }

  /**
   * Get available use cases and their configurations
   */
  getAvailableUseCases() {
    return Object.entries(USE_CASE_CONFIGS).map(([name, config]) => ({
      name,
      description: config.description,
      targetMetrics: config.targetMetrics
    }));
  }

  /**
   * Switch to different use case configuration
   */
  switchUseCase(useCase, customConfig = {}) {
    this.useCase = useCase;
    this.metricConfig = new MetricConfig(useCase);

    const config = USE_CASE_CONFIGS[useCase];
    if (config) {
      const weights = { ...config.initialWeights, ...customConfig.initialWeights };
      this.dynamicWeights = new DynamicWeights(weights);
      this.targetMetrics = config.targetMetrics;
    }

    return {
      success: true,
      useCase,
      targetMetrics: this.targetMetrics,
      weights: this.dynamicWeights.getCurrentWeights()
    };
  }

  /**
   * Export scorer configuration
   */
  exportConfiguration() {
    return {
      useCase: this.useCase,
      targetMetrics: this.targetMetrics,
      weights: this.dynamicWeights.exportConfig(),
      metricConfig: this.metricConfig.exportConfiguration(),
      calibrationHistory: this.calibrationAPI.getCalibrationHistory(),
      legacyMode: this.legacyMode,
      decisionCompressionEnabled: this.decisionCompressionEnabled,
      exportedAt: Date.now()
    };
  }

  /**
   * Enable/disable decision compression mode
   */
  setDecisionCompressionMode(enabled, swarmInstance = null) {
    this.decisionCompressionEnabled = enabled;
    this.swarmInstance = swarmInstance;
    return {
      success: true,
      decisionCompressionEnabled: this.decisionCompressionEnabled,
      swarmIntegrationEnabled: !!this.swarmInstance
    };
  }

  async #scoreOne(story) {
    const interest = await this.#interestMatch(story);
    const temporal = this.#temporalRelevance(story);
    const novelty = this.#noveltyScore(story);
    const action = this.#actionability(story);
    const trust = this.#sourceTrust(story);
    const freshness = this.#freshnessDecay(story);

    // Dimension scores for metric-agnostic system
    const dimensionScores = {
      interest_match: interest,
      temporal_relevance: temporal,
      novelty,
      actionability: action,
      source_trust: trust
    };

    // Use dynamic weights or legacy weights
    let raw;
    if (this.legacyMode) {
      // Backward compatibility: use fixed SCORE_WEIGHTS for VIVO
      raw = (
        interest * SCORE_WEIGHTS.interest_match +
        temporal * SCORE_WEIGHTS.temporal_relevance +
        novelty * SCORE_WEIGHTS.novelty +
        action * SCORE_WEIGHTS.actionability +
        trust * SCORE_WEIGHTS.source_trust
      );
    } else {
      // Metric-agnostic: use dynamic weights
      raw = this.dynamicWeights.computeWeightedScore(dimensionScores);
    }

    const magic_score = raw * freshness;

    const result = {
      story,
      magic_score,
      interest_match: interest,
      temporal_relevance: temporal,
      novelty,
      actionability: action,
      source_trust: trust,
      arc_position: 0, // set later by arc reranker
      why: this.#explainScore({ interest, temporal, novelty, action, trust }),

      // Metric-agnostic additions
      use_case: this.useCase,
      dimension_scores: dimensionScores,
      current_weights: this.dynamicWeights.getCurrentWeights(),
      confidence: this.#calculateConfidence(dimensionScores)
    };

    // Add business predictions if not in legacy mode
    if (!this.legacyMode) {
      result.business_predictions = this.#generateBusinessPredictions(dimensionScores);
    }

    // Add decision compression output if enabled
    if (this.decisionCompressionEnabled) {
      const compression = this.#generateDecisionCompression(story, dimensionScores, result);
      result.what_matters = compression.what_matters;
      result.why = compression.why; // Replace basic why with enhanced version
      result.what_to_do_next = compression.what_to_do_next;
      result.compression_confidence = compression.confidence;
    }

    return result;
  }

  // ─── METRIC-AGNOSTIC METHODS ────────────────────────────────────────────

  /**
   * Generate business predictions based on dimension scores
   */
  #generateBusinessPredictions(dimensionScores) {
    const predictions = {};

    for (const metric of this.targetMetrics) {
      // Simple heuristic predictions based on dimension correlations
      let expectedDelta = 0;

      if (metric.includes('conversion') || metric.includes('revenue')) {
        // Conversion/revenue correlates with personalization + actionability
        expectedDelta = (dimensionScores.interest_match * 0.4 +
          dimensionScores.actionability * 0.4 +
          dimensionScores.source_trust * 0.2) - 0.5;
      } else if (metric.includes('engagement') || metric.includes('time')) {
        // Engagement correlates with temporal relevance + novelty
        expectedDelta = (dimensionScores.temporal_relevance * 0.4 +
          dimensionScores.novelty * 0.3 +
          dimensionScores.interest_match * 0.3) - 0.5;
      } else if (metric.includes('retention') || metric.includes('return')) {
        // Retention correlates with novelty + trust
        expectedDelta = (dimensionScores.novelty * 0.4 +
          dimensionScores.source_trust * 0.3 +
          dimensionScores.interest_match * 0.3) - 0.5;
      } else {
        // Generic prediction
        expectedDelta = (Object.values(dimensionScores).reduce((sum, score) => sum + score, 0) /
          Object.keys(dimensionScores).length) - 0.5;
      }

      predictions[metric] = {
        expectedDelta: Math.max(-0.5, Math.min(0.5, expectedDelta)),
        confidence: this.#calculatePredictionConfidence(dimensionScores),
        factors: this.#identifyTopFactors(dimensionScores, metric)
      };
    }

    return predictions;
  }

  /**
   * Calculate confidence score for predictions
   */
  #calculateConfidence(dimensionScores) {
    const scores = Object.values(dimensionScores);
    const avgScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;
    const variance = this.#calculateVariance(scores);

    // Higher confidence when scores are consistent and strong
    const consistencyBonus = Math.max(0, 1 - variance * 3);
    const strengthBonus = avgScore * 0.5;

    return Math.max(0.1, Math.min(0.95, (consistencyBonus + strengthBonus) / 1.5));
  }

  #calculatePredictionConfidence(dimensionScores) {
    const calibrationHistory = this.calibrationAPI.getCalibrationHistory();
    const baseConfidence = this.#calculateConfidence(dimensionScores);

    // Adjust based on calibration experience
    if (calibrationHistory.totalCalibrations > 10) {
      return Math.min(0.9, baseConfidence + calibrationHistory.confidence * 0.2);
    }

    return baseConfidence * 0.7; // Lower confidence without calibration data
  }

  #identifyTopFactors(dimensionScores, metric) {
    const sorted = Object.entries(dimensionScores)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3);

    return sorted.map(([dimension, score]) => ({
      dimension,
      score,
      impact: score > 0.6 ? 'high' : score > 0.4 ? 'medium' : 'low'
    }));
  }

  #calculateVariance(values) {
    const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
    const squaredDiffs = values.map(val => Math.pow(val - mean, 2));
    return squaredDiffs.reduce((sum, diff) => sum + diff, 0) / values.length;
  }

  #generateSessionId() {
    return `prism_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // ─── DECISION COMPRESSION METHODS ──────────────────────────────────────────

  /**
   * Generate decision compression output for a story
   * @param {Object} story - The story object
   * @param {Object} dimensionScores - Scoring dimensions
   * @param {Object} baseResult - Base scoring result
   * @returns {Object} Decision compression data
   */
  #generateDecisionCompression(story, dimensionScores, baseResult) {
    const topDimensions = this.#identifyTopDimensions(dimensionScores);
    const swarmReasoning = this.#getSwarmReasoning(story);

    return {
      what_matters: this.#generateWhatMatters(story, topDimensions, baseResult.magic_score),
      why: this.#generateEnhancedWhy(story, topDimensions, swarmReasoning),
      what_to_do_next: this.#generateActionableCTA(story, dimensionScores),
      confidence: this.#calculateCompressionConfidence(dimensionScores, swarmReasoning)
    };
  }

  /**
   * Identify the top 2-3 dimensions driving the score
   */
  #identifyTopDimensions(dimensionScores) {
    return Object.entries(dimensionScores)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([dimension, score]) => ({
        dimension,
        score,
        impact: score > 0.7 ? 'high' : score > 0.4 ? 'medium' : 'low'
      }));
  }

  /**
   * Get reasoning from swarm agents if available
   */
  #getSwarmReasoning(story) {
    if (!this.swarmInstance || !this.swarmInstance.agents) {
      return null;
    }

    const agentReasons = [];
    for (const agent of this.swarmInstance.agents) {
      const pick = agent.picks?.find(p => p.story.id === story.id);
      if (pick && pick.reason) {
        agentReasons.push({
          agent: agent.lens.name,
          reason: pick.reason,
          score: pick.score
        });
      }
    }

    return agentReasons.length > 0 ? agentReasons : null;
  }

  /**
   * Generate concise "what matters" statement
   */
  #generateWhatMatters(story, topDimensions, magicScore) {
    const primary = topDimensions[0];
    const secondary = topDimensions[1];

    if (magicScore > 0.8) {
      if (primary.dimension === 'temporal_relevance') {
        return 'Perfect timing for your current priorities';
      } else if (primary.dimension === 'interest_match') {
        return 'Directly relevant to your core interests';
      } else if (primary.dimension === 'actionability') {
        return 'Immediate action opportunity';
      }
      return 'High-value content across multiple factors';
    } else if (magicScore > 0.6) {
      if (primary.dimension === 'temporal_relevance' && secondary?.dimension === 'actionability') {
        return 'Timely opportunity you can act on';
      } else if (primary.dimension === 'interest_match' && secondary?.dimension === 'novelty') {
        return 'Fresh perspective on your interests';
      } else if (primary.dimension === 'novelty') {
        return 'New signal worth your attention';
      }
      return `Strong ${primary.dimension.replace('_', ' ')} match`;
    } else {
      return 'Moderate relevance with growth potential';
    }
  }

  /**
   * Generate enhanced why with hypothesis
   */
  #generateEnhancedWhy(story, topDimensions, swarmReasoning) {
    const dimensionReasons = topDimensions.map(d => {
      switch (d.dimension) {
        case 'temporal_relevance':
          return d.score > 0.6 ? 'aligns with your current projects' : 'has timely elements';
        case 'interest_match':
          return d.score > 0.6 ? 'matches your established interests' : 'touches relevant themes';
        case 'novelty':
          return d.score > 0.6 ? 'brings fresh perspectives' : 'offers new angles';
        case 'actionability':
          return d.score > 0.6 ? 'presents clear next steps' : 'suggests potential actions';
        case 'source_trust':
          return d.score > 0.6 ? 'comes from trusted sources' : 'has reasonable credibility';
        default:
          return `scores well on ${d.dimension.replace('_', ' ')}`;
      }
    }).slice(0, 2);

    let baseWhy = `This ${dimensionReasons.join(' and ')}`;

    // Add swarm insights if available
    if (swarmReasoning) {
      const topAgentReason = swarmReasoning
        .sort((a, b) => b.score - a.score)[0];

      if (topAgentReason) {
        baseWhy += `. ${topAgentReason.agent.replace(' Agent', '')}: ${topAgentReason.reason}`;
      }
    }

    // Add hypothesis
    const hypothesis = this.#generateInsightHypothesis(story, topDimensions);
    if (hypothesis) {
      baseWhy += `. Hypothesis: ${hypothesis}`;
    }

    return baseWhy;
  }

  /**
   * Generate insight hypothesis from knowledge graph
   */
  #generateInsightHypothesis(story, topDimensions) {
    const primaryDimension = topDimensions[0];

    if (primaryDimension.dimension === 'temporal_relevance' && primaryDimension.score > 0.6) {
      return 'reading this now could influence decisions you\'re making today';
    } else if (primaryDimension.dimension === 'interest_match' && primaryDimension.score > 0.7) {
      return 'this connects to patterns in your knowledge graph';
    } else if (primaryDimension.dimension === 'novelty' && primaryDimension.score > 0.6) {
      return 'this could expand your current understanding';
    } else if (primaryDimension.dimension === 'actionability' && primaryDimension.score > 0.6) {
      return 'this presents implementation opportunities for your current work';
    }

    return null;
  }

  /**
   * Generate actionable next step or CTA
   */
  #generateActionableCTA(story, dimensionScores) {
    const { actionability, temporal_relevance, interest_match } = dimensionScores;

    // High actionability = direct action
    if (actionability > 0.6) {
      if (story.title?.toLowerCase().includes('launch') || story.summary?.toLowerCase().includes('available')) {
        return 'Research implementation details and timeline';
      } else if (story.title?.toLowerCase().includes('deadline') || story.summary?.toLowerCase().includes('apply')) {
        return 'Check dates and requirements immediately';
      } else {
        return 'Identify specific steps to implement this';
      }
    }

    // High temporal relevance = timing-based action
    if (temporal_relevance > 0.6) {
      return 'Consider how this affects your current priorities';
    }

    // High interest match = knowledge building
    if (interest_match > 0.7) {
      return 'Save for deeper research and cross-reference with current projects';
    }

    // Default based on story type
    if (story.url) {
      return 'Review full article to assess relevance';
    } else {
      return 'Monitor for developments and related content';
    }
  }

  /**
   * Calculate confidence in the decision compression
   */
  #calculateCompressionConfidence(dimensionScores, swarmReasoning) {
    const baseConfidence = this.#calculateConfidence(dimensionScores);

    // Boost confidence if we have swarm reasoning
    if (swarmReasoning && swarmReasoning.length > 0) {
      const avgSwarmScore = swarmReasoning.reduce((sum, r) => sum + r.score, 0) / swarmReasoning.length;
      return Math.min(0.95, baseConfidence + avgSwarmScore * 0.15);
    }

    return baseConfidence * 0.9; // Slightly lower without swarm validation
  }

  // ─── SCORING DIMENSIONS ────────────────────────────────────────────────

  /**
   * How well does this story match the user's interest graph?
   * Uses semantic embeddings for better matching (e.g., "EU digital markets act" matches "Shopify compliance")
   */
  async #interestMatch(story) {
    if (!story.topics?.length) return 0.3; // neutral for untagged

    // Get story content for semantic analysis
    const storyText = `${story.title} ${story.summary || ''}`.trim();
    if (!storyText) return 0.3;

    try {
      // Get user interests from knowledge graph
      const userInterests = this.kg.getTopInterests?.() || [];
      if (!userInterests.length) {
        // Fallback to topic-based scoring if no interests available
        const weights = story.topics.map(t => this.kg.getInterestWeight(t));
        if (weights.every(w => w === 0)) return 0.1;
        const max = Math.max(...weights);
        const matchCount = weights.filter(w => w > 0).length;
        const multiBonus = Math.min(0.1, matchCount * 0.03);
        return Math.min(1, max + multiBonus);
      }

      // Use semantic similarity for matching
      const interestTexts = userInterests.map(interest =>
        typeof interest === 'string' ? interest : interest.name || interest.topic
      ).filter(Boolean);

      const bestMatch = await embeddings.findMostSimilar(storyText, interestTexts, 0.2);

      if (bestMatch.similarity > 0) {
        // Convert similarity score (0-1) to interest match score with some boosting
        const semanticScore = Math.min(1, bestMatch.similarity * 1.2);

        // Blend with traditional topic matching if available
        const topicWeights = story.topics.map(t => this.kg.getInterestWeight(t));
        const maxTopicWeight = Math.max(0, ...topicWeights);

        // Use the higher of semantic or topic-based score
        return Math.max(semanticScore, maxTopicWeight * 0.8);
      }

      // Fallback to topic-based matching
      const weights = story.topics.map(t => this.kg.getInterestWeight(t));
      if (weights.every(w => w === 0)) return 0.1;
      const max = Math.max(...weights);
      return max * 0.8; // Slightly lower for non-semantic matches

    } catch (error) {
      console.warn('Semantic matching failed, using fallback:', error.message);
      // Fallback to original keyword-based matching
      const weights = story.topics.map(t => this.kg.getInterestWeight(t));
      if (weights.every(w => w === 0)) return 0.1;
      const max = Math.max(...weights);
      const matchCount = weights.filter(w => w > 0).length;
      const multiBonus = Math.min(0.1, matchCount * 0.03);
      return Math.min(1, max + multiBonus);
    }
  }

  /**
   * How relevant is this story to what's happening in the user's life TODAY?
   * This is the magic dimension — calendar, projects, conversations.
   */
  #temporalRelevance(story) {
    const ctx = this.kg.user.context;
    let score = 0.2; // baseline

    const storyText = `${story.title} ${story.summary}`.toLowerCase();

    // Check against active projects
    for (const project of ctx.active_projects || []) {
      if (storyText.includes(project.toLowerCase())) {
        score += 0.3;
        break;
      }
    }

    // Check against today's calendar
    for (const event of ctx.calendar || []) {
      const eventWords = event.toLowerCase().split(/\s+/);
      if (eventWords.some(w => w.length > 3 && storyText.includes(w))) {
        score += 0.25;
        break;
      }
    }

    // Check against recent conversation topics
    for (const convo of ctx.recent_conversations || []) {
      if (storyText.includes(convo.toLowerCase())) {
        score += 0.15;
        break;
      }
    }

    return Math.min(1, score);
  }

  /**
   * How novel/surprising is this story?
   * Stories the user has already seen or on over-saturated topics score lower.
   */
  #noveltyScore(story) {
    // Already seen = 0
    if (this.kg.hasSeen(story.id)) return 0;

    // Check topic saturation in recent history
    const recentHistory = this.kg.user.history.slice(-50);
    const topicCounts = {};
    for (const h of recentHistory) {
      for (const t of h.topics || []) {
        topicCounts[t] = (topicCounts[t] || 0) + 1;
      }
    }

    // Stories with over-represented topics get novelty penalty
    let saturation = 0;
    for (const topic of story.topics || []) {
      saturation += (topicCounts[topic] || 0);
    }

    const novelty = Math.max(0.1, 1 - (saturation / 20));
    return novelty;
  }

  /**
   * Can the user DO something with this story today?
   */
  #actionability(story) {
    // If story has explicit actionability tag, use it
    if (typeof story.actionability === 'number') return story.actionability;

    // Heuristic: stories mentioning tools, launches, deadlines, opportunities
    const actionWords = ['launch', 'deadline', 'opportunity', 'available', 'release',
      'update', 'new feature', 'apply', 'register', 'open source', 'free'];
    const text = `${story.title} ${story.summary}`.toLowerCase();
    const matches = actionWords.filter(w => text.includes(w)).length;

    return Math.min(1, 0.2 + matches * 0.15);
  }

  /**
   * How much does the user trust this source?
   */
  #sourceTrust(story) {
    return this.kg.getSourceTrust(story.source);
  }

  /**
   * Freshness decay — older stories get penalized
   */
  #freshnessDecay(story) {
    const hoursOld = (Date.now() - new Date(story.published_at).getTime()) / 3600000;
    if (hoursOld < 2) return 1.0;
    if (hoursOld < 6) return 0.95;
    if (hoursOld < 12) return 0.85;
    if (hoursOld < 24) return 0.7;
    if (hoursOld < 48) return 0.5;
    return 0.3;
  }

  /**
   * Generate human-readable explanation for why a story was selected
   */
  #explainScore({ interest, temporal, novelty, action, trust }) {
    const reasons = [];
    if (temporal > 0.5) reasons.push('relevant to your day');
    if (interest > 0.6) reasons.push('matches your interests');
    if (novelty > 0.7) reasons.push('fresh perspective');
    if (action > 0.5) reasons.push('actionable');
    if (trust > 0.7) reasons.push('trusted source');
    return reasons.join(', ') || 'general relevance';
  }
}
