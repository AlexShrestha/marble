/**
 * Calibration API for Prism Metric-Agnostic Scoring
 *
 * Interface for startups to send business outcome data and auto-tune Marble weights.
 * Clone fitness evolves against REAL metrics, not just engagement.
 */

import { MetricConfig } from './metric-config.js';

export class CalibrationAPI {
  constructor(scoringEngine) {
    this.engine = scoringEngine;
    this.calibrationHistory = [];
    this.metricConfig = new MetricConfig(scoringEngine.useCase);
  }

  /**
   * Main calibration endpoint - processes outcome data and adjusts weights
   * @param {Object[]} validationBatch - Array of validation records
   * @returns {Promise<Object>} Calibration results and performance metrics
   */
  async calibrateWeights(validationBatch) {
    if (!Array.isArray(validationBatch) || validationBatch.length === 0) {
      throw new Error('Validation batch must be a non-empty array');
    }

    const results = {
      success: true,
      processedRecords: 0,
      skippedRecords: 0,
      performanceImprovement: 0,
      confidence: 0,
      insights: {
        keyFindings: [],
        weightChanges: {},
        metricCorrelations: {}
      },
      timestamp: new Date().toISOString()
    };

    try {
      // Process each validation record
      for (const validation of validationBatch) {
        const processedValidation = await this.processValidationRecord(validation);

        if (processedValidation.valid) {
          const improvement = await this.updateWeightsFromOutcome(processedValidation);
          results.processedRecords++;
          results.performanceImprovement += improvement;
        } else {
          results.skippedRecords++;
          console.warn(`Skipped invalid validation record: ${processedValidation.error}`);
        }
      }

      // Calculate average improvement
      if (results.processedRecords > 0) {
        results.performanceImprovement /= results.processedRecords;
      }

      // Store calibration in history
      this.calibrationHistory.push({
        batchSize: validationBatch.length,
        processedRecords: results.processedRecords,
        performanceImprovement: results.performanceImprovement,
        timestamp: Date.now()
      });

      // Keep last 50 calibrations
      if (this.calibrationHistory.length > 50) {
        this.calibrationHistory = this.calibrationHistory.slice(-50);
      }

      // Generate insights
      results.insights = await this.generateInsights();
      results.confidence = this.calculateConfidence();

      return results;

    } catch (error) {
      console.error('Calibration failed:', error);
      return {
        success: false,
        error: error.message,
        processedRecords: results.processedRecords,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Process and validate a single validation record
   */
  async processValidationRecord(validation) {
    try {
      // Required fields validation
      const required = ['dimensionScores', 'actualMetrics', 'baseline'];
      const missing = required.filter(field => !validation[field]);

      if (missing.length > 0) {
        return { valid: false, error: `Missing required fields: ${missing.join(', ')}` };
      }

      // Validate dimension scores
      if (typeof validation.dimensionScores !== 'object') {
        return { valid: false, error: 'dimensionScores must be an object' };
      }

      // Validate and normalize metrics
      const targetMetrics = this.metricConfig.getTargetMetrics();
      const normalizedActual = {};
      const normalizedBaseline = {};

      for (const metric of targetMetrics) {
        // Validate actual metrics
        if (validation.actualMetrics[metric] === undefined) {
          console.warn(`Missing actual metric: ${metric}, using default 0`);
          normalizedActual[metric] = 0;
        } else {
          const validationResult = this.metricConfig.validateMetricValue(
            metric,
            validation.actualMetrics[metric],
            validation
          );

          if (!validationResult.valid) {
            return { valid: false, error: `Invalid ${metric}: ${validationResult.error}` };
          }

          normalizedActual[metric] = this.metricConfig.normalizeMetricValue(
            metric,
            validation.actualMetrics[metric],
            validation
          );
        }

        // Validate baseline metrics
        if (validation.baseline[metric] === undefined) {
          normalizedBaseline[metric] = 0.5; // Default baseline
        } else {
          normalizedBaseline[metric] = this.metricConfig.normalizeMetricValue(
            metric,
            validation.baseline[metric],
            validation
          );
        }
      }

      return {
        valid: true,
        dimensionScores: validation.dimensionScores,
        actualMetrics: normalizedActual,
        baseline: normalizedBaseline,
        metadata: validation.metadata || {},
        originalValidation: validation
      };

    } catch (error) {
      return { valid: false, error: `Processing error: ${error.message}` };
    }
  }

  /**
   * Update scoring weights based on single outcome
   */
  async updateWeightsFromOutcome(processedValidation) {
    const targetMetrics = this.metricConfig.getTargetMetrics();
    const primaryMetric = targetMetrics[0]; // Use first metric as primary

    const actualValue = processedValidation.actualMetrics[primaryMetric] || 0;
    const baselineValue = processedValidation.baseline[primaryMetric] || 0.5;

    // Calculate improvement
    const improvement = actualValue - baselineValue;
    const relativeImprovement = baselineValue > 0 ? improvement / baselineValue : improvement;

    // Update dynamic weights
    const updateResult = this.engine.dynamicWeights.updateFromValidation(
      processedValidation.dimensionScores,
      actualValue,
      baselineValue
    );

    return relativeImprovement;
  }

  /**
   * Generate insights from recent calibration data
   */
  async generateInsights() {
    if (this.calibrationHistory.length < 3) {
      return {
        keyFindings: ['Insufficient data for insights - need more calibrations'],
        weightChanges: {},
        metricCorrelations: {}
      };
    }

    const insights = {
      keyFindings: [],
      weightChanges: this.engine.dynamicWeights.getRecentChanges(),
      metricCorrelations: {}
    };

    // Analyze performance trend
    const recent = this.calibrationHistory.slice(-5);
    const improvements = recent.map(c => c.performanceImprovement);
    const avgImprovement = improvements.reduce((sum, imp) => sum + imp, 0) / improvements.length;

    if (avgImprovement > 0.1) {
      insights.keyFindings.push('Scoring performance improving significantly');
    } else if (avgImprovement > 0.05) {
      insights.keyFindings.push('Scoring performance showing steady improvement');
    } else if (avgImprovement < -0.05) {
      insights.keyFindings.push('Scoring performance declining - review metric definitions');
    } else {
      insights.keyFindings.push('Scoring performance stable');
    }

    // Analyze weight stability
    const { stability } = insights.weightChanges;
    if (stability === 'stable') {
      insights.keyFindings.push('Weight system has converged to optimal configuration');
    } else if (stability === 'stabilizing') {
      insights.keyFindings.push('Weight system is stabilizing - continue calibration');
    } else {
      insights.keyFindings.push('Weight system actively learning - more data needed');
    }

    // Identify top-performing dimensions
    const topDimensions = Object.entries(insights.weightChanges.changes)
      .filter(([_, change]) => change.trend === 'rising')
      .map(([dim, _]) => dim);

    if (topDimensions.length > 0) {
      insights.keyFindings.push(`High-performing dimensions: ${topDimensions.join(', ')}`);
    }

    return insights;
  }

  /**
   * Calculate calibration confidence (0-1)
   */
  calculateConfidence() {
    if (this.calibrationHistory.length < 5) {
      return 0.2; // Low confidence with little data
    }

    const recent = this.calibrationHistory.slice(-10);
    const positiveOutcomes = recent.filter(c => c.performanceImprovement > 0).length;
    const confidenceScore = positiveOutcomes / recent.length;

    // Adjust for stability
    const { stability } = this.engine.dynamicWeights.getRecentChanges();
    const stabilityBonus = stability === 'stable' ? 0.2 : stability === 'stabilizing' ? 0.1 : 0;

    return Math.min(0.95, confidenceScore + stabilityBonus);
  }

  /**
   * Get calibration history and statistics
   */
  getCalibrationHistory() {
    const recent = this.calibrationHistory.slice(-20);
    const totalCalibrations = this.calibrationHistory.length;
    const totalRecords = recent.reduce((sum, c) => sum + c.processedRecords, 0);

    const improvements = recent.map(c => c.performanceImprovement);
    const avgImprovement = improvements.length > 0
      ? improvements.reduce((sum, imp) => sum + imp, 0) / improvements.length
      : 0;

    return {
      totalCalibrations,
      recentCalibrations: recent.length,
      totalProcessedRecords: totalRecords,
      averageImprovement: Math.round(avgImprovement * 1000) / 1000,
      confidence: this.calculateConfidence(),
      lastCalibration: recent.length > 0 ? new Date(recent[recent.length - 1].timestamp).toISOString() : null
    };
  }

  /**
   * Export calibration configuration
   */
  exportConfiguration() {
    return {
      useCase: this.engine.useCase,
      targetMetrics: this.metricConfig.getTargetMetrics(),
      calibrationHistory: this.calibrationHistory.slice(-10),
      weights: this.engine.dynamicWeights.exportConfig(),
      metricConfig: this.metricConfig.exportConfiguration(),
      exportedAt: Date.now()
    };
  }

  /**
   * Batch calibration for multiple use cases
   */
  async calibrateBatch(batchData) {
    const results = {};

    for (const [useCase, validationBatch] of Object.entries(batchData)) {
      try {
        // Switch to appropriate use case
        const originalUseCase = this.engine.useCase;
        this.engine.useCase = useCase;
        this.metricConfig = new MetricConfig(useCase);

        results[useCase] = await this.calibrateWeights(validationBatch);

        // Restore original use case
        this.engine.useCase = originalUseCase;
        this.metricConfig = new MetricConfig(originalUseCase);

      } catch (error) {
        results[useCase] = { success: false, error: error.message };
      }
    }

    return {
      success: Object.values(results).every(r => r.success),
      results,
      timestamp: new Date().toISOString()
    };
  }
}