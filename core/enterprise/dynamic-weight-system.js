/**
 * Dynamic Weight System
 *
 * Manages auto-tuning of scoring weights based on business outcome correlations.
 * Implements learning algorithms to optimize weight distribution over time.
 */

export class DynamicWeightSystem {
  constructor(initialWeights) {
    this.weights = { ...initialWeights };
    this.performanceHistory = [];
    this.learningRate = 0.08;
    this.minWeight = 0.05;
    this.maxWeight = 0.60;
    this.momentum = 0.9;
    this.previousGradients = {};
    this.created = Date.now();

    // Normalize initial weights
    this.normalizeWeights();
  }

  /**
   * Compute weighted score from dimension scores
   */
  computeWeightedScore(dimensionScores) {
    let totalScore = 0;
    let totalWeight = 0;

    for (const [dimension, score] of Object.entries(dimensionScores)) {
      const weight = this.weights[dimension] || 0;
      totalScore += weight * score;
      totalWeight += weight;
    }

    // Normalize by total weight to handle missing dimensions
    return totalWeight > 0 ? Math.min(1, Math.max(0, totalScore / totalWeight)) : 0;
  }

  /**
   * Update weights based on validation outcome
   */
  updateFromValidation(dimensionScores, actualMetric, baselineMetric) {
    const improvement = (actualMetric - baselineMetric) / Math.max(baselineMetric, 0.01);

    // Calculate correlations for each dimension
    const correlations = this.calculateCorrelations(dimensionScores, improvement);

    // Apply momentum-based weight updates
    for (const [dimension, correlation] of Object.entries(correlations)) {
      if (Math.abs(correlation) > 0.15) { // Lowered threshold for real correlation math
        const gradient = this.learningRate * correlation;

        // Apply momentum
        const previousGradient = this.previousGradients[dimension] || 0;
        const momentumGradient = this.momentum * previousGradient + (1 - this.momentum) * gradient;
        this.previousGradients[dimension] = momentumGradient;

        // Update weight
        const oldWeight = this.weights[dimension] || 0;
        this.weights[dimension] = this.clampWeight(oldWeight + momentumGradient);
      }
    }

    this.normalizeWeights();
    this.recordPerformance(improvement, correlations, dimensionScores);
  }

  /**
   * Calculate correlation between dimension scores and business outcomes
   */
  calculateCorrelations(dimensionScores, improvement) {
    const correlations = {};

    for (const [dimension, score] of Object.entries(dimensionScores)) {
      correlations[dimension] = this.computeCorrelation(dimension, score, improvement);
    }

    return correlations;
  }

  /**
   * Compute real correlation using historical data and Pearson correlation coefficient
   */
  computeCorrelation(dimension, currentScore, currentImprovement) {
    const minSampleSize = 10; // Minimum data points for reliable correlation

    if (this.performanceHistory.length < minSampleSize) {
      return this.fallbackCorrelation(currentScore, currentImprovement);
    }

    // Collect historical dimension scores and improvements for this dimension
    const dimensionScores = [];
    const improvements = [];

    // Add current data point
    dimensionScores.push(currentScore);
    improvements.push(currentImprovement);

    // Add historical data points
    for (const record of this.performanceHistory) {
      if (record.dimensionScores && record.dimensionScores[dimension] !== undefined) {
        dimensionScores.push(record.dimensionScores[dimension]);
        improvements.push(record.improvement);
      }
    }

    if (dimensionScores.length < minSampleSize) {
      return this.fallbackCorrelation(currentScore, currentImprovement);
    }

    // Calculate Pearson correlation coefficient
    return this.pearsonCorrelation(dimensionScores, improvements);
  }

  /**
   * Calculate Pearson correlation coefficient between two arrays
   */
  pearsonCorrelation(x, y) {
    if (x.length !== y.length || x.length === 0) return 0;

    const n = x.length;
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
    const sumY2 = y.reduce((sum, yi) => sum + yi * yi, 0);

    const numerator = n * sumXY - sumX * sumY;
    const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

    if (denominator === 0) return 0; // Avoid division by zero

    const correlation = numerator / denominator;

    // Clamp to reasonable bounds and apply significance threshold
    const clampedCorrelation = Math.max(-0.8, Math.min(0.8, correlation));

    // Only return correlations with statistical significance (> 0.1 absolute value)
    return Math.abs(clampedCorrelation) > 0.1 ? clampedCorrelation : 0;
  }

  /**
   * Fallback correlation estimation when insufficient historical data
   */
  fallbackCorrelation(dimensionScore, improvement) {
    // Simple heuristic when we don't have enough data
    if (improvement > 0) {
      return dimensionScore > 0.5 ? 0.3 : 0.1;
    } else {
      return dimensionScore > 0.5 ? -0.2 : 0.0;
    }
  }

  /**
   * Normalize weights to sum to 1
   */
  normalizeWeights() {
    const sum = Object.values(this.weights).reduce((a, b) => a + b, 0);

    if (sum > 0) {
      for (const key of Object.keys(this.weights)) {
        this.weights[key] /= sum;
      }
    } else {
      // If all weights are 0, distribute equally
      const keys = Object.keys(this.weights);
      const equalWeight = 1 / keys.length;
      for (const key of keys) {
        this.weights[key] = equalWeight;
      }
    }
  }

  /**
   * Clamp weight within allowed bounds
   */
  clampWeight(weight) {
    return Math.max(this.minWeight, Math.min(this.maxWeight, weight));
  }

  /**
   * Record performance for analytics
   */
  recordPerformance(improvement, correlations, dimensionScores = {}) {
    this.performanceHistory.push({
      timestamp: Date.now(),
      improvement,
      correlations: { ...correlations },
      weights: { ...this.weights },
      dimensionScores: { ...dimensionScores }
    });

    // Keep last 100 performance records
    if (this.performanceHistory.length > 100) {
      this.performanceHistory = this.performanceHistory.slice(-100);
    }
  }

  /**
   * Get current weights
   */
  getCurrentWeights() {
    return { ...this.weights };
  }

  /**
   * Get recent weight changes
   */
  getRecentChanges() {
    if (this.performanceHistory.length < 2) {
      return {};
    }

    const recent = this.performanceHistory[this.performanceHistory.length - 1];
    const previous = this.performanceHistory[this.performanceHistory.length - 2];

    const changes = {};
    for (const dimension of Object.keys(this.weights)) {
      const currentWeight = recent.weights[dimension] || 0;
      const previousWeight = previous.weights[dimension] || 0;
      changes[dimension] = currentWeight - previousWeight;
    }

    return changes;
  }

  /**
   * Get performance analytics
   */
  getPerformanceAnalytics() {
    if (this.performanceHistory.length === 0) {
      return { message: 'No performance data available' };
    }

    const recent = this.performanceHistory.slice(-20);
    const improvements = recent.map(r => r.improvement);
    const avgImprovement = improvements.reduce((a, b) => a + b, 0) / improvements.length;

    // Calculate weight stability
    const weightVariances = {};
    for (const dimension of Object.keys(this.weights)) {
      const weights = recent.map(r => r.weights[dimension] || 0);
      const avgWeight = weights.reduce((a, b) => a + b, 0) / weights.length;
      const variance = weights.reduce((sum, w) => sum + Math.pow(w - avgWeight, 2), 0) / weights.length;
      weightVariances[dimension] = variance;
    }

    const overallStability = 1 - Object.values(weightVariances).reduce((a, b) => a + b, 0) / Object.keys(weightVariances).length;

    return {
      totalValidations: this.performanceHistory.length,
      averageImprovement: Math.round(avgImprovement * 1000) / 1000,
      stability: Math.round(overallStability * 1000) / 1000,
      weightVariances,
      currentWeights: this.getCurrentWeights(),
      isConverged: overallStability > 0.95 && this.performanceHistory.length > 50
    };
  }

  /**
   * Reset weights to initial values
   */
  reset(newInitialWeights = null) {
    if (newInitialWeights) {
      this.weights = { ...newInitialWeights };
    }
    this.performanceHistory = [];
    this.previousGradients = {};
    this.normalizeWeights();
  }

  /**
   * Export configuration for persistence
   */
  exportConfig() {
    return {
      weights: this.getCurrentWeights(),
      learningRate: this.learningRate,
      minWeight: this.minWeight,
      maxWeight: this.maxWeight,
      momentum: this.momentum,
      performanceHistory: this.performanceHistory.slice(-20), // Export last 20 records
      created: this.created,
      lastUpdated: Date.now()
    };
  }

  /**
   * Import configuration from persistence
   */
  importConfig(config) {
    this.weights = { ...config.weights };
    this.learningRate = config.learningRate || 0.08;
    this.minWeight = config.minWeight || 0.05;
    this.maxWeight = config.maxWeight || 0.60;
    this.momentum = config.momentum || 0.9;
    this.performanceHistory = config.performanceHistory || [];
    this.created = config.created || Date.now();
    this.normalizeWeights();
  }

  /**
   * Get performance history
   */
  getPerformanceHistory() {
    return this.performanceHistory;
  }

  /**
   * Get weight evolution summary
   */
  getEvolutionSummary() {
    if (this.performanceHistory.length < 3) {
      return {
        status: 'learning',
        message: 'Need more calibration data for evolution analysis',
        data_points: this.performanceHistory.length
      };
    }

    const recent = this.performanceHistory.slice(-10);
    const initial = this.performanceHistory.slice(0, 3);

    const recentAvgImprovement = recent.reduce((sum, h) => sum + h.improvement, 0) / recent.length;
    const initialAvgImprovement = initial.reduce((sum, h) => sum + h.improvement, 0) / initial.length;

    const evolutionTrend = recentAvgImprovement - initialAvgImprovement;

    return {
      status: evolutionTrend > 0.05 ? 'improving' : evolutionTrend < -0.05 ? 'declining' : 'stable',
      evolution_trend: Math.round(evolutionTrend * 1000) / 1000,
      recent_performance: Math.round(recentAvgImprovement * 1000) / 1000,
      initial_performance: Math.round(initialAvgImprovement * 1000) / 1000,
      data_points: this.performanceHistory.length,
      weight_stability: this.getPerformanceAnalytics().stability,
      weight_evolution: this.getWeightEvolution()
    };
  }

  /**
   * Get detailed weight evolution over time
   */
  getWeightEvolution() {
    if (this.performanceHistory.length < 2) {
      return { message: 'Insufficient data for weight evolution' };
    }

    const evolution = {};
    const dimensions = Object.keys(this.weights);

    // Track weight changes over time
    const timeline = [];
    const initialWeights = this.performanceHistory[0].weights || this.weights;

    for (let i = 0; i < this.performanceHistory.length; i += Math.max(1, Math.floor(this.performanceHistory.length / 10))) {
      const record = this.performanceHistory[i];
      timeline.push({
        timestamp: record.timestamp,
        weights: { ...record.weights },
        improvement: record.improvement,
        step: i
      });
    }

    // Add final state
    const lastRecord = this.performanceHistory[this.performanceHistory.length - 1];
    timeline.push({
      timestamp: lastRecord.timestamp,
      weights: { ...this.weights },
      improvement: lastRecord.improvement,
      step: this.performanceHistory.length - 1
    });

    // Calculate total changes for each dimension
    for (const dimension of dimensions) {
      const initialWeight = initialWeights[dimension] || 0;
      const finalWeight = this.weights[dimension] || 0;
      const totalChange = finalWeight - initialWeight;

      evolution[dimension] = {
        initial: Math.round(initialWeight * 1000) / 1000,
        final: Math.round(finalWeight * 1000) / 1000,
        change: Math.round(totalChange * 1000) / 1000,
        change_percent: Math.round((totalChange / Math.max(initialWeight, 0.001)) * 100),
        correlation_avg: this.getAverageCorrelation(dimension)
      };
    }

    return {
      timeline,
      dimension_changes: evolution,
      total_calibrations: this.performanceHistory.length,
      using_real_correlation: this.performanceHistory.length >= 10
    };
  }

  /**
   * Get average correlation for a dimension across all calibrations
   */
  getAverageCorrelation(dimension) {
    const correlations = this.performanceHistory
      .map(record => record.correlations?.[dimension])
      .filter(c => c !== undefined && c !== 0);

    if (correlations.length === 0) return 0;

    const avg = correlations.reduce((a, b) => a + b, 0) / correlations.length;
    return Math.round(avg * 1000) / 1000;
  }
}
