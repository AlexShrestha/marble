/**
 * Marble Calibration — Thin Facade
 *
 * Maps the legacy (kg, metricConfig) constructor interface to the unified
 * CalibrationAPI. All calibration logic lives in calibration-api.js.
 *
 * New code should use CalibrationAPI directly from calibration-api.js.
 */

import { CalibrationAPI, CorrelationTracker, WeightOptimizer, generateInsights } from './calibration-api.js';
import { METRIC_DEFINITIONS } from './metric-agnostic-scorer.js';
import { MetricConfiguration, METRIC_TYPES } from './types.js';

// Map legacy METRIC_TYPES values to METRIC_DEFINITIONS keys
const LEGACY_METRIC_MAP = {
  reply_rate: 'email_reply_rate',
  conversion: 'conversion_rate',
  retention: 'retention_rate',
  engagement_time: 'dwell_time',
};

// Re-export unified utilities so old imports still work
export { CorrelationTracker, WeightOptimizer, generateInsights };

/**
 * Backward-compatible wrapper around CalibrationAPI.
 *
 * Translates the old per-outcome interface (storyId, actualValue, metricType,
 * dimensionScores) into CalibrationAPI's per-startup batch model.
 */
export class MarbleCalibrationAPI {
  constructor(kg, metricConfig = null) {
    this.kg = kg;
    this.metricConfig = metricConfig || new MetricConfiguration(METRIC_TYPES.ENGAGEMENT_TIME, 'default');
    this._api = new CalibrationAPI();
    this._startupId = `legacy_${this.metricConfig.useCase || 'default'}`;
    this._registered = false;
    this.outcomeBuffer = [];
    this.minBatchSize = 10;
  }

  async _ensureRegistered() {
    if (!this._registered) {
      const legacyMetric = this.metricConfig.metricType;
      const resolvedMetric = LEGACY_METRIC_MAP[legacyMetric] || legacyMetric;

      // If the metric still isn't in METRIC_DEFINITIONS, register it as a custom metric
      const isKnown = !!METRIC_DEFINITIONS[resolvedMetric];
      const customMetrics = isKnown ? {} : {
        [resolvedMetric]: {
          type: 'primary',
          weight: 1.0,
          dimensions: Object.keys(this.metricConfig.weights || {}),
          correlationFactors: this.metricConfig.weights || {}
        }
      };

      await this._api.registerStartup(this._startupId, {
        useCase: this.metricConfig.useCase,
        primaryMetrics: [resolvedMetric],
        secondaryMetrics: [],
        weights: this.metricConfig.weights,
        learningRate: this.metricConfig.learningRate,
        customMetrics
      });
      this._registered = true;
    }
  }

  /**
   * Translate a legacy outcome object into the CalibrationAPI format.
   */
  _translateOutcome(data) {
    return {
      content_id: data.storyId,
      dimension_scores: data.dimensionScores,
      actual_metrics: { [data.metricType]: data.actualValue },
      baseline_metrics: data.baselineValue != null
        ? { [data.metricType]: data.baselineValue }
        : {},
      metadata: { timestamp: data.timestamp }
    };
  }

  /**
   * Submit outcome data for a story that was previously scored.
   * Buffers locally, then delegates to CalibrationAPI in batch.
   */
  async submitOutcome(outcomeData) {
    try {
      this._validateOutcomeData(outcomeData);

      this.outcomeBuffer.push({
        ...outcomeData,
        processedAt: Date.now()
      });

      if (this.outcomeBuffer.length >= this.minBatchSize) {
        return await this.calibrateWeights();
      }

      return {
        success: true,
        buffered: this.outcomeBuffer.length,
        willCalibrate: this.outcomeBuffer.length >= this.minBatchSize
      };
    } catch (error) {
      console.error('Error submitting outcome:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Process batched outcomes via CalibrationAPI and update metricConfig weights.
   */
  async calibrateWeights() {
    if (this.outcomeBuffer.length < this.minBatchSize) {
      return { success: false, reason: 'Insufficient data for calibration' };
    }

    try {
      await this._ensureRegistered();

      const translated = this.outcomeBuffer
        .filter(o => o.actualValue !== undefined && o.dimensionScores && Object.keys(o.dimensionScores).length > 0)
        .map(o => this._translateOutcome(o));

      if (translated.length < 5) {
        return { success: false, reason: 'Insufficient valid outcomes for analysis' };
      }

      const batchResult = await this._api.submitOutcomeBatch(this._startupId, translated);

      // Sync updated weights back to the legacy metricConfig
      const engine = this._api.engines.get(this._startupId);
      if (engine) {
        const engineWeights = engine.config.weights;
        if (engineWeights && typeof this.metricConfig.updateWeights === 'function') {
          this.metricConfig.updateWeights(engineWeights);
        }
        this.metricConfig.correlationHistory.push({
          timestamp: Date.now(),
          batchResult,
          source: 'unified_calibration_api'
        });
      }

      // Retain a small tail for continuity
      const keep = Math.min(100, Math.floor(this.outcomeBuffer.length * 0.1));
      this.outcomeBuffer = this.outcomeBuffer.slice(-keep);

      return {
        success: true,
        processed: batchResult.processed,
        successful: batchResult.successful,
        results: batchResult.results
      };
    } catch (error) {
      console.error('Calibration error:', error);
      return { success: false, error: error.message };
    }
  }

  _validateOutcomeData(data) {
    const required = ['storyId', 'actualValue', 'metricType', 'dimensionScores'];
    for (const field of required) {
      if (data[field] === undefined) {
        throw new Error(`Missing required field: ${field}`);
      }
    }

    if (typeof data.actualValue !== 'number' || isNaN(data.actualValue)) {
      throw new Error('actualValue must be a valid number');
    }

    if (!Object.keys(METRIC_TYPES).includes(data.metricType.toUpperCase())) {
      console.warn(`Unknown metric type: ${data.metricType}, proceeding anyway`);
    }
  }

  generateInsights(analysis) {
    return generateInsights(analysis);
  }
}
