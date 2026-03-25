/**
 * Latency-Only Benchmark
 * Tests selection speed on different dataset sizes (1 minute)
 */

import { MarbleBenchmark } from './benchmark-suite.js';

async function runLatencyTest() {
  console.log('⚡ Latency Benchmark');

  const benchmark = new MarbleBenchmark();

  // Generate test dataset
  console.log('📊 Generating test dataset (1000 stories)...');
  const stories = benchmark.generateDataset(1000);

  // Test algorithms (excluding Marble for now to avoid init issues)
  const algorithms = {
    cosine_similarity: (stories) => benchmark.cosineSimilarityBaseline(stories),
    random: (stories) => benchmark.randomBaseline(stories)
  };

  console.log('🔮 Running latency benchmarks...');
  for (const [algName, algorithm] of Object.entries(algorithms)) {
    console.log(`  Benchmarking ${algName}...`);

    const results = await benchmark.benchmarkLatency(algorithm, stories, [100, 500, 1000]);

    Object.entries(results).forEach(([size, timing]) => {
      console.log(`    ${size} stories: ${timing.mean_ms.toFixed(2)}ms ± ${timing.std_ms.toFixed(2)}ms`);
    });
    console.log('');
  }

  console.log('✅ Latency benchmark complete!');
}

runLatencyTest().catch(console.error);