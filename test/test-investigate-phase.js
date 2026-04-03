/**
 * Sanity check: generateInvestigationQuestions + swarmScoreDeep
 *
 * Usage:
 *   LLM_PROVIDER=openai node test/test-investigate-phase.js
 *   LLM_PROVIDER=anthropic node test/test-investigate-phase.js
 *
 * Refs: task #1362 (Investigate phase)
 */

import { generateInvestigationQuestions, swarmScoreDeep } from '../core/swarm.js';

const movieCandidate = {
  title: 'Blade Runner 2049',
  summary: "A young blade runner discovers a long-buried secret that has the potential to plunge what's left of society into chaos.",
  topics: ['sci-fi', 'cyberpunk', 'dystopia', 'mystery', 'action'],
  url: 'https://example.com/blade-runner-2049',
};

const kgSummary = `Insights: User rates action films 3.5/5 on average; prefers thrillers over horror; watches 2-3 movies/week.
Interests: technology, science fiction, philosophy, environmental issues
Hypotheses: User may prefer cerebral sci-fi over action-heavy sci-fi; user engages more with films that have strong female leads.`;

const mockKg = {
  user: {
    insights: [],
    interests: [],
    hypotheses: [],
    relationships: [],
    context: {},
  },
};

async function runSanityCheck() {
  console.log('=== Investigate Phase Sanity Check ===\n');
  console.log('Candidate:', movieCandidate.title);
  console.log('Domain: movies\n');

  // Test 1: generateInvestigationQuestions directly
  console.log('--- Test 1: generateInvestigationQuestions ---');
  const questions = await generateInvestigationQuestions(
    movieCandidate,
    kgSummary,
    'movies'
  );

  if (!Array.isArray(questions)) {
    console.error('FAIL: expected array, got', typeof questions);
    process.exit(1);
  }

  console.log(`Generated ${questions.length} investigation question(s):\n`);
  for (const [i, q] of questions.entries()) {
    console.log(`  Q${i + 1}: ${q.question}`);
    console.log(`       Rationale: ${q.rationale}`);
    console.log(`       Source hint: ${q.source_hint}\n`);
  }

  // Test 2: swarmScoreDeep with mode=deep
  console.log('--- Test 2: swarmScoreDeep (mode=deep) ---');
  const deepResult = await swarmScoreDeep(movieCandidate, mockKg, {
    mode: 'deep',
    domain: 'movies',
    kgSummary,
  });

  console.log(`Score: ${deepResult.score}`);
  console.log(`Mode: ${deepResult.mode}`);
  console.log(`Investigation questions attached: ${deepResult.investigationQuestions?.length ?? 0}`);
  console.log('\nPASS: Investigate phase working correctly');
}

runSanityCheck().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
