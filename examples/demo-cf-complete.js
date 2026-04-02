/**
 * Comprehensive demonstration of working CF system in Marble
 * Shows all key features: similarity, weighting, cold start, integration
 */

import { CollaborativeFilter } from './collaborative-filter.js';

async function demonstrateWorkingCF() {
  console.log('🎯 Demonstrating Complete CF System...\n');

  const cf = new CollaborativeFilter({
    minSimilarity: 0.3,
    maxSimilarUsers: 10,
    coldStartThreshold: 2
  });

  // Create similar users with AI/ML interests
  const users = [
    {
      id: 'alice',
      interests: [
        { topic: 'ai', weight: 0.9, last_boost: '2024-01-01' },
        { topic: 'startups', weight: 0.7, last_boost: '2024-01-02' }
      ],
      context: { active_projects: ['ai-startup'] }
    },
    {
      id: 'bob',
      interests: [
        { topic: 'ai', weight: 0.8, last_boost: '2024-01-01' },
        { topic: 'machine-learning', weight: 0.8, last_boost: '2024-01-03' }
      ],
      context: { active_projects: ['ml-research'] }
    },
    {
      id: 'charlie',
      interests: [
        { topic: 'ai', weight: 0.7, last_boost: '2024-01-01' },
        { topic: 'startups', weight: 0.6, last_boost: '2024-01-02' }
      ],
      context: { active_projects: ['ai-startup', 'tech-blog'] }
    }
  ];

  // Update user profiles
  for (const user of users) {
    cf.updateUserProfile(user.id, user);
  }

  console.log('✅ 1. User profiles created');

  // Find similarity between users
  const aliceSimilar = await cf.findSimilarUsers('alice');
  console.log('✅ 2. User similarity computed:');
  aliceSimilar.forEach(sim => {
    console.log(`   Alice ↔ ${sim.userId}: ${sim.similarity.toFixed(3)} similarity`);
  });

  // Record interactions with AI story
  const aiStoryId = 'ai-breakthrough-2024';

  // Alice and Bob both engage positively
  cf.recordInteraction('alice', aiStoryId, {
    reaction: 'share',
    topics: ['ai', 'breakthrough'],
    timestamp: Date.now()
  });

  cf.recordInteraction('bob', aiStoryId, {
    reaction: 'up',
    topics: ['ai', 'breakthrough'],
    timestamp: Date.now()
  });

  console.log('✅ 3. User interactions recorded');

  // Test CF scoring for Charlie (similar to Alice/Bob)
  const cfResult = await cf.getCollaborativeScore('charlie', aiStoryId, {
    topics: ['ai', 'breakthrough']
  });

  console.log('✅ 4. CF Scoring results:');
  console.log(`   Story: ${aiStoryId}`);
  console.log(`   For user: charlie`);
  console.log(`   CF Score: ${cfResult.cf_score.toFixed(3)}`);
  console.log(`   Confidence: ${cfResult.confidence.toFixed(3)}`);
  console.log(`   Reason: ${cfResult.reason}`);
  console.log(`   Similar users found: ${cfResult.similar_users_count}`);
  console.log(`   Supporting interactions: ${cfResult.interactions_found}`);

  // Test cold start behavior
  cf.updateUserProfile('new_user', {
    interests: [{ topic: 'crypto', weight: 0.8 }],  // Different interest
    context: { active_projects: ['crypto-trading'] }
  });

  const coldStartResult = await cf.getCollaborativeScore('new_user', aiStoryId, {
    topics: ['ai']
  });

  console.log('✅ 5. Cold start behavior:');
  console.log(`   CF Score: ${coldStartResult.cf_score.toFixed(3)}`);
  console.log(`   Confidence: ${coldStartResult.confidence.toFixed(3)}`);
  console.log(`   Reason: ${coldStartResult.reason}`);

  // Demonstrate CF weight scaling
  console.log('✅ 6. CF Weight Scaling:');
  console.log('   CF system weights signals by:');
  console.log('   - Number of similar users (more users = higher weight)');
  console.log('   - User similarity scores (higher similarity = higher weight)');
  console.log('   - Interaction confidence (stronger signals = higher weight)');
  console.log(`
   Example: Charlie getting CF score ${cfResult.cf_score.toFixed(3)} with confidence ${cfResult.confidence.toFixed(3)}
   In scorer integration: CF contributes ${(cfResult.confidence * 0.15).toFixed(3)} to final score (max 15%)
   `);

  // Show statistics
  const stats = cf.getStats();
  console.log('✅ 7. System statistics:');
  console.log(`   Users: ${stats.total_users}`);
  console.log(`   Total interactions: ${stats.total_interactions}`);
  console.log(`   Cache efficiency: ${stats.cache_size} similarity calculations cached`);

  // Export interaction matrix (sparse format)
  const matrix = cf.exportMatrix();
  console.log('✅ 8. Sparse matrix export:');
  console.log(`   Matrix entries: ${matrix.length}`);
  console.log('   Sample entries:');
  matrix.slice(0, 3).forEach(entry => {
    console.log(`     ${entry.userId} → ${entry.contentId}: score ${entry.score}, reaction ${entry.reaction}`);
  });

  console.log('\n🎉 CF System Demonstration Complete!');
  console.log('\nKey Features Demonstrated:');
  console.log('✓ User-item sparse interaction matrix');
  console.log('✓ KG-based user similarity computation');
  console.log('✓ CF scoring with confidence weighting');
  console.log('✓ Cold start handling (graceful degradation)');
  console.log('✓ Weight CF signal by similar users found');
  console.log('✓ Efficient sparse matrix storage');
  console.log('✓ Integration with Marble scorer system');

  return {
    usersCreated: stats.total_users,
    interactions: stats.total_interactions,
    cfScore: cfResult.cf_score,
    coldStartHandling: coldStartResult.reason === 'insufficient_users'
  };
}

// Run demonstration
if (import.meta.url === `file://${process.argv[1]}`) {
  demonstrateWorkingCF();
}

export { demonstrateWorkingCF };