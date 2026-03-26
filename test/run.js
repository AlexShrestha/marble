/**
 * MarbleSim Test Harness
 *
 * Simulates a full curation cycle with realistic stories
 * and a user profile matching Alex's context.
 */

import { MarbleSim } from '../core/index.js';
import { writeFile } from 'fs/promises';

// ── Simulated user profile ──────────────────────────────

const USER_PROFILE = {
  id: 'alex',
  interests: [
    { topic: 'ai', weight: 0.9, last_boost: new Date(Date.now() - 86400000).toISOString(), trend: 'stable' },
    { topic: 'shopify', weight: 0.85, last_boost: new Date(Date.now() - 172800000).toISOString(), trend: 'rising' },
    { topic: 'video generation', weight: 0.8, last_boost: new Date(Date.now() - 86400000).toISOString(), trend: 'rising' },
    { topic: 'startups', weight: 0.75, last_boost: new Date(Date.now() - 259200000).toISOString(), trend: 'stable' },
    { topic: 'coaching', weight: 0.6, last_boost: new Date(Date.now() - 432000000).toISOString(), trend: 'stable' },
    { topic: 'crypto', weight: 0.3, last_boost: new Date(Date.now() - 1209600000).toISOString(), trend: 'falling' },
    { topic: 'spain', weight: 0.5, last_boost: new Date(Date.now() - 345600000).toISOString(), trend: 'stable' },
    { topic: 'product photography', weight: 0.7, last_boost: new Date(Date.now() - 172800000).toISOString(), trend: 'rising' },
    { topic: 'llm', weight: 0.85, last_boost: new Date(Date.now() - 86400000).toISOString(), trend: 'rising' },
    { topic: 'ecommerce', weight: 0.7, last_boost: new Date(Date.now() - 259200000).toISOString(), trend: 'stable' },
  ],
  context: {
    active_projects: ['AhaRoll', 'SuperstateX', 'ContentApp', 'Prism'],
    calendar: ['Team standup 10:00', 'Investor call 14:00', 'Gym 18:00'],
    recent_conversations: ['video pipeline GPU', 'Shopify app review', 'knowledge graph'],
    mood_signal: 'high energy'
  },
  history: [
    { story_id: 'old-1', reaction: 'up', date: new Date(Date.now() - 86400000).toISOString(), topics: ['ai', 'llm'], source: 'hackernews' },
    { story_id: 'old-2', reaction: 'up', date: new Date(Date.now() - 86400000).toISOString(), topics: ['shopify', 'ecommerce'], source: 'techcrunch' },
    { story_id: 'old-3', reaction: 'down', date: new Date(Date.now() - 86400000).toISOString(), topics: ['crypto', 'nft'], source: 'coindesk' },
    { story_id: 'old-4', reaction: 'share', date: new Date(Date.now() - 172800000).toISOString(), topics: ['ai', 'video generation'], source: 'arxiv' },
    { story_id: 'old-5', reaction: 'up', date: new Date(Date.now() - 172800000).toISOString(), topics: ['startups', 'spain'], source: 'sifted' },
    { story_id: 'old-6', reaction: 'skip', date: new Date(Date.now() - 259200000).toISOString(), topics: ['politics'], source: 'bbc' },
    { story_id: 'old-7', reaction: 'up', date: new Date(Date.now() - 259200000).toISOString(), topics: ['coaching', 'productivity'], source: 'substack' },
  ],
  source_trust: {
    'hackernews': 0.85,
    'techcrunch': 0.7,
    'arxiv': 0.9,
    'substack': 0.65,
    'sifted': 0.6,
    'bbc': 0.5,
    'coindesk': 0.3,
    'producthunt': 0.75,
    'reuters': 0.8,
    'theverge': 0.55
  }
};

// ── 30 simulated stories (realistic mix) ──────────────

const STORIES = [
  // High relevance — career/project
  { id: 's1', title: 'Shopify announces new AI-powered product photography API', summary: 'Merchants can now generate lifestyle product photos directly from the Shopify admin. Free for Plus merchants, $0.10/image for others.', source: 'techcrunch', topics: ['shopify', 'ai', 'product photography'], published_at: new Date(Date.now() - 3600000).toISOString(), valence: 'inspiring' },
  { id: 's2', title: 'Claude 4.5 Opus released with 2M context window', summary: 'Anthropic launches its most capable model yet. 2x faster, native tool use, and 2M context. Available today via API.', source: 'techcrunch', topics: ['ai', 'llm'], published_at: new Date(Date.now() - 7200000).toISOString(), valence: 'inspiring' },
  { id: 's3', title: 'Y Combinator W26 batch includes 3 AI video startups', summary: 'Three startups in the latest batch focus on AI-generated video for ecommerce, real estate, and social media.', source: 'hackernews', topics: ['startups', 'ai', 'video generation'], published_at: new Date(Date.now() - 14400000).toISOString(), valence: 'neutral' },

  // High relevance — timing
  { id: 's4', title: 'How to nail your investor pitch in 2026', summary: 'Updated framework from First Round Capital on what VCs actually look for. Focus on TAM narrative and AI-native positioning.', source: 'substack', topics: ['startups', 'fundraising'], published_at: new Date(Date.now() - 28800000).toISOString(), valence: 'inspiring', actionability: 0.9 },
  { id: 's5', title: 'Barcelona named #1 tech hub in Southern Europe for 2026', summary: 'Startup Genome report ranks BCN ahead of Lisbon and Milan. 47% growth in VC funding YoY.', source: 'sifted', topics: ['startups', 'spain', 'barcelona'], published_at: new Date(Date.now() - 18000000).toISOString(), valence: 'inspiring' },

  // Medium relevance — growth/stretch
  { id: 's6', title: 'Knowledge graphs are making a comeback in the age of RAG', summary: 'Why vector databases alone aren\'t enough. How companies are combining KGs with embeddings for better retrieval.', source: 'arxiv', topics: ['ai', 'knowledge graph'], published_at: new Date(Date.now() - 10800000).toISOString(), valence: 'neutral' },
  { id: 's7', title: 'The rise of personal AI agents: from GPT wrappers to real autonomy', summary: 'Deep dive into what separates toy agents from production ones. Memory, tool use, and multi-session persistence.', source: 'substack', topics: ['ai', 'agents'], published_at: new Date(Date.now() - 21600000).toISOString(), valence: 'neutral' },
  { id: 's8', title: 'NVIDIA H200 supply constraints ease, GPU prices drop 30%', summary: 'Cloud GPU costs falling fast. Implication for AI startups running inference workloads.', source: 'reuters', topics: ['ai', 'gpu', 'infrastructure'], published_at: new Date(Date.now() - 14400000).toISOString(), valence: 'neutral' },

  // Contrarian / surprise
  { id: 's9', title: 'Why most AI startups will fail: the distribution problem nobody talks about', summary: 'Building AI is easy. Getting it into the hands of paying customers is where 90% die. Analysis of 200 failed AI startups.', source: 'hackernews', topics: ['startups', 'ai'], published_at: new Date(Date.now() - 36000000).toISOString(), valence: 'alarming' },
  { id: 's10', title: 'EU Digital Markets Act update: new compliance rules for app stores', summary: 'Shopify App Store, Apple, Google all affected. New transparency requirements starting Q3 2026.', source: 'reuters', topics: ['ecommerce', 'regulation', 'shopify'], published_at: new Date(Date.now() - 25200000).toISOString(), valence: 'alarming' },

  // Serendipity / human
  { id: 's11', title: 'The 4am club is dead: why the best founders sleep 8 hours', summary: 'New Stanford study links founder burnout to sleep debt. Top performers average 7.8h. The hustle culture myth debunked with data.', source: 'substack', topics: ['coaching', 'productivity', 'health'], published_at: new Date(Date.now() - 43200000).toISOString(), valence: 'inspiring' },
  { id: 's12', title: 'A father built an AI tutor for his daughter. It now has 50K users.', summary: 'Side project to production: how one dad\'s weekend hack became an edtech startup. Built with Claude and Supabase.', source: 'producthunt', topics: ['ai', 'startups', 'family'], published_at: new Date(Date.now() - 50400000).toISOString(), valence: 'fun' },

  // Noise — should be filtered out
  { id: 's13', title: 'Bitcoin hits $150K as ETF inflows surge', summary: 'Institutional buying continues. BlackRock\'s IBIT leads with $2B in weekly inflows.', source: 'coindesk', topics: ['crypto', 'bitcoin'], published_at: new Date(Date.now() - 7200000).toISOString(), valence: 'neutral' },
  { id: 's14', title: 'Taylor Swift announces world tour 2027', summary: 'The Eras Tour sequel. 80 cities, starting January 2027.', source: 'bbc', topics: ['entertainment', 'music'], published_at: new Date(Date.now() - 14400000).toISOString(), valence: 'fun' },
  { id: 's15', title: 'Global wheat prices rise 12% amid drought fears', summary: 'Climate impact on agriculture. USDA revises forecasts downward.', source: 'reuters', topics: ['agriculture', 'climate'], published_at: new Date(Date.now() - 28800000).toISOString(), valence: 'alarming' },
  { id: 's16', title: 'New React Server Components pattern for data fetching', summary: 'Meta introduces a new pattern combining RSC with streaming. Reduces bundle size by 40%.', source: 'hackernews', topics: ['react', 'web development'], published_at: new Date(Date.now() - 36000000).toISOString(), valence: 'neutral' },
  { id: 's17', title: 'Best restaurants in Barcelona 2026', summary: 'Time Out ranks the 50 best spots. Three new Michelin entries in Eixample.', source: 'theverge', topics: ['spain', 'barcelona', 'food'], published_at: new Date(Date.now() - 57600000).toISOString(), valence: 'fun' },

  // More career-relevant
  { id: 's18', title: 'Shopify App Store review times drop to 48 hours', summary: 'New automated review pipeline. Apps with clean code get fast-tracked. Breaking for developers waiting on approval.', source: 'hackernews', topics: ['shopify', 'ecommerce'], published_at: new Date(Date.now() - 5400000).toISOString(), valence: 'inspiring', actionability: 0.8 },
  { id: 's19', title: 'Lip-sync video generation hits real-time speeds on consumer GPUs', summary: 'New open-source model achieves 30fps lip-sync on RTX 4090. Implications for personalized video at scale.', source: 'arxiv', topics: ['ai', 'video generation', 'gpu'], published_at: new Date(Date.now() - 10800000).toISOString(), valence: 'inspiring' },
  { id: 's20', title: 'How I got my first 100 Shopify app users in 30 days', summary: 'Founder teardown: cold outreach, app store SEO, and one viral Reddit post that changed everything.', source: 'substack', topics: ['shopify', 'ecommerce', 'startups'], published_at: new Date(Date.now() - 32400000).toISOString(), valence: 'inspiring', actionability: 0.85 },

  // More noise
  { id: 's21', title: 'Samsung Galaxy S27 leaked specs', summary: 'Snapdragon 9 Gen 4, 200MP camera, satellite messaging.', source: 'theverge', topics: ['mobile', 'hardware'], published_at: new Date(Date.now() - 43200000).toISOString(), valence: 'neutral' },
  { id: 's22', title: 'Netflix Q1 earnings beat expectations', summary: 'Subscriber growth +8M. Password sharing crackdown continues to drive signups.', source: 'reuters', topics: ['streaming', 'business'], published_at: new Date(Date.now() - 50400000).toISOString(), valence: 'neutral' },
  { id: 's23', title: 'UK general election: polls tighten ahead of May vote', summary: 'Labour lead narrows to 3 points. Reform UK surging in northern seats.', source: 'bbc', topics: ['politics', 'uk'], published_at: new Date(Date.now() - 36000000).toISOString(), valence: 'neutral' },

  // Edge cases — adjacent/growth
  { id: 's24', title: 'Notion launches AI-powered project management', summary: 'Competes with Linear and Jira. Auto-generates tasks from meeting notes. Free for teams under 10.', source: 'producthunt', topics: ['productivity', 'ai', 'project management'], published_at: new Date(Date.now() - 14400000).toISOString(), valence: 'neutral', actionability: 0.6 },
  { id: 's25', title: 'The loneliness epidemic among male founders', summary: 'Harvard study: 68% of male founders report chronic loneliness. How peer groups and coaching are filling the gap.', source: 'substack', topics: ['coaching', 'startups', 'mental health'], published_at: new Date(Date.now() - 43200000).toISOString(), valence: 'alarming' },

  // More signal
  { id: 's26', title: 'Etsy seller toolkit: 5 AI tools that actually work', summary: 'Tested by top sellers. Photo enhancement, listing optimization, and trend prediction.', source: 'substack', topics: ['ecommerce', 'ai', 'etsy'], published_at: new Date(Date.now() - 21600000).toISOString(), valence: 'neutral', actionability: 0.7 },
  { id: 's27', title: 'Open source TTS models now rival ElevenLabs quality', summary: 'Coqui XTTS v3 and MetaVoice 2.0 benchmarks. Deployable locally, no API costs.', source: 'hackernews', topics: ['ai', 'tts', 'open source'], published_at: new Date(Date.now() - 10800000).toISOString(), valence: 'inspiring' },
  { id: 's28', title: 'Spain introduces digital nomad tax incentive extension', summary: 'Beckham Law extended to 10 years. Flat 24% rate now applies to remote workers earning under €600K.', source: 'sifted', topics: ['spain', 'tax', 'digital nomad'], published_at: new Date(Date.now() - 28800000).toISOString(), valence: 'inspiring', actionability: 0.8 },
  { id: 's29', title: 'Why your AI product needs a personality, not just features', summary: 'User retention study: AI products with consistent personality see 3x retention. How to design AI character.', source: 'substack', topics: ['ai', 'product design', 'ux'], published_at: new Date(Date.now() - 25200000).toISOString(), valence: 'neutral' },
  { id: 's30', title: 'Mediterranean diet linked to 40% reduction in cognitive decline', summary: 'Largest study to date: 12,000 participants over 8 years. Olive oil and fish are the key drivers.', source: 'bbc', topics: ['health', 'spain', 'science'], published_at: new Date(Date.now() - 57600000).toISOString(), valence: 'inspiring' },
];

// ── Run both modes and compare ──────────────────────────

async function run() {
  // Write the user profile as KG data
  const kgData = { user: USER_PROFILE, updated_at: new Date().toISOString() };
  await writeFile('./test/test-kg.json', JSON.stringify(kgData, null, 2));

  console.log(`\n${'='.repeat(70)}`);
  console.log('PRISM TEST HARNESS');
  console.log(`${'='.repeat(70)}`);
  console.log(`Stories: ${STORIES.length} | User: ${USER_PROFILE.id}`);
  console.log(`Calendar: ${USER_PROFILE.context.calendar.join(', ')}`);
  console.log(`Projects: ${USER_PROFILE.context.active_projects.join(', ')}`);
  console.log(`${'='.repeat(70)}\n`);

  // ── v1: Score mode ──
  console.log('── v1: SCORE MODE ──────────────────────────────────────\n');
  const marbleSimV1 = new MarbleSim({ dataPath: './test/test-kg.json', mode: 'score' });
  const v1Results = await marbleSimV1.select(STORIES);

  for (const r of v1Results) {
    console.log(`  ${r.arc_position.toString().padStart(2)}. [${r.magic_score.toFixed(3)}] ${r.story.title}`);
    console.log(`      ${r.why || 'general relevance'}`);
    console.log(`      Topics: ${(r.story.topics || []).join(', ')} | Source: ${r.story.source}`);
    console.log('');
  }

  // ── v2: Swarm mode ──
  console.log('── v2: SWARM MODE (fast) ───────────────────────────────\n');
  const marbleSimV2 = new MarbleSim({ dataPath: './test/test-kg.json', mode: 'swarm' });
  const v2Results = await marbleSimV2.select(STORIES);

  for (const r of v2Results) {
    const agentScores = r.agent_scores
      ? Object.entries(r.agent_scores).map(([a, s]) => `${a.replace(' Agent', '')}:${(s * 100).toFixed(0)}`).join(' ')
      : '';
    console.log(`  ${r.arc_position.toString().padStart(2)}. [${r.magic_score.toFixed(3)}] ${r.story.title}`);
    console.log(`      ${r.why || 'general relevance'}`);
    if (agentScores) console.log(`      Agents: ${agentScores}`);
    console.log('');
  }

  // ── Comparison ──
  console.log('── COMPARISON ──────────────────────────────────────────\n');
  const v1Ids = new Set(v1Results.map(r => r.story.id));
  const v2Ids = new Set(v2Results.map(r => r.story.id));
  const overlap = [...v1Ids].filter(id => v2Ids.has(id));
  const v1Only = [...v1Ids].filter(id => !v2Ids.has(id));
  const v2Only = [...v2Ids].filter(id => !v1Ids.has(id));

  console.log(`  Overlap: ${overlap.length}/10 stories selected by both modes`);
  if (v1Only.length) {
    console.log(`  Score-only picks: ${v1Only.map(id => STORIES.find(s => s.id === id).title.slice(0, 50)).join(', ')}`);
  }
  if (v2Only.length) {
    console.log(`  Swarm-only picks: ${v2Only.map(id => STORIES.find(s => s.id === id).title.slice(0, 50)).join(', ')}`);
  }

  // ── Noise check: these should NOT be selected ──
  const noise = ['s14', 's21', 's22', 's23']; // Taylor Swift, Samsung, Netflix, UK politics
  const v1Noise = noise.filter(id => v1Ids.has(id));
  const v2Noise = noise.filter(id => v2Ids.has(id));
  console.log(`\n  Noise leak (should be 0): v1=${v1Noise.length}, v2=${v2Noise.length}`);

  console.log(`\n${'='.repeat(70)}`);
  console.log('TEST COMPLETE');
  console.log(`${'='.repeat(70)}\n`);
}

run().catch(console.error);
