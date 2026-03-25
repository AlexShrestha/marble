/**
 * Quick Accuracy Benchmark
 * Tests ranking metrics only (30 seconds)
 */

import { MarbleBenchmark } from './benchmark-suite.js';

async function runQuickAccuracyTest() {
  console.log('🎯 Quick Accuracy Benchmark');

  const benchmark = new MarbleBenchmark();

  // Generate smaller dataset for speed
  console.log('📊 Generating test dataset (500 stories)...');
  const stories = benchmark.generateDataset(500);

  const groundTruth = stories.map(story => ({
    id: story.id,
    relevance: story.ground_truth_relevance
  }));

  // Test algorithms
  const algorithms = {
    cosine_similarity: (stories) => benchmark.cosineSimilarityBaseline(stories),
    random: (stories) => benchmark.randomBaseline(stories)
  };

  console.log('🔮 Testing algorithms...');
  for (const [algName, algorithm] of Object.entries(algorithms)) {
    console.log(`  Testing ${algName}...`);

    const ranked = await algorithm(stories);
    const metrics = benchmark.computeRankingMetrics(ranked, groundTruth);

    console.log(`    Precision@10: ${metrics.precision.toFixed(3)}`);
    console.log(`    Recall@10: ${metrics.recall.toFixed(3)}`);
    console.log(`    nDCG@10: ${metrics.ndcg.toFixed(3)}`);
    console.log(`    MRR: ${metrics.mrr.toFixed(3)}`);
    console.log('');
  }

  console.log('✅ Quick accuracy test complete!');
}

runQuickAccuracyTest().catch(console.error);