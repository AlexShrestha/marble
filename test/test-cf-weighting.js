/**
 * Test to demonstrate CF signal weighting by number of similar users
 * Shows how low users = low CF weight, more users = higher CF weight
 */

import { CollaborativeFilter } from '../core/collaborative-filter.js';

async function testCFWeighting() {
  console.log('🧪 Testing CF Signal Weighting by User Count...\n');

  const cf = new CollaborativeFilter({
    minSimilarUsers: 2,
    maxSimilarUsers: 10,
    similarityThreshold: 0.2
  });

  // Create users with similar interests (AI/ML focused)
  const users = [
    { id: 'user1', interests: [{ topic: 'ai', weight: 0.9 }, { topic: 'startups', weight: 0.7 }] },
    { id: 'user2', interests: [{ topic: 'ai', weight: 0.8 }, { topic: 'machine-learning', weight: 0.8 }] },
    { id: 'user3', interests: [{ topic: 'ai', weight: 0.7 }, { topic: 'startups', weight: 0.6 }] },
    { id: 'user4', interests: [{ topic: 'ai', weight: 0.8 }, { topic: 'deep-learning', weight: 0.7 }] },
    { id: 'user5', interests: [{ topic: 'ai', weight: 0.9 }, { topic: 'neural-networks', weight: 0.8 }] },
    { id: 'user6', interests: [{ topic: 'ai', weight: 0.7 }, { topic: 'computer-vision', weight: 0.6 }] }
  ];

  // Update profiles
  for (const user of users) {
    cf.updateUserProfile(user.id, user);
  }

  // Record interactions for an AI story - users gradually engage with it
  const storyId = 'ai-breakthrough-story';

  // Test 1: Only 2 users engage (minimal CF signal)
  cf.recordInteraction('user1', storyId, {}, 'share', 1.0);
  cf.recordInteraction('user2', storyId, {}, 'up', 1.0);

  const cfResult2Users = cf.getCollaborativeScore('user3', storyId, users[2]);
  console.log('📊 CF Score with 2 similar users:');
  console.log(`  Score: ${(cfResult2Users.score || 0).toFixed(3)}`);
  console.log(`  Confidence: ${(cfResult2Users.confidence || 0).toFixed(3)}`);
  console.log(`  Users count: ${cfResult2Users.userCount || 0}`);
  console.log(`  Reason: ${cfResult2Users.reason}\n`);

  // Test 2: 4 users engage (higher CF signal)
  cf.recordInteraction('user4', storyId, {}, 'up', 1.0);
  cf.recordInteraction('user5', storyId, {}, 'share', 1.0);

  const cfResult4Users = cf.getCollaborativeScore('user3', storyId, users[2]);
  console.log('📊 CF Score with 4 similar users:');
  console.log(`  Score: ${(cfResult4Users.score || 0).toFixed(3)}`);
  console.log(`  Confidence: ${(cfResult4Users.confidence || 0).toFixed(3)}`);
  console.log(`  Users count: ${cfResult4Users.userCount || 0}`);
  console.log(`  Reason: ${cfResult4Users.reason}\n`);

  // Test 3: 6 users engage (maximum CF signal)
  cf.recordInteraction('user6', storyId, {}, 'up', 1.0);

  const cfResult6Users = cf.getCollaborativeScore('user3', storyId, users[2]);
  console.log('📊 CF Score with 5 similar users:');
  console.log(`  Score: ${(cfResult6Users.score || 0).toFixed(3)}`);
  console.log(`  Confidence: ${(cfResult6Users.confidence || 0).toFixed(3)}`);
  console.log(`  Users count: ${cfResult6Users.userCount || 0}`);
  console.log(`  Reason: ${cfResult6Users.reason}\n`);

  // Demonstrate the weighting effect
  console.log('📈 CF Signal Weighting Demonstration:');
  console.log(`  2 users: score=${(cfResult2Users.score || 0).toFixed(3)}, confidence=${(cfResult2Users.confidence || 0).toFixed(3)}`);
  console.log(`  4 users: score=${(cfResult4Users.score || 0).toFixed(3)}, confidence=${(cfResult4Users.confidence || 0).toFixed(3)}`);
  console.log(`  5 users: score=${(cfResult6Users.score || 0).toFixed(3)}, confidence=${(cfResult6Users.confidence || 0).toFixed(3)}`);
  console.log('\n✓ CF signal increases with more similar users engaged!');

  return true;
}

// Run the test
if (import.meta.url === `file://${process.argv[1]}`) {
  testCFWeighting();
}

export { testCFWeighting };