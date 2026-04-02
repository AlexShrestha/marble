/**
 * Calibration API
 *
 * Handles outcome data from startups and adjusts Marble scoring weights in real-time.
 * The key innovation: Clone fitness evolves against the REAL metric, not just engagement.
 */

import { MetricAgnosticScoringEngine, MetricConfig } from './metric-agnostic-scorer.js';
import { DynamicWeightSystem } from './enterprise/dynamic-weight-system.js';

export class CalibrationAPI {
  constructor() {
    this.engines = new Map(); // startupId -> MetricAgnosticScoringEngine
    this.outcomeQueue = [];
    this.processing = false;
  }

  /**
   * Register a startup with their metric configuration
   */
  async registerStartup(startupId, metricConfig) {
    const config = new MetricConfig({ startupId, ...metricConfig });
    const validation = config.validate();

    if (!validation.isValid) {
      throw new Error(`Invalid metric config: ${validation.errors.join(', ')}`);
    }

    const engine = new MetricAgnosticScoringEngine(config);
    this.engines.set(startupId, engine);

    return {
      success: true,
      startup_id: startupId,
      status: 'registered',
      target_metrics: [...config.primaryMetrics, ...config.secondaryMetrics],
      initial_weights: config.weights,
      created: new Date().toISOString()
    };
  }

  /**
   * Submit outcome data for calibration
   *
   * @param {string} startupId - Startup identifier
   * @param {Object} outcomeData - Business metric results
   * @param {string} outcomeData.content_id - Content that was scored
   * @param {Object} outcomeData.dimension_scores - Original dimension scores
   * @param {Object} outcomeData.actual_metrics - Actual business results
   * @param {Object} outcomeData.baseline_metrics - Baseline/control metrics
   * @param {Object} outcomeData.metadata - Additional context
   */
  async submitOutcome(startupId, outcomeData) {
    const engine = this.engines.get(startupId);
    if (!engine) {
      throw new Error(`Startup ${startupId} not registered. Call registerStartup() first.`);
    }

    const enrichedOutcome = {
      ...outcomeData,
      startup_id: startupId,
      timestamp: Date.now(),
      processed: false
    };

    this.outcomeQueue.push(enrichedOutcome);

    // Process immediately if not already processing
    if (!this.processing) {
      const results = await this._processOutcomeQueue();

      // Find the result for this specific outcome
      const myResult = results.find(r => r.startup_id === startupId);
      if (myResult && myResult.calibration_result) {
        return {
          success: true,
          performanceImprovement: myResult.calibration_result.averageImprovement || 0,
          calibrationData: myResult.calibration_result,
          processedAt: myResult.processed_at
        };
      }

      return { success: false, reason: 'Calibration processing failed' };
    }

    return { queued: true, position: this.outcomeQueue.length };
  }

  /**
   * Process queued outcome data and update scoring weights
   */
  async _processOutcomeQueue() {
    if (this.processing) return;
    this.processing = true;

    const results = [];

    try {
      while (this.outcomeQueue.length > 0) {
        const outcome = this.outcomeQueue.shift();
        const engine = this.engines.get(outcome.startup_id);

        if (engine) {
          const calibrationResult = await engine.calibrateFromOutcomes(outcome);
          results.push({
            startup_id: outcome.startup_id,
            content_id: outcome.content_id,
            calibration_result: calibrationResult,
            processed_at: new Date().toISOString()
          });
        }

        outcome.processed = true;
      }
    } finally {
      this.processing = false;
    }

    return results;
  }

  /**
   * Score content for a specific startup
   */
  async scoreForStartup(startupId, content, options = {}) {
    const engine = this.engines.get(startupId);
    if (!engine) {
      throw new Error(`Startup ${startupId} not registered`);
    }

    return await engine.scoreContent(content, options);
  }

  /**
   * Batch submit outcomes for better performance
   */
  async submitOutcomeBatch(startupId, outcomeDataArray) {
    const engine = this.engines.get(startupId);
    if (!engine) {
      throw new Error(`Startup ${startupId} not registered`);
    }

    const results = [];
    for (const outcomeData of outcomeDataArray) {
      try {
        const result = await engine.calibrateFromOutcomes({
          ...outcomeData,
          startup_id: startupId,
          timestamp: Date.now()
        });
        results.push({
          content_id: outcomeData.content_id,
          success: true,
          calibration_result: result
        });
      } catch (error) {
        results.push({
          content_id: outcomeData.content_id,
          success: false,
          error: error.message
        });
      }
    }

    return {
      startup_id: startupId,
      processed: results.length,
      successful: results.filter(r => r.success).length,
      results
    };
  }

  /**
   * Update startup metric configuration
   */
  updateStartupConfig(startupId, configUpdates) {
    const engine = this.engines.get(startupId);
    if (!engine) {
      throw new Error(`Startup ${startupId} not registered`);
    }

    engine.updateConfig(configUpdates);
    return {
      startup_id: startupId,
      updated: new Date().toISOString(),
      new_config: engine.getConfig()
    };
  }

  /**
   * Export calibration data for a startup (for backup/analysis)
   */
  exportStartupData(startupId) {
    const engine = this.engines.get(startupId);
    if (!engine) {
      throw new Error(`Startup ${startupId} not registered`);
    }

    return engine.exportCalibrationData();
  }

  /**
   * List all registered startups
   */
  listStartups() {
    return Array.from(this.engines.entries()).map(([startupId, engine]) => ({
      startup_id: startupId,
      use_case: engine.config.useCase,
      target_metrics: [...engine.config.primaryMetrics, ...engine.config.secondaryMetrics],
      calibrations: engine.calibrationHistory.length,
      confidence: engine._getCalibrationConfidence(),
      created: new Date(engine.config.created).toISOString()
    }));
  }

  /**
   * Get calibration status for a startup
   */
  async getCalibrationStatus(startupId) {
    const engine = this.engines.get(startupId);

    if (!engine) {
      throw new Error(`Startup ${startupId} not found. Call registerStartup() first.`);
    }

    // Get full calibration summary from the engine (includes auto-tuning info)
    const summary = engine._getCalibrationSummary();
    const calibrationData = engine.calibrationHistory;
    const totalValidations = calibrationData.length;

    // Calculate average improvement from the calibration history
    const averageImprovement = totalValidations > 0
      ? calibrationData.reduce((sum, cal) => {
          const metricImprovements = Object.values(cal.improvements || {});
          return sum + (metricImprovements.reduce((a, b) => a + b, 0) / Math.max(1, metricImprovements.length));
        }, 0) / totalValidations
      : 0;

    return {
      startupId,
      totalValidations,
      averageImprovement,
      calibrationConfidence: summary.confidence,
      auto_tuning_active: summary.auto_tuning_active,
      samples_until_autotuning: summary.samples_until_autotuning,
      performance: summary.performance,
      status: totalValidations > 0 ? 'calibrated' : 'learning',
      lastCalibration: totalValidations > 0 ? calibrationData[calibrationData.length - 1].timestamp : null,
      currentWeights: engine.config.weights
    };
  }

  /**
   * Offline calibration mode - fit weights from held-out labeled data
   * @param {string} useCase - Use case identifier
   * @param {Array} labeledData - Array of {dimension_scores, actual_metrics, baseline_metrics}
   * @param {Object} options - Calibration options
   */
  async fitWeightsOffline(useCase, labeledData, options = {}) {
    const {
      testSplit = 0.2,
      learningRate = 0.08,
      maxIterations = 100,
      convergenceThreshold = 0.001
    } = options;

    // Split data into train/test
    const shuffled = labeledData.sort(() => Math.random() - 0.5);
    const splitIndex = Math.floor(labeledData.length * (1 - testSplit));
    const trainData = shuffled.slice(0, splitIndex);
    const testData = shuffled.slice(splitIndex);

    // Initialize weight system from first sample
    const firstSample = trainData[0];
    const initialWeights = {};
    const dimensions = Object.keys(firstSample.dimension_scores);

    dimensions.forEach(dim => {
      initialWeights[dim] = 1.0 / dimensions.length;
    });

    const weightSystem = new DynamicWeightSystem(initialWeights);
    weightSystem.learningRate = learningRate;

    // Fit weights on training data
    let prevError = Infinity;
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      let totalError = 0;

      for (const sample of trainData) {
        const primaryMetric = Object.keys(sample.actual_metrics)[0];
        const actual = sample.actual_metrics[primaryMetric];
        const baseline = sample.baseline_metrics[primaryMetric] || 0.01;

        weightSystem.updateFromValidation(
          sample.dimension_scores,
          actual,
          baseline
        );

        // Calculate prediction error for convergence check
        const prediction = weightSystem.computeWeightedScore(sample.dimension_scores);
        const improvement = (actual - baseline) / Math.max(baseline, 0.01);
        totalError += Math.pow(prediction - improvement, 2);
      }

      const avgError = totalError / trainData.length;
      if (Math.abs(prevError - avgError) < convergenceThreshold) {
        console.log(`Converged after ${iteration + 1} iterations`);
        break;
      }
      prevError = avgError;
    }

    // Evaluate on test set
    let testError = 0;
    const testPredictions = [];

    for (const sample of testData) {
      const prediction = weightSystem.computeWeightedScore(sample.dimension_scores);
      const primaryMetric = Object.keys(sample.actual_metrics)[0];
      const actual = sample.actual_metrics[primaryMetric];
      const baseline = sample.baseline_metrics[primaryMetric] || 0.01;
      const actualImprovement = (actual - baseline) / Math.max(baseline, 0.01);

      const error = Math.pow(prediction - actualImprovement, 2);
      testError += error;

      testPredictions.push({
        predicted: prediction,
        actual: actualImprovement,
        error: error
      });
    }

    const avgTestError = testError / testData.length;
    const calibratedWeights = weightSystem.getCurrentWeights();

    // Export weight profile for this use case
    const weightProfile = {
      useCase,
      weights: calibratedWeights,
      performance: {
        trainingSamples: trainData.length,
        testSamples: testData.length,
        testError: Math.round(avgTestError * 1000) / 1000,
        convergence: prevError < convergenceThreshold
      },
      weightEvolution: weightSystem.getEvolutionSummary(),
      trainedAt: new Date().toISOString(),
      parameters: { learningRate, maxIterations, convergenceThreshold }
    };

    return {
      success: true,
      weightProfile,
      testPredictions: testPredictions.slice(0, 10), // First 10 test predictions
      recommendation: avgTestError < 0.1 ? 'deploy' : 'need_more_data'
    };
  }

  /**
   * Export weight profile for deployment
   */
  exportWeightProfile(useCase, weightProfile) {
    return {
      version: '1.0',
      useCase,
      calibratedWeights: weightProfile.weights,
      performance: weightProfile.performance,
      exportedAt: new Date().toISOString(),
      deploymentReady: weightProfile.performance.testError < 0.15
    };
  }

  /**
   * Health check for the calibration system
   */
  healthCheck() {
    return {
      status: 'healthy',
      registered_startups: this.engines.size,
      queue_length: this.outcomeQueue.length,
      processing: this.processing,
      memory_usage: process.memoryUsage(),
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    };
  }
}

// Example usage schemas for documentation
export const EXAMPLE_CONFIGS = {
  email_campaigns: {
    startupId: 'acme_startup',
    useCase: 'email_campaigns',
    primaryMetrics: ['reply_rate', 'click_through_rate'],
    secondaryMetrics: ['dwell_time', 'share_rate'],
    thresholds: { improvement: 0.20, confidence: 0.8 },
    learningRate: 0.12
  },

  content_platform: {
    startupId: 'media_startup',
    useCase: 'content_curation',
    primaryMetrics: ['retention_rate', 'dwell_time'],
    secondaryMetrics: ['share_rate', 'return_frequency', 'sentiment_shift'],
    customMetrics: {
      video_completion_rate: {
        type: 'primary',
        weight: 0.9,
        dimensions: ['insight_density', 'psychological_resonance'],
        correlationFactors: { insight_density: 0.6, psychological_resonance: 0.4 }
      }
    },
    thresholds: { improvement: 0.15, confidence: 0.75 }
  },

  ecommerce: {
    startupId: 'shop_startup',
    useCase: 'coaching_pipeline',
    primaryMetrics: ['revenue', 'conversion_rate'],
    secondaryMetrics: ['dwell_time', 'return_frequency'],
    weights: {
      actionability: 0.4,
      trust_indicators: 0.3,
      personalization_depth: 0.3
    }
  }
};
EXAMPLE_CONFIGS.email_campaign = EXAMPLE_CONFIGS.email_campaigns; // Legacy alias

export const EXAMPLE_OUTCOME_DATA = {
  content_id: 'story_123',
  dimension_scores: {
    interest_match: 0.8,
    temporal_relevance: 0.6,
    actionability: 0.7,
    trust_indicators: 0.9,
    personalization_depth: 0.75
  },
  actual_metrics: {
    conversion_rate: 0.12,  // 12% conversion
    revenue: 1500,          // $1500 generated
    dwell_time: 180         // 3 minutes average
  },
  baseline_metrics: {
    conversion_rate: 0.08,  // 8% baseline
    revenue: 1000,          // $1000 baseline
    dwell_time: 120         // 2 minutes baseline
  },
  metadata: {
    campaign_id: 'campaign_456',
    segment: 'high_value_users',
    ab_test_variant: 'treatment'
  }
};

/**
 * Correlation tracking and statistical analysis
 * (Unified from calibration.js)
 */
export class CorrelationTracker {
  calculateCorrelation(xValues, yValues) {
    if (xValues.length !== yValues.length || xValues.length < 3) {
      return { correlation: 0, significance: 0, n: xValues.length };
    }

    const n = xValues.length;
    const sumX = xValues.reduce((a, b) => a + b, 0);
    const sumY = yValues.reduce((a, b) => a + b, 0);
    const sumXY = xValues.reduce((sum, x, i) => sum + x * yValues[i], 0);
    const sumXX = xValues.reduce((sum, x) => sum + x * x, 0);
    const sumYY = yValues.reduce((sum, y) => sum + y * y, 0);

    const numerator = n * sumXY - sumX * sumY;
    const denominator = Math.sqrt((n * sumXX - sumX * sumX) * (n * sumYY - sumY * sumY));

    const correlation = denominator === 0 ? 0 : numerator / denominator;

    // Simple significance approximation
    const significance = Math.abs(correlation) * Math.sqrt(n - 2) / Math.sqrt(1 - correlation * correlation);

    return { correlation, significance, n };
  }
}

/**
 * Weight optimization algorithms
 * (Unified from calibration.js)
 */
export class WeightOptimizer {
  constructor(metricConfig) {
    this.metricConfig = metricConfig;
    this.minWeight = 0.05;
    this.maxWeight = 0.60;
  }

  optimize(analysis) {
    const currentWeights = { ...this.metricConfig.weights };
    const recommendedWeights = { ...currentWeights };
    const changes = {};

    for (const [dimension, correlationData] of Object.entries(analysis.correlations)) {
      if (!currentWeights[dimension]) continue;

      const correlation = correlationData.correlation;
      const currentWeight = currentWeights[dimension];

      if (Math.abs(correlation) > 0.3 && correlationData.significance > 1.96) {
        const adjustment = this.metricConfig.learningRate * correlation;
        const newWeight = Math.max(
          this.minWeight,
          Math.min(this.maxWeight, currentWeight * (1 + adjustment))
        );

        recommendedWeights[dimension] = newWeight;
        changes[dimension] = {
          from: currentWeight,
          to: newWeight,
          change: newWeight - currentWeight,
          reason: `${correlation > 0 ? 'Positive' : 'Negative'} correlation (${Math.round(correlation * 100)}%)`
        };
      }
    }

    this._normalizeWeights(recommendedWeights);

    const improvementExpected = this._estimateImprovement(analysis, changes);

    return { recommendedWeights, changes, improvementExpected };
  }

  _normalizeWeights(weights) {
    const sum = Object.values(weights).reduce((a, b) => a + b, 0);
    if (sum > 0) {
      for (const key of Object.keys(weights)) {
        weights[key] /= sum;
      }
    }
  }

  _estimateImprovement(analysis, changes) {
    let potential = 0;
    for (const [dimension, change] of Object.entries(changes)) {
      const correlation = analysis.correlations[dimension]?.correlation || 0;
      potential += Math.abs(correlation * change.change);
    }
    return Math.min(0.5, potential);
  }
}

/**
 * Generate business-friendly insights from correlation analysis
 * (Unified from calibration.js)
 */
export function generateInsights(analysis) {
  const insights = [];

  const correlationEntries = Object.entries(analysis.correlations)
    .sort((a, b) => Math.abs(b[1].correlation) - Math.abs(a[1].correlation))
    .slice(0, 3);

  for (const [dimension, data] of correlationEntries) {
    if (Math.abs(data.correlation) > 0.3) {
      const direction = data.correlation > 0 ? 'positively' : 'negatively';
      const strength = Math.abs(data.correlation) > 0.6 ? 'strongly' : 'moderately';
      insights.push(`${dimension} correlates ${strength} ${direction} with ${analysis.primaryMetric} (${Math.round(data.correlation * 100)}%)`);
    }
  }

  if (analysis.averageImprovement > 0.1) {
    insights.push(`Current strategy showing ${Math.round(analysis.averageImprovement * 100)}% average improvement over baseline`);
  } else if (analysis.averageImprovement < -0.05) {
    insights.push(`Performance declining: ${Math.round(Math.abs(analysis.averageImprovement) * 100)}% below baseline - weight adjustment needed`);
  }

  return insights;
}

// Singleton instance for easy import
export const calibrationAPI = new CalibrationAPI();