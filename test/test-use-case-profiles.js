/**
 * Test use case profiles for survey_opinion and preference_ranking
 */

import { Scorer } from '../core/scorer.js';
import { swarmRank } from '../core/swarm.js';
import { KnowledgeGraph } from '../core/kg.js';
import { USE_CASE_CONFIGS } from '../core/types.js';

// Test data
const testStories = [
  {
    id: 'story1',
    title: 'New Study Shows Coffee Benefits',
    summary: 'Research indicates coffee may improve cognitive function',
    topics: ['health', 'science', 'lifestyle'],
    source: 'healthnews',
    published_at: new Date().toISOString(),
    actionability: 0.3,
    novelty: 0.7
  },
  {
    id: 'story2',
    title: 'Political Opinion Poll Results',
    summary: 'Latest polling data on upcoming election preferences',
    topics: ['politics', 'polling', 'elections'],
    source: 'politico',
    published_at: new Date().toISOString(),
    actionability: 0.1,
    novelty: 0.2
  },
  {
    id: 'story3',
    title: 'Movie Review: Latest Blockbuster',
    summary: 'Comprehensive review of the new action movie',
    topics: ['entertainment', 'movies', 'reviews'],
    source: 'moviecritic',
    published_at: new Date().toISOString(),
    actionability: 0.2,
    novelty: 0.5
  }
];

// Mock KG with user preferences
const mockKG = {
  user: {
    id: 'test_user',
    interests: [
      { topic: 'health', weight: 0.8, last_boost: new Date() },
      { topic: 'movies', weight: 0.6, last_boost: new Date() },
      { topic: 'politics', weight: 0.3, last_boost: new Date() }
    ],
    preferences: [
      { topic: 'health', strength: 0.9 },
      { topic: 'entertainment', strength: 0.8 },
      { topic: 'politics', strength: 0.4 }
    ],
    beliefs: [
      { topic: 'science', alignment: 0.9 },
      { topic: 'health', alignment: 0.8 }
    ],
    identity_markers: [
      { category: 'profession', value: 'researcher', relevance: 0.8 }
    ]
  },
  getUser: () => mockKG.user,
  getInterests: () => mockKG.user.interests
};

async function testUseCaseProfiles() {
  console.log('Testing use case profiles...\n');

  // Test 1: Verify USE_CASE_CONFIGS contains new profiles
  console.log('1. Checking USE_CASE_CONFIGS:');
  console.log('survey_opinion exists:', !!USE_CASE_CONFIGS.survey_opinion);
  console.log('preference_ranking exists:', !!USE_CASE_CONFIGS.preference_ranking);

  if (USE_CASE_CONFIGS.survey_opinion) {
    console.log('survey_opinion weights:', USE_CASE_CONFIGS.survey_opinion.initialWeights);
  }
  if (USE_CASE_CONFIGS.preference_ranking) {
    console.log('preference_ranking weights:', USE_CASE_CONFIGS.preference_ranking.initialWeights);
  }
  console.log('');

  // Test 2: swarmRank with useCase parameter
  console.log('2. Testing swarmRank with useCase parameter:');

  try {
    const defaultRanked = swarmRank(testStories, mockKG);
    console.log('Default ranking scores:', defaultRanked.map(s => ({
      id: s.story?.id || s.id,
      score: s.score || s.relevance_score
    })));

    const surveyRanked = swarmRank(testStories, mockKG, { useCase: 'survey_opinion' });
    console.log('Survey opinion ranking scores:', surveyRanked.map(s => ({
      id: s.story?.id || s.id,
      score: s.score || s.relevance_score
    })));

    const prefRanked = swarmRank(testStories, mockKG, { useCase: 'preference_ranking' });
    console.log('Preference ranking scores:', prefRanked.map(s => ({
      id: s.story?.id || s.id,
      score: s.score || s.relevance_score
    })));
  } catch (error) {
    console.error('swarmRank test failed:', error.message);
  }
  console.log('');

  // Test 3: Scorer.rank method
  console.log('3. Testing Scorer.rank method:');

  try {
    const scorer = new Scorer(mockKG);

    const defaultScored = await scorer.rank(testStories);
    console.log('Default scorer ranking scores:', defaultScored.slice(0, 3).map(s => ({
      id: s.id,
      score: s.relevance_score
    })));

    const surveyScored = await scorer.rank(testStories, { useCase: 'survey_opinion' });
    console.log('Survey opinion scorer ranking:', surveyScored.slice(0, 3).map(s => ({
      id: s.id,
      score: s.relevance_score
    })));

    const prefScored = await scorer.rank(testStories, { useCase: 'preference_ranking' });
    console.log('Preference ranking scorer ranking:', prefScored.slice(0, 3).map(s => ({
      id: s.id,
      score: s.relevance_score
    })));
  } catch (error) {
    console.error('Scorer.rank test failed:', error.message);
  }
  console.log('');

  console.log('✅ Use case profile testing complete!');
}

// Run the test
testUseCaseProfiles().catch(console.error);