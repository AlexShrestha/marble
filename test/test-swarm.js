/**
 * test-swarm.js — Tests for the 5-agent relationship-aware swarm
 */

import { swarmScore, swarmRank, getAgentConfig, AGENT_WEIGHTS, buildSwarmContext } from './swarm.js';
import { MarbleKG } from '../kg.js';

// ─── TEST HELPERS ──────────────────────────────────────────────────────────

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

function buildTestKG() {
  const kg = new MarbleKG('/tmp/test-swarm-kg.json');
  kg.data = {
    _kg_version: 2,
    user: {
      id: 'alex',
      interests: [
        { topic: 'AI', weight: 0.9, trend: 'rising', last_boost: '2026-03-25' },
        { topic: 'startup', weight: 0.85, trend: 'stable', last_boost: '2026-03-24' },
        { topic: 'fitness', weight: 0.7, trend: 'rising', last_boost: '2026-03-25' },
        { topic: 'parenting', weight: 0.5, trend: 'rising', last_boost: '2026-03-24' },
      ],
      insights: [
        {
          id: 'ins_career_1',
          observation: 'User is a startup founder building AI products',
          hypothesis: 'Career-driven content about AI startups will resonate',
          supporting_signals: ['startup', 'AI', 'founder'],
          contradicting_signals: [],
          confidence: 0.8,
          derived_predictions: ['Content about AI startup funding will be well-received'],
          source_layer: 'observed',
          created_at: '2026-03-20',
          updated_at: '2026-03-25',
          test_results: [],
        },
        {
          id: 'ins_family_1',
          observation: 'User has a daughter and values family time',
          hypothesis: 'Family-related content influences career and lifestyle choices',
          supporting_signals: ['family', 'parenting', 'daughter'],
          contradicting_signals: [],
          confidence: 0.7,
          derived_predictions: ['User prefers work-life balance content'],
          source_layer: 'observed',
          created_at: '2026-03-20',
          updated_at: '2026-03-25',
          test_results: [],
        },
        {
          id: 'ins_avoid_1',
          observation: 'User skips emotional wellness content',
          hypothesis: 'Emotional content does not match current self-image',
          supporting_signals: ['self-help'],
          contradicting_signals: ['emotions_negative', 'mental health_negative'],
          confidence: 0.5,
          derived_predictions: ['User will skip articles about emotional awareness'],
          source_layer: 'synthetic',
          created_at: '2026-03-22',
          updated_at: '2026-03-25',
          test_results: [],
        },
      ],
      signals: [],
      context: {
        active_projects: ['OpenClaw', 'VIVO'],
        calendar: ['Team standup 10am', 'Daughter piano recital Saturday'],
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
            interests: ['drawing', 'stories', 'outdoor play', 'music'],
            age: 7,
            ageEstimate: { low: 6, high: 8, mid: 7 },
            needs: ['homework support', 'creative outlets', 'quality time'],
          },
          interaction_patterns: ['weekend outings', 'bedtime stories', 'school pickup'],
          shared_interests: { direct: ['music'], category_overlap: [{ category: 'outdoor', person_a: ['fitness'], person_b: ['outdoor play'] }] },
          tension_points: [
            { type: 'time_competition', description: 'Career focus competes with daughter time', severity: 'medium', suggestion: 'Schedule dedicated family time' },
          ],
          recommendations: [],
          created_at: '2026-03-20',
          updated_at: '2026-03-25',
        },
        {
          id: 'rel_002',
          person_a: 'Alex',
          person_b: 'Partner',
          relationship_type: 'partner',
          person_b_profile: {
            interests: ['yoga', 'cooking', 'travel', 'reading'],
            needs: ['quality time', 'communication', 'shared experiences'],
          },
          interaction_patterns: ['weekly date night', 'morning coffee together'],
          shared_interests: { direct: [], category_overlap: [{ category: 'fitness', person_a: ['fitness'], person_b: ['yoga'] }] },
          tension_points: [],
          recommendations: [],
          created_at: '2026-03-20',
          updated_at: '2026-03-25',
        },
      ],
    },
    updated_at: '2026-03-25',
  };
  return kg;
}

// ─── TESTS ─────────────────────────────────────────────────────────────────

console.log('\n=== Swarm Agent Tests ===\n');

// Test 1: Agent weights sum to 1.0
console.log('1. Agent configuration');
const config = getAgentConfig();
assert(config.totalWeight === 1.0, `Agent weights sum to 1.0 (got ${config.totalWeight})`);
assert(config.agents.length === 5, `5 agents configured (got ${config.agents.length})`);
assert(config.agents.every(a => a.description), 'All agents have descriptions');

// Test 2: Basic scoring works
console.log('\n2. Basic swarm scoring');
const kg = buildTestKG();

const aiStory = {
  title: 'AI Startup Raises $50M to Build Autonomous Agents',
  summary: 'A new AI startup focused on autonomous agents has raised funding.',
  topics: ['AI', 'startup', 'funding'],
  source: 'TechCrunch',
};

const result = swarmScore(aiStory, kg);
assert(typeof result.score === 'number', `Score is a number: ${result.score}`);
assert(result.score > 0, `Career-relevant story scores > 0: ${result.score}`);
assert(result.agentScores.career !== undefined, 'Career agent score present');
assert(result.agentScores.timing !== undefined, 'Timing agent score present');
assert(result.agentScores.serendipity !== undefined, 'Serendipity agent score present');
assert(result.agentScores.growth !== undefined, 'Growth agent score present');
assert(result.agentScores.contrarian !== undefined, 'Contrarian agent score present');
assert(result.reasons.length > 0, `Has reasons: ${result.reasons.length}`);

// Test 3: Career agent adjusts for parent responsibilities
console.log('\n3. Career agent — relationship awareness');

const hustleStory = {
  title: 'Why You Need to Grind 80-Hour Weeks to Succeed',
  summary: 'Hustle culture and working 80-hour weeks is the path to startup success.',
  topics: ['startup', 'career'],
};

const balanceStory = {
  title: 'Building a Sustainable Startup with Work-Life Balance',
  summary: 'How to build a successful startup with remote work and flexible hours while being a great parent.',
  topics: ['startup', 'career', 'work-life balance'],
};

const hustleResult = swarmScore(hustleStory, kg);
const balanceResult = swarmScore(balanceStory, kg);

assert(
  balanceResult.agentScores.career > hustleResult.agentScores.career,
  `Balance story career score (${balanceResult.agentScores.career.toFixed(3)}) > hustle story (${hustleResult.agentScores.career.toFixed(3)}) for parent`
);

const balanceCareerReasons = balanceResult.reasons.filter(r => r.agent === 'career');
assert(
  balanceCareerReasons.some(r => r.reason.includes('Family-aware') || r.reason.includes('Sustainable') || r.reason.includes('relationship')),
  'Career agent mentions family/relationship awareness'
);

// Test 4: Timing agent uses relationship calendar
console.log('\n4. Timing agent — relationship calendar');

const schoolBreakStory = {
  title: 'Best Summer Camp Activities for Kids',
  summary: 'Fun camp and vacation activities for families during school break.',
  topics: ['family', 'kids', 'activities'],
};

const summerDate = new Date('2026-07-15T10:00:00'); // school break
const summerResult = swarmScore(schoolBreakStory, kg, { date: summerDate });
assert(
  summerResult.agentScores.timing > 0,
  `School break content scores in timing during summer: ${summerResult.agentScores.timing.toFixed(3)}`
);

const timingReasons = summerResult.reasons.filter(r => r.agent === 'timing');
assert(
  timingReasons.some(r => r.reason.includes('Sophia') || r.reason.includes('break') || r.reason.includes('school')),
  'Timing agent references child/school schedule'
);

// Test 5: Serendipity agent suggests relationship-relevant surprises
console.log('\n5. Serendipity agent — relationship surprises');

const sharedActivityStory = {
  title: 'Science Museum Opens New Interactive Exhibit for Kids',
  summary: 'A science museum has opened a family activity exhibit perfect for kids event.',
  topics: ['science', 'museum', 'family activity'],
};

const serendipityResult = swarmScore(sharedActivityStory, kg);
assert(
  serendipityResult.agentScores.serendipity > 0,
  `Shared activity story triggers serendipity: ${serendipityResult.agentScores.serendipity.toFixed(3)}`
);

const serendipityReasons = serendipityResult.reasons.filter(r => r.agent === 'serendipity');
assert(
  serendipityReasons.some(r => r.reason.includes('Sophia') || r.reason.includes('age') || r.reason.includes('activity')),
  'Serendipity agent suggests age-appropriate activity'
);

// Test 6: Growth agent considers relational growth
console.log('\n6. Growth agent — relationship context');

const parentingGrowthStory = {
  title: 'Positive Discipline: A Guide for Modern Parents',
  summary: 'Learn parenting techniques for emotional intelligence and quality time with your child.',
  topics: ['parenting', 'child development'],
};

const growthResult = swarmScore(parentingGrowthStory, kg);
assert(
  growthResult.agentScores.growth > 0,
  `Parenting growth content scores: ${growthResult.agentScores.growth.toFixed(3)}`
);

const growthReasons = growthResult.reasons.filter(r => r.agent === 'growth');
assert(
  growthReasons.some(r => r.reason.includes('Parenting') || r.reason.includes('Sophia')),
  'Growth agent considers parenting relationship'
);

// Test 7: Contrarian agent surfaces relationship blind spots
console.log('\n7. Contrarian agent — relationship blind spots');

const emotionalStory = {
  title: 'Why Founders Need to Talk About Their Emotions and Mental Health',
  summary: 'Emotional awareness and mental health are critical for founders and parents.',
  topics: ['mental health', 'emotions', 'founders'],
};

const contrarianResult = swarmScore(emotionalStory, kg);
assert(
  contrarianResult.agentScores.contrarian > 0,
  `Contrarian scores emotional content for parent who avoids it: ${contrarianResult.agentScores.contrarian.toFixed(3)}`
);

const contrarianReasons = contrarianResult.reasons.filter(r => r.agent === 'contrarian');
assert(
  contrarianReasons.some(r => r.reason.includes('Emotional') || r.reason.includes('blind spot') || r.reason.includes('parent')),
  'Contrarian surfaces emotional awareness need'
);

// Test 8: swarmRank orders correctly
console.log('\n8. Ranking');
const stories = [aiStory, hustleStory, balanceStory, sharedActivityStory, parentingGrowthStory, emotionalStory];
const ranked = swarmRank(stories, kg);
assert(ranked.length === stories.length, `Ranked all ${stories.length} stories`);
assert(ranked[0].score >= ranked[ranked.length - 1].score, 'Ranking is descending by score');

for (const r of ranked) {
  console.log(`    ${r.score.toFixed(3)} — ${r.story.title?.slice(0, 60)}`);
}

// Test 9: Context builder includes relationship data
console.log('\n9. Context builder');
const ctx = buildSwarmContext(kg);
assert(ctx.relationships.length === 2, `Found ${ctx.relationships.length} relationships`);
assert(Object.keys(ctx.archetypes).length === 2, `Built ${Object.keys(ctx.archetypes).length} archetype profiles`);
assert(ctx.archetypes['Sophia']?.relationship_type === 'parent-child', 'Sophia archetype is parent-child');
assert(ctx.archetypes['Partner']?.relationship_type === 'partner', 'Partner archetype is partner');
assert(ctx.insights.length > 0, 'Insights loaded');
assert(ctx.interests.length > 0, 'Interests loaded');

// ─── SUMMARY ───────────────────────────────────────────────────────────────

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
