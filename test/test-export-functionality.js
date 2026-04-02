/**
 * Standalone test for Export Functionality refinements
 * Tests all export-related features in the metric-agnostic scoring system
 */

import { MetricConfig, MetricAgnosticScoringEngine } from './metric-agnostic-scorer.js';
import { CalibrationAPI } from './calibration-api.js';

async function testExportFunctionalities() {
  console.log('🧪 Testing Export Functionality Refinements\n');

  try {
    // Test 1: Basic export functionality
    console.log('1️⃣ Testing basic export...');
    const config = new MetricConfig({
      startupId: 'export_test_basic',
      primaryMetrics: ['revenue', 'conversion_rate'],
      secondaryMetrics: ['dwell_time', 'share_rate']
    });

    const engine = new MetricAgnosticScoringEngine(config);

    // Add some calibration data
    await engine.calibrateFromOutcomes({
      content_id: 'export_basic_1',
      dimension_scores: {
        actionability: 0.8,
        interest_match: 0.7,
        trust_indicators: 0.9
      },
      actual_metrics: {
        revenue: 1500,
        conversion_rate: 0.12,
        dwell_time: 180
      },
      baseline_metrics: {
        revenue: 1000,
        conversion_rate: 0.08,
        dwell_time: 120
      }
    });

    const exportData = engine.exportCalibrationData();
    console.log('   ✅ Basic export completed');
    console.log('   ✅ Export contains:', Object.keys(exportData));

    // Test 2: Export data structure validation
    console.log('\n2️⃣ Testing export data structure...');
    const requiredFields = ['config', 'calibration_history', 'performance_summary'];
    for (const field of requiredFields) {
      if (!(field in exportData)) {
        throw new Error(`Export missing required field: ${field}`);
      }
    }

    if (exportData.calibration_history.length !== 1) {
      throw new Error(`Expected 1 calibration record, got ${exportData.calibration_history.length}`);
    }

    if (!exportData.performance_summary.startup_id) {
      throw new Error('Performance summary missing startup_id');
    }

    console.log('   ✅ Export structure validation passed');

    // Test 3: CalibrationAPI export
    console.log('\n3️⃣ Testing CalibrationAPI export...');
    const api = new CalibrationAPI();
    api.registerStartup('api_export_test', {
      primaryMetrics: ['conversion_rate'],
      secondaryMetrics: ['dwell_time']
    });

    // Add some data
    await api.submitOutcome('api_export_test', {
      content_id: 'api_test_1',
      dimension_scores: { actionability: 0.75 },
      actual_metrics: { conversion_rate: 0.15 },
      baseline_metrics: { conversion_rate: 0.10 }
    });

    const apiExportData = api.exportStartupData('api_export_test');
    if (!apiExportData.config || apiExportData.config.startupId !== 'api_export_test') {
      throw new Error('CalibrationAPI export failed');
    }

    console.log('   ✅ CalibrationAPI export working');

    // Test 4: Export size limits (100 calibrations max)
    console.log('\n4️⃣ Testing export size limits...');
    for (let i = 0; i < 120; i++) {
      await engine.calibrateFromOutcomes({
        content_id: `bulk_${i}`,
        dimension_scores: { actionability: 0.5 + (i % 50) / 100 },
        actual_metrics: { revenue: 1000 + i * 10 },
        baseline_metrics: { revenue: 1000 }
      });
    }

    const bulkExportData = engine.exportCalibrationData();
    if (bulkExportData.calibration_history.length > 100) {
      throw new Error(`Export should limit to 100, got ${bulkExportData.calibration_history.length}`);
    }

    console.log('   ✅ Export size limits working correctly');

    // Test 5: Export serialization
    console.log('\n5️⃣ Testing export serialization...');
    const serialized = JSON.stringify(exportData);
    const parsed = JSON.parse(serialized);

    if (parsed.config.startupId !== config.startupId) {
      throw new Error('Export serialization failed');
    }

    console.log('   ✅ Export data properly serializable');

    // Test 6: Empty export handling
    console.log('\n6️⃣ Testing empty export handling...');
    const emptyEngine = new MetricAgnosticScoringEngine(
      new MetricConfig({
        startupId: 'empty_test',
        primaryMetrics: ['revenue']
      })
    );

    const emptyExportData = emptyEngine.exportCalibrationData();
    if (emptyExportData.calibration_history.length !== 0) {
      throw new Error('Empty engine should export empty calibration history');
    }

    console.log('   ✅ Empty export handling works');

    console.log('\n✅ All export functionality tests passed!');
    console.log('\n📊 Export Test Summary:');
    console.log(`   - Basic export: ✅`);
    console.log(`   - Structure validation: ✅`);
    console.log(`   - CalibrationAPI export: ✅`);
    console.log(`   - Size limits (max 100): ✅`);
    console.log(`   - JSON serialization: ✅`);
    console.log(`   - Empty export handling: ✅`);

    return { success: true };

  } catch (error) {
    console.error('\n❌ Export functionality test failed:', error.message);
    console.error(error.stack);
    return { success: false, error: error.message };
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  await testExportFunctionalities();
}

export { testExportFunctionalities };