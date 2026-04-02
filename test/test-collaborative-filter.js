/**
 * Tests for Marble Collaborative Filtering
 *
 * Tests user-item interaction matrix, similarity computation, and CF scoring.
 */

import { CollaborativeFilter } from './collaborative-filter.js';
import { Scorer } from './scorer.js';
import { KnowledgeGraph } from './kg.js';

async function testCollaborativeFilter() {
  console.log('🧪 Testing Collaborative Filter...\n');

  // Setup test data
  const cf = new CollaborativeFilter({
    minSimilarity: 0.2,
    maxSimilarUsers: 5,
    coldStartThreshold: 2
  });

  // Mock user profiles
  const users = [
    {
      id: 'user1',
      interests: [
        { topic: 'ai', weight: 0.8, last_boost: '2024-01-01' },
        { topic: 'startups', weight: 0.6, last_boost: '2024-01-02' }
      ],
      context: { active_projects: ['ai-startup', 'ml-research'] }
    },
    {
      id: 'user2',
      interests: [
        { topic: 'ai', weight: 0.9, last_boost: '2024-01-01' },
        { topic: 'machine-learning', weight: 0.7, last_boost: '2024-01-03' }
      ],
      context: { active_projects: ['ml-research', 'data-science'] }
    },
    {
      id: 'user3',
      interests: [
        { topic: 'crypto', weight: 0.8, last_boost: '2024-01-01' },
        { topic: 'trading', weight: 0.5, last_boost: '2024-01-02' }
      ],
      context: { active_projects: ['crypto-trading'] }
    }
  ];

  // Update user profiles
  for (const user of users) {
    cf.updateUserProfile(user.id, user);
  }

  console.log('✓ User profiles updated');

  // Test 1: Record interactions
  const interactions = [
    { userId: 'user1', contentId: 'story1', reaction: 'up', topics: ['ai', 'startups'] },
    { userId: 'user2', contentId: 'story1', reaction: 'share', topics: ['ai', 'startups'] },
    { userId: 'user1', contentId: 'story2', reaction: 'down', topics: ['crypto'] },
    { userId: 'user2', contentId: 'story3', reaction: 'up', topics: ['machine-learning'] },
    { userId: 'user3', contentId: 'story4', reaction: 'up', topics: ['crypto', 'trading'] }
  ];

  for (const interaction of interactions) {
    cf.recordInteraction(interaction.userId, interaction.contentId, {
      reaction: interaction.reaction,
      topics: interaction.topics,
      timestamp: Date.now()
    });
  }

  console.log('✓ Interactions recorded');

  // Test 2: User similarity
  const similarUsers = await cf.findSimilarUsers('user1');
  console.log('\n📊 Similar users to user1:');
  similarUsers.forEach(sim => {
    console.log(`  ${sim.userId}: ${sim.similarity.toFixed(3)}`);
  });

  // Test 3: CF scoring for user1 on story1 (should be positive - user2 shared it)
  const cfResult = await cf.getCollaborativeScore('user1', 'story1', {
    topics: ['ai', 'startups']
  });

  console.log('\n⚡ CF Score for user1 + story1:');
  console.log(`  Score: ${cfResult.cf_score.toFixed(3)}`);
  console.log(`  Confidence: ${cfResult.confidence.toFixed(3)}`);
  console.log(`  Reason: ${cfResult.reason}`);
  console.log(`  Similar users: ${cfResult.similar_users_count}`);

  // Test 4: CF scoring for new user (cold start)
  const coldStartResult = await cf.getCollaborativeScore('new_user', 'story1', {
    topics: ['ai']
  });

  console.log('\n❄️ Cold start test:');
  console.log(`  Score: ${coldStartResult.cf_score.toFixed(3)}`);
  console.log(`  Cold start: ${coldStartResult.cold_start}`);
  console.log(`  Reason: ${coldStartResult.reason}`);

  // Test 5: Integration with scorer
  console.log('\n🎯 Testing scorer integration...');

  const mockKG = {
    user: {
      id: 'user1',
      interests: users[0].interests,
      context: users[0].context,
      history: []
    },
    getInterestWeight: () => 0.5,
    hasSeen: () => false,
    getSourceTrust: () => 0.7
  };

  const scorer = new Scorer(mockKG, {
    userId: 'user1',
    enableCollaborativeFiltering: true
  });

  const testStory = {
    id: 'story1',
    title: 'AI Startup Funding News',
    summary: 'New AI startup raises $50M',
    topics: ['ai', 'startups'],
    source: 'techcrunch',
    published_at: new Date().toISOString()
  };

  const scores = await scorer.score([testStory]);
  const scoredStory = scores[0];

  console.log('\n📈 Integrated scoring results:');
  console.log(`  Total relevance: ${scoredStory.relevance_score.toFixed(3)}`);
  console.log(`  Interest match: ${scoredStory.interest_match.toFixed(3)}`);
  console.log(`  CF score: ${(scoredStory.collaborative_filtering || 0).toFixed(3)}`);
  console.log(`  CF confidence: ${(scoredStory.cf_confidence || 0).toFixed(3)}`);

  // Test 6: Stats
  const stats = cf.getStats();
  console.log('\n📊 CF Statistics:');
  console.log(`  Total users: ${stats.total_users}`);
  console.log(`  Total interactions: ${stats.total_interactions}`);

  console.log('\n✅ All collaborative filtering tests completed!\n');
  return true;
}

async function testColdStartBehavior() {
  console.log('🧪 Testing Cold Start Behavior...\n');

  const cf = new CollaborativeFilter();

  // Single user, should have low confidence
  cf.updateUserProfile('solo_user', {
    interests: [{ topic: 'ai', weight: 0.8 }]
  });

  const result = await cf.getCollaborativeScore('solo_user', 'new_story', {
    topics: ['ai']
  });

  console.log('❄️ Solo user CF result:');
  console.log(`  Score: ${result.cf_score}`);
  console.log(`  Confidence: ${result.confidence}`);
  console.log(`  Reason: ${result.reason}`);

  return result.cf_score === 0 && result.confidence === 0;
}

async function testSimilarityComputation() {
  console.log('🧪 Testing Similarity Computation...\n');

  const cf = new CollaborativeFilter();

  // Very similar users
  cf.updateUserProfile('alice', {
    interests: [
      { topic: 'javascript', weight: 0.9 },
      { topic: 'react', weight: 0.8 },
      { topic: 'frontend', weight: 0.7 }
    ],
    context: { active_projects: ['web-app'] }
  });

  cf.updateUserProfile('bob', {
    interests: [
      { topic: 'javascript', weight: 0.8 },
      { topic: 'react', weight: 0.9 },
      { topic: 'frontend', weight: 0.6 }
    ],
    context: { active_projects: ['web-app', 'mobile-app'] }
  });

  // Different user
  cf.updateUserProfile('charlie', {
    interests: [
      { topic: 'python', weight: 0.9 },
      { topic: 'data-science', weight: 0.8 }
    ],
    context: { active_projects: ['ml-model'] }
  });

  const aliceSimilar = await cf.findSimilarUsers('alice');

  console.log('👥 Alice\'s similar users:');
  aliceSimilar.forEach(sim => {
    console.log(`  ${sim.userId}: ${sim.similarity.toFixed(3)}`);
  });

  // Bob should be most similar to Alice
  const bobSimilarity = aliceSimilar.find(s => s.userId === 'bob')?.similarity || 0;
  const charlieSimilarity = aliceSimilar.find(s => s.userId === 'charlie')?.similarity || 0;

  console.log(`\n✓ Bob similarity: ${bobSimilarity.toFixed(3)}`);
  console.log(`✓ Charlie similarity: ${charlieSimilarity.toFixed(3)}`);

  return bobSimilarity > charlieSimilarity;
}

async function runAllTests() {
  console.log('🚀 Running Collaborative Filter Tests\n');
  console.log('=' .repeat(50));

  const results = [];

  try {
    results.push(await testCollaborativeFilter());
    results.push(await testColdStartBehavior());
    results.push(await testSimilarityComputation());

    const passed = results.filter(Boolean).length;
    const total = results.length;

    console.log('=' .repeat(50));
    console.log(`\n🎉 Tests completed: ${passed}/${total} passed\n`);

    if (passed === total) {
      console.log('✅ All tests passed! CF system is working correctly.');
    } else {
      console.log('❌ Some tests failed. Check implementation.');
    }

  } catch (error) {
    console.error('❌ Test execution failed:', error);
  }
}

// Run tests if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllTests();
}

export { runAllTests, testCollaborativeFilter, testColdStartBehavior, testSimilarityComputation };