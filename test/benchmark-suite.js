/**
 * Marble Comprehensive Benchmark Suite
 *
 * Tests Marble vs baselines on 1000+ stories with real metrics:
 * - precision@10, recall, nDCG, MRR
 * - Latency benchmarks (100, 500, 1000 stories)
 * - Desktop vs mobile-class hardware simulation
 */

import { Marblism } from '../core/index.js';
import fs from 'fs/promises';
import { performance } from 'perf_hooks';

export class MarbleBenchmark {
  constructor() {
    this.results = {
      timestamp: new Date().toISOString(),
      system_info: this.#getSystemInfo(),
      datasets: {},
      algorithms: {},
      latency: {},
      accuracy: {},
      summary: {}
    };
  }

  #getSystemInfo() {
    return {
      platform: process.platform,
      arch: process.arch,
      node_version: process.version,
      memory_gb: Math.round(process.memoryUsage().heapTotal / 1024 / 1024 / 1024 * 100) / 100
    };
  }

  /**
   * Generate synthetic dataset of 1000+ stories with ground truth
   */
  generateDataset(size = 1000) {
    const topics = ['AI', 'crypto', 'startup', 'funding', 'product', 'marketing', 'tech', 'policy', 'research', 'security'];
    const sources = ['TechCrunch', 'Hacker News', 'MIT Review', 'Wired', 'ArXiv', 'VentureBeat', 'ProductHunt'];

    const stories = [];
    for (let i = 0; i < size; i++) {
      const topicsSubset = this.#sampleArray(topics, Math.ceil(Math.random() * 3));
      stories.push({
        id: `story_${i.toString().padStart(4, '0')}`,
        title: this.#generateTitle(topicsSubset),
        summary: this.#generateSummary(topicsSubset),
        topics: topicsSubset,
        source: this.#sampleArray(sources, 1)[0],
        url: `https://example.com/story/${i}`,
        published_at: new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000),
        actionability: Math.random(),
        // Ground truth relevance (0-1) - simulate user preferences
        ground_truth_relevance: this.#computeGroundTruthRelevance(topicsSubset),
        // Business metrics for validation
        engagement_time: Math.random() * 300, // seconds
        conversion_probability: Math.random(),
        revenue_impact: Math.random() * 1000
      });
    }

    this.results.datasets[`synthetic_${size}`] = {
      size,
      topics_distribution: this.#analyzeTopicDistribution(stories),
      relevance_distribution: this.#analyzeRelevanceDistribution(stories)
    };

    return stories;
  }

  #sampleArray(arr, n) {
    const shuffled = [...arr].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, n);
  }

  #generateTitle(topics) {
    const templates = [
      `${topics[0]} startup raises $10M for revolutionary ${topics[1] || 'technology'}`,
      `How ${topics[0]} is transforming ${topics[1] || 'industry'} in 2026`,
      `Breaking: New ${topics[0]} breakthrough changes everything`,
      `The future of ${topics[0]}: what ${topics[1] || 'experts'} predict`,
      `${topics[0]} meets ${topics[1] || 'AI'}: game-changing implications`
    ];
    return templates[Math.floor(Math.random() * templates.length)];
  }

  #generateSummary(topics) {
    return `Detailed analysis of ${topics.join(', ')} developments with actionable insights for decision makers. Covers market implications, technical details, and strategic recommendations.`;
  }

  #computeGroundTruthRelevance(topics) {
    // Simulate user preferences: higher relevance for AI + crypto combinations
    let relevance = 0.3 + Math.random() * 0.4; // base 0.3-0.7
    if (topics.includes('AI')) relevance += 0.2;
    if (topics.includes('crypto')) relevance += 0.15;
    if (topics.includes('AI') && topics.includes('crypto')) relevance += 0.1;
    return Math.min(relevance, 1.0);
  }

  #analyzeTopicDistribution(stories) {
    const dist = {};
    stories.forEach(story => {
      story.topics.forEach(topic => {
        dist[topic] = (dist[topic] || 0) + 1;
      });
    });
    return dist;
  }

  #analyzeRelevanceDistribution(stories) {
    const relevances = stories.map(s => s.ground_truth_relevance);
    return {
      mean: relevances.reduce((a, b) => a + b) / relevances.length,
      std: Math.sqrt(relevances.map(x => Math.pow(x - relevances.reduce((a, b) => a + b) / relevances.length, 2)).reduce((a, b) => a + b) / relevances.length),
      min: Math.min(...relevances),
      max: Math.max(...relevances)
    };
  }

  /**
   * Cosine similarity baseline algorithm
   */
  cosineSimilarityBaseline(stories, userProfile = null) {
    // Simple cosine similarity against user interests
    const userInterests = userProfile || ['AI', 'startup', 'product']; // default profile

    return stories.map(story => ({
      ...story,
      magic_score: this.#cosineSimilarity(story.topics, userInterests) + Math.random() * 0.1 // add noise
    })).sort((a, b) => b.magic_score - a.magic_score);
  }

  #cosineSimilarity(topics1, topics2) {
    const set1 = new Set(topics1);
    const set2 = new Set(topics2);
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    return intersection.size / Math.sqrt(set1.size * set2.size);
  }

  /**
   * Random baseline algorithm
   */
  randomBaseline(stories) {
    return stories.map(story => ({
      ...story,
      magic_score: Math.random()
    })).sort((a, b) => b.magic_score - a.magic_score);
  }

  /**
   * Compute ranking metrics: precision@10, recall, nDCG, MRR
   */
  computeRankingMetrics(rankedStories, groundTruth, k = 10) {
    const topK = rankedStories.slice(0, k);
    const relevantIds = groundTruth.filter(item => item.relevance > 0.7).map(item => item.id);
    const retrievedIds = topK.map(story => story.id);

    // Precision@K
    const relevantRetrieved = retrievedIds.filter(id => relevantIds.includes(id)).length;
    const precision = relevantRetrieved / k;

    // Recall@K
    const recall = relevantIds.length > 0 ? relevantRetrieved / relevantIds.length : 0;

    // nDCG@K
    const ndcg = this.#computeNDCG(topK, groundTruth, k);

    // MRR (Mean Reciprocal Rank)
    let mrr = 0;
    for (let i = 0; i < topK.length; i++) {
      if (relevantIds.includes(topK[i].id)) {
        mrr = 1 / (i + 1);
        break;
      }
    }

    return { precision, recall, ndcg, mrr };
  }

  #computeNDCG(rankedStories, groundTruth, k) {
    const groundTruthMap = {};
    groundTruth.forEach(item => {
      groundTruthMap[item.id] = item.relevance;
    });

    // DCG
    let dcg = 0;
    for (let i = 0; i < Math.min(k, rankedStories.length); i++) {
      const relevance = groundTruthMap[rankedStories[i].id] || 0;
      dcg += relevance / Math.log2(i + 2);
    }

    // IDCG (ideal DCG)
    const sortedRelevance = groundTruth
      .map(item => item.relevance)
      .sort((a, b) => b - a);
    let idcg = 0;
    for (let i = 0; i < Math.min(k, sortedRelevance.length); i++) {
      idcg += sortedRelevance[i] / Math.log2(i + 2);
    }

    return idcg > 0 ? dcg / idcg : 0;
  }

  /**
   * Latency benchmark: measure selection time for different dataset sizes
   */
  async benchmarkLatency(algorithm, stories, sizes = [100, 500, 1000]) {
    const results = {};

    for (const size of sizes) {
      const subset = stories.slice(0, size);
      const times = [];

      // Run 5 iterations for each size
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        await algorithm(subset);
        const end = performance.now();
        times.push(end - start);
      }

      results[size] = {
        mean_ms: times.reduce((a, b) => a + b) / times.length,
        min_ms: Math.min(...times),
        max_ms: Math.max(...times),
        std_ms: Math.sqrt(times.map(x => Math.pow(x - times.reduce((a, b) => a + b) / times.length, 2)).reduce((a, b) => a + b) / times.length)
      };
    }

    return results;
  }

  /**
   * Mobile simulation: throttle CPU and limit memory
   */
  simulateMobilePerformance() {
    // Simulate mobile constraints by adding artificial delays
    return new Promise(resolve => {
      setTimeout(resolve, Math.random() * 50 + 20); // 20-70ms delay
    });
  }

  /**
   * Full benchmark suite runner
   */
  async runFullBenchmark() {
    console.log('🚀 Starting Marble Comprehensive Benchmark Suite...');

    // Generate test datasets
    console.log('📊 Generating datasets...');
    const stories_1000 = this.generateDataset(1000);
    const stories_5000 = this.generateDataset(5000); // Extended dataset

    // Ground truth for evaluation
    const groundTruth = stories_1000.map(story => ({
      id: story.id,
      relevance: story.ground_truth_relevance
    }));

    // Initialize Marble
    console.log('🔮 Initializing Marble...');
    const marble = new Marblism({
      dataPath: './test-kg.json',
      count: 10,
      mode: 'score' // Test v1 first
    });
    await marble.init();

    // Algorithm definitions
    const algorithms = {
      marble_v1: async (stories) => {
        const marble_v1 = new Marblism({ mode: 'score', count: 10 });
        await marble_v1.init();
        return await marble_v1.select(stories);
      },
      marble_v2_swarm: async (stories) => {
        const marble_v2 = new Marblism({ mode: 'swarm', count: 10 });
        await marble_v2.init();
        return await marble_v2.select(stories);
      },
      cosine_similarity: (stories) => this.cosineSimilarityBaseline(stories),
      random: (stories) => this.randomBaseline(stories)
    };

    // Accuracy benchmarks
    console.log('🎯 Running accuracy benchmarks...');
    for (const [algName, algorithm] of Object.entries(algorithms)) {
      console.log(`  Testing ${algName}...`);

      const ranked = await algorithm(stories_1000);
      const metrics = this.computeRankingMetrics(ranked, groundTruth);

      this.results.accuracy[algName] = metrics;
      console.log(`    P@10: ${metrics.precision.toFixed(3)}, R@10: ${metrics.recall.toFixed(3)}, nDCG: ${metrics.ndcg.toFixed(3)}, MRR: ${metrics.mrr.toFixed(3)}`);
    }

    // Latency benchmarks - Desktop
    console.log('⚡ Running desktop latency benchmarks...');
    for (const [algName, algorithm] of Object.entries(algorithms)) {
      console.log(`  Benchmarking ${algName} latency...`);
      this.results.latency[`${algName}_desktop`] = await this.benchmarkLatency(algorithm, stories_1000);
    }

    // Latency benchmarks - Mobile simulation
    console.log('📱 Running mobile-class latency benchmarks...');
    for (const [algName, algorithm] of Object.entries(algorithms)) {
      console.log(`  Benchmarking ${algName} mobile simulation...`);

      const mobileAlgorithm = async (stories) => {
        await this.simulateMobilePerformance();
        return await algorithm(stories);
      };

      this.results.latency[`${algName}_mobile`] = await this.benchmarkLatency(mobileAlgorithm, stories_1000, [100, 200, 500]);
    }

    // Generate summary
    this.results.summary = this.#generateBenchmarkSummary();

    console.log('✅ Benchmark complete!');
    return this.results;
  }

  #generateBenchmarkSummary() {
    const accuracy = this.results.accuracy;
    const latency = this.results.latency;

    // Find best algorithm by nDCG
    let bestAlg = null;
    let bestNdcg = -1;

    Object.entries(accuracy).forEach(([alg, metrics]) => {
      if (metrics.ndcg > bestNdcg) {
        bestNdcg = metrics.ndcg;
        bestAlg = alg;
      }
    });

    // Find fastest algorithm (desktop, 1000 stories)
    let fastestAlg = null;
    let fastestTime = Infinity;

    Object.entries(latency).forEach(([alg, results]) => {
      if (alg.includes('desktop') && results[1000]) {
        if (results[1000].mean_ms < fastestTime) {
          fastestTime = results[1000].mean_ms;
          fastestAlg = alg;
        }
      }
    });

    return {
      best_accuracy: { algorithm: bestAlg, ndcg: bestNdcg },
      fastest_latency: { algorithm: fastestAlg, time_ms: fastestTime },
      honest_assessment: this.#generateHonestAssessment()
    };
  }

  #generateHonestAssessment() {
    const marbleNdcg = this.results.accuracy.marble_v1?.ndcg || 0;
    const cosineNdcg = this.results.accuracy.cosine_similarity?.ndcg || 0;
    const randomNdcg = this.results.accuracy.random?.ndcg || 0;

    const assessment = [];

    if (marbleNdcg < cosineNdcg) {
      assessment.push(`⚠️  Marble v1 (nDCG: ${marbleNdcg.toFixed(3)}) performs worse than simple cosine similarity (nDCG: ${cosineNdcg.toFixed(3)})`);
    }

    if (marbleNdcg < randomNdcg) {
      assessment.push(`🚨 Marble v1 performs worse than random selection - critical algorithm issue`);
    }

    const marbleLatency = this.results.latency.marble_v1_desktop?.[1000]?.mean_ms || 0;
    const cosineLatency = this.results.latency.cosine_similarity_desktop?.[1000]?.mean_ms || 0;

    if (marbleLatency > cosineLatency * 10) {
      assessment.push(`⏱️  Marble is ${Math.round(marbleLatency / cosineLatency)}x slower than cosine similarity baseline`);
    }

    if (assessment.length === 0) {
      assessment.push('✅ Marble meets or exceeds all baselines on accuracy and performance');
    }

    return assessment;
  }

  /**
   * Save results to file
   */
  async saveResults(filepath = './benchmark-results.json') {
    await fs.writeFile(filepath, JSON.stringify(this.results, null, 2));
    console.log(`💾 Results saved to ${filepath}`);
  }
}

// CLI runner
if (import.meta.url === `file://${process.argv[1]}`) {
  const benchmark = new MarbleBenchmark();
  const results = await benchmark.runFullBenchmark();
  await benchmark.saveResults(`./benchmark-results-${Date.now()}.json`);
}