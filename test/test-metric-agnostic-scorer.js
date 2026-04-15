/**
 * Tests for Metric-Agnostic Scoring Engine
 *
 * Tests the core functionality: startup-defined metrics, auto-tuning weights,
 * calibration API, and backward compatibility.
 */

import { MetricConfig, MetricAgnosticScoringEngine, METRIC_DEFINITIONS } from '../core/metric-agnostic-scorer.js';
import { CalibrationAPI, EXAMPLE_CONFIGS, EXAMPLE_OUTCOME_DATA } from '../core/calibration-api.js';

async function runTests() {
  console.log('🧪 Testing Metric-Agnostic Scoring Engine\n');

  try {
    // Test 1: MetricConfig Creation and Validation
    await testMetricConfig();

    // Test 2: Metric-Agnostic Scoring
    await testMetricAgnosticScoring();

    // Test 3: Calibration API
    await testCalibrationAPI();

    // Test 4: Weight Auto-tuning
    await testWeightAutoTuning();

    // Test 5: Backward Compatibility
    await testBackwardCompatibility();

    // Test 6: Export Functionality
    await testExportFunctionality();

    console.log('\n✅ All tests passed! Metric-agnostic scoring system is working.');

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

async function testMetricConfig() {
  console.log('1️⃣ Testing MetricConfig...');

  // Valid config
  const config = new MetricConfig({
    startupId: 'test_startup',
    useCase: 'email_campaigns',
    primaryMetrics: ['conversion_rate', 'revenue'],
    secondaryMetrics: ['dwell_time', 'share_rate']
  });

  const validation = config.validate();
  if (!validation.isValid) {
    throw new Error(`Config validation failed: ${validation.errors.join(', ')}`);
  }

  // Check metric-optimized weights
  if (!config.weights.actionability || config.weights.actionability < 0.1) {
    throw new Error('Actionability weight should be boosted for conversion_rate metric');
  }

  // Test custom metric
  config.addCustomMetric('custom_engagement', {
    type: 'secondary',
    weight: 0.8,
    dimensions: ['interest_match', 'novelty'],
    correlationFactors: { interest_match: 0.7, novelty: 0.3 }
  });

  if (!config.customMetrics.custom_engagement) {
    throw new Error('Custom metric not added properly');
  }

  console.log('   ✅ MetricConfig creation and validation works');
}

async function testMetricAgnosticScoring() {
  console.log('2️⃣ Testing Metric-Agnostic Scoring...');

  const config = new MetricConfig(EXAMPLE_CONFIGS.email_campaigns);
  const engine = new MetricAgnosticScoringEngine(config);

  const testContent = {
    id: 'test_content_1',
    title: 'Revolutionary AI Tool Launch - Limited Time Offer',
    summary: 'New breakthrough tool that transforms productivity. Download now while free!',
    source: 'techcrunch',
    topics: ['AI', 'productivity', 'tools'],
    published_at: new Date(Date.now() - 2 * 60 * 60 * 1000) // 2 hours ago
  };

  const result = await engine.scoreContent(testContent, {
    userContext: {
      interests: ['AI', 'productivity'],
      activeProjects: ['tool evaluation']
    }
  });

  // Check result structure
  const requiredFields = [
    'magic_score', 'dimension_scores', 'metric_predictions',
    'startup_id', 'target_metrics', 'calibration_confidence'
  ];

  for (const field of requiredFields) {
    if (!(field in result)) {
      throw new Error(`Missing required field: ${field}`);
    }
  }

  // Check metric predictions
  if (!result.metric_predictions.conversion_rate || !result.metric_predictions.revenue) {
    throw new Error('Missing primary metric predictions');
  }

  if (result.metric_predictions.conversion_rate.expected_delta < 0) {
    throw new Error('Expected positive conversion prediction for actionable content');
  }

  console.log('   ✅ Metric-agnostic scoring produces valid results');
}

async function testCalibrationAPI() {
  console.log('3️⃣ Testing Calibration API...');

  const api = new CalibrationAPI();

  // Register startup
  const registration = await api.registerStartup('test_startup', EXAMPLE_CONFIGS.email_campaigns);

  if (registration.startup_id !== 'test_startup') {
    throw new Error('Startup registration failed');
  }

  // Submit outcome data
  const outcomeResult = await api.submitOutcome('test_startup', EXAMPLE_OUTCOME_DATA);

  if (!outcomeResult || outcomeResult.length === 0) {
    throw new Error('Outcome submission failed');
  }

  // Check calibration status
  const status = await api.getCalibrationStatus('test_startup');

  if (status.calibrations_processed === 0) {
    throw new Error('Calibration not processed');
  }

  // Test batch submission
  const batchData = [
    { ...EXAMPLE_OUTCOME_DATA, content_id: 'batch_1' },
    { ...EXAMPLE_OUTCOME_DATA, content_id: 'batch_2', actual_metrics: { conversion_rate: 0.15, revenue: 2000, dwell_time: 200 } }
  ];

  const batchResult = await api.submitOutcomeBatch('test_startup', batchData);

  if (batchResult.successful !== 2) {
    throw new Error(`Batch processing failed: ${batchResult.successful}/2 successful`);
  }

  console.log('   ✅ Calibration API working properly');
}

async function testWeightAutoTuning() {
  console.log('4️⃣ Testing Weight Auto-tuning...');

  const config = new MetricConfig({
    startupId: 'tuning_test',
    primaryMetrics: ['conversion_rate'],
    secondaryMetrics: ['dwell_time'],
    learningRate: 0.2 // Higher learning rate for faster testing
  });

  const engine = new MetricAgnosticScoringEngine(config);

  // Get initial weights
  const initialWeights = { ...config.weights };

  // Simulate multiple positive outcomes that should boost actionability weight
  // Need 15+ samples for auto-tuning to kick in
  for (let i = 1; i <= 16; i++) {
    await engine.calibrateFromOutcomes({
      content_id: `tuning_test_${i}`,
      dimension_scores: {
        actionability: 0.9, // High actionability
        interest_match: 0.5,
        trust_indicators: 0.6
      },
      actual_metrics: {
        conversion_rate: 0.20 // Strong conversion
      },
      baseline_metrics: {
        conversion_rate: 0.08 // Weak baseline
      }
    });
  }

  // Check if actionability weight increased
  const newWeights = engine.engine.weights.getCurrentWeights();

  if (newWeights.actionability <= initialWeights.actionability) {
    throw new Error(`Actionability weight should have increased: ${initialWeights.actionability} -> ${newWeights.actionability}`);
  }

  console.log('   ✅ Weight auto-tuning works correctly');
}

async function testBackwardCompatibility() {
  console.log('5️⃣ Testing Backward Compatibility...');

  // Test that existing Scorer still works with legacy mode
  const { Scorer } = await import('./scorer.js');

  // Mock KG for testing
  const mockKG = {
    getInterestWeight: () => 0.7,
    getSourceTrust: () => 0.8,
    hasSeen: () => false,
    user: {
      context: {
        active_projects: ['test project'],
        calendar: ['meeting about AI'],
        recent_conversations: ['productivity tools']
      },
      history: []
    }
  };

  const legacyScorer = new Scorer(mockKG);

  const testStory = {
    id: 'legacy_test',
    title: 'Test AI productivity meeting',
    summary: 'Relevant to user context',
    source: 'hackernews',
    topics: ['AI', 'productivity'],
    published_at: new Date()
  };

  const legacyResult = await legacyScorer.score([testStory]);

  if (!legacyResult || legacyResult.length === 0) {
    throw new Error('Legacy scoring failed');
  }

  if (!legacyResult[0].magic_score || legacyResult[0].magic_score <= 0) {
    throw new Error('Legacy scoring produced invalid magic_score');
  }

  console.log('   ✅ Backward compatibility maintained');
}

async function testExportFunctionality() {
  console.log('6️⃣ Testing Export Functionality...');

  const config = new MetricConfig({
    startupId: 'export_test',
    primaryMetrics: ['conversion_rate', 'revenue'],
    secondaryMetrics: ['dwell_time']
  });

  const engine = new MetricAgnosticScoringEngine(config);

  // Add some calibration data
  await engine.calibrateFromOutcomes({
    content_id: 'export_test_1',
    dimension_scores: {
      actionability: 0.8,
      interest_match: 0.7,
      trust_indicators: 0.9
    },
    actual_metrics: {
      conversion_rate: 0.15,
      revenue: 1800,
      dwell_time: 160
    },
    baseline_metrics: {
      conversion_rate: 0.10,
      revenue: 1200,
      dwell_time: 120
    }
  });

  // Test export functionality
  const exportedData = engine.exportCalibrationData();

  // Validate exported data structure
  const requiredFields = ['config', 'calibration_history', 'performance_summary'];
  for (const field of requiredFields) {
    if (!(field in exportedData)) {
      throw new Error(`Export missing required field: ${field}`);
    }
  }

  // Validate config export
  if (exportedData.config.startupId !== 'export_test') {
    throw new Error('Config not exported correctly');
  }

  // Validate calibration history export
  if (!Array.isArray(exportedData.calibration_history)) {
    throw new Error('Calibration history should be an array');
  }

  if (exportedData.calibration_history.length === 0) {
    throw new Error('Should have exported calibration history');
  }

  // Validate performance summary export
  if (!exportedData.performance_summary.startup_id) {
    throw new Error('Performance summary missing startup_id');
  }

  if (!exportedData.performance_summary.performance) {
    throw new Error('Performance summary missing performance data');
  }

  // Test that export data can be serialized (important for actual export functionality)
  try {
    const serialized = JSON.stringify(exportedData);
    const parsed = JSON.parse(serialized);

    if (parsed.config.startupId !== 'export_test') {
      throw new Error('Export data not properly serializable');
    }
  } catch (error) {
    throw new Error(`Export data serialization failed: ${error.message}`);
  }

  // Test CalibrationAPI export functionality too
  const api = new CalibrationAPI();
  api.registerStartup('api_export_test', {
    primaryMetrics: ['revenue'],
    secondaryMetrics: ['dwell_time']
  });

  // Test exportStartupData method
  const apiExportData = api.exportStartupData('api_export_test');

  if (!apiExportData || !apiExportData.config) {
    throw new Error('CalibrationAPI export failed');
  }

  if (apiExportData.config.startupId !== 'api_export_test') {
    throw new Error('CalibrationAPI export data incorrect');
  }

  // Test export data size limits (should only export last 100 calibrations)
  const manyCalibrations = [];
  for (let i = 0; i < 150; i++) {
    await engine.calibrateFromOutcomes({
      content_id: `bulk_test_${i}`,
      dimension_scores: { actionability: 0.5 + (i % 50) / 100 },
      actual_metrics: { conversion_rate: 0.1 + (i % 20) / 200 },
      baseline_metrics: { conversion_rate: 0.08 }
    });
  }

  const bulkExportData = engine.exportCalibrationData();
  if (bulkExportData.calibration_history.length > 100) {
    throw new Error(`Export should limit to 100 calibrations, got ${bulkExportData.calibration_history.length}`);
  }

  // Test export with empty calibration history
  const emptyEngine = new MetricAgnosticScoringEngine(
    new MetricConfig({ startupId: 'empty_test', primaryMetrics: ['revenue'] })
  );

  const emptyExportData = emptyEngine.exportCalibrationData();
  if (emptyExportData.calibration_history.length !== 0) {
    throw new Error('Empty engine should export empty calibration history');
  }

  console.log('   ✅ Export functionality working properly');
}

// Performance test
async function testPerformance() {
  console.log('⚡ Testing Performance...');

  const config = new MetricConfig(EXAMPLE_CONFIGS.content_platform);
  const engine = new MetricAgnosticScoringEngine(config);

  const testContent = {
    id: 'perf_test',
    title: 'Performance test content',
    summary: 'Testing scoring performance',
    source: 'test',
    topics: ['test'],
    published_at: new Date()
  };

  const iterations = 100;
  const startTime = Date.now();

  for (let i = 0; i < iterations; i++) {
    await engine.scoreContent({ ...testContent, id: `perf_test_${i}` });
  }

  const endTime = Date.now();
  const avgTime = (endTime - startTime) / iterations;

  if (avgTime > 50) { // Should be under 50ms per scoring on average
    console.warn(`   ⚠️ Performance warning: ${avgTime.toFixed(2)}ms average per scoring`);
  } else {
    console.log(`   ✅ Performance good: ${avgTime.toFixed(2)}ms average per scoring`);
  }
}

// Helper function to demonstrate usage
export function demonstrateUsage() {
  console.log('\n🎯 Usage Example:');
  console.log(`
// 1. Register your startup with target metrics
import { calibrationAPI } from '../core/calibration-api.js';

const myConfig = {
  startupId: 'my_startup',
  useCase: 'email_campaigns',
  primaryMetrics: ['conversion_rate', 'revenue'],
  secondaryMetrics: ['dwell_time', 'share_rate']
};

calibrationAPI.registerStartup('my_startup', myConfig);

// 2. Score content
const content = {
  title: 'Your content title',
  summary: 'Content summary...',
  // ... other fields
};

const scoringResult = await calibrationAPI.scoreForStartup('my_startup', content);
console.log('Score:', scoringResult.magic_score);
console.log('Revenue prediction:', scoringResult.metric_predictions.revenue);

// 3. Submit business outcomes for calibration
const outcomeData = {
  content_id: 'your_content_id',
  dimension_scores: scoringResult.dimension_scores,
  actual_metrics: {
    conversion_rate: 0.15,  // Your actual results
    revenue: 2500
  },
  baseline_metrics: {
    conversion_rate: 0.08,  // Control group results
    revenue: 1200
  }
};

await calibrationAPI.submitOutcome('my_startup', outcomeData);

// 4. System automatically tunes weights for better predictions!
`);
}

// Run tests if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  await runTests();
  await testPerformance();
  demonstrateUsage();
}