/**
 * Baseline Algorithms for Marble Benchmarking
 *
 * First-class implementations of baseline algorithms that all benchmark runs must beat or match.
 * - Majority class
 * - Popularity-based
 * - Exact overlap
 * - Demographic bucket
 * - Nearest-profile
 */

export class BaselineAlgorithms {
  constructor() {
    this.baselines = new Map();
    this.trained = false;
    this.trainingData = [];
  }

  /**
   * Train all baseline algorithms from historical data
   */
  async trainFromData(historicalData) {
    this.trainingData = [...historicalData];

    // Train each baseline
    this.baselines.set('majority', this.trainMajorityBaseline(historicalData));
    this.baselines.set('popularity', this.trainPopularityBaseline(historicalData));
    this.baselines.set('exact_overlap', this.trainExactOverlapBaseline(historicalData));
    this.baselines.set('demographic_bucket', this.trainDemographicBaseline(historicalData));
    this.baselines.set('nearest_profile', this.trainNearestProfileBaseline(historicalData));

    this.trained = true;

    return {
      success: true,
      baselines: Array.from(this.baselines.keys()),
      trainingData: historicalData.length,
      trainedAt: new Date().toISOString()
    };
  }

  /**
   * Majority Class Baseline
   * Always predicts the most common outcome
   */
  trainMajorityBaseline(data) {
    const outcomes = data.map(sample => {
      const metric = Object.keys(sample.actual_metrics)[0];
      const actual = sample.actual_metrics[metric];
      const baseline = sample.baseline_metrics?.[metric] || 0.01;
      return (actual - baseline) / baseline > 0.1; // Binary: improved vs not
    });

    const positiveCount = outcomes.filter(o => o).length;
    const majorityClass = positiveCount > outcomes.length / 2;
    const confidence = Math.max(positiveCount, outcomes.length - positiveCount) / outcomes.length;

    return {
      prediction: majorityClass ? 0.7 : 0.3, // Fixed prediction for majority class
      confidence: confidence,
      trainingAccuracy: confidence,
      algorithm: 'majority_class'
    };
  }

  /**
   * Popularity-based Baseline
   * Predicts based on content popularity/engagement patterns
   */
  trainPopularityBaseline(data) {
    const popularityLookup = new Map();

    for (const sample of data) {
      const contentId = sample.content_id;
      const metric = Object.keys(sample.actual_metrics)[0];
      const actual = sample.actual_metrics[metric];
      const baseline = sample.baseline_metrics?.[metric] || 0.01;
      const improvement = (actual - baseline) / baseline;

      if (!popularityLookup.has(contentId)) {
        popularityLookup.set(contentId, []);
      }
      popularityLookup.get(contentId).push(improvement);
    }

    // Calculate average performance per content
    const popularityScores = new Map();
    for (const [contentId, improvements] of popularityLookup) {
      const avgImprovement = improvements.reduce((a, b) => a + b) / improvements.length;
      popularityScores.set(contentId, avgImprovement);
    }

    // Sort by popularity (average improvement)
    const sortedByPopularity = Array.from(popularityScores.entries())
      .sort(([,a], [,b]) => b - a);

    const popularityThreshold = sortedByPopularity.length * 0.3; // Top 30%
    const topContent = new Set(
      sortedByPopularity.slice(0, popularityThreshold).map(([id]) => id)
    );

    return {
      topContent,
      popularityScores,
      algorithm: 'popularity',
      topThreshold: 0.3
    };
  }

  /**
   * Exact Overlap Baseline
   * Predicts based on exact matches in historical data
   */
  trainExactOverlapBaseline(data) {
    const exactMatches = new Map(); // dimension_scores_hash -> outcome

    for (const sample of data) {
      const scoresHash = this.hashDimensionScores(sample.dimension_scores);
      const metric = Object.keys(sample.actual_metrics)[0];
      const actual = sample.actual_metrics[metric];
      const baseline = sample.baseline_metrics?.[metric] || 0.01;
      const improvement = (actual - baseline) / baseline;

      if (!exactMatches.has(scoresHash)) {
        exactMatches.set(scoresHash, []);
      }
      exactMatches.get(scoresHash).push(improvement);
    }

    // Average outcomes for exact matches
    const exactLookup = new Map();
    for (const [hash, improvements] of exactMatches) {
      const avgImprovement = improvements.reduce((a, b) => a + b) / improvements.length;
      exactLookup.set(hash, avgImprovement);
    }

    return {
      exactLookup,
      algorithm: 'exact_overlap',
      matchCount: exactLookup.size
    };
  }

  /**
   * Demographic Bucket Baseline
   * Predicts based on respondent demographic clusters
   */
  trainDemographicBaseline(data) {
    const buckets = new Map(); // demographic_bucket -> outcomes

    for (const sample of data) {
      const bucket = this.getDemographicBucket(sample.metadata);
      const metric = Object.keys(sample.actual_metrics)[0];
      const actual = sample.actual_metrics[metric];
      const baseline = sample.baseline_metrics?.[metric] || 0.01;
      const improvement = (actual - baseline) / baseline;

      if (!buckets.has(bucket)) {
        buckets.set(bucket, []);
      }
      buckets.get(bucket).push(improvement);
    }

    // Calculate bucket averages
    const bucketAverages = new Map();
    for (const [bucket, improvements] of buckets) {
      const avg = improvements.reduce((a, b) => a + b) / improvements.length;
      bucketAverages.set(bucket, {
        average: avg,
        sampleSize: improvements.length,
        confidence: Math.min(1, improvements.length / 10)
      });
    }

    return {
      bucketAverages,
      algorithm: 'demographic_bucket',
      buckets: buckets.size
    };
  }

  /**
   * Nearest Profile Baseline
   * Predicts based on similarity to historical profiles
   */
  trainNearestProfileBaseline(data) {
    const profiles = data.map(sample => ({
      dimensionScores: sample.dimension_scores,
      outcome: this.calculateOutcome(sample),
      metadata: sample.metadata
    }));

    return {
      profiles,
      algorithm: 'nearest_profile',
      profileCount: profiles.length
    };
  }

  /**
   * Run all baseline predictions for comparison
   */
  async runAllBaselines(content, metadata = {}) {
    if (!this.trained) {
      throw new Error('Baselines must be trained first. Call trainFromData().');
    }

    const results = {};

    // Run each baseline
    results.majority = this.predictMajority(content, metadata);
    results.popularity = this.predictPopularity(content, metadata);
    results.exact_overlap = this.predictExactOverlap(content, metadata);
    results.demographic_bucket = this.predictDemographicBucket(content, metadata);
    results.nearest_profile = this.predictNearestProfile(content, metadata);

    return {
      baseline_predictions: results,
      best_baseline: this.getBestBaseline(results),
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Predict using majority baseline
   */
  predictMajority(content, metadata) {
    const baseline = this.baselines.get('majority');
    return {
      prediction: baseline.prediction,
      confidence: baseline.confidence,
      algorithm: 'majority'
    };
  }

  /**
   * Predict using popularity baseline
   */
  predictPopularity(content, metadata) {
    const baseline = this.baselines.get('popularity');
    const contentId = content.id || content.content_id;

    if (baseline.topContent.has(contentId)) {
      return { prediction: 0.7, confidence: 0.8, algorithm: 'popularity', reason: 'top_content' };
    }

    const popularityScore = baseline.popularityScores.get(contentId);
    if (popularityScore !== undefined) {
      return {
        prediction: Math.max(0.1, Math.min(0.9, 0.5 + popularityScore)),
        confidence: 0.6,
        algorithm: 'popularity',
        popularityScore
      };
    }

    return { prediction: 0.5, confidence: 0.3, algorithm: 'popularity', reason: 'no_history' };
  }

  /**
   * Predict using exact overlap baseline
   */
  predictExactOverlap(content, metadata) {
    const baseline = this.baselines.get('exact_overlap');
    const hash = this.hashDimensionScores(content.dimension_scores || {});

    const exactMatch = baseline.exactLookup.get(hash);
    if (exactMatch !== undefined) {
      return {
        prediction: Math.max(0.1, Math.min(0.9, 0.5 + exactMatch)),
        confidence: 0.9,
        algorithm: 'exact_overlap',
        exactMatch: true
      };
    }

    return { prediction: 0.5, confidence: 0.1, algorithm: 'exact_overlap', exactMatch: false };
  }

  /**
   * Predict using demographic bucket baseline
   */
  predictDemographicBucket(content, metadata) {
    const baseline = this.baselines.get('demographic_bucket');
    const bucket = this.getDemographicBucket(metadata);

    const bucketData = baseline.bucketAverages.get(bucket);
    if (bucketData) {
      return {
        prediction: Math.max(0.1, Math.min(0.9, 0.5 + bucketData.average)),
        confidence: bucketData.confidence,
        algorithm: 'demographic_bucket',
        bucket,
        sampleSize: bucketData.sampleSize
      };
    }

    return { prediction: 0.5, confidence: 0.2, algorithm: 'demographic_bucket', bucket: 'unknown' };
  }

  /**
   * Predict using nearest profile baseline
   */
  predictNearestProfile(content, metadata) {
    const baseline = this.baselines.get('nearest_profile');
    const queryScores = content.dimension_scores || {};

    // Find nearest profile by cosine similarity
    let bestMatch = null;
    let bestSimilarity = -1;

    for (const profile of baseline.profiles) {
      const similarity = this.cosineSimilarity(queryScores, profile.dimensionScores);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestMatch = profile;
      }
    }

    if (bestMatch && bestSimilarity > 0.7) {
      return {
        prediction: Math.max(0.1, Math.min(0.9, 0.5 + bestMatch.outcome)),
        confidence: bestSimilarity,
        algorithm: 'nearest_profile',
        similarity: Math.round(bestSimilarity * 1000) / 1000
      };
    }

    return { prediction: 0.5, confidence: 0.3, algorithm: 'nearest_profile', similarity: 0 };
  }

  /**
   * Helper: Hash dimension scores for exact matching
   */
  hashDimensionScores(scores) {
    const sortedKeys = Object.keys(scores).sort();
    const rounded = sortedKeys.map(key =>
      `${key}:${Math.round(scores[key] * 100)}`
    );
    return rounded.join('|');
  }

  /**
   * Helper: Get demographic bucket from metadata
   */
  getDemographicBucket(metadata = {}) {
    const cluster = metadata.respondentCluster || 'unknown';
    const segment = metadata.segment || 'default';
    return `${cluster}_${segment}`;
  }

  /**
   * Helper: Calculate outcome from sample
   */
  calculateOutcome(sample) {
    const metric = Object.keys(sample.actual_metrics)[0];
    const actual = sample.actual_metrics[metric];
    const baseline = sample.baseline_metrics?.[metric] || 0.01;
    return (actual - baseline) / baseline;
  }

  /**
   * Helper: Calculate cosine similarity between two score vectors
   */
  cosineSimilarity(a, b) {
    const dimensions = new Set([...Object.keys(a), ...Object.keys(b)]);

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (const dim of dimensions) {
      const scoreA = a[dim] || 0;
      const scoreB = b[dim] || 0;
      dotProduct += scoreA * scoreB;
      normA += scoreA * scoreA;
      normB += scoreB * scoreB;
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    return magnitude > 0 ? dotProduct / magnitude : 0;
  }

  /**
   * Get the best performing baseline from results
   */
  getBestBaseline(results) {
    let best = { algorithm: 'majority', confidence: 0 };

    for (const [algorithm, result] of Object.entries(results)) {
      if (result.confidence > best.confidence) {
        best = { algorithm, ...result };
      }
    }

    return best;
  }

  /**
   * Evaluate all baselines against test data
   */
  async evaluateBaselines(testData) {
    const results = {
      majority: { correct: 0, total: 0, errors: [] },
      popularity: { correct: 0, total: 0, errors: [] },
      exact_overlap: { correct: 0, total: 0, errors: [] },
      demographic_bucket: { correct: 0, total: 0, errors: [] },
      nearest_profile: { correct: 0, total: 0, errors: [] }
    };

    for (const sample of testData) {
      const actualOutcome = this.calculateOutcome(sample);
      const content = {
        id: sample.content_id,
        dimension_scores: sample.dimension_scores
      };

      const predictions = await this.runAllBaselines(content, sample.metadata);

      for (const [algorithm, prediction] of Object.entries(predictions.baseline_predictions)) {
        const predicted = prediction.prediction > 0.5;
        const actual = actualOutcome > 0.1;
        const correct = predicted === actual;

        results[algorithm].correct += correct ? 1 : 0;
        results[algorithm].total += 1;

        if (!correct) {
          results[algorithm].errors.push({
            predicted: prediction.prediction,
            actual: actualOutcome,
            content_id: sample.content_id,
            error: Math.abs(prediction.prediction - actualOutcome)
          });
        }
      }
    }

    // Calculate accuracies
    const evaluation = {};
    for (const [algorithm, stats] of Object.entries(results)) {
      evaluation[algorithm] = {
        accuracy: stats.total > 0 ? stats.correct / stats.total : 0,
        correct: stats.correct,
        total: stats.total,
        avgError: stats.errors.length > 0
          ? stats.errors.reduce((sum, e) => sum + e.error, 0) / stats.errors.length
          : 0
      };
    }

    return {
      evaluation,
      bestBaseline: Object.entries(evaluation).reduce((best, [alg, stats]) =>
        stats.accuracy > best.accuracy ? { algorithm: alg, ...stats } : best
      , { accuracy: 0 })
    };
  }

  /**
   * Generate benchmark comparison report
   */
  generateBenchmarkReport(marbleResults, baselineResults) {
    const report = {
      marble: {
        algorithm: 'marble_calibrated',
        accuracy: marbleResults.accuracy || 0,
        avgError: marbleResults.avgError || 0
      },
      baselines: baselineResults.evaluation,
      comparison: {},
      recommendation: 'unknown'
    };

    // Compare Marble vs each baseline
    for (const [algorithm, stats] of Object.entries(baselineResults.evaluation)) {
      const improvement = report.marble.accuracy - stats.accuracy;
      report.comparison[algorithm] = {
        marbleAdvantage: improvement,
        significantImprovement: improvement > 0.03,
        status: improvement > 0.03 ? 'beats' : improvement > -0.03 ? 'matches' : 'loses'
      };
    }

    // Overall recommendation
    const beatsCount = Object.values(report.comparison).filter(c => c.status === 'beats').length;
    const totalBaselines = Object.keys(report.comparison).length;

    if (beatsCount >= totalBaselines * 0.8) {
      report.recommendation = 'deploy';
    } else if (beatsCount >= totalBaselines * 0.5) {
      report.recommendation = 'needs_improvement';
    } else {
      report.recommendation = 'back_to_training';
    }

    report.summary = {
      beatsBaselines: beatsCount,
      totalBaselines,
      percentBeaten: Math.round((beatsCount / totalBaselines) * 100),
      bestBaseline: baselineResults.bestBaseline.algorithm,
      marbleVsBest: report.marble.accuracy - baselineResults.bestBaseline.accuracy
    };

    return report;
  }
}

// Singleton instance for easy import
export const baselineAlgorithms = new BaselineAlgorithms();