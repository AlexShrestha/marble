/**
 * Simple test for MetricDrivenScoringEngine
 * Tests core functionality without full KG dependencies
 */

import { MetricDrivenScoringEngine } from '../enterprise/metric-driven-scoring-engine.js';
import { USE_CASE_PROFILES } from '../core/use-case-profiles.js';

async function testMetricDrivenScoringEngine() {
  console.log('🧪 Testing MetricDrivenScoringEngine...');

  const config = {
    useCase: 'email_campaigns',
    targetMetrics: ['reply_rate'],
    initialWeights: USE_CASE_PROFILES.email_campaigns.weights
  };

  const engine = new MetricDrivenScoringEngine(config);

  const emailContent = {
    title: 'Personalized outreach for your startup growth',
    summary: 'Time-sensitive opportunity to improve your customer acquisition',
    source: 'direct',
    context: { urgency: 'high', personalization: 'deep' }
  };

  console.log('\n📊 Initial scoring...');
  const score = await engine.scoreContent(emailContent);

  console.log('Score result:', {
    magic_score: score.magic_score.toFixed(3),
    business_predictions: score.business_predictions,
    confidence: score.confidence.toFixed(3),
    reasoning: score.reasoning,
    current_weights: Object.entries(score.current_weights)
      .map(([k, v]) => `${k}: ${v.toFixed(2)}`)
      .join(', ')
  });

  console.log('\n🎯 Simulating outcomes and calibration...');

  // Simulate successful outcome
  const validationData = [{
    dimensionScores: score.dimension_scores,
    actualMetrics: { reply_rate: 0.23 }, // 23% reply rate (good!)
    baseline: { reply_rate: 0.12 }       // 12% baseline
  }];

  const calibrationSummary = await engine.calibrateFromOutcomes(validationData);

  console.log('Calibration summary:', {
    validationsProcessed: calibrationSummary.validationsProcessed,
    averageImprovement: `${(calibrationSummary.averageImprovement * 100).toFixed(1)}%`,
    confidence: calibrationSummary.confidence.toFixed(3),
    weightChanges: calibrationSummary.weightChanges
  });

  console.log('\n📈 Testing another content item...');

  const secondContent = {
    title: 'Generic marketing template',
    summary: 'Standard email template for cold outreach',
    source: 'template'
  };

  const secondScore = await engine.scoreContent(secondContent);

  console.log('Second score (should be lower):', {
    magic_score: secondScore.magic_score.toFixed(3),
    reasoning: secondScore.reasoning,
    improvement_vs_first: ((secondScore.magic_score - score.magic_score) * 100).toFixed(1) + '%'
  });

  return {
    success: true,
    firstScore: score.magic_score,
    secondScore: secondScore.magic_score,
    calibrationImprovement: calibrationSummary.averageImprovement
  };
}

// Test different use cases
async function testMultipleUseCases() {
  console.log('\n🔄 Testing Multiple Use Cases...');

  const useCases = ['email_campaigns', 'content_curation', 'sales_leads'];
  const results = {};

  for (const useCase of useCases) {
    const config = {
      useCase,
      targetMetrics: Object.keys(USE_CASE_PROFILES[useCase].weights),
      initialWeights: USE_CASE_PROFILES[useCase].weights
    };

    const engine = new MetricDrivenScoringEngine(config);
    const testContent = {
      title: `Test content for ${useCase}`,
      summary: 'Sample content to test scoring differences'
    };

    const score = await engine.scoreContent(testContent);
    results[useCase] = {
      score: score.magic_score.toFixed(3),
      topDimension: Object.entries(score.dimension_scores)
        .sort(([,a], [,b]) => b - a)[0][0]
    };
  }

  console.log('Use case comparison:', results);
  return results;
}

async function runAllTests() {
  try {
    console.log('🚀 Starting Marble Metric-Driven Scoring Tests...\n');

    const engineTest = await testMetricDrivenScoringEngine();
    const multiTest = await testMultipleUseCases();

    console.log('\n✅ All tests completed successfully!');
    console.log('\n📊 Summary:');
    console.log(`- Engine test successful: ${engineTest.success}`);
    console.log(`- First content score: ${engineTest.firstScore.toFixed(3)}`);
    console.log(`- Second content score: ${engineTest.secondScore.toFixed(3)}`);
    console.log(`- Calibration improvement: ${(engineTest.calibrationImprovement * 100).toFixed(1)}%`);
    console.log(`- Use cases tested: ${Object.keys(multiTest).length}`);

    return { success: true, engineTest, multiTest };

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    return { success: false, error: error.message };
  }
}

// Run tests
runAllTests();

export { testMetricDrivenScoringEngine, testMultipleUseCases, runAllTests };