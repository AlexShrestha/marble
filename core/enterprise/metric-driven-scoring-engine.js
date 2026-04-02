/**
 * Metric-Driven Scoring Engine
 *
 * Core engine that scores content based on business metrics rather than fixed weights.
 * Auto-tunes scoring weights based on correlation with actual business outcomes.
 */

import { DynamicWeightSystem } from './dynamic-weight-system.js';
import { BusinessMetricPredictor } from './business-metric-predictor.js';
import { USE_CASE_CONFIGS } from '../types.js';
import { PluggableMetricConfig } from './pluggable-metric-config.js';

export class MetricDrivenScoringEngine {
  constructor(config) {
    this.useCase = config.useCase || 'content_curation';
    this.targetMetrics = config.targetMetrics || ['engagement_time'];

    // Initialize pluggable metric system
    this.metricConfig = config.metricConfig || new PluggableMetricConfig();

    // Get use case configuration (supports both standard and custom)
    const useCaseConfig = this.metricConfig.getUseCaseConfig(this.useCase) || USE_CASE_CONFIGS[this.useCase];

    // Use provided weights or derive from use case config
    const initialWeights = config.initialWeights || useCaseConfig?.initialWeights || this.getDefaultWeights();

    this.weights = new DynamicWeightSystem(initialWeights);
    this.predictor = new BusinessMetricPredictor();
    this.validationHistory = [];
    this.customMetrics = config.customMetrics || [];
    this.created = Date.now();
  }

  /**
   * Score content using dynamic weights and business metric predictions
   */
  async scoreContent(content, options = {}) {
    const dimensionScores = await this.computeDimensionScores(content, options);
    const weightedScore = this.weights.computeWeightedScore(dimensionScores);
    const businessPredictions = this.predictor.generatePredictions(
      dimensionScores,
      this.targetMetrics
    );

    return {
      magic_score: weightedScore,
      dimension_scores: dimensionScores,
      business_predictions: businessPredictions,
      confidence: this.computeConfidence(dimensionScores),
      reasoning: this.explainScore(dimensionScores, businessPredictions),
      use_case: this.useCase,
      current_weights: this.weights.getCurrentWeights(),
      session_id: this.generateSessionId()
    };
  }

  /**
   * Compute dimension scores for content
   */
  async computeDimensionScores(content, options = {}) {
    const scores = {};

    // Interest/Personalization dimension
    scores.personalization_depth = this.scorePersonalization(content, options);
    scores.interest_match = scores.personalization_depth; // Alias for compatibility

    // Temporal relevance
    scores.temporal_relevance = this.scoreTemporalRelevance(content, options);

    // Novelty/Psychological resonance
    scores.psychological_resonance = this.scorePsychologicalResonance(content, options);
    scores.novelty = scores.psychological_resonance; // Alias for compatibility

    // Actionability
    scores.actionability = this.scoreActionability(content, options);

    // Trust indicators
    scores.trust_indicators = this.scoreTrustIndicators(content, options);
    scores.source_trust = scores.trust_indicators; // Alias for compatibility

    // Advanced dimensions for specific use cases
    if (this.useCase === 'content_curation') {
      scores.insight_density = this.scoreInsightDensity(content, options);
      scores.social_proof = this.scoreSocialProof(content, options);
    }

    return scores;
  }

  /**
   * Calibrate weights based on business outcomes
   */
  async calibrateFromOutcomes(validationBatch) {
    for (const validation of validationBatch) {
      // Handle custom metric validation and normalization
      const processedValidation = await this.processValidationData(validation);

      this.weights.updateFromValidation(
        processedValidation.dimensionScores,
        processedValidation.actualMetrics[this.targetMetrics[0]], // Primary metric
        processedValidation.baseline[this.targetMetrics[0]]
      );
    }

    this.validationHistory.push(...validationBatch);

    // Keep last 500 validations
    if (this.validationHistory.length > 500) {
      this.validationHistory = this.validationHistory.slice(-500);
    }

    return this.getCalibrationSummary();
  }

  /**
   * Process validation data with custom metric handling
   */
  async processValidationData(validation) {
    const processed = { ...validation };

    // Validate and normalize custom metrics
    for (const metricName of this.targetMetrics) {
      if (processed.actualMetrics[metricName] !== undefined) {
        // Validate metric value
        const validationResult = this.metricConfig.validateMetricValue(
          metricName,
          processed.actualMetrics[metricName],
          { validation, useCase: this.useCase }
        );

        if (!validationResult.valid) {
          console.warn(`Metric validation failed for ${metricName}: ${validationResult.error}`);
          continue;
        }

        // Normalize metric value
        processed.actualMetrics[metricName] = this.metricConfig.normalizeMetricValue(
          metricName,
          processed.actualMetrics[metricName],
          { validation, useCase: this.useCase }
        );
      }

      // Same for baseline metrics
      if (processed.baseline && processed.baseline[metricName] !== undefined) {
        processed.baseline[metricName] = this.metricConfig.normalizeMetricValue(
          metricName,
          processed.baseline[metricName],
          { validation, useCase: this.useCase }
        );
      }
    }

    return processed;
  }

  /**
   * Get summary of calibration performance
   */
  getCalibrationSummary() {
    const recent = this.validationHistory.slice(-50);
    const improvements = recent.map(v => {
      const primaryMetric = this.targetMetrics[0];
      const actual = v.actualMetrics[primaryMetric] || 0;
      const baseline = v.baseline[primaryMetric] || 0.01;
      return (actual - baseline) / baseline;
    });

    const avgImprovement = improvements.reduce((a, b) => a + b, 0) / improvements.length || 0;
    const validationsCount = this.validationHistory.length;

    return {
      validationsProcessed: validationsCount,
      averageImprovement: Math.round(avgImprovement * 100) / 100,
      confidence: this.calculateCalibrationConfidence(),
      weightChanges: this.weights.getRecentChanges(),
      lastUpdated: new Date().toISOString()
    };
  }

  // ─── SCORING DIMENSIONS ────────────────────────────────────────────────

  scorePersonalization(content, options) {
    // Score based on user context matching
    const userContext = options.userContext || {};
    const contentTopics = content.topics || [];

    let score = 0.2; // Baseline

    // Match against user interests
    const userInterests = userContext.interests || [];
    const matchCount = contentTopics.filter(topic =>
      userInterests.some(interest =>
        interest.includes(topic) || topic.includes(interest)
      )
    ).length;

    score += Math.min(0.6, matchCount * 0.15);

    // Boost for user-specific context
    if (userContext.activeProjects) {
      const projectMatch = userContext.activeProjects.some(project =>
        content.title?.toLowerCase().includes(project.toLowerCase())
      );
      if (projectMatch) score += 0.2;
    }

    return Math.min(1, score);
  }

  scoreTemporalRelevance(content, options) {
    const now = new Date();
    const publishedAt = new Date(content.published_at || now);
    const hoursOld = (now - publishedAt) / (1000 * 60 * 60);

    let score = 0.8; // High baseline for recent content

    // Decay based on age
    if (hoursOld > 48) score *= 0.5;
    else if (hoursOld > 24) score *= 0.7;
    else if (hoursOld > 12) score *= 0.9;

    // Boost for time-sensitive content
    const urgentKeywords = ['breaking', 'urgent', 'deadline', 'expires', 'limited'];
    const hasUrgency = urgentKeywords.some(keyword =>
      content.title?.toLowerCase().includes(keyword)
    );
    if (hasUrgency) score += 0.2;

    return Math.min(1, score);
  }

  scorePsychologicalResonance(content, options) {
    // Score based on psychological impact and novelty
    const userContext = options.userContext || {};
    const recentTopics = userContext.recentTopics || [];

    let score = 0.5; // Baseline novelty

    // Penalty for over-saturated topics
    const topicSaturation = (content.topics || []).reduce((saturation, topic) => {
      const count = recentTopics.filter(rt => rt === topic).length;
      return saturation + count / 10;
    }, 0);

    score = Math.max(0.1, score - topicSaturation);

    // Boost for emotional resonance
    const emotionalWords = ['breakthrough', 'transform', 'revolution', 'discover'];
    const hasEmotion = emotionalWords.some(word =>
      content.title?.toLowerCase().includes(word)
    );
    if (hasEmotion) score += 0.3;

    return Math.min(1, score);
  }

  scoreActionability(content, options) {
    // Score based on actionable content
    let score = 0.2; // Baseline

    const actionableKeywords = [
      'how to', 'guide', 'tutorial', 'steps', 'tool', 'launch',
      'available', 'apply', 'register', 'download', 'free'
    ];

    const text = `${content.title} ${content.summary || ''}`.toLowerCase();
    const matches = actionableKeywords.filter(keyword => text.includes(keyword));

    score += Math.min(0.6, matches.length * 0.15);

    // Boost for explicit calls to action
    if (text.includes('get started') || text.includes('try now')) score += 0.2;

    return Math.min(1, score);
  }

  scoreTrustIndicators(content, options) {
    // Score based on source trustworthiness and credibility signals
    let score = 0.5; // Neutral baseline

    // Source trust mapping (could be externalized)
    const trustedSources = {
      'techcrunch': 0.8, 'hackernews': 0.9, 'arstechnica': 0.8,
      'github': 0.9, 'stackoverflow': 0.8, 'medium': 0.6
    };

    const sourceScore = trustedSources[content.source?.toLowerCase()] || 0.5;
    score = sourceScore;

    // Boost for credibility indicators
    const credibilityIndicators = ['research', 'study', 'data', 'report'];
    const hasCredibility = credibilityIndicators.some(indicator =>
      content.title?.toLowerCase().includes(indicator)
    );
    if (hasCredibility) score += 0.1;

    return Math.min(1, score);
  }

  scoreInsightDensity(content, options) {
    // Score based on information density and insight quality
    let score = 0.4; // Baseline

    const insightKeywords = [
      'analysis', 'insight', 'behind', 'why', 'because', 'pattern',
      'trend', 'implications', 'deeper', 'understanding'
    ];

    const text = `${content.title} ${content.summary || ''}`.toLowerCase();
    const matches = insightKeywords.filter(keyword => text.includes(keyword));

    score += Math.min(0.5, matches.length * 0.1);

    // Boost for analytical content
    if (content.summary && content.summary.length > 200) score += 0.1;

    return Math.min(1, score);
  }

  scoreSocialProof(content, options) {
    // Score based on social validation signals
    let score = 0.3; // Baseline

    // Use engagement metrics if available
    if (content.metrics) {
      const engagement = (content.metrics.likes || 0) + (content.metrics.shares || 0);
      score += Math.min(0.4, engagement / 1000); // Normalize engagement
    }

    // Boost for community endorsement
    const socialKeywords = ['popular', 'trending', 'viral', 'recommended'];
    const hasSocial = socialKeywords.some(keyword =>
      content.title?.toLowerCase().includes(keyword)
    );
    if (hasSocial) score += 0.3;

    return Math.min(1, score);
  }

  // ─── UTILITY METHODS ────────────────────────────────────────────────

  computeConfidence(dimensionScores) {
    const scores = Object.values(dimensionScores);
    const variance = this.calculateVariance(scores);
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;

    // Higher confidence when scores are consistent and strong
    const consistencyBonus = 1 - Math.min(0.5, variance * 2);
    const strengthBonus = avgScore * 0.5;

    return Math.max(0.1, Math.min(0.95, consistencyBonus + strengthBonus));
  }

  calculateVariance(scores) {
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const squaredDiffs = scores.map(score => Math.pow(score - mean, 2));
    return squaredDiffs.reduce((a, b) => a + b, 0) / scores.length;
  }

  explainScore(dimensionScores, businessPredictions) {
    const topDimensions = Object.entries(dimensionScores)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 3)
      .map(([dim, score]) => `${dim}: ${Math.round(score * 100)}%`);

    const primaryMetric = this.targetMetrics[0];
    const prediction = businessPredictions[primaryMetric];

    return `Strong in: ${topDimensions.join(', ')}. Predicted ${primaryMetric} impact: ${prediction ? Math.round(prediction.expectedDelta * 100) : 0}%`;
  }

  calculateCalibrationConfidence() {
    if (this.validationHistory.length < 10) return 0.2;

    const recent = this.validationHistory.slice(-20);
    const improvements = recent.filter(v => {
      const primaryMetric = this.targetMetrics[0];
      const actual = v.actualMetrics[primaryMetric] || 0;
      const baseline = v.baseline[primaryMetric] || 0;
      return actual > baseline;
    });

    return Math.min(0.9, improvements.length / recent.length);
  }

  generateSessionId() {
    return `scoring_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get default weights for dimensions
   */
  getDefaultWeights() {
    return {
      personalization_depth: 0.20,
      temporal_relevance: 0.20,
      psychological_resonance: 0.15,
      actionability: 0.15,
      trust_indicators: 0.10,
      insight_density: 0.10,
      social_proof: 0.05,
      interest_match: 0.05  // Alias compatibility
    };
  }

  /**
   * Register a custom metric for this engine instance
   */
  registerCustomMetric(metricDefinition) {
    return this.metricConfig.registerCustomMetric(metricDefinition);
  }

  /**
   * Add custom use case configuration
   */
  addCustomUseCase(useCaseDefinition) {
    return this.metricConfig.createCustomUseCase(useCaseDefinition);
  }

  /**
   * Get metrics available for this engine
   */
  getAvailableMetrics() {
    return this.metricConfig.getAvailableMetrics();
  }

  /**
   * Export engine configuration including custom metrics
   */
  exportConfiguration() {
    return {
      useCase: this.useCase,
      targetMetrics: this.targetMetrics,
      weights: this.weights.exportConfig(),
      predictor: this.predictor.exportConfig(),
      metricConfig: this.metricConfig.exportConfiguration(),
      validationHistory: this.validationHistory.slice(-50),
      customMetrics: this.customMetrics,
      created: this.created,
      exportedAt: Date.now()
    };
  }

  /**
   * Import engine configuration including custom metrics
   */
  importConfiguration(config) {
    if (config.metricConfig) {
      this.metricConfig.importConfiguration(config.metricConfig);
    }

    if (config.weights) {
      this.weights.importConfig(config.weights);
    }

    if (config.predictor) {
      this.predictor.importConfig(config.predictor);
    }

    this.validationHistory = config.validationHistory || [];
    this.customMetrics = config.customMetrics || [];

    return {
      success: true,
      message: 'Engine configuration imported successfully'
    };
  }
}
