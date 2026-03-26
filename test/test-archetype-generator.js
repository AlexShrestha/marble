/**
 * Tests for archetype-generator.js
 */

import {
  generateArchetype,
  updateArchetype,
  toKGInsights,
  listTemplates,
  estimateAgeFromContext,
} from '../core/archetype-generator.js';

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

// ─── Test 1: Minimal daughter archetype ──────────────────────────────────────
console.log('\n=== Test 1: Minimal daughter archetype (just relationship type) ===');
{
  const arch = generateArchetype({ relationshipType: 'daughter' });
  assert(!arch.error, 'No error returned');
  assert(arch.templateKey === 'parent-child-daughter', 'Correct template key');
  assert(arch.relationship === 'parent-child', 'Relationship is parent-child');
  assert(arch.synthetic === true, 'Marked as synthetic');
  assert(arch.overallConfidence > 0 && arch.overallConfidence < 0.5, `Low confidence: ${arch.overallConfidence}`);
  assert(arch.traits.length > 0, `Has traits: ${arch.traits.length}`);
  assert(arch.insights.length > 0, `Has KG insights: ${arch.insights.length}`);
  assert(arch.traits.every(t => typeof t.confidence === 'number'), 'All traits have confidence');
  assert(arch.traits.some(t => t.synthetic), 'Some traits are synthetic');
}

// ─── Test 2: Daughter with age range ─────────────────────────────────────────
console.log('\n=== Test 2: Daughter with explicit age range ===');
{
  const arch = generateArchetype({
    relationshipType: 'daughter',
    ageRange: [6, 10],
    name: 'Sophia',
  });
  assert(arch.developmentalStage === 'school-age', `Stage: ${arch.developmentalStage}`);
  assert(arch.ageEstimate.mid === 8, `Age mid: ${arch.ageEstimate.mid}`);
  assert(arch.name === 'Sophia', 'Name preserved');
  assert(arch.overallConfidence > 0.3, `Higher confidence with more data: ${arch.overallConfidence}`);
  assert(arch.traits.some(t => t.category === 'interest' && t.value.includes('reading')), 'School-age interests present');
}

// ─── Test 3: Age estimation from context signals ─────────────────────────────
console.log('\n=== Test 3: Age estimation from context signals ===');
{
  const est = estimateAgeFromContext(['she goes to elementary school', 'has ballet lessons']);
  assert(est !== null, 'Age estimated');
  assert(est.low >= 4 && est.high <= 12, `Range reasonable: ${est.low}-${est.high}`);
  assert(est.signalCount === 2, `Signal count: ${est.signalCount}`);
}

// ─── Test 4: Context-driven archetype ────────────────────────────────────────
console.log('\n=== Test 4: Context-driven archetype with signals ===');
{
  const arch = generateArchetype({
    relationshipType: 'daughter',
    contextSignals: ['she is in high school', 'learning to drive'],
    mentionedInterests: ['music'],
  });
  assert(arch.developmentalStage === 'teenager', `Stage from context: ${arch.developmentalStage}`);
  assert(arch.traits.some(t => t.value === 'music' && t.confidence >= 0.8), 'Mentioned interest has high confidence');
}

// ─── Test 5: Partner archetype ───────────────────────────────────────────────
console.log('\n=== Test 5: Partner archetype ===');
{
  const arch = generateArchetype({
    relationshipType: 'wife',
    name: 'Sarah',
    mentionedInterests: ['yoga', 'cooking'],
  });
  assert(arch.templateKey === 'partner', 'Wife maps to partner template');
  assert(arch.label === 'Romantic Partner', 'Label correct');
  assert(arch.traits.some(t => t.value === 'yoga' && !t.synthetic), 'Yoga is non-synthetic');
  assert(arch.subjectImpact.timeCommitment === 'very high', 'Partner impact: very high time');
}

// ─── Test 6: Colleague archetype ─────────────────────────────────────────────
console.log('\n=== Test 6: Colleague archetype ===');
{
  const arch = generateArchetype({
    relationshipType: 'coworker',
    name: 'James',
    extraFacts: { department: 'engineering', seniority: 'senior' },
  });
  assert(arch.templateKey === 'colleague', 'Coworker maps to colleague');
  assert(arch.traits.some(t => t.category === 'department' && t.value === 'engineering'), 'Extra facts as traits');
  assert(arch.traits.find(t => t.category === 'department').confidence === 0.9, 'Extra facts high confidence');
}

// ─── Test 7: Update archetype with confirmation ──────────────────────────────
console.log('\n=== Test 7: Update archetype — confirm trait ===');
{
  const arch = generateArchetype({ relationshipType: 'daughter', ageRange: [6, 10] });
  const sportsTrait = arch.traits.find(t => t.value === 'sports');
  const oldConf = sportsTrait ? sportsTrait.confidence : 0;

  const updated = updateArchetype(arch, {
    traitCategory: 'interest',
    traitValue: 'sports',
    outcome: 'confirmed',
  });

  const newTrait = updated.traits.find(t => t.value === 'sports');
  if (newTrait) {
    assert(newTrait.confidence > oldConf, `Confidence increased: ${oldConf} → ${newTrait.confidence}`);
    assert(newTrait.synthetic === false, 'No longer synthetic after confirmation');
    assert(newTrait.source === 'confirmed', 'Source updated to confirmed');
  } else {
    assert(false, 'Sports trait not found');
  }
}

// ─── Test 8: Update archetype — deny trait ───────────────────────────────────
console.log('\n=== Test 8: Update archetype — deny trait ===');
{
  const arch = generateArchetype({ relationshipType: 'daughter', ageRange: [14, 17] });
  const smTrait = arch.traits.find(t => t.value.includes('social media'));
  const oldConf = smTrait ? smTrait.confidence : 0;

  const updated = updateArchetype(arch, {
    traitCategory: 'interest',
    traitValue: 'social media',
    outcome: 'denied',
  });

  const newTrait = updated.traits.find(t => t.value.includes('social media'));
  if (newTrait) {
    assert(newTrait.confidence < oldConf, `Confidence decreased: ${oldConf} → ${newTrait.confidence}`);
  } else {
    assert(false, 'Social media trait not found');
  }
}

// ─── Test 9: KG insight compatibility ────────────────────────────────────────
console.log('\n=== Test 9: KG insight format compatibility ===');
{
  const arch = generateArchetype({ relationshipType: 'son', ageRange: [3, 5] });
  const insights = toKGInsights(arch);
  assert(insights.length > 0, `Has insights: ${insights.length}`);

  for (const insight of insights) {
    assert(typeof insight.id === 'string', `Insight has id: ${insight.id.slice(0, 20)}...`);
    assert(insight.source_layer === 'synthetic', 'Source layer is synthetic');
    assert(typeof insight.confidence === 'number', 'Has numeric confidence');
    assert(Array.isArray(insight.derived_predictions), 'Has predictions array');
    assert(insight.hypothesis, 'Has hypothesis');
  }
}

// ─── Test 10: List templates ─────────────────────────────────────────────────
console.log('\n=== Test 10: List available templates ===');
{
  const templates = listTemplates();
  assert(templates.length >= 7, `Templates available: ${templates.length}`);
  assert(templates.some(t => t.key === 'parent-child-daughter'), 'Has daughter template');
  assert(templates.some(t => t.key === 'partner'), 'Has partner template');
  assert(templates.some(t => t.hasAgeStages === true), 'Some have age stages');
  assert(templates.some(t => t.hasAgeStages === false), 'Some lack age stages');
}

// ─── Test 11: Unknown type ───────────────────────────────────────────────────
console.log('\n=== Test 11: Unknown relationship type ===');
{
  const arch = generateArchetype({ relationshipType: 'alien' });
  assert(arch.error, 'Returns error for unknown type');
  assert(Array.isArray(arch.availableTypes), 'Lists available types');
}

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('All tests passed!');
}
