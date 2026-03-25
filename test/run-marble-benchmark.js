/**
 * Marble Algorithm Benchmark
 * Tests actual Marble performance vs baselines (2 minutes)
 */

import { MarbleBenchmark } from './benchmark-suite.js';
import { Marblism } from '../core/index.js';

async function runMarbleBenchmark() {
  console.log('🔮 Marble Algorithm Benchmark');

  const benchmark = new MarbleBenchmark();

  // Generate test dataset
  console.log('📊 Generating test dataset (500 stories)...');
  const stories = benchmark.generateDataset(500);

  const groundTruth = stories.map(story => ({
    id: story.id,
    relevance: story.ground_truth_relevance
  }));

  // Initialize minimal Marble instance
  console.log('🔮 Initializing Marble...');

  try {
    // Create minimal KG for testing
    const testKgPath = '/tmp/test-marble-kg.json';
    const minimalKg = {
      user: {
        interests: ['AI', 'crypto', 'startup'],
        context: {},
        history: []
      },
      reactions: [],
      relationships: {},
      projects: [],
      version: '1.0'
    };

    const fs = await import('fs/promises');
    await fs.writeFile(testKgPath, JSON.stringify(minimalKg, null, 2));

    const marble = new Marblism({
      dataPath: testKgPath,
      count: 10,
      mode: 'score'
    });

    await marble.init();
    console.log('✅ Marble initialized successfully');

    // Test algorithms including Marble
    const algorithms = {
      marble: async (stories) => await marble.select(stories),
      cosine_similarity: (stories) => benchmark.cosineSimilarityBaseline(stories),
      random: (stories) => benchmark.randomBaseline(stories)
    };

    console.log('🏆 Accuracy Comparison:');
    for (const [algName, algorithm] of Object.entries(algorithms)) {
      console.log(`  Testing ${algName}...`);

      const start = performance.now();
      const ranked = await algorithm(stories);
      const end = performance.now();

      const metrics = benchmark.computeRankingMetrics(ranked, groundTruth);

      console.log(`    Precision@10: ${metrics.precision.toFixed(3)}`);
      console.log(`    Recall@10: ${metrics.recall.toFixed(3)}`);
      console.log(`    nDCG@10: ${metrics.ndcg.toFixed(3)}`);
      console.log(`    MRR: ${metrics.mrr.toFixed(3)}`);
      console.log(`    Latency: ${(end - start).toFixed(2)}ms`);
      console.log('');
    }

    console.log('📊 Latency Comparison:');
    const latencyResults = await benchmark.benchmarkLatency(algorithms.marble, stories, [100, 250, 500]);
    Object.entries(latencyResults).forEach(([size, timing]) => {
      console.log(`  Marble ${size} stories: ${timing.mean_ms.toFixed(2)}ms ± ${timing.std_ms.toFixed(2)}ms`);
    });

    // Cleanup
    await fs.unlink(testKgPath);

  } catch (error) {
    console.error('❌ Marble test failed:', error.message);
    console.log('📊 Falling back to baseline comparison only...');

    const algorithms = {
      cosine_similarity: (stories) => benchmark.cosineSimilarityBaseline(stories),
      random: (stories) => benchmark.randomBaseline(stories)
    };

    for (const [algName, algorithm] of Object.entries(algorithms)) {
      const ranked = await algorithm(stories);
      const metrics = benchmark.computeRankingMetrics(ranked, groundTruth);

      console.log(`${algName}: P@10=${metrics.precision.toFixed(3)}, nDCG=${metrics.ndcg.toFixed(3)}`);
    }
  }

  console.log('✅ Marble benchmark complete!');
}

runMarbleBenchmark().catch(console.error);