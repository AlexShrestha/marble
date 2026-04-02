/**
 * Final integration test to verify CF system works with realistic data
 */

import { Scorer } from './scorer.js';
import { globalCollaborativeFilter } from '../collaborative-filter.js';

async function testCFIntegration() {
  console.log('🧪 Testing CF Integration in Marble...\n');

  // Create mock KG with user data
  const mockKG = {
    user: {
      id: 'test_user_1',
      interests: [
        { topic: 'ai', weight: 0.8, last_boost: new Date().toISOString() },
        { topic: 'startups', weight: 0.6, last_boost: new Date().toISOString() }
      ],
      context: {
        active_projects: ['ai-startup'],
        calendar: ['team meeting', 'investor call'],
        recent_conversations: ['funding', 'product launch']
      },
      history: []
    },
    getInterestWeight: (topic) => {
      const interests = {
        'ai': 0.8,
        'startups': 0.6,
        'machine-learning': 0.4
      };
      return interests[topic] || 0.1;
    },
    hasSeen: () => false,
    getSourceTrust: () => 0.7,
    getTopInterests: () => [
      { topic: 'ai', weight: 0.8 },
      { topic: 'startups', weight: 0.6 }
    ]
  };

  // Record some interactions for the user and similar users
  console.log('📝 Recording sample interactions...');

  // User 1 (our target user) interactions
  globalCollaborativeFilter.recordInteraction('test_user_1', 'story_ai_1', mockKG, 'up', 1.0);
  globalCollaborativeFilter.recordInteraction('test_user_1', 'story_startup_1', mockKG, 'share', 1.0);

  // Similar user interactions (same interests) - need at least 3 users for CF
  const similarUserKG = {
    user: {
      id: 'test_user_2',
      interests: [
        { topic: 'ai', weight: 0.9 },
        { topic: 'machine-learning', weight: 0.7 }
      ],
      context: { active_projects: ['ml-research'] },
      history: []
    }
  };

  globalCollaborativeFilter.recordInteraction('test_user_2', 'story_ai_2', similarUserKG, 'up', 1.0);
  globalCollaborativeFilter.recordInteraction('test_user_2', 'story_ai_3', similarUserKG, 'share', 1.0);

  // Another similar user
  const similarUserKG2 = {
    user: {
      id: 'test_user_3',
      interests: [
        { topic: 'ai', weight: 0.7 },
        { topic: 'startups', weight: 0.8 }
      ],
      context: { active_projects: ['ai-startup'] },
      history: []
    }
  };

  globalCollaborativeFilter.recordInteraction('test_user_3', 'story_ai_2', similarUserKG2, 'up', 1.0);
  globalCollaborativeFilter.recordInteraction('test_user_3', 'story_startup_2', similarUserKG2, 'share', 1.0);

  // Add a third similar user to meet minimum threshold
  const similarUserKG3 = {
    user: {
      id: 'test_user_4',
      interests: [
        { topic: 'ai', weight: 0.8 },
        { topic: 'startups', weight: 0.6 }
      ],
      context: { active_projects: ['ai-startup'] },
      history: []
    }
  };

  globalCollaborativeFilter.recordInteraction('test_user_4', 'story_ai_2', similarUserKG3, 'share', 1.0);

  // Create scorer with CF enabled
  const scorer = new Scorer(mockKG, {
    userId: 'test_user_1',
    enableCollaborativeFiltering: true
  });

  // Test story that similar users engaged with
  const testStory = {
    id: 'story_ai_2',
    title: 'New AI Breakthrough in Machine Learning',
    summary: 'Revolutionary AI advancement shows 50% improvement in accuracy',
    topics: ['ai', 'machine-learning'],
    source: 'techcrunch',
    published_at: new Date().toISOString()
  };

  console.log('🎯 Scoring story that similar users engaged with...');
  const scores = await scorer.score([testStory]);
  const scoredStory = scores[0];

  console.log('\n📈 Scoring Results:');
  console.log(`  Story: ${testStory.title}`);
  console.log(`  Total relevance: ${scoredStory.relevance_score.toFixed(3)}`);
  console.log(`  Interest match: ${scoredStory.interest_match.toFixed(3)}`);
  console.log(`  CF score: ${(scoredStory.collaborative_filtering || 0).toFixed(6)} (raw: ${scoredStory.collaborative_filtering})`);
  console.log(`  CF confidence: ${(scoredStory.cf_confidence || 0).toFixed(6)} (raw: ${scoredStory.cf_confidence})`);
  console.log(`  Explanation: ${scoredStory.why}`);

  // Debug: check if CF is actually enabled
  console.log('  DEBUG - CF enabled:', scorer.enableCollaborativeFiltering);
  console.log('  DEBUG - UserID:', scorer.userId);

  // Test story that similar users did NOT engage with
  const testStory2 = {
    id: 'story_unrelated',
    title: 'Sports News Update',
    summary: 'Local sports team wins championship',
    topics: ['sports', 'news'],
    source: 'espn',
    published_at: new Date().toISOString()
  };

  console.log('\n🎯 Scoring story with no similar user engagement...');
  const scores2 = await scorer.score([testStory2]);
  const scoredStory2 = scores2[0];

  console.log('\n📈 Scoring Results (no CF signal):');
  console.log(`  Story: ${testStory2.title}`);
  console.log(`  Total relevance: ${scoredStory2.relevance_score.toFixed(3)}`);
  console.log(`  Interest match: ${scoredStory2.interest_match.toFixed(3)}`);
  console.log(`  CF score: ${(scoredStory2.collaborative_filtering || 0).toFixed(3)}`);
  console.log(`  CF confidence: ${(scoredStory2.cf_confidence || 0).toFixed(3)}`);

  // Check CF stats
  const cfStats = globalCollaborativeFilter.getStats();
  console.log('\n📊 CF System Statistics:');
  console.log(`  Total users: ${cfStats.totalUsers}`);
  console.log(`  Total interactions: ${cfStats.totalInteractions}`);
  console.log(`  Sparsity: ${cfStats.sparsity.toFixed(1)}%`);

  // Test CF recommendations
  const recommendations = globalCollaborativeFilter.getRecommendations('test_user_1', mockKG, 5);
  console.log('\n💡 CF Recommendations for test_user_1:');
  recommendations.forEach((rec, i) => {
    console.log(`  ${i+1}. Item ${rec.itemId}: CF score ${rec.cfScore.toFixed(3)} (${rec.userCount} users)`);
  });

  console.log('\n✅ CF Integration test completed!');

  return {
    cfWorking: (scoredStory.collaborative_filtering || 0) !== (scoredStory2.collaborative_filtering || 0),
    hasCFSignal: (scoredStory.collaborative_filtering || 0) > 0 || (scoredStory.cf_confidence || 0) > 0,
    hasRecommendations: recommendations.length > 0
  };
}

// Run the test
if (import.meta.url === `file://${process.argv[1]}`) {
  testCFIntegration();
}

export { testCFIntegration };