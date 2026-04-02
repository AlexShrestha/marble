/**
 * Integration test for metric-driven scoring system
 * Demonstrates end-to-end workflow from scoring to calibration
 */

import { MetricDrivenScoringEngine } from '../enterprise/metric-driven-scoring-engine.js';
import { CalibrationAPI, EXAMPLE_CONFIGS } from './calibration-api.js';
import { createProfileConfig, USE_CASE_PROFILES } from './use-case-profiles.js';
import { Scorer } from './scorer.js';
import { KnowledgeGraph } from './kg.js';

// Mock test data
const mockStories = [
  {
    id: 'story_1',
    title: 'New AI breakthrough in personalization',
    summary: 'Researchers develop better recommendation algorithms',
    source: 'techcrunch',
    topics: ['ai', 'personalization'],
    published_at: new Date(Date.now() - 3600000), // 1 hour ago
    actionability: 0.6
  },
  {
    id: 'story_2',
    title: 'Email marketing strategies for startups',
    summary: 'How to improve reply rates with better targeting',
    source: 'hackernews',
    topics: ['marketing', 'startups'],
    published_at: new Date(Date.now() - 7200000), // 2 hours ago
    actionability: 0.8
  }
];

async function testEmailCampaignUseCase() {
  console.log('\n=== Testing Email Campaign Use Case ===');

  // Create KG and scorer with email campaign profile
  const kg = new KnowledgeGraph('/tmp/test_user_kg.json');
  await kg.load(); // Initialize the user data
  const emailConfig = createProfileConfig('email_campaigns');
  const scorer = new Scorer(kg, { metricConfig: emailConfig, useCase: 'email_campaigns' });

  console.log('Email campaign weights:', emailConfig.weights);

  // Score stories
  const scoredStories = await scorer.score(mockStories);
  console.log('Scored stories:', scoredStories.map(s => ({
    id: s.story.id,
    magic_score: s.magic_score.toFixed(3),
    weights_used: emailConfig.weights
  })));

  // Set up calibration using the unified CalibrationAPI directly
  const calibrationAPI = new CalibrationAPI();
  const startupId = 'test_email_campaign';

  await calibrationAPI.registerStartup(startupId, {
    useCase: 'email_campaigns',
    primaryMetrics: ['email_reply_rate'],
    secondaryMetrics: [],
    weights: emailConfig.weights,
    learningRate: emailConfig.learningRate
  });

  // Build outcome batch in the unified format
  const outcomes = [
    {
      content_id: 'story_1',
      dimension_scores: {
        personalization_depth: 0.7,
        temporal_relevance: 0.8,
        psychological_resonance: 0.6,
        actionability: 0.6,
        trust_indicators: 0.8
      },
      actual_metrics: { email_reply_rate: 0.18 },
      baseline_metrics: { email_reply_rate: 0.12 },
      metadata: { timestamp: Date.now() }
    },
    {
      content_id: 'story_2',
      dimension_scores: {
        personalization_depth: 0.6,
        temporal_relevance: 0.9,
        psychological_resonance: 0.5,
        actionability: 0.8,
        trust_indicators: 0.7
      },
      actual_metrics: { email_reply_rate: 0.25 },
      baseline_metrics: { email_reply_rate: 0.12 },
      metadata: { timestamp: Date.now() }
    },
    // Additional mock outcomes to meet batch threshold
    ...Array(8).fill(0).map((_, i) => ({
      content_id: `mock_story_${i}`,
      dimension_scores: {
        personalization_depth: Math.random(),
        temporal_relevance: Math.random(),
        psychological_resonance: Math.random(),
        actionability: Math.random(),
        trust_indicators: Math.random()
      },
      actual_metrics: { email_reply_rate: 0.15 + (Math.random() * 0.1) },
      baseline_metrics: { email_reply_rate: 0.12 },
      metadata: { timestamp: Date.now() }
    }))
  ];

  const calibrationResult = await calibrationAPI.submitOutcomeBatch(startupId, outcomes);
  console.log('\nCalibration result:', calibrationResult);

  // Read back updated weights from the engine
  const engine = calibrationAPI.engines.get(startupId);
  const updatedWeights = engine ? engine.config.weights : emailConfig.weights;
  console.log('\nUpdated weights:', updatedWeights);

  return { scoredStories, calibrationResult, updatedWeights };
}

async function testMetricDrivenScoringEngine() {
  console.log('\n=== Testing MetricDrivenScoringEngine ===');

  const config = {
    useCase: 'content_curation',
    targetMetrics: ['engagement_time'],
    initialWeights: USE_CASE_PROFILES.content_curation.weights
  };

  const engine = new MetricDrivenScoringEngine(config);

  const contentItem = {
    title: 'How to optimize your morning routine',
    summary: 'Science-backed tips for starting your day productively',
    source: 'medium'
  };

  const score = await engine.scoreContent(contentItem);
  console.log('Content scoring result:', {
    magic_score: score.magic_score,
    top_dimensions: Object.entries(score.dimension_scores)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 3)
      .map(([dim, score]) => `${dim}: ${score.toFixed(2)}`),
    reasoning: score.reasoning
  });

  // Test calibration
  const mockValidation = [{
    dimensionScores: score.dimension_scores,
    actualMetrics: { engagement_time: 420 }, // 7 minutes
    baseline: { engagement_time: 240 } // 4 minutes baseline
  }];

  const calibrationSummary = await engine.calibrateFromOutcomes(mockValidation);
  console.log('Calibration summary:', calibrationSummary);

  // Test export functionality (if available)
  if (typeof engine.exportCalibrationData === 'function') {
    const exportData = engine.exportCalibrationData();
    console.log('Export data keys:', Object.keys(exportData));
    if (!exportData.performance_summary) {
      console.warn('⚠️ Export data missing performance_summary');
    }
  } else {
    console.log('ℹ️ Export functionality not available in MetricDrivenScoringEngine');
  }

  return { score, calibrationSummary };
}

async function runAllTests() {
  try {
    console.log('🧪 Running Marble Metric-Driven Scoring Tests...');

    const emailTest = await testEmailCampaignUseCase();
    const engineTest = await testMetricDrivenScoringEngine();

    console.log('\n✅ All tests completed successfully!');
    console.log('\n📊 Test Summary:');
    console.log(`- Email campaign scoring: ${emailTest.scoredStories.length} stories scored`);
    console.log(`- Calibration processed: ${emailTest.calibrationResult.processed || 0} outcomes`);
    console.log(`- Engine test score: ${engineTest.score.magic_score.toFixed(3)}`);
    console.log(`- Engine calibration confidence: ${engineTest.calibrationSummary.confidence.toFixed(3)}`);

    return { success: true, results: { emailTest, engineTest } };

  } catch (error) {
    console.error('❌ Test failed:', error);
    return { success: false, error: error.message };
  }
}

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllTests();
}

export { runAllTests, testEmailCampaignUseCase, testMetricDrivenScoringEngine };