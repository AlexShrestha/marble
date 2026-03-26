/**
 * Tests for Synthetic Reasoner — Marble Layer 2 inference
 */

import { SyntheticReasoner, categorizeInsight, REASONING_RULES } from '../core/synthetic-reasoner.js';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

// ── categorizeInsight ──
console.log('\n── categorizeInsight ──');

const controlInsight = { hypothesis: 'User seeks control through routine', category: 'behavior', confidence: 0.7 };
const cats = categorizeInsight(controlInsight);
assert(cats.includes('control'), 'detects control category');

const familyInsight = { hypothesis: 'Has young children at home', category: 'family-status', confidence: 0.8 };
assert(categorizeInsight(familyInsight).includes('family'), 'detects family category');

const careerInsight = { hypothesis: 'Recently changed career path', category: 'professional', confidence: 0.6 };
assert(categorizeInsight(careerInsight).includes('career'), 'detects career category');

const multiInsight = { hypothesis: 'Ambitious about career growth despite insecurity', category: 'ambition', confidence: 0.65 };
const multiCats = categorizeInsight(multiInsight);
assert(multiCats.includes('ambition') && multiCats.includes('career') && multiCats.includes('insecurity'),
  'detects multiple categories from one insight');

// ── reason: needs 3+ insights ──
console.log('\n── reason: minimum insight threshold ──');

const reasoner = new SyntheticReasoner();

const twoInsights = [
  { hypothesis: 'Control-seeking', category: 'control', confidence: 0.7, synthetic: false },
  { hypothesis: 'Has family', category: 'family', confidence: 0.8, synthetic: false }
];
const { synthetic: noResult, reasoning: noReasoning } = reasoner.reason(twoInsights);
assert(noResult.length === 0, 'returns empty with <3 insights');
assert(noReasoning[0].note.includes('Need 3+'), 'reasoning explains why');

// ── reason: generates synthetic insights ──
console.log('\n── reason: generates synthetics from 3+ insights ──');

const threeInsights = [
  { hypothesis: 'User seeks control through gym discipline', category: 'behavior', confidence: 0.7, synthetic: false },
  { hypothesis: 'Has young kid, family-oriented', category: 'family-status', confidence: 0.8, synthetic: false },
  { hypothesis: 'Recently changed career to entrepreneurship', category: 'professional', confidence: 0.65, synthetic: false }
];

const { synthetic: synths, reasoning } = reasoner.reason(threeInsights);
assert(synths.length > 0, `generated ${synths.length} synthetic insights`);
assert(synths.every(s => s.synthetic === true), 'all marked as synthetic');
assert(synths.every(s => s.confidence < 0.8), 'all have capped confidence');
assert(synths.every(s => s.predictions && s.predictions.length > 0), 'all have predictions');
assert(synths.every(s => s.sourceInsights && s.sourceInsights.length > 0), 'all cite sources');
assert(synths.every(s => s.testable && s.testable.length > 0), 'all have testable predictions');

// Check we got the control+family rule
const controlFamily = synths.find(s => s.ruleId === 'control_family');
assert(!!controlFamily, 'control_family rule fired');
if (controlFamily) {
  assert(controlFamily.predictions.includes('protection'), 'control_family predicts protection-framing');
  assert(controlFamily.avoidances.includes('letting go'), 'control_family avoids letting-go framing');
}

// Check triple rule fires
const tripleRule = synths.find(s => s.ruleId === 'triple_control_career_family');
assert(!!tripleRule, 'triple_control_career_family rule fired');

// ── reason: skips synthetic inputs ──
console.log('\n── reason: ignores synthetic inputs ──');

const mixedInsights = [
  { hypothesis: 'Control-seeking', category: 'control', confidence: 0.7, synthetic: false },
  { hypothesis: 'Family-oriented', category: 'family', confidence: 0.8, synthetic: true }, // synthetic — should be skipped
  { hypothesis: 'Career-focused', category: 'career', confidence: 0.6, synthetic: false }
];
const { synthetic: mixedResult } = reasoner.reason(mixedInsights);
assert(mixedResult.length === 0, 'does not fire rules when a required category only comes from synthetic insights');

// ── reason: respects confidence threshold ──
console.log('\n── reason: respects confidence threshold ──');

const lowConfInsights = [
  { hypothesis: 'Control-seeking', category: 'control', confidence: 0.2, synthetic: false }, // below threshold
  { hypothesis: 'Family-oriented', category: 'family', confidence: 0.8, synthetic: false },
  { hypothesis: 'Career-focused', category: 'career', confidence: 0.6, synthetic: false }
];
const { synthetic: lowResult } = reasoner.reason(lowConfInsights);
// Control insight filtered out, so control+family rule shouldn't fire
const hasControlRule = lowResult.some(s => s.ruleId === 'control_family');
assert(!hasControlRule, 'low-confidence insight excluded from rule matching');

// ── processFeedback: confirmation ──
console.log('\n── processFeedback ──');

const testSynthetic = {
  hypothesis: 'Test hypothesis',
  confidence: 0.35,
  synthetic: true,
  confirmations: 0,
  contradictions: 0
};

const { insight: confirmed1, action: a1 } = reasoner.processFeedback(testSynthetic, true);
assert(confirmed1.confirmations === 1, 'increments confirmations');
assert(confirmed1.confidence > testSynthetic.confidence, 'boosts confidence on confirm');
assert(a1 === 'keep', 'keeps after 1 confirmation');

// Promote after 3 confirmations
let current = { ...testSynthetic, confirmations: 2, confidence: 0.5 };
const { insight: promoted, action: a2 } = reasoner.processFeedback(current, true);
assert(a2 === 'promote', 'promotes after reaching threshold');
assert(promoted.synthetic === false, 'no longer marked synthetic after promotion');
assert(promoted.promotedFrom === 'synthetic', 'tracks promotion origin');

// Demote after contradictions
let contra = { ...testSynthetic, contradictions: 1, confidence: 0.3 };
const { insight: demoted, action: a3 } = reasoner.processFeedback(contra, false);
assert(a3 === 'demote', 'demotes after reaching contradiction threshold');
assert(demoted.confidence < contra.confidence, 'drops confidence on contradiction');

// ── merge: no duplicates ──
console.log('\n── merge ──');

const existing = [
  { hypothesis: 'Real insight', confidence: 0.8 },
  { hypothesis: 'Old synthetic', ruleId: 'control_family', confidence: 0.4, synthetic: true }
];
const newSynths = [
  { hypothesis: 'New from control_family', ruleId: 'control_family', confidence: 0.35, synthetic: true },
  { hypothesis: 'New from health_control', ruleId: 'health_control', confidence: 0.3, synthetic: true }
];
const merged = reasoner.merge(existing, newSynths);
assert(merged.length === 3, 'does not duplicate existing ruleId');
assert(merged.some(i => i.ruleId === 'health_control'), 'adds new non-duplicate');

// ── augment: full cycle ──
console.log('\n── augment: full cycle on clone ──');

const fakeClone = {
  insights: [
    { hypothesis: 'Control-seeking behavior in daily routine', category: 'behavior', confidence: 0.75, synthetic: false },
    { hypothesis: 'Strong family bonds, has children', category: 'family', confidence: 0.85, synthetic: false },
    { hypothesis: 'Ambitious about career trajectory', category: 'career', confidence: 0.7, synthetic: false },
    { hypothesis: 'Gym 5x/week, tracks macros', category: 'health', confidence: 0.9, synthetic: false }
  ]
};

const { clone: augmented, added, reasoning: augReasoning } = reasoner.augment(fakeClone);
assert(added > 0, `augment added ${added} synthetic insights`);
assert(augmented.insights.length > 4, 'clone now has more insights than it started with');
assert(augmented.insights.filter(i => i.synthetic).length === added, 'synthetic count matches added');
assert(augReasoning.length === added, 'reasoning trace for each generated insight');

// Verify some expected rules fired
const augSynths = augmented.insights.filter(i => i.synthetic);
const ruleIds = augSynths.map(s => s.ruleId);
assert(ruleIds.includes('control_family'), 'augment: control_family fired');
assert(ruleIds.includes('health_control'), 'augment: health_control fired');
assert(ruleIds.includes('health_ambition'), 'augment: health_ambition fired');
assert(ruleIds.includes('triple_control_career_family'), 'augment: triple rule fired');

// ── Summary ──
console.log(`\n━━━ Results: ${passed} passed, ${failed} failed ━━━`);
process.exit(failed > 0 ? 1 : 0);
