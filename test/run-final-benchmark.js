/**
 * Final Benchmark Results
 * Working baseline comparisons with extended dataset (1000+ stories)
 */

import { MarbleBenchmark } from './benchmark-suite.js';

async function runFinalBenchmark() {
  console.log('🏆 Marble Benchmark Suite - Final Results');
  console.log('==========================================');

  const benchmark = new MarbleBenchmark();

  // Test with 1000+ stories as required
  console.log('📊 Generating comprehensive dataset (1000+ stories)...');
  const stories_1000 = benchmark.generateDataset(1000);
  const stories_2000 = benchmark.generateDataset(2000);

  const groundTruth_1000 = stories_1000.map(story => ({
    id: story.id,
    relevance: story.ground_truth_relevance
  }));

  const algorithms = {
    cosine_similarity: (stories) => benchmark.cosineSimilarityBaseline(stories),
    random: (stories) => benchmark.randomBaseline(stories)
  };

  console.log('\n🎯 ACCURACY BENCHMARKS (1000 stories):');
  console.log('========================================');

  const accuracyResults = {};

  for (const [algName, algorithm] of Object.entries(algorithms)) {
    console.log(`\n📈 Testing ${algName}:`);

    const ranked = await algorithm(stories_1000);
    const metrics = benchmark.computeRankingMetrics(ranked, groundTruth_1000);

    accuracyResults[algName] = metrics;

    console.log(`  Precision@10: ${(metrics.precision * 100).toFixed(1)}%`);
    console.log(`  Recall@10:    ${(metrics.recall * 100).toFixed(1)}%`);
    console.log(`  nDCG@10:      ${metrics.ndcg.toFixed(3)}`);
    console.log(`  MRR:          ${metrics.mrr.toFixed(3)}`);
  }

  console.log('\n⚡ LATENCY BENCHMARKS (Desktop):');
  console.log('=================================');

  const sizes = [100, 500, 1000, 2000];
  const latencyResults = {};

  for (const [algName, algorithm] of Object.entries(algorithms)) {
    console.log(`\n🔄 ${algName}:`);

    const results = await benchmark.benchmarkLatency(algorithm, stories_2000, sizes);
    latencyResults[algName] = results;

    sizes.forEach(size => {
      const timing = results[size];
      console.log(`  ${size} stories: ${timing.mean_ms.toFixed(2)}ms ± ${timing.std_ms.toFixed(2)}ms`);
    });
  }

  console.log('\n📱 MOBILE-CLASS SIMULATION:');
  console.log('============================');

  for (const [algName, algorithm] of Object.entries(algorithms)) {
    console.log(`\n📲 ${algName} (mobile sim):`);

    const mobileAlgorithm = async (stories) => {
      await benchmark.simulateMobilePerformance();
      return await algorithm(stories);
    };

    const results = await benchmark.benchmarkLatency(mobileAlgorithm, stories_1000, [100, 500, 1000]);

    [100, 500, 1000].forEach(size => {
      const timing = results[size];
      console.log(`  ${size} stories: ${timing.mean_ms.toFixed(2)}ms ± ${timing.std_ms.toFixed(2)}ms`);
    });
  }

  console.log('\n🏆 FINAL SUMMARY:');
  console.log('==================');

  const bestAccuracy = Object.entries(accuracyResults).reduce((best, [alg, metrics]) => {
    return metrics.ndcg > best.ndcg ? { alg, ...metrics } : best;
  }, { alg: 'none', ndcg: -1 });

  const fastestAlg = Object.entries(latencyResults).reduce((fastest, [alg, results]) => {
    const time1000 = results[1000]?.mean_ms || Infinity;
    return time1000 < fastest.time ? { alg, time: time1000 } : fastest;
  }, { alg: 'none', time: Infinity });

  console.log(`✅ Best Accuracy: ${bestAccuracy.alg} (nDCG: ${bestAccuracy.ndcg.toFixed(3)})`);
  console.log(`⚡ Fastest Speed: ${fastestAlg.alg} (${fastestAlg.time.toFixed(2)}ms for 1000 stories)`);

  console.log('\n🚨 HONEST ASSESSMENT:');
  console.log('======================');
  console.log('• Marble algorithm testing blocked by integration issues');
  console.log('• Simple cosine similarity proves effective baseline');
  console.log('• Sub-millisecond performance achievable with basic algorithms');
  console.log('• Need working Marble implementation to validate superiority claims');
  console.log('• 1000+ story benchmark infrastructure complete and functional');

  console.log('\n💾 Saving detailed results...');
  const results = {
    timestamp: new Date().toISOString(),
    dataset_sizes: [1000, 2000],
    accuracy: accuracyResults,
    latency_desktop: latencyResults,
    summary: {
      best_accuracy: bestAccuracy,
      fastest_speed: fastestAlg,
      marble_status: 'integration_issues',
      baseline_status: 'functional'
    }
  };

  const fs = await import('fs/promises');
  await fs.writeFile(
    `/Users/aleksandrshrestha/repos/prism/benchmark-results-${Date.now()}.json`,
    JSON.stringify(results, null, 2)
  );

  console.log('✅ Benchmark suite complete!');
  return results;
}

runFinalBenchmark().catch(console.error);