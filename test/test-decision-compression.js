/**
 * Test Decision Compression Output Feature
 *
 * Validates that Marble can generate decision-compressed output:
 * - what_matters: why this item ranks high
 * - why: enhanced insight hypothesis
 * - what_to_do_next: actionable CTA
 * - confidence: real vs synthesized
 */

import { Scorer } from '../core/scorer.js';
import { Swarm } from '../core/swarm.js';

// Mock KG for testing
class MockKG {
  constructor() {
    this.user = {
      context: {
        active_projects: ['Shopify app development', 'AI automation'],
        calendar: ['Product review meeting', 'Customer calls'],
        recent_conversations: ['API integration', 'performance optimization']
      },
      history: [
        { topics: ['ecommerce', 'shopify'], timestamp: Date.now() - 86400000 },
        { topics: ['ai', 'automation'], timestamp: Date.now() - 172800000 }
      ],
      interests: [
        { topic: 'ecommerce', weight: 0.8, trend: 'stable' },
        { topic: 'shopify', weight: 0.9, trend: 'increasing' },
        { topic: 'ai', weight: 0.7, trend: 'increasing' },
        { topic: 'automation', weight: 0.6, trend: 'stable' },
        { topic: 'saas', weight: 0.5, trend: 'stable' }
      ],
      source_trust: {
        'TechCrunch': 0.8,
        'Hacker News': 0.9,
        'SaaS Magazine': 0.7,
        'Unknown': 0.5
      }
    };

    this.interests = {
      'ecommerce': 0.8,
      'shopify': 0.9,
      'ai': 0.7,
      'automation': 0.6,
      'saas': 0.5
    };

    this.sourceTrust = {
      'TechCrunch': 0.8,
      'Hacker News': 0.9,
      'Unknown': 0.5
    };
  }

  getInterestWeight(topic) {
    return this.interests[topic] || 0;
  }

  getSourceTrust(source) {
    return this.sourceTrust[source] || 0.5;
  }

  hasSeen(id) {
    return false;
  }

  getTopInterests() {
    return Object.entries(this.interests)
      .map(([name, weight]) => ({ name, weight }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 5);
  }
}

// Test stories
const testStories = [
  {
    id: 'story_1',
    title: 'Shopify Partners Program Announces New Revenue Sharing Model',
    summary: 'Shopify unveils enhanced partner benefits with 25% revenue sharing for apps, effective immediately. Applications now open.',
    source: 'TechCrunch',
    topics: ['ecommerce', 'shopify', 'saas'],
    published_at: new Date(Date.now() - 3600000), // 1 hour ago
    actionability: 0.8
  },
  {
    id: 'story_2',
    title: 'OpenAI Releases Function Calling API for Autonomous Agents',
    summary: 'New AI capabilities enable more sophisticated automation workflows. Developers can now build self-directing agent systems.',
    source: 'Hacker News',
    topics: ['ai', 'automation', 'api'],
    published_at: new Date(Date.now() - 7200000), // 2 hours ago
    actionability: 0.6
  },
  {
    id: 'story_3',
    title: 'The Psychology of Customer Retention in SaaS',
    summary: 'Research shows how subtle UX changes can improve long-term user engagement and reduce churn rates.',
    source: 'SaaS Magazine',
    topics: ['saas', 'psychology', 'ux'],
    published_at: new Date(Date.now() - 14400000), // 4 hours ago
    actionability: 0.4
  }
];

// Test function
async function testDecisionCompression() {
  console.log('🧪 Testing Marble Decision Compression Feature\n');

  const kg = new MockKG();

  // Test 1: Basic decision compression without swarm
  console.log('── Test 1: Basic Decision Compression ──');
  const basicScorer = new Scorer(kg, {
    decisionCompressionEnabled: true,
    legacyMode: false
  });

  console.log('✓ Scorer initialized with decision compression enabled');

  const basicResults = await basicScorer.score(testStories);
  const topStory = basicResults[0];

  console.log('\n📊 Top Story Results:');
  console.log(`Title: ${topStory.story.title}`);
  console.log(`Magic Score: ${topStory.magic_score.toFixed(3)}`);
  console.log(`\n🎯 Decision Compression Output:`);
  console.log(`What Matters: ${topStory.what_matters}`);
  console.log(`Why: ${topStory.why}`);
  console.log(`What To Do Next: ${topStory.what_to_do_next}`);
  console.log(`Compression Confidence: ${topStory.compression_confidence.toFixed(3)}`);

  // Test 2: Decision compression with swarm integration
  console.log('\n── Test 2: Decision Compression with Swarm Integration ──');

  const swarm = new Swarm(kg, { mode: 'fast' });
  const swarmScorer = new Scorer(kg, {
    decisionCompressionEnabled: true,
    swarmInstance: swarm,
    legacyMode: false
  });

  console.log('✓ Scorer initialized with swarm integration');

  // Run swarm evaluation to populate agent reasoning
  const swarmResults = await swarm.curate(testStories);

  // Now score with swarm context
  const enhancedResults = await swarmScorer.score(testStories);
  const enhancedTopStory = enhancedResults[0];

  console.log('\n📊 Enhanced Results with Swarm Reasoning:');
  console.log(`\n🎯 Enhanced Decision Compression Output:`);
  console.log(`What Matters: ${enhancedTopStory.what_matters}`);
  console.log(`Why: ${enhancedTopStory.why}`);
  console.log(`What To Do Next: ${enhancedTopStory.what_to_do_next}`);
  console.log(`Compression Confidence: ${enhancedTopStory.compression_confidence.toFixed(3)}`);

  // Test 3: Compare raw scores vs decision-compressed output
  console.log('\n── Test 3: Raw Scores vs Decision Compression Comparison ──');

  const rawScorer = new Scorer(kg, {
    decisionCompressionEnabled: false,
    legacyMode: false
  });

  const rawResults = await rawScorer.score(testStories);
  const rawTopStory = rawResults[0];

  console.log('\n📊 Raw Scoring Output:');
  console.log(`Magic Score: ${rawTopStory.magic_score.toFixed(3)}`);
  console.log(`Confidence: ${rawTopStory.confidence.toFixed(3)}`);
  console.log(`Why: ${rawTopStory.why}`);
  console.log(`(No decision compression fields)`);

  console.log('\n📊 Decision-Compressed Output:');
  console.log(`Magic Score: ${topStory.magic_score.toFixed(3)} (same)`);
  console.log(`Original Confidence: ${topStory.confidence.toFixed(3)}`);
  console.log(`Compression Confidence: ${topStory.compression_confidence.toFixed(3)}`);
  console.log(`Enhanced Fields: what_matters, enhanced why, what_to_do_next`);

  // Test 4: Configuration switching
  console.log('\n── Test 4: Dynamic Configuration Switching ──');

  const dynamicScorer = new Scorer(kg, { legacyMode: false });

  // Initially disabled
  console.log('Initial state:', dynamicScorer.exportConfiguration().decisionCompressionEnabled);

  // Enable compression
  const enableResult = dynamicScorer.setDecisionCompressionMode(true, swarm);
  console.log('Enable result:', enableResult);

  // Test scoring with new config
  const dynamicResults = await dynamicScorer.score([testStories[0]]);
  const hasCompressionFields = 'what_matters' in dynamicResults[0];
  console.log('Has compression fields after enable:', hasCompressionFields);

  // Disable compression
  dynamicScorer.setDecisionCompressionMode(false);
  const disabledResults = await dynamicScorer.score([testStories[0]]);
  const lacksCompressionFields = !('what_matters' in disabledResults[0]);
  console.log('Lacks compression fields after disable:', lacksCompressionFields);

  // Test 5: Validate all stories get compression output
  console.log('\n── Test 5: Validate All Stories Get Compression Output ──');

  const allResults = await basicScorer.score(testStories);

  for (let i = 0; i < allResults.length; i++) {
    const story = allResults[i];
    const hasAllFields = story.what_matters && story.what_to_do_next &&
                        story.compression_confidence !== undefined;

    console.log(`Story ${i + 1}: ${story.story.title.substring(0, 40)}...`);
    console.log(`  Has all compression fields: ${hasAllFields}`);
    console.log(`  What matters: "${story.what_matters}"`);
    console.log(`  What to do: "${story.what_to_do_next}"`);
    console.log(`  Confidence: ${story.compression_confidence?.toFixed(3)}`);
  }

  console.log('\n🎉 All Decision Compression Tests Completed!');

  // Summary validation
  const validationResults = {
    basicCompressionWorks: !!topStory.what_matters,
    enhancedReasoningWorks: enhancedTopStory.why.length > topStory.why.length,
    configSwitchingWorks: enableResult.success,
    allStoriesProcessed: allResults.every(r => r.what_matters),
    confidenceCalculated: allResults.every(r => typeof r.compression_confidence === 'number')
  };

  console.log('\n📋 Validation Summary:', validationResults);

  return validationResults;
}

// Run tests
testDecisionCompression().catch(console.error);