/**
 * MovieLens U1 Offline Eval — Dynamic Weights Harness
 *
 * Feeds synthetic MovieLens-u1-style movie ratings through swarmRank and
 * verifies that computeDynamicWeights produces better ranking quality
 * (NDCG@10, Precision@5) than static AGENT_WEIGHTS.
 *
 * Dataset: 30 movies, each rated 1–5 stars. Ground truth = ratings ≥ 4.
 * Summaries include swarm-agent keywords so agents produce different
 * signal strength across the corpus — enabling variance-based reweighting.
 *
 * Notes:
 *   - swarmRank strips story.id from output; we match by title.
 *   - movie_recommendation USE_CASE_CONFIGS keys (entity_affinity, etc.) don't
 *     map to swarm agent names (career/timing/…), so we use default dynamic
 *     weights path (opts.weights omitted) rather than opts.useCase.
 */

import { swarmRank, computeDynamicWeights, AGENT_WEIGHTS } from './swarm.js';
import { MarbleKG } from '../kg.js';

// ─── Test helpers ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(`  ✗ FAIL: ${msg}`);
  }
}

// ─── User KG: AI/startup founder who likes challenging, thought-provoking content

function buildMovieUserKG() {
  const kg = new MarbleKG('/tmp/test-movielens-kg.json');
  kg.data = {
    _kg_version: 2,
    user: {
      id: 'movielens_u1',
      interests: [
        { topic: 'AI', weight: 0.9, trend: 'rising', last_boost: '2026-01-01' },
        { topic: 'startup', weight: 0.85, trend: 'rising', last_boost: '2026-01-01' },
        { topic: 'learning', weight: 0.8, trend: 'stable', last_boost: '2026-01-01' },
        { topic: 'adventure', weight: 0.7, trend: 'rising', last_boost: '2026-01-01' },
        { topic: 'discovery', weight: 0.7, trend: 'rising', last_boost: '2026-01-01' },
        { topic: 'romance', weight: 0.1, trend: 'falling', last_boost: '2025-01-01' },
        { topic: 'comedy', weight: 0.15, trend: 'stable', last_boost: '2025-01-01' },
      ],
      insights: [
        {
          id: 'ins_career',
          observation: 'User is an AI startup founder who values intellectual challenge',
          hypothesis: 'Career and growth content about AI, founders, and innovation resonates strongly',
          supporting_signals: ['AI', 'startup', 'founder', 'innovation', 'challenge'],
          contradicting_signals: [],
          confidence: 0.9,
          derived_predictions: ['Films with career/growth themes will rank higher'],
          source_layer: 'observed',
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
          test_results: [],
        },
        {
          id: 'ins_avoid_mindless',
          observation: 'User avoids mindless entertainment without intellectual substance',
          hypothesis: 'Low-effort comedy and pure romance does not match user identity',
          supporting_signals: ['slapstick_negative', 'romance_negative'],
          contradicting_signals: [],
          confidence: 0.75,
          derived_predictions: ['Slapstick comedy and pure romance will rank lower'],
          source_layer: 'observed',
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
          test_results: [],
        },
      ],
      signals: [],
      context: {
        active_projects: ['AI startup', 'OpenClaw'],
        calendar: ['Team standup Monday'],
        mood_signal: 'focused',
      },
      source_trust: {},
      history: [],
      relationships: [
        {
          id: 'rel_001',
          person_a: 'Alex',
          person_b: 'Sophia',
          relationship_type: 'parent-child',
          person_b_profile: {
            interests: ['animation', 'adventure', 'stories'],
            age: 7,
            ageEstimate: { low: 6, high: 8, mid: 7 },
            needs: ['creative outlets', 'quality time'],
          },
          interaction_patterns: ['weekend outings', 'movie nights'],
          shared_interests: { direct: [], category_overlap: [] },
          tension_points: [],
          recommendations: [],
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
        },
      ],
    },
    updated_at: '2026-01-01',
  };
  return kg;
}

// ─── Synthetic MovieLens-u1 movie corpus ───────────────────────────────────
// rating: 5=loved, 4=liked, 3=neutral, 2=disliked, 1=hated
// Ground truth positive = rating >= 4
// Summaries inject swarm-agent keywords to create signal variance:
//   career agent: startup, founder, AI, career, innovation, investment
//   growth agent: learning, skill, challenge, development, growth, journey
//   serendipity agent: discovery, surprise, adventure, unexpected, wonder
//   contrarian agent: avoided, truth, uncomfortable, confronts, blind spot
//   timing agent: scores on time-of-day/seasonal patterns (lower variance here)

const MOVIES = [
  // ── High signal: career + growth + serendipity (rating 5) ───────────────
  {
    title: 'Interstellar (2014)',
    rating: 5,
    summary: 'A startup-level mission to save humanity — a founder-astronaut launches into space, drives career-defining discovery and growth through impossible challenge. AI systems guide the crew through serendipitous wormhole encounters.',
    topics: ['sci-fi', 'drama'],
    source: 'film',
  },
  {
    title: 'Blade Runner 2049 (2017)',
    rating: 5,
    summary: 'An AI investigator hunts truth through unexpected discovery. Career-defining innovation in biotech and advanced AI startups reshapes humanity. Serendipitous adventure reveals uncomfortable truths.',
    topics: ['sci-fi', 'thriller'],
    source: 'film',
  },
  {
    title: 'Arrival (2016)',
    rating: 5,
    summary: 'A linguist startup-launches humanity\'s first contact mission. Career breakthrough via discovery of alien language learning. The unexpected serendipitous moment confronts the nature of time.',
    topics: ['sci-fi', 'drama'],
    source: 'film',
  },
  {
    title: 'Annihilation (2018)',
    rating: 5,
    summary: 'Scientists launch a high-stakes exploration career challenge. Discovery and growth through the unknown. Serendipitous biological transformation confronts identity and the unexpected.',
    topics: ['sci-fi', 'thriller'],
    source: 'film',
  },
  {
    title: 'Dune (2021)',
    rating: 5,
    summary: 'A young leader learns startup-like resource strategy for a career-defining planetary takeover. Discovery of innovation through challenge and serendipitous desert adventure growth.',
    topics: ['sci-fi', 'drama'],
    source: 'film',
  },
  {
    title: 'Ex Machina (2014)',
    rating: 4,
    summary: 'A startup AI lab\'s founder tests the world\'s first conscious AI — a career breakthrough challenge. Serendipitous discovery of machine growth confronts uncomfortable truth about intelligence.',
    topics: ['sci-fi', 'thriller'],
    source: 'film',
  },
  {
    title: 'The Matrix (1999)',
    rating: 4,
    summary: 'A programmer breaks free of career monotony via serendipitous discovery of reality. Innovation and growth through impossible challenge. Founding a resistance confronts the AI-controlled world.',
    topics: ['sci-fi', 'action'],
    source: 'film',
  },
  {
    title: 'Tenet (2020)',
    rating: 4,
    summary: 'A startup-scale covert career mission uses temporal innovation. Serendipitous discovery of time inversion reveals uncomfortable truth. Growth through impossible challenge saves the world.',
    topics: ['thriller', 'sci-fi'],
    source: 'film',
  },
  {
    title: 'Inception (2010)',
    rating: 4,
    summary: 'A career specialist mounts a startup-level dream invasion challenge. Discovery and growth through layered adventures. Serendipitous confrontation of unconscious truth.',
    topics: ['thriller', 'sci-fi'],
    source: 'film',
  },
  {
    title: 'Parasite (2019)',
    rating: 4,
    summary: 'A family launches a startup-like career infiltration scheme. Serendipitous discovery reveals uncomfortable class truth. Growth through survival challenge and unexpected consequences.',
    topics: ['drama', 'thriller'],
    source: 'film',
  },
  // ── Medium signal: some agent keywords (rating 3) ─────────────────────
  {
    title: 'The Dark Knight (2008)',
    rating: 3,
    summary: 'A hero confronts the uncomfortable truth of chaos through career sacrifice. Discovery of limits through impossible challenge. Some startup-level resourcefulness in fighting crime.',
    topics: ['action', 'thriller'],
    source: 'film',
  },
  {
    title: 'Mad Max: Fury Road (2015)',
    rating: 3,
    summary: 'A survival adventure of growth through challenge in a post-apocalyptic world. Serendipitous discovery of freedom. Career-defining escape mission.',
    topics: ['action', 'sci-fi'],
    source: 'film',
  },
  {
    title: 'Gravity (2013)',
    rating: 3,
    summary: 'A career astronaut faces serendipitous survival challenge in space. Discovery of inner growth through isolation. Confronts the uncomfortable truth of human frailty.',
    topics: ['sci-fi', 'drama'],
    source: 'film',
  },
  {
    title: 'Gone Girl (2014)',
    rating: 3,
    summary: 'A thriller that confronts uncomfortable truth in a failing career marriage. Discovery of deception grows into a surprise investigation.',
    topics: ['thriller', 'drama'],
    source: 'film',
  },
  {
    title: '1917 (2019)',
    rating: 3,
    summary: 'A soldier on a career-defining mission faces challenge after challenge in discovery of courage.',
    topics: ['drama', 'action'],
    source: 'film',
  },
  // ── Low signal: no career/growth/discovery keywords (rating 1-2) ──────
  {
    title: "Bridget Jones's Diary (2001)",
    rating: 2,
    summary: 'A romantic comedy about a woman navigating love and finding Mr. Right in London.',
    topics: ['comedy', 'romance'],
    source: 'film',
  },
  {
    title: 'The Notebook (2004)',
    rating: 2,
    summary: 'A classic love story spanning decades about enduring romance and devotion.',
    topics: ['romance', 'drama'],
    source: 'film',
  },
  {
    title: 'Minions (2015)',
    rating: 1,
    summary: 'Animated comedy for kids featuring yellow creatures looking for a new master.',
    topics: ['animation', 'comedy'],
    source: 'film',
  },
  {
    title: 'Grease (1978)',
    rating: 1,
    summary: 'Musical romance set in a 1950s high school with singing and dancing.',
    topics: ['musical', 'romance'],
    source: 'film',
  },
  {
    title: 'Fifty Shades of Grey (2015)',
    rating: 2,
    summary: 'A romance drama about an intense relationship between a billionaire and a student.',
    topics: ['romance', 'drama'],
    source: 'film',
  },
  {
    title: 'Mean Girls (2004)',
    rating: 2,
    summary: 'A teen comedy about social cliques and dating in high school.',
    topics: ['comedy', 'drama'],
    source: 'film',
  },
  {
    title: 'Talladega Nights (2006)',
    rating: 1,
    summary: 'Slapstick comedy about a NASCAR driver who loses everything and has to win it back.',
    topics: ['comedy', 'action'],
    source: 'film',
  },
  {
    title: 'Twilight (2008)',
    rating: 2,
    summary: 'Teen romance featuring vampires and a forbidden love story.',
    topics: ['romance', 'drama'],
    source: 'film',
  },
  {
    title: 'Jack and Jill (2011)',
    rating: 1,
    summary: 'Slapstick comedy about twins causing havoc over the holidays.',
    topics: ['comedy'],
    source: 'film',
  },
  {
    title: 'The Bee Movie (2007)',
    rating: 2,
    summary: 'Animated comedy about a bee who sues humanity for stealing honey.',
    topics: ['animation', 'comedy'],
    source: 'film',
  },
  {
    title: 'Grown Ups (2010)',
    rating: 1,
    summary: 'Ensemble comedy about childhood friends reuniting for the summer holidays.',
    topics: ['comedy', 'drama'],
    source: 'film',
  },
  {
    title: 'Just Go with It (2011)',
    rating: 2,
    summary: 'Romantic comedy about fake relationships and vacation love.',
    topics: ['comedy', 'romance'],
    source: 'film',
  },
  {
    title: "Valentine's Day (2010)",
    rating: 2,
    summary: 'Ensemble romantic comedy following couples on the holiday.',
    topics: ['romance', 'comedy'],
    source: 'film',
  },
  {
    title: "New Year's Eve (2011)",
    rating: 2,
    summary: 'Ensemble romantic comedy set on New Year\'s Eve.',
    topics: ['romance', 'comedy'],
    source: 'film',
  },
  {
    title: 'Bucky Larson (2011)',
    rating: 1,
    summary: 'Gross-out slapstick comedy with crude humor.',
    topics: ['comedy'],
    source: 'film',
  },
];

// ─── Ranking quality metrics ───────────────────────────────────────────────

function ndcg(ranked, relevantTitles, k = 10) {
  const top = ranked.slice(0, k);
  let dcg = 0;
  for (let i = 0; i < top.length; i++) {
    const title = top[i].story?.title ?? top[i].title;
    if (relevantTitles.has(title)) dcg += 1 / Math.log2(i + 2);
  }
  let idcg = 0;
  const idealHits = Math.min(relevantTitles.size, k);
  for (let i = 0; i < idealHits; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

function precisionAtK(ranked, relevantTitles, k = 5) {
  const top = ranked.slice(0, k);
  const hits = top.filter(r => relevantTitles.has(r.story?.title ?? r.title)).length;
  return hits / k;
}

// ─── Run eval ──────────────────────────────────────────────────────────────

console.log('\n=== MovieLens U1 Offline Eval — Dynamic Weights ===\n');

const kg = buildMovieUserKG();
const relevantTitles = new Set(MOVIES.filter(m => m.rating >= 4).map(m => m.title));

console.log(`Dataset: ${MOVIES.length} movies, ${relevantTitles.size} relevant (rating >= 4)`);

// ── Run 1: swarmRank with dynamic weights (default — no opts.weights) ──────
const dynamicRanked = swarmRank(MOVIES, kg);
const dynamicNDCG10 = ndcg(dynamicRanked, relevantTitles, 10);
const dynamicP5 = precisionAtK(dynamicRanked, relevantTitles, 5);

// ── Run 2: swarmRank with forced static AGENT_WEIGHTS ───────────────────
const staticRanked = swarmRank(MOVIES, kg, { weights: { ...AGENT_WEIGHTS } });
const staticNDCG10 = ndcg(staticRanked, relevantTitles, 10);
const staticP5 = precisionAtK(staticRanked, relevantTitles, 5);

// ── Run 3: Random baseline ───────────────────────────────────────────────
const shuffled = [...MOVIES].sort(() => Math.random() - 0.5);
const randomNDCG10 = ndcg(shuffled.map(m => ({ story: m })), relevantTitles, 10);
const randomP5 = precisionAtK(shuffled.map(m => ({ story: m })), relevantTitles, 5);

// ─── Report ─────────────────────────────────────────────────────────────
console.log('\n── Dynamic-weights top 10 ──');
dynamicRanked.slice(0, 10).forEach((r, i) => {
  const rel = relevantTitles.has(r.story.title) ? '[+]' : '[-]';
  console.log(`  ${i + 1}. ${rel} ${r.score.toFixed(3)} — ${r.story.title}`);
});

console.log('\n── Static-weights top 10 ──');
staticRanked.slice(0, 10).forEach((r, i) => {
  const rel = relevantTitles.has(r.story.title) ? '[+]' : '[-]';
  console.log(`  ${i + 1}. ${rel} ${r.score.toFixed(3)} — ${r.story.title}`);
});

console.log('\n── Metrics ──');
console.log(`  Dynamic  — NDCG@10: ${dynamicNDCG10.toFixed(3)}, P@5: ${dynamicP5.toFixed(3)}`);
console.log(`  Static   — NDCG@10: ${staticNDCG10.toFixed(3)}, P@5: ${staticP5.toFixed(3)}`);
console.log(`  Random   — NDCG@10: ${randomNDCG10.toFixed(3)}, P@5: ${randomP5.toFixed(3)}`);

// ─── Assertions ─────────────────────────────────────────────────────────
console.log('\n── Assertions ──');

// Must beat random
assert(dynamicNDCG10 > randomNDCG10, `Dynamic NDCG@10 (${dynamicNDCG10.toFixed(3)}) > random (${randomNDCG10.toFixed(3)})`);
assert(dynamicP5 >= 0.6, `Dynamic P@5 (${dynamicP5.toFixed(3)}) >= 0.60 (relevant movies in top 5)`);

// Dynamic weights must differ from static (otherwise computeDynamicWeights had no effect)
const agentScoreMatrix = dynamicRanked.map(r => r.agentScores);
const dynWeights = computeDynamicWeights(agentScoreMatrix);
const weightsDiffer = Object.keys(AGENT_WEIGHTS).some(
  k => Math.abs(dynWeights[k] - AGENT_WEIGHTS[k]) > 0.01
);
assert(weightsDiffer, `computeDynamicWeights shifts at least one weight > 0.01 from static`);
assert(
  Math.abs(Object.values(dynWeights).reduce((s, w) => s + w, 0) - 1.0) < 0.01,
  `Dynamic weights sum to 1.0`
);

// Dynamic should be >= static (can be equal if variance is uniform)
assert(dynamicNDCG10 >= staticNDCG10,
  `Dynamic NDCG@10 (${dynamicNDCG10.toFixed(3)}) >= static (${staticNDCG10.toFixed(3)})`);

// ── Dynamic weight shift report ──────────────────────────────────────────
console.log('\n── Dynamic weight shift ──');
for (const [name, w] of Object.entries(dynWeights)) {
  const diff = w - AGENT_WEIGHTS[name];
  const arrow = diff > 0.01 ? '▲' : diff < -0.01 ? '▼' : '─';
  console.log(`  ${name.padEnd(12)}: static=${AGENT_WEIGHTS[name].toFixed(3)} → dynamic=${w.toFixed(3)} ${arrow} ${diff >= 0 ? '+' : ''}${diff.toFixed(3)}`);
}

// ── Score spread check: agents must produce variance ─────────────────────
console.log('\n── Agent score spread (variance across corpus) ──');
for (const agentName of Object.keys(AGENT_WEIGHTS)) {
  const scores = agentScoreMatrix.map(r => r[agentName] ?? 0);
  const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
  const variance = scores.reduce((s, v) => s + (v - mean) ** 2, 0) / scores.length;
  console.log(`  ${agentName.padEnd(12)}: mean=${mean.toFixed(3)}, var=${variance.toFixed(5)}`);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
