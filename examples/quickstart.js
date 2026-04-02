#!/usr/bin/env node
/**
 * Marble 5-Minute Quickstart
 *
 * This example demonstrates the core Marble functionality:
 * - Initialize a Knowledge Graph for user modeling
 * - Score content items across 5 dimensions
 * - Update user interests based on interactions
 *
 * Run: node quickstart.js
 */

import { KnowledgeGraph } from '../kg.js';
import { Scorer } from '../scorer.js';
import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';

async function quickstartDemo() {
  console.log('🎯 Marble Quickstart Demo');
  console.log('=========================\n');

  // Step 1: Initialize Knowledge Graph
  console.log('1️⃣ Setting up user Knowledge Graph...');
  const dataDir = './examples/data';
  const kgPath = './examples/data/quickstart-kg.json';

  // Ensure data directory exists
  await mkdir(dataDir, { recursive: true }).catch(() => {});

  const kg = new KnowledgeGraph(kgPath);
  await kg.load();

  // Add some initial interests for demo
  if (!kg.user.interests.length) {
    kg.user.interests = [
      { topic: 'ai', weight: 0.8, last_boost: new Date().toISOString() },
      { topic: 'startups', weight: 0.6, last_boost: new Date().toISOString() },
      { topic: 'javascript', weight: 0.7, last_boost: new Date().toISOString() }
    ];
    await kg.save();
  }

  console.log(`   ✅ User model loaded with ${kg.user.interests.length} interests`);
  console.log('   📊 Current interests:');
  kg.user.interests.forEach(interest => {
    console.log(`      • ${interest.topic}: ${interest.weight.toFixed(2)}`);
  });

  // Step 2: Initialize Scorer
  console.log('\n2️⃣ Initializing Marble Scorer...');
  const scorer = new Scorer(kg, {
    userId: 'demo-user',
    enableCollaborativeFiltering: false // Disable CF for simple demo
  });
  console.log('   ✅ Scorer ready');

  // Step 3: Sample stories to score
  console.log('\n3️⃣ Scoring sample content...');
  const sampleStories = [
    {
      id: 'story-1',
      title: 'New AI Breakthrough Revolutionizes Startups',
      content: 'A revolutionary AI system is helping startups automate their business processes...',
      topics: ['ai', 'startups', 'automation'],
      source: 'TechCrunch',
      published_at: new Date().toISOString(),
      url: 'https://example.com/ai-startups'
    },
    {
      id: 'story-2',
      title: 'JavaScript Framework Wars: React vs Vue 2024',
      content: 'The latest comparison of popular JavaScript frameworks and their performance...',
      topics: ['javascript', 'react', 'vue', 'web-development'],
      source: 'Dev.to',
      published_at: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
      url: 'https://example.com/js-frameworks'
    },
    {
      id: 'story-3',
      title: 'Climate Change Impact on Global Economy',
      content: 'New research shows how climate change is affecting economic systems worldwide...',
      topics: ['climate', 'economy', 'research'],
      source: 'Reuters',
      published_at: new Date(Date.now() - 7200000).toISOString(), // 2 hours ago
      url: 'https://example.com/climate-economy'
    }
  ];

  // Score the stories
  const scoredStories = await scorer.score(sampleStories);

  console.log('   ✅ Scored 3 sample stories');
  console.log('\n📈 Results (ranked by relevance):');
  console.log('=====================================');

  scoredStories.forEach((result, index) => {
    console.log(`\n🏆 #${index + 1}: ${result.story.title}`);
    console.log(`   📊 Relevance Score: ${result.relevance_score.toFixed(3)}`);
    console.log('   📋 Breakdown:');
    console.log(`      • Interest Match: ${(result.interest_match || 0).toFixed(3)}`);
    console.log(`      • Temporal Relevance: ${(result.temporal_relevance || 0).toFixed(3)}`);
    console.log(`      • Novelty: ${(result.novelty || 0).toFixed(3)}`);
    console.log(`      • Actionability: ${(result.actionability || 0).toFixed(3)}`);
    console.log(`      • Source Trust: ${(result.source_trust || 0).toFixed(3)}`);
    console.log(`   🔗 ${result.story.url}`);
  });

  // Step 4: Simulate user interaction
  console.log('\n4️⃣ Simulating user interaction...');
  const topResult = scoredStories[0];
  const topStory = topResult.story;
  console.log(`   👍 User liked: "${topStory.title}"`);

  // Record positive reaction to boost related interests
  if (topStory.topics) {
    topStory.topics.forEach(topic => {
      kg.boostInterest(topic, 0.1);
    });
  }

  await kg.save();
  console.log('   ✅ User interests updated');

  // Show updated interests
  console.log('\n📊 Updated interests after interaction:');
  kg.user.interests.forEach(interest => {
    console.log(`   • ${interest.topic}: ${interest.weight.toFixed(2)}`);
  });

  console.log('\n🎉 Quickstart Complete!');
  console.log('\nNext steps:');
  console.log('• Check out the full documentation in docs/');
  console.log('• Try enabling collaborative filtering');
  console.log('• Integrate with your content feeds');
  console.log('• Experiment with different scoring weights');

  return {
    storiesScored: scoredStories.length,
    topStoryScore: scoredStories[0].relevance_score,
    userInterests: kg.user.interests.length
  };
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  quickstartDemo().catch(console.error);
}

export { quickstartDemo };