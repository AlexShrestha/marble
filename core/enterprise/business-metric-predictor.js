/**
 * Business Metric Predictor
 *
 * Predicts business metric impacts based on content dimension scores.
 * Maps psychological and content patterns to specific business outcomes.
 */

export class BusinessMetricPredictor {
  constructor() {
    this.patternMappings = this.initializePatternMappings();
    this.predictionHistory = [];
    this.confidenceThresholds = {
      high: 0.8,
      medium: 0.5,
      low: 0.2
    };
  }

  /**
   * Generate business metric predictions from dimension scores
   */
  generatePredictions(dimensionScores, targetMetrics) {
    const predictions = {};

    for (const metric of targetMetrics) {
      predictions[metric] = this.predictMetricImpact(metric, dimensionScores);
    }

    return predictions;
  }

  /**
   * Predict impact on a specific business metric
   */
  predictMetricImpact(metric, dimensionScores) {
    const metricMapping = this.patternMappings[metric] || this.patternMappings.default;

    let expectedDelta = 0;
    let confidenceFactors = [];
    const reasoningComponents = [];

    // Calculate weighted impact from each dimension
    for (const [dimension, score] of Object.entries(dimensionScores)) {
      const impact = metricMapping[dimension] || 0;
      const contribution = impact * score;
      expectedDelta += contribution;

      if (Math.abs(contribution) > 0.05) {
        confidenceFactors.push(score);
        reasoningComponents.push({
          dimension,
          score: Math.round(score * 100),
          impact: Math.round(contribution * 100)
        });
      }
    }

    // Calculate confidence based on score consistency and strength
    const confidence = this.calculatePredictionConfidence(confidenceFactors, expectedDelta);

    return {
      expectedDelta: Math.round(expectedDelta * 1000) / 1000,
      confidence: Math.round(confidence * 100) / 100,
      reasoning: this.generateReasoning(metric, reasoningComponents),
      components: reasoningComponents
    };
  }

  /**
   * Initialize pattern mappings for different metrics
   */
  initializePatternMappings() {
    return {
      reply_rate: {
        personalization_depth: 0.35,
        temporal_relevance: 0.25,
        psychological_resonance: 0.15,
        actionability: 0.20,
        trust_indicators: 0.15,
        insight_density: 0.10
      },
      click_through_rate: {
        personalization_depth: 0.30,
        temporal_relevance: 0.20,
        psychological_resonance: 0.25,
        actionability: 0.35,
        trust_indicators: 0.10,
        social_proof: 0.15
      },
      click_through: {
        personalization_depth: 0.30,
        temporal_relevance: 0.20,
        psychological_resonance: 0.25,
        actionability: 0.35,
        trust_indicators: 0.10,
        social_proof: 0.15
      },
      engagement_time: {
        personalization_depth: 0.25,
        temporal_relevance: 0.15,
        psychological_resonance: 0.30,
        actionability: 0.10,
        trust_indicators: 0.15,
        insight_density: 0.35,
        social_proof: 0.10
      },
      conversion: {
        personalization_depth: 0.40,
        temporal_relevance: 0.20,
        psychological_resonance: 0.20,
        actionability: 0.30,
        trust_indicators: 0.25,
        social_proof: 0.15
      },
      conversion_rate: {
        personalization_depth: 0.40,
        temporal_relevance: 0.20,
        psychological_resonance: 0.20,
        actionability: 0.30,
        trust_indicators: 0.25,
        social_proof: 0.15
      },
      revenue: {
        personalization_depth: 0.35,
        temporal_relevance: 0.25,
        psychological_resonance: 0.20,
        actionability: 0.25,
        trust_indicators: 0.30,
        social_proof: 0.20
      },
      retention_rate: {
        personalization_depth: 0.30,
        temporal_relevance: 0.35,
        psychological_resonance: 0.25,
        actionability: 0.15,
        trust_indicators: 0.20,
        insight_density: 0.25
      },
      behavior_change_rate: {
        personalization_depth: 0.35,
        temporal_relevance: 0.30,
        psychological_resonance: 0.20,
        actionability: 0.40,
        trust_indicators: 0.25,
        insight_density: 0.20
      },
      default: {
        personalization_depth: 0.25,
        temporal_relevance: 0.25,
        psychological_resonance: 0.20,
        actionability: 0.20,
        trust_indicators: 0.15,
        insight_density: 0.15,
        social_proof: 0.10
      }
    };
  }

  /**
   * Calculate prediction confidence based on score factors
   */
  calculatePredictionConfidence(confidenceFactors, expectedDelta) {
    if (confidenceFactors.length === 0) return 0.1;

    // Base confidence from score consistency
    const avgScore = confidenceFactors.reduce((a, b) => a + b, 0) / confidenceFactors.length;
    const variance = confidenceFactors.reduce((sum, score) => {
      return sum + Math.pow(score - avgScore, 2);
    }, 0) / confidenceFactors.length;

    let confidence = avgScore * (1 - variance); // Higher when scores are high and consistent

    // Boost confidence for stronger expected impacts
    const impactBonus = Math.min(0.3, Math.abs(expectedDelta) * 2);
    confidence += impactBonus;

    // Ensure reasonable bounds
    return Math.max(0.1, Math.min(0.95, confidence));
  }

  /**
   * Generate human-readable reasoning for predictions
   */
  generateReasoning(metric, components) {
    if (components.length === 0) {
      return `No significant predictors for ${metric}`;
    }

    const topComponents = components
      .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
      .slice(0, 3);

    const reasons = topComponents.map(comp => {
      const direction = comp.impact > 0 ? 'boost' : 'reduce';
      return `${comp.dimension} (${comp.score}%) will ${direction} by ${Math.abs(comp.impact)}%`;
    });

    return `${metric} prediction: ${reasons.join(', ')}`;
  }

  /**
   * Validate prediction against actual outcomes
   */
  validatePrediction(predictionId, actualMetric, predictedDelta, metadata = {}) {
    const accuracy = this.calculateAccuracy(predictedDelta, actualMetric);

    const validation = {
      predictionId,
      timestamp: Date.now(),
      predictedDelta,
      actualMetric,
      accuracy,
      metadata
    };

    this.predictionHistory.push(validation);

    // Keep last 200 predictions for analysis
    if (this.predictionHistory.length > 200) {
      this.predictionHistory = this.predictionHistory.slice(-200);
    }

    return validation;
  }

  /**
   * Calculate prediction accuracy
   */
  calculateAccuracy(predicted, actual) {
    if (Math.abs(predicted) < 0.01 && Math.abs(actual) < 0.01) return 1.0;

    const directionMatch = (predicted > 0 && actual > 0) || (predicted < 0 && actual < 0) || (predicted === 0 && Math.abs(actual) < 0.02);

    if (!directionMatch) return 0.1;

    const magnitudeRatio = 1 - Math.abs(predicted - actual) / Math.max(Math.abs(predicted), Math.abs(actual), 0.01);

    return Math.max(0.1, Math.min(1.0, magnitudeRatio));
  }

  /**
   * Get predictor analytics and performance
   */
  getPredictorAnalytics() {
    if (this.predictionHistory.length < 5) {
      return {
        status: 'insufficient_data',
        message: 'Need more validations for analysis'
      };
    }

    const recent = this.predictionHistory.slice(-50);
    const totalAccuracy = recent.reduce((sum, p) => sum + p.accuracy, 0) / recent.length;

    // Group by metric type if available
    const byMetric = {};
    recent.forEach(prediction => {
      const metric = prediction.metadata?.metric || 'unknown';
      if (!byMetric[metric]) byMetric[metric] = [];
      byMetric[metric].push(prediction.accuracy);
    });

    const metricPerformance = {};
    for (const [metric, accuracies] of Object.entries(byMetric)) {
      metricPerformance[metric] = {
        averageAccuracy: accuracies.reduce((a, b) => a + b, 0) / accuracies.length,
        sampleSize: accuracies.length
      };
    }

    return {
      totalPredictions: this.predictionHistory.length,
      recentPredictions: recent.length,
      overallAccuracy: Math.round(totalAccuracy * 100) / 100,
      metricPerformance,
      confidenceCalibration: this.analyzeConfidenceCalibration(recent),
      lastUpdated: new Date().toISOString()
    };
  }

  /**
   * Analyze how well confidence scores correlate with accuracy
   */
  analyzeConfidenceCalibration(predictions) {
    const bins = { high: [], medium: [], low: [] };

    predictions.forEach(pred => {
      const confidence = pred.metadata?.confidence || 0.5;
      if (confidence >= this.confidenceThresholds.high) {
        bins.high.push(pred.accuracy);
      } else if (confidence >= this.confidenceThresholds.medium) {
        bins.medium.push(pred.accuracy);
      } else {
        bins.low.push(pred.accuracy);
      }
    });

    const calibration = {};
    for (const [bin, accuracies] of Object.entries(bins)) {
      if (accuracies.length > 0) {
        calibration[bin] = {
          averageAccuracy: accuracies.reduce((a, b) => a + b, 0) / accuracies.length,
          count: accuracies.length
        };
      }
    }

    return calibration;
  }

  /**
   * Update pattern mappings based on validation data
   */
  updatePatternMappings(metric, dimensionCorrelations) {
    if (!this.patternMappings[metric]) {
      this.patternMappings[metric] = { ...this.patternMappings.default };
    }

    // Gradually adjust mappings based on observed correlations
    const learningRate = 0.05;

    for (const [dimension, correlation] of Object.entries(dimensionCorrelations)) {
      if (Math.abs(correlation) > 0.2) { // Significant correlation
        const currentMapping = this.patternMappings[metric][dimension] || 0;
        const adjustment = learningRate * correlation;
        this.patternMappings[metric][dimension] = Math.max(-0.5, Math.min(0.5, currentMapping + adjustment));
      }
    }

    return this.patternMappings[metric];
  }

  /**
   * Export predictor configuration
   */
  exportConfig() {
    return {
      patternMappings: this.patternMappings,
      predictionHistory: this.predictionHistory.slice(-50), // Export recent history
      confidenceThresholds: this.confidenceThresholds,
      lastUpdated: new Date().toISOString()
    };
  }

  /**
   * Import predictor configuration
   */
  importConfig(config) {
    this.patternMappings = config.patternMappings || this.initializePatternMappings();
    this.predictionHistory = config.predictionHistory || [];
    this.confidenceThresholds = config.confidenceThresholds || this.confidenceThresholds;
  }
}
