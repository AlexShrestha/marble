/**
 * Test: Secondary Context Collection Engine
 *
 * Tests:
 * 1. Movie domain — rate 3 movies → question-engine generates follow-ups → answers stored as KG nodes
 * 2. Implicit extraction — rate 5 Nolan films → era + director preferences auto-inferred
 * 3. API surface works end-to-end
 */

import { KnowledgeGraph } from './kg.js';
import { QuestionEngine } from './question-engine.js';
import { detectDomain } from './domain-schemas.js';
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';

const TEST_KG_PATH = join(import.meta.dirname || '.', 'data', 'test-secondary-kg.json');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    failed++;
  }
}

async function cleanup() {
  try { await unlink(TEST_KG_PATH); } catch {}
}

// ── Test 1: Domain Detection ──────────────────────────

console.log('\n═══ Test 1: Domain Detection ═══');

assert(detectDomain({ domain: 'movie' }) === 'movie', 'Explicit domain field');
assert(detectDomain({ type: 'film' }) === 'movie', 'Type detection: film → movie');
assert(detectDomain({ tags: ['music', 'indie'] }) === 'music', 'Tags detection: music');
assert(detectDomain({ title: 'Best restaurants in NYC' }) === 'place', 'Title detection: restaurant → place');
assert(detectDomain({ title: 'Random XYZ' }) === null, 'Unknown domain returns null');

// ── Test 2: Movie Follow-Up Questions ─────────────────

console.log('\n═══ Test 2: Movie Follow-Up Questions ═══');

const kg = new KnowledgeGraph(TEST_KG_PATH);
await kg.load();

const engine = new QuestionEngine(kg);

const movie1 = { domain: 'movie', title: 'Inception', metadata: { director: 'Christopher Nolan', year: '2010', genre: 'sci-fi' } };
const movie2 = { domain: 'movie', title: 'Interstellar', metadata: { director: 'Christopher Nolan', year: '2014', genre: 'sci-fi' } };
const movie3 = { domain: 'movie', title: 'The Dark Knight', metadata: { director: 'Christopher Nolan', year: '2008', genre: 'action' } };

const q1 = engine.generateFollowUpQuestions(movie1, 5, { maxQuestions: 3 });
assert(q1.length === 3, `Generated ${q1.length} follow-up questions for movie (expected 3)`);
assert(q1[0].domain === 'movie', 'Questions tagged with movie domain');
assert(q1[0].options && q1[0].options.length > 0, 'Questions have selectable options');
assert(q1[0].id.startsWith('movie:'), 'Question IDs prefixed with domain');

// Questions should be sorted by info gain (director_style=0.9 first)
assert(q1[0].dimension === 'director_style', 'Highest info-gain dimension first');

// ── Test 3: Record Answers → KG Nodes ────────────────

console.log('\n═══ Test 3: Record Answers → KG Nodes ═══');

engine.recordSecondaryContext(movie1, 5, [
  { dimensionId: 'director_style', value: 'narrative_complexity' },
  { dimensionId: 'film_era', value: '1990s_2000s' },
  { dimensionId: 'theme_resonance', value: 'scifi_concepts' }
]);

// Check KG nodes were created
const beliefs = kg.getActiveBeliefs();
const dirBelief = beliefs.find(b => b.topic === 'director_style');
assert(dirBelief !== null && dirBelief !== undefined, 'Director style stored as belief node');
assert(dirBelief?.claim === 'narrative_complexity', 'Belief claim = narrative_complexity');

const prefs = kg.getActivePreferences();
const eraPref = prefs.find(p => p.type === 'film_era');
assert(eraPref !== null && eraPref !== undefined, 'Film era stored as preference node');
assert(eraPref?.description === '1990s_2000s', 'Preference description = 1990s_2000s');

const ids = kg.getActiveIdentities();
const themeId = ids.find(i => i.role === 'theme');
assert(themeId !== null && themeId !== undefined, 'Theme stored as identity node');
assert(themeId?.context === 'scifi_concepts', 'Identity context = scifi_concepts');

// After answering, those dimensions should not re-appear
const q2 = engine.generateFollowUpQuestions(movie2, 4, { maxQuestions: 3 });
const answeredDims = ['director_style', 'film_era', 'theme_resonance'];
const overlap = q2.filter(q => answeredDims.includes(q.dimension));
assert(overlap.length === 0, 'Answered dimensions not re-asked');

// ── Test 4: Implicit Extraction (5 Nolan Films) ──────

console.log('\n═══ Test 4: Implicit Extraction — 5 Nolan Films ═══');

const kg2 = new KnowledgeGraph(TEST_KG_PATH);
await kg2.load();
const engine2 = new QuestionEngine(kg2);

const nolanFilms = [
  { domain: 'movie', title: 'Inception', metadata: { director: 'Christopher Nolan', year: '2010', genre: 'sci-fi' } },
  { domain: 'movie', title: 'Interstellar', metadata: { director: 'Christopher Nolan', year: '2014', genre: 'sci-fi' } },
  { domain: 'movie', title: 'The Dark Knight', metadata: { director: 'Christopher Nolan', year: '2008', genre: 'action' } },
  { domain: 'movie', title: 'Memento', metadata: { director: 'Christopher Nolan', year: '2000', genre: 'thriller' } },
  { domain: 'movie', title: 'Tenet', metadata: { director: 'Christopher Nolan', year: '2020', genre: 'sci-fi' } }
];

// Rate all 5 positively
for (const film of nolanFilms) {
  engine2.extractImplicitContext(film, 4.5);
}

// Director preference should be auto-inferred (threshold=3, we have 5)
const beliefs2 = kg2.getActiveBeliefs();
const dirInferred = beliefs2.find(b => b.topic === 'director_style');
assert(dirInferred !== null && dirInferred !== undefined, 'Director style auto-inferred from 5 Nolan films');
assert(dirInferred?.claim === 'christopher nolan', 'Inferred director = christopher nolan');

// Sci-fi genre should be inferred (3+ sci-fi films)
const prefs2 = kg2.getActivePreferences();
const genreInferred = prefs2.find(p => p.type === 'genre_preference');
assert(genreInferred !== null && genreInferred !== undefined, 'Genre preference auto-inferred');
assert(genreInferred?.description === 'sci-fi', 'Inferred genre = sci-fi');

// Era inference: most films are 2000s-2010s
const eraInferred = prefs2.find(p => p.type === 'film_era');
assert(eraInferred !== null && eraInferred !== undefined, 'Era preference auto-inferred');

// Summary should show collected context
const summary = engine2.getSummary();
assert(summary.ratingHistoryCount === 5, 'Rating history has 5 entries');

// ── Test 5: API Surface Completeness ─────────────────

console.log('\n═══ Test 5: API Surface ═══');

assert(typeof engine.generateFollowUpQuestions === 'function', 'generateFollowUpQuestions exists');
assert(typeof engine.recordSecondaryContext === 'function', 'recordSecondaryContext exists');
assert(typeof engine.extractImplicitContext === 'function', 'extractImplicitContext exists');
assert(typeof engine.getSummary === 'function', 'getSummary exists');

// ── Test 6: Non-movie domains ────────────────────────

console.log('\n═══ Test 6: Multi-Domain ═══');

const article = { domain: 'article', title: 'AI Trends 2026' };
const aq = engine.generateFollowUpQuestions(article, 4, { maxQuestions: 2 });
assert(aq.length > 0, 'Article domain generates questions');
assert(aq[0].domain === 'article', 'Article questions tagged correctly');

const musicItem = { domain: 'music', title: 'Dark Side of the Moon' };
const mq = engine.generateFollowUpQuestions(musicItem, 5, { maxQuestions: 2 });
assert(mq.length > 0, 'Music domain generates questions');

// ── Results ──────────────────────────────────────────

await cleanup();

console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('All tests passed!\n');
}
