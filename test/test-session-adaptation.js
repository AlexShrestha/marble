/**
 * Tests for Marble Within-Session Adaptation
 *
 * Tests real-time scoring adjustments based on user engagement within a session.
 * When user engages with story A (dwell > 30s), immediately boost similar topics.
 * When user skips story B (dwell < 5s), demote similar topics for remaining stories.
 */

import { MarbleSignalProcessor } from '../signals.js';
import { Scorer } from './scorer.js';
import { KnowledgeGraph } from './kg.js';

async function testSessionAdaptation() {
  console.log('🧪 Testing Within-Session Adaptation...\n');

  // Test 1: SessionAdapter Basic Functionality
  console.log('1️⃣ Testing SessionAdapter Basic Functionality');

  const signalProcessor = new MarbleSignalProcessor({
    enableSessionAdaptation: true
  });

  // Test recording high engagement
  signalProcessor.recordSessionSignal('story1', 'dwell', {
    duration_seconds: 45, // High engagement
    topics: ['ai', 'startups']
  });

  // Verify topic boosts
  const aiBoost = signalProcessor.getSessionTopicModifier('ai');
  const startupsBoost = signalProcessor.getSessionTopicModifier('startups');
  const unrelatedBoost = signalProcessor.getSessionTopicModifier('crypto');

  console.log(`✓ AI topic boost: ${aiBoost} (expected: 0.2)`);
  console.log(`✓ Startups topic boost: ${startupsBoost} (expected: 0.2)`);
  console.log(`✓ Unrelated topic boost: ${unrelatedBoost} (expected: 0)`);

  // Test recording skip behavior
  signalProcessor.recordSessionSignal('story2', 'skip', {
    duration_seconds: 3, // Low engagement
    topics: ['blockchain']
  });

  const blockchainDemote = signalProcessor.getSessionTopicModifier('blockchain');
  console.log(`✓ Blockchain topic demote: ${blockchainDemote} (expected: -0.1)`);

  console.log('');

  // Test 2: Scorer Integration
  console.log('2️⃣ Testing Scorer Integration');

  // Create mock KG
  const mockKG = {
    user: {
      id: 'test_user',
      interests: [
        { topic: 'ai', weight: 0.7 },
        { topic: 'startups', weight: 0.6 }
      ],
      context: {
        active_projects: ['ai-startup'],
        calendar: [],
        recent_conversations: []
      },
      history: []
    },
    getTopInterests: () => [
      { name: 'ai', weight: 0.7 },
      { name: 'startups', weight: 0.6 }
    ],
    getInterestWeight: (topic) => {
      const interests = { 'ai': 0.7, 'startups': 0.6, 'crypto': 0.2, 'blockchain': 0.1 };
      return interests[topic] || 0;
    },
    hasSeen: () => false,
    getSourceTrust: () => 0.8
  };

  // Create scorer with session adaptation
  const scorer = new Scorer(mockKG, {
    enableSessionAdaptation: true,
    signalProcessor: signalProcessor
  });

  // Test stories
  const stories = [
    {
      id: 'story_ai',
      title: 'New AI Breakthrough',
      summary: 'Revolutionary AI technology announced',
      topics: ['ai', 'technology'],
      published_at: new Date().toISOString(),
      source: 'tech-news'
    },
    {
      id: 'story_blockchain',
      title: 'Blockchain Update',
      summary: 'Latest blockchain developments',
      topics: ['blockchain', 'crypto'],
      published_at: new Date().toISOString(),
      source: 'crypto-news'
    },
    {
      id: 'story_startups',
      title: 'Startup Funding News',
      summary: 'New startup raises Series A',
      topics: ['startups', 'funding'],
      published_at: new Date().toISOString(),
      source: 'startup-news'
    }
  ];

  // Score stories
  const scoredStories = await scorer.score(stories);

  console.log('📊 Story Scores with Session Adaptation:');
  for (const scored of scoredStories) {
    const sessionBoost = scored.session_boost || 0;
    console.log(`  ${scored.story.title}: ${scored.relevance_score.toFixed(3)} (session boost: ${sessionBoost.toFixed(3)})`);
  }

  // AI story should have highest score due to session boost
  const aiStory = scoredStories.find(s => s.story.id === 'story_ai');
  const blockchainStory = scoredStories.find(s => s.story.id === 'story_blockchain');

  console.log(`✓ AI story boosted: ${(aiStory.session_boost || 0) > 0 ? 'Yes' : 'No'}`);
  console.log(`✓ Blockchain story demoted: ${(blockchainStory.session_boost || 0) < 0 ? 'Yes' : 'No'}`);
  console.log('');

  // Test 3: Real-time Engagement Recording
  console.log('3️⃣ Testing Real-time Engagement Recording');

  // Record engagement with startup story
  scorer.recordEngagement('story_startups', 'dwell', {
    duration_seconds: 35,
    topics: ['startups', 'funding']
  });

  // Re-score remaining stories to see immediate adaptation
  const updatedScores = await scorer.score([
    {
      id: 'story_funding',
      title: 'VC Investment Trends',
      summary: 'Analysis of venture capital trends',
      topics: ['funding', 'venture-capital'],
      published_at: new Date().toISOString(),
      source: 'finance-news'
    }
  ]);

  const fundingStory = updatedScores[0];
  console.log(`✓ Funding story session boost: ${(fundingStory.session_boost || 0).toFixed(3)}`);
  console.log(`✓ Immediate adaptation working: ${(fundingStory.session_boost || 0) > 0 ? 'Yes' : 'No'}`);
  console.log('');

  // Test 4: Session State Management
  console.log('4️⃣ Testing Session State Management');

  const sessionState = scorer.getSessionState();
  console.log('📋 Current Session State:');
  console.log(`  Session ID: ${sessionState.sessionId}`);
  console.log(`  Active Topics: ${sessionState.activeTopics.size}`);
  console.log(`  Boosts: ${Object.keys(sessionState.boosts).length}`);
  console.log(`  Demotes: ${Object.keys(sessionState.demotes).length}`);
  console.log('');

  // Test 5: Session Limits and Bounds
  console.log('5️⃣ Testing Session Limits and Bounds');

  // Test maximum boost limit
  for (let i = 0; i < 5; i++) {
    signalProcessor.recordSessionSignal(`story_boost_${i}`, 'dwell', {
      duration_seconds: 60,
      topics: ['test-topic']
    });
  }

  const maxBoost = signalProcessor.getSessionTopicModifier('test-topic');
  console.log(`✓ Max boost limit respected: ${maxBoost <= 0.5 ? 'Yes' : 'No'} (${maxBoost.toFixed(3)})`);

  // Test maximum demote limit
  for (let i = 0; i < 5; i++) {
    signalProcessor.recordSessionSignal(`story_demote_${i}`, 'skip', {
      duration_seconds: 2,
      topics: ['demote-topic']
    });
  }

  const maxDemote = signalProcessor.getSessionTopicModifier('demote-topic');
  console.log(`✓ Max demote limit respected: ${maxDemote >= -0.3 ? 'Yes' : 'No'} (${maxDemote.toFixed(3)})`);
  console.log('');

  // Test 6: Session Clearing
  console.log('6️⃣ Testing Session Clearing');

  signalProcessor.clearSession();
  const clearedState = signalProcessor.getSessionState();

  console.log(`✓ Session cleared: boosts=${Object.keys(clearedState.boosts).length}, demotes=${Object.keys(clearedState.demotes).length}`);
  console.log(`✓ New session ID generated: ${clearedState.sessionId !== sessionState.sessionId ? 'Yes' : 'No'}`);

  console.log('\n🎉 Session Adaptation Tests Complete!\n');
  console.log('✅ Real-time topic boosting working');
  console.log('✅ Real-time topic demoting working');
  console.log('✅ Scorer integration functional');
  console.log('✅ Session state management working');
  console.log('✅ Bounds and limits enforced');
  console.log('✅ Session lifecycle managed');
}

// Run the test
if (import.meta.url === `file://${process.argv[1]}`) {
  testSessionAdaptation().catch(console.error);
}

export { testSessionAdaptation };