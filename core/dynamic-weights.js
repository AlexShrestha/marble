/**
 * Dynamic Weight System for Prism Scorer
 *
 * Auto-adjusts scoring dimension weights based on business outcome correlations.
 * Clone fitness evolves against real metrics, not just engagement.
 */

export class DynamicWeights {
  constructor(initialWeights = {}) {
    this.weights = { ...initialWeights };
    this.history = [];
    this.learningRate = 0.1;
    this.stabilityThreshold = 0.95;
    this.performanceHistory = [];
    this.lastUpdate = Date.now();
  }

  /**
   * Get current weights for scoring
   */
  getCurrentWeights() {
    return { ...this.weights };
  }

  /**
   * Update weights based on validation outcome
   * @param {Object} dimensionScores - Scores for each dimension (0-1)
   * @param {number} actualMetric - Actual business outcome (normalized 0-1)
   * @param {number} baselineMetric - Baseline for comparison (normalized 0-1)
   */
  updateFromValidation(dimensionScores, actualMetric, baselineMetric = 0.5) {
    const improvement = actualMetric - baselineMetric;
    const performanceSignal = improvement > 0 ? 1 : -1;

    // Calculate correlation between each dimension and the outcome
    const correlations = {};
    for (const [dimension, score] of Object.entries(dimensionScores)) {
      // Simple correlation: high dimension score + good outcome = positive signal
      correlations[dimension] = score * performanceSignal * Math.abs(improvement);
    }

    // Update weights based on correlations
    const totalCorrelation = Object.values(correlations).reduce((sum, corr) => sum + Math.abs(corr), 0);

    if (totalCorrelation > 0) {
      for (const [dimension, correlation] of Object.entries(correlations)) {
        const currentWeight = this.weights[dimension] || 0.1;
        const adjustment = (correlation / totalCorrelation) * this.learningRate;

        // Bounded weight update
        this.weights[dimension] = Math.max(0.01, Math.min(0.8, currentWeight + adjustment));
      }

      // Normalize weights to sum to 1
      this.normalizeWeights();
    }

    // Store performance data
    this.performanceHistory.push({
      improvement,
      correlations,
      weights: { ...this.weights },
      timestamp: Date.now()
    });

    // Keep last 100 performance records
    if (this.performanceHistory.length > 100) {
      this.performanceHistory = this.performanceHistory.slice(-100);
    }

    this.lastUpdate = Date.now();
    return this.getUpdateSummary();
  }

  /**
   * Normalize weights so they sum to approximately 1
   */
  normalizeWeights() {
    const totalWeight = Object.values(this.weights).reduce((sum, weight) => sum + weight, 0);
    if (totalWeight > 0) {
      for (const dimension in this.weights) {
        this.weights[dimension] /= totalWeight;
      }
    }
  }

  /**
   * Compute weighted score from dimension scores
   */
  computeWeightedScore(dimensionScores) {
    let score = 0;
    for (const [dimension, dimensionScore] of Object.entries(dimensionScores)) {
      const weight = this.weights[dimension] || 0;
      score += dimensionScore * weight;
    }
    return Math.max(0, Math.min(1, score));
  }

  /**
   * Get summary of recent weight changes
   */
  getRecentChanges() {
    if (this.performanceHistory.length < 2) {
      return { changes: [], stability: 'insufficient_data' };
    }

    const recent = this.performanceHistory.slice(-5);
    const changes = {};

    for (const dimension in this.weights) {
      const recentWeights = recent.map(r => r.weights[dimension] || 0);
      const variance = this.calculateVariance(recentWeights);
      changes[dimension] = {
        current: this.weights[dimension],
        variance,
        trend: this.calculateTrend(recentWeights)
      };
    }

    const avgVariance = Object.values(changes).reduce((sum, change) => sum + change.variance, 0) / Object.keys(changes).length;
    const stability = avgVariance < 0.01 ? 'stable' : avgVariance < 0.05 ? 'stabilizing' : 'learning';

    return { changes, stability, avgVariance };
  }

  /**
   * Get evolution summary for monitoring
   */
  getEvolutionSummary() {
    if (this.performanceHistory.length < 5) {
      return {
        status: 'learning',
        averageImprovement: 0,
        confidence: 0.1,
        weightStability: 'insufficient_data'
      };
    }

    const recent = this.performanceHistory.slice(-10);
    const improvements = recent.map(r => r.improvement);
    const avgImprovement = improvements.reduce((sum, imp) => sum + imp, 0) / improvements.length;

    const positiveOutcomes = improvements.filter(imp => imp > 0).length;
    const confidence = positiveOutcomes / improvements.length;

    const { stability } = this.getRecentChanges();

    return {
      status: confidence > 0.7 ? 'optimized' : confidence > 0.5 ? 'improving' : 'learning',
      averageImprovement: Math.round(avgImprovement * 1000) / 1000,
      confidence: Math.round(confidence * 100) / 100,
      weightStability: stability,
      totalUpdates: this.performanceHistory.length
    };
  }

  /**
   * Export weights and performance data
   */
  exportConfig() {
    return {
      weights: { ...this.weights },
      performanceHistory: this.performanceHistory.slice(-20),
      learningRate: this.learningRate,
      lastUpdate: this.lastUpdate,
      exportedAt: Date.now()
    };
  }

  /**
   * Import weights and performance data
   */
  importConfig(config) {
    if (config.weights) {
      this.weights = { ...config.weights };
    }
    if (config.performanceHistory) {
      this.performanceHistory = config.performanceHistory;
    }
    if (config.learningRate !== undefined) {
      this.learningRate = config.learningRate;
    }
    this.lastUpdate = Date.now();
    return { success: true };
  }

  /**
   * Reset weights to initial values
   */
  reset(initialWeights = {}) {
    this.weights = { ...initialWeights };
    this.performanceHistory = [];
    this.lastUpdate = Date.now();
    return { success: true };
  }

  // Utility methods
  calculateVariance(values) {
    if (values.length < 2) return 0;
    const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
    const squaredDiffs = values.map(val => Math.pow(val - mean, 2));
    return squaredDiffs.reduce((sum, diff) => sum + diff, 0) / values.length;
  }

  calculateTrend(values) {
    if (values.length < 3) return 'unknown';
    const recent = values.slice(-3);
    const increasing = recent[2] > recent[1] && recent[1] > recent[0];
    const decreasing = recent[2] < recent[1] && recent[1] < recent[0];
    return increasing ? 'rising' : decreasing ? 'falling' : 'stable';
  }

  getUpdateSummary() {
    const evolution = this.getEvolutionSummary();
    const changes = this.getRecentChanges();

    return {
      weightsUpdated: true,
      evolution,
      recentChanges: changes,
      timestamp: new Date().toISOString()
    };
  }
}