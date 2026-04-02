/**
 * Collaborative Filtering Integration Demo
 *
 * Shows how CF works alongside clone evolution in Marble scoring.
 */

import { Scorer } from './scorer.js';
import { KnowledgeGraph } from './kg.js';
import { globalCollaborativeFilter } from '../collaborative-filter.js';

async function runCFDemo() {
  console.log('🚀 Marble Collaborative Filtering Demo\n');
  console.log('=' .repeat(50));

  // Create two users with different profiles
  const users = [
    {
      id: 'founder_alex',
      interests: [
        { topic: 'ai', weight: 0.9, last_boost: '2024-01-01', trend: 'rising' },
        { topic: 'startups', weight: 0.8, last_boost: '2024-01-02', trend: 'rising' },
        { topic: 'funding', weight: 0.6, last_boost: '2024-01-03', trend: 'stable' }
      ],
      context: {
        active_projects: ['ai-startup', 'fundraising'],
        calendar: ['investor meeting', 'team standup'],
        recent_conversations: ['AI market', 'Series A preparation']
      },
      history: []
    },
    {
      id: 'engineer_sarah',
      interests: [
        { topic: 'ai', weight: 0.9, last_boost: '2024-01-01', trend: 'rising' },
        { topic: 'machine-learning', weight: 0.8, last_boost: '2024-01-02', trend: 'rising' },
        { topic: 'python', weight: 0.7, last_boost: '2024-01-03', trend: 'stable' }
      ],
      context: {
        active_projects: ['ml-model', 'ai-startup'],
        calendar: ['code review', 'research meeting'],
        recent_conversations: ['model training', 'deployment pipeline']
      },
      history: []
    }
  ];

  // Initialize CF with user profiles via first interaction
  for (const user of users) {
    // Record a dummy interaction to initialize user profile
    globalCollaborativeFilter.recordInteraction(user.id, 'init_story', {
      user: user,
      interests: user.interests,
      context: user.context
    });
  }

  console.log('👥 Users initialized:');
  console.log('  - Alex (AI founder)');
  console.log('  - Sarah (AI engineer)\n');

  // Test stories
  const stories = [
    {
      id: 'story1',
      title: 'OpenAI Announces GPT-5 with Revolutionary Reasoning Capabilities',
      summary: 'New model shows breakthrough in logical reasoning and problem solving',
      topics: ['ai', 'machine-learning', 'openai'],
      source: 'techcrunch',
      published_at: new Date().toISOString(),
      url: 'https://techcrunch.com/gpt5-announcement'
    },
    {
      id: 'story2',
      title: 'AI Startup Anthropic Raises $1.2B Series B Funding Round',
      summary: 'Company valued at $15B as investors bet big on AI safety research',
      topics: ['ai', 'startups', 'funding'],
      source: 'bloomberg',
      published_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
      url: 'https://bloomberg.com/anthropic-funding'
    },
    {
      id: 'story3',
      title: 'New Python Library Simplifies Machine Learning Model Deployment',
      summary: 'Open-source tool reduces ML deployment complexity by 70%',
      topics: ['python', 'machine-learning', 'open-source'],
      source: 'github',
      published_at: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(), // 6 hours ago
      url: 'https://github.com/example/ml-deploy'
    }
  ];

  // Phase 1: Sarah reacts to stories (building CF data)
  console.log('📖 Phase 1: Sarah reads and reacts to stories\n');

  const sarahKG = {
    user: users[1],
    getInterestWeight: (topic) => users[1].interests.find(i => i.topic === topic)?.weight || 0,
    hasSeen: () => false,
    getSourceTrust: (source) => source === 'techcrunch' ? 0.8 : 0.6,
    recordReaction: () => {} // Mock for demo
  };

  const sarahScorer = new Scorer(sarahKG, {
    userId: 'engineer_sarah',
    enableCollaborativeFiltering: true
  });

  // Sarah really likes the OpenAI story
  globalCollaborativeFilter.recordInteraction('engineer_sarah', 'story1', sarahKG, 'share', 1.0);

  // Sarah somewhat likes the funding story
  globalCollaborativeFilter.recordInteraction('engineer_sarah', 'story2', sarahKG, 'like', 0.8);

  // Sarah loves the Python tool
  globalCollaborativeFilter.recordInteraction('engineer_sarah', 'story3', sarahKG, 'share', 1.0);

  console.log('  ✓ Sarah shared: OpenAI GPT-5 story');
  console.log('  ✓ Sarah liked: Anthropic funding story');
  console.log('  ✓ Sarah shared: Python ML tool story\n');

  // Phase 2: Alex gets recommendations with CF
  console.log('🎯 Phase 2: Alex gets CF-enhanced recommendations\n');

  const alexKG = {
    user: users[0],
    getInterestWeight: (topic) => users[0].interests.find(i => i.topic === topic)?.weight || 0,
    hasSeen: () => false,
    getSourceTrust: (source) => source === 'bloomberg' ? 0.9 : 0.7,
    recordReaction: () => {} // Mock for demo
  };

  const alexScorer = new Scorer(alexKG, {
    userId: 'founder_alex',
    enableCollaborativeFiltering: true
  });

  const alexScores = await alexScorer.score(stories);

  console.log('📊 Alex\'s story scores (with CF enhancement):\n');

  alexScores.forEach((scored, i) => {
    const story = scored.story;
    console.log(`${i + 1}. ${story.title}`);
    console.log(`   Relevance: ${scored.relevance_score.toFixed(3)}`);
    console.log(`   Interest: ${scored.interest_match.toFixed(3)}`);
    console.log(`   Temporal: ${scored.temporal_relevance.toFixed(3)}`);
    console.log(`   CF Score: ${(scored.collaborative_filtering || 0).toFixed(3)}`);
    console.log(`   CF Confidence: ${(scored.cf_confidence || 0).toFixed(3)}`);
    console.log(`   Topics: ${story.topics.join(', ')}`);
    console.log('');
  });

  // Phase 3: Show CF system stats
  console.log('📈 Collaborative Filter Statistics:\n');

  const stats = globalCollaborativeFilter.getStats();
  console.log(`  Total users: ${stats.totalUsers}`);
  console.log(`  Total interactions: ${stats.totalInteractions}`);
  console.log(`  Avg interactions/user: ${stats.avgInteractionsPerUser}`);
  console.log(`  Matrix sparsity: ${stats.sparsity}%\n`);

  // Phase 4: Show CF score details for Alex
  console.log('🔍 CF Score Details for Alex on stories:\n');

  for (const story of stories) {
    const cfResult = globalCollaborativeFilter.getCollaborativeScore('founder_alex', story.id, alexKG);
    console.log(`  ${story.title.substring(0, 50)}...`);
    console.log(`    CF Score: ${cfResult.score.toFixed(3)}`);
    console.log(`    Confidence: ${cfResult.confidence.toFixed(3)}`);
    console.log(`    Reason: ${cfResult.reason}`);
    console.log('');
  }

  console.log('=' .repeat(50));
  console.log('✅ Demo completed!\n');

  // Summary
  console.log('🎉 Key Collaborative Filtering Benefits:\n');
  console.log('  1. 🎯 "Users like you" signal complements clone evolution');
  console.log('  2. ❄️  Graceful cold start handling (low weight when few users)');
  console.log('  3. 🔄 Real-time learning from user interactions');
  console.log('  4. 💡 Discovers content through user behavior patterns');
  console.log('  5. ⚖️  Dynamic weight based on confidence level\n');
}

async function testRecommendations() {
  console.log('🔍 Testing CF-based recommendations...\n');

  // Test if getRecommendations method exists
  if (typeof globalCollaborativeFilter.getRecommendations === 'function') {
    // Create mock user profile for testing
    const alexProfile = {
      interests: [
        { topic: 'ai', weight: 0.9 },
        { topic: 'startups', weight: 0.8 }
      ]
    };

    const recs = globalCollaborativeFilter.getRecommendations('founder_alex', alexProfile, 5);

    if (recs.length > 0) {
      console.log('💡 Recommended for Alex based on similar users:\n');
      recs.forEach((rec, i) => {
        console.log(`${i + 1}. Item: ${rec.itemId}`);
        console.log(`   CF Score: ${rec.cfScore.toFixed(3)}`);
        console.log(`   Users who engaged: ${rec.userCount}`);
        console.log('');
      });
    } else {
      console.log('ℹ️  No recommendations available (need more interaction data)\n');
    }
  } else {
    console.log('ℹ️  Recommendations feature not available in current CF implementation\n');
  }
}

// Run demo if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runCFDemo()
    .then(() => testRecommendations())
    .catch(console.error);
}

export { runCFDemo, testRecommendations };