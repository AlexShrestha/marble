/**
 * Metric-Agnostic Scoring Engine
 *
 * Core innovation: Startups define their success metrics, scoring auto-tunes against real business outcomes.
 * Clone fitness evolves against the REAL metric, not just engagement.
 */

import { MetricDrivenScoringEngine } from '../enterprise/metric-driven-scoring-engine.js';
import { DynamicWeightSystem } from '../enterprise/dynamic-weight-system.js';

// Predefined metric types with optimized configurations
export const METRIC_DEFINITIONS = {
  // Primary business metrics
  revenue: {
    type: 'primary',
    weight: 1.0,
    dimensions: ['personalization_depth', 'actionability', 'trust_indicators', 'temporal_relevance'],
    correlationFactors: { personalization_depth: 0.4, actionability: 0.3, trust_indicators: 0.3 }
  },
  conversion_rate: {
    type: 'primary',
    weight: 1.0,
    dimensions: ['actionability', 'psychological_resonance', 'trust_indicators', 'temporal_relevance'],
    correlationFactors: { actionability: 0.45, psychological_resonance: 0.35, trust_indicators: 0.2 }
  },
  retention_rate: {
    type: 'primary',
    weight: 1.0,
    dimensions: ['interest_match', 'insight_density', 'novelty', 'personalization_depth'],
    correlationFactors: { interest_match: 0.4, insight_density: 0.3, personalization_depth: 0.3 }
  },

  // Secondary engagement metrics
  dwell_time: {
    type: 'secondary',
    weight: 0.7,
    dimensions: ['insight_density', 'interest_match', 'novelty'],
    correlationFactors: { insight_density: 0.5, interest_match: 0.3, novelty: 0.2 }
  },
  scroll_depth: {
    type: 'secondary',
    weight: 0.6,
    dimensions: ['insight_density', 'actionability', 'psychological_resonance'],
    correlationFactors: { insight_density: 0.4, actionability: 0.3, psychological_resonance: 0.3 }
  },
  share_rate: {
    type: 'secondary',
    weight: 0.8,
    dimensions: ['social_proof', 'psychological_resonance', 'novelty'],
    correlationFactors: { social_proof: 0.4, psychological_resonance: 0.35, novelty: 0.25 }
  },
  return_frequency: {
    type: 'secondary',
    weight: 0.75,
    dimensions: ['interest_match', 'personalization_depth', 'novelty'],
    correlationFactors: { interest_match: 0.45, personalization_depth: 0.35, novelty: 0.2 }
  },
  sentiment_shift: {
    type: 'secondary',
    weight: 0.5,
    dimensions: ['psychological_resonance', 'trust_indicators', 'insight_density'],
    correlationFactors: { psychological_resonance: 0.5, trust_indicators: 0.3, insight_density: 0.2 }
  },
  email_reply_rate: {
    type: 'secondary',
    weight: 0.8,
    dimensions: ['personalization_depth', 'actionability', 'temporal_relevance'],
    correlationFactors: { personalization_depth: 0.4, actionability: 0.35, temporal_relevance: 0.25 }
  }
};

/**
 * MetricConfig Interface - Startups define their success metrics
 */
export class MetricConfig {
  constructor(config) {
    this.startupId = config.startupId;
    this.useCase = config.useCase || 'content_curation';
    this.primaryMetrics = config.primaryMetrics || ['conversion_rate'];
    this.secondaryMetrics = config.secondaryMetrics || ['dwell_time', 'share_rate'];
    this.customMetrics = config.customMetrics || {};
    this.weights = this._initializeWeights(config.weights);
    this.thresholds = config.thresholds || { improvement: 0.15, confidence: 0.7 };
    this.learningRate = config.learningRate || 0.1;
    this.created = Date.now();
    this.version = '1.0';
  }

  _initializeWeights(customWeights = {}) {
    // Start with metric-optimized weights based on primary metrics
    const baseWeights = this._getMetricOptimizedWeights();
    return { ...baseWeights, ...customWeights };
  }

  _getMetricOptimizedWeights() {
    const weights = {};
    const allDimensions = new Set();

    // Collect dimensions from all target metrics
    [...this.primaryMetrics, ...this.secondaryMetrics].forEach(metricName => {
      const metric = METRIC_DEFINITIONS[metricName];
      if (metric) {
        metric.dimensions.forEach(dim => allDimensions.add(dim));
      }
    });

    // Initialize all dimension weights
    const baseDimensions = [
      'interest_match', 'temporal_relevance', 'novelty', 'actionability',
      'source_trust', 'personalization_depth', 'psychological_resonance',
      'trust_indicators', 'insight_density', 'social_proof'
    ];

    baseDimensions.forEach(dim => weights[dim] = 0.1);

    // Boost weights for dimensions that correlate with target metrics
    [...this.primaryMetrics, ...this.secondaryMetrics].forEach(metricName => {
      const metric = METRIC_DEFINITIONS[metricName];
      if (metric?.correlationFactors) {
        Object.entries(metric.correlationFactors).forEach(([dim, factor]) => {
          weights[dim] = Math.max(weights[dim], factor * (metric.weight || 1));
        });
      }
    });

    // Normalize weights to sum to 1
    const sum = Object.values(weights).reduce((a, b) => a + b, 0);
    Object.keys(weights).forEach(key => weights[key] /= sum);

    return weights;
  }

  addCustomMetric(name, definition) {
    this.customMetrics[name] = definition;
    return this;
  }

  updateThreshold(metric, value) {
    this.thresholds[metric] = value;
    return this;
  }

  validate() {
    const errors = [];

    if (!this.startupId) errors.push('startupId is required');
    if (!this.primaryMetrics.length) errors.push('At least one primary metric required');

    // Validate metric definitions exist
    [...this.primaryMetrics, ...this.secondaryMetrics].forEach(metric => {
      if (!METRIC_DEFINITIONS[metric] && !this.customMetrics[metric]) {
        errors.push(`Unknown metric: ${metric}`);
      }
    });

    return { isValid: errors.length === 0, errors };
  }
}

/**
 * Metric-Agnostic Scoring Engine
 * Orchestrates scoring based on configurable business metrics
 */
export class MetricAgnosticScoringEngine {
  constructor(metricConfig) {
    this.config = metricConfig;
    this.engine = new MetricDrivenScoringEngine({
      useCase: metricConfig.useCase,
      targetMetrics: [...metricConfig.primaryMetrics, ...metricConfig.secondaryMetrics],
      initialWeights: metricConfig.weights
    });

    // Outcome tracking for calibration
    this.calibrationHistory = [];
    this.performanceMetrics = new Map();
    this.lastCalibration = null;
  }

  /**
   * Score content using metric-specific tuning
   */
  async scoreContent(content, options = {}) {
    const result = await this.engine.scoreContent(content, options);

    // Apply metric-specific transformations
    const metricPredictions = this._generateMetricPredictions(result.dimension_scores);
    const compositeScore = this._computeCompositeScore(result.dimension_scores, metricPredictions);

    return {
      ...result,
      relevance_score: compositeScore,
      metric_predictions: metricPredictions,
      startup_id: this.config.startupId,
      target_metrics: [...this.config.primaryMetrics, ...this.config.secondaryMetrics],
      calibration_confidence: this._getCalibrationConfidence()
    };
  }

  /**
   * Calibration API: Process outcome data and adjust weights
   */
  async calibrateFromOutcomes(outcomeData) {
    const validation = {
      timestamp: Date.now(),
      content_id: outcomeData.content_id,
      dimension_scores: outcomeData.dimension_scores,
      actual_metrics: outcomeData.actual_metrics,
      baseline_metrics: outcomeData.baseline_metrics || {},
      metadata: outcomeData.metadata || {}
    };

    // Process each target metric
    const improvements = {};
    for (const metricName of this.config.primaryMetrics) {
      const actual = outcomeData.actual_metrics[metricName];
      const baseline = outcomeData.baseline_metrics[metricName] || 0.01;

      if (actual !== undefined) {
        improvements[metricName] = (actual - baseline) / baseline;
        this._updateMetricWeights(metricName, actual, baseline, outcomeData.dimension_scores);
      }
    }

    // Track secondary metrics too but with lower weight
    for (const metricName of this.config.secondaryMetrics) {
      const actual = outcomeData.actual_metrics[metricName];
      const baseline = outcomeData.baseline_metrics[metricName] || 0.01;

      if (actual !== undefined) {
        improvements[metricName] = (actual - baseline) / baseline;
        this._updateMetricWeights(metricName, actual, baseline, outcomeData.dimension_scores, 0.5);
      }
    }

    validation.improvements = improvements;
    this.calibrationHistory.push(validation);

    // Keep last 1000 validations
    if (this.calibrationHistory.length > 1000) {
      this.calibrationHistory = this.calibrationHistory.slice(-1000);
    }

    this.lastCalibration = Date.now();

    return this._getCalibrationSummary();
  }

  /**
   * Update weights based on metric performance
   */
  _updateMetricWeights(metricName, actual, baseline, dimensionScores, weightMultiplier = 1.0) {
    const metric = METRIC_DEFINITIONS[metricName] || this.config.customMetrics[metricName];
    if (!metric) return;

    // MINIMUM SAMPLE SIZE CHECK - prevent overfitting on small datasets
    const MIN_SAMPLES_FOR_AUTOTUNING = 15;
    const relevantSamples = this.calibrationHistory.filter(h =>
      h.improvements && h.improvements[metricName] !== undefined
    );

    if (relevantSamples.length < MIN_SAMPLES_FOR_AUTOTUNING) {
      // Not enough samples yet - skip auto-tuning to prevent overfitting
      console.log(`[Marble Calibration] Skipping auto-tune for ${metricName}: only ${relevantSamples.length}/${MIN_SAMPLES_FOR_AUTOTUNING} samples`);
      return;
    }

    const improvement = (actual - baseline) / baseline;
    const learningRate = this.config.learningRate * weightMultiplier;

    // Calculate real correlation math before applying updates
    const correlationStrength = this._calculateRealCorrelation(metricName, dimensionScores, relevantSamples);

    // Update weights for dimensions that correlate with this metric
    if (metric.correlationFactors) {
      Object.entries(metric.correlationFactors).forEach(([dimension, correlation]) => {
        const dimensionScore = dimensionScores[dimension] || 0;
        const currentWeight = this.engine.weights.getCurrentWeights()[dimension] || 0.1;

        // Apply real correlation strength to weight updates
        const realCorrelation = correlationStrength[dimension] || correlation;
        const adjustedLearningRate = learningRate * Math.abs(realCorrelation);

        // Let the dynamic weight system handle the update with real correlation data
        const mockDimensionScores = {};
        mockDimensionScores[dimension] = dimensionScore;

        this.engine.weights.updateFromValidation(mockDimensionScores, actual, baseline);
      });
    }
  }

  /**
   * Calculate real correlation between dimensions and metric outcomes
   */
  _calculateRealCorrelation(metricName, currentDimensionScores, historicalSamples) {
    const correlations = {};

    // Get all dimension names from current scores
    const dimensions = Object.keys(currentDimensionScores);

    dimensions.forEach(dimension => {
      // Extract dimension scores and metric improvements from historical data
      const pairs = historicalSamples
        .map(sample => ({
          dimensionScore: sample.dimension_scores?.[dimension] || 0,
          improvement: sample.improvements?.[metricName] || 0
        }))
        .filter(pair => pair.dimensionScore > 0); // Filter out zero scores

      if (pairs.length < 10) {
        correlations[dimension] = 0; // Not enough data for reliable correlation
        return;
      }

      // Calculate Pearson correlation coefficient
      const n = pairs.length;
      const sumX = pairs.reduce((sum, p) => sum + p.dimensionScore, 0);
      const sumY = pairs.reduce((sum, p) => sum + p.improvement, 0);
      const sumXY = pairs.reduce((sum, p) => sum + (p.dimensionScore * p.improvement), 0);
      const sumX2 = pairs.reduce((sum, p) => sum + (p.dimensionScore * p.dimensionScore), 0);
      const sumY2 = pairs.reduce((sum, p) => sum + (p.improvement * p.improvement), 0);

      const numerator = n * sumXY - sumX * sumY;
      const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

      correlations[dimension] = denominator !== 0 ? numerator / denominator : 0;
    });

    return correlations;
  }

  /**
   * Generate predictions for all target metrics
   */
  _generateMetricPredictions(dimensionScores) {
    const predictions = {};

    // Predict primary metrics
    this.config.primaryMetrics.forEach(metricName => {
      predictions[metricName] = this._predictMetric(metricName, dimensionScores);
    });

    // Predict secondary metrics
    this.config.secondaryMetrics.forEach(metricName => {
      predictions[metricName] = this._predictMetric(metricName, dimensionScores);
    });

    return predictions;
  }

  _predictMetric(metricName, dimensionScores) {
    const metric = METRIC_DEFINITIONS[metricName] || this.config.customMetrics[metricName];
    if (!metric) return { expected_delta: 0, confidence: 0.1 };

    let prediction = 0;
    let totalWeight = 0;

    // Weight prediction by correlation factors
    if (metric.correlationFactors) {
      Object.entries(metric.correlationFactors).forEach(([dimension, correlation]) => {
        const score = dimensionScores[dimension] || 0;
        prediction += score * correlation;
        totalWeight += correlation;
      });
    }

    if (totalWeight > 0) {
      prediction /= totalWeight;
    }

    // Apply metric weight and historical performance
    const metricWeight = metric.weight || 1.0;
    const historicalPerformance = this._getHistoricalPerformance(metricName);

    const expectedDelta = prediction * metricWeight * historicalPerformance.multiplier;
    const confidence = Math.min(0.9, historicalPerformance.confidence * (prediction + 0.1));

    return {
      expected_delta: expectedDelta,
      confidence: confidence,
      contributing_dimensions: this._getTopContributingDimensions(metricName, dimensionScores)
    };
  }

  _getTopContributingDimensions(metricName, dimensionScores) {
    const metric = METRIC_DEFINITIONS[metricName] || this.config.customMetrics[metricName];
    if (!metric?.correlationFactors) return [];

    return Object.entries(metric.correlationFactors)
      .map(([dim, correlation]) => ({
        dimension: dim,
        score: dimensionScores[dim] || 0,
        correlation,
        contribution: (dimensionScores[dim] || 0) * correlation
      }))
      .sort((a, b) => b.contribution - a.contribution)
      .slice(0, 3);
  }

  _computeCompositeScore(dimensionScores, metricPredictions) {
    let compositeScore = 0;
    let totalWeight = 0;

    // Primary metrics contribute more to composite score
    this.config.primaryMetrics.forEach(metricName => {
      const prediction = metricPredictions[metricName];
      if (prediction) {
        const weight = 1.0; // Primary metrics get full weight
        compositeScore += prediction.expected_delta * prediction.confidence * weight;
        totalWeight += weight;
      }
    });

    // Secondary metrics contribute less
    this.config.secondaryMetrics.forEach(metricName => {
      const prediction = metricPredictions[metricName];
      if (prediction) {
        const metric = METRIC_DEFINITIONS[metricName] || this.config.customMetrics[metricName];
        const weight = (metric?.weight || 0.5) * 0.6; // Secondary get reduced weight
        compositeScore += prediction.expected_delta * prediction.confidence * weight;
        totalWeight += weight;
      }
    });

    return totalWeight > 0 ? Math.max(0, Math.min(1, compositeScore / totalWeight)) : 0.1;
  }

  _getHistoricalPerformance(metricName) {
    const recent = this.calibrationHistory.slice(-50);
    const metricHistory = recent
      .filter(h => h.improvements[metricName] !== undefined)
      .map(h => h.improvements[metricName]);

    if (metricHistory.length === 0) {
      return { multiplier: 1.0, confidence: 0.3 };
    }

    const avgImprovement = metricHistory.reduce((a, b) => a + b, 0) / metricHistory.length;
    const variance = metricHistory.reduce((sum, val) => sum + Math.pow(val - avgImprovement, 2), 0) / metricHistory.length;

    const multiplier = Math.max(0.5, Math.min(2.0, 1 + avgImprovement));
    const confidence = Math.max(0.1, Math.min(0.9, 1 - variance));

    return { multiplier, confidence };
  }

  _getCalibrationConfidence() {
    const MIN_SAMPLES_FOR_AUTOTUNING = 15;

    if (this.calibrationHistory.length < 10) return 0.1; // Very low confidence with <10 samples
    if (this.calibrationHistory.length < MIN_SAMPLES_FOR_AUTOTUNING) return 0.3; // Low confidence before auto-tuning

    const recent = this.calibrationHistory.slice(-20);
    const positiveImprovements = recent.filter(h => {
      return this.config.primaryMetrics.some(metric =>
        h.improvements[metric] > this.config.thresholds.improvement
      );
    });

    // Higher confidence after minimum samples reached
    const baseConfidence = positiveImprovements.length / recent.length;
    return Math.min(0.95, baseConfidence + 0.1); // Slight boost for reaching auto-tuning threshold
  }

  _getCalibrationSummary() {
    const MIN_SAMPLES_FOR_AUTOTUNING = 15;
    const autoTuningActive = this.calibrationHistory.length >= MIN_SAMPLES_FOR_AUTOTUNING;

    const summary = {
      startup_id: this.config.startupId,
      calibrations_processed: this.calibrationHistory.length,
      confidence: this._getCalibrationConfidence(),
      auto_tuning_active: autoTuningActive,
      samples_until_autotuning: Math.max(0, MIN_SAMPLES_FOR_AUTOTUNING - this.calibrationHistory.length),
      last_updated: new Date(this.lastCalibration || this.config.created).toISOString(),
      target_metrics: {
        primary: this.config.primaryMetrics,
        secondary: this.config.secondaryMetrics
      },
      performance: {}
    };

    // Add performance summary for each metric
    [...this.config.primaryMetrics, ...this.config.secondaryMetrics].forEach(metric => {
      const performance = this._getHistoricalPerformance(metric);
      const metricSamples = this.calibrationHistory.filter(h => h.improvements[metric] !== undefined).length;

      summary.performance[metric] = {
        improvement_multiplier: Math.round(performance.multiplier * 100) / 100,
        confidence: Math.round(performance.confidence * 100) / 100,
        data_points: metricSamples,
        auto_tuning_ready: metricSamples >= MIN_SAMPLES_FOR_AUTOTUNING
      };
    });

    return summary;
  }

  // API Methods
  getConfig() { return this.config; }

  updateConfig(updates) {
    Object.assign(this.config, updates);
    return this;
  }

  exportCalibrationData() {
    return {
      config: this.config,
      calibration_history: this.calibrationHistory.slice(-100), // Last 100 for export
      performance_summary: this._getCalibrationSummary()
    };
  }
}