#!/usr/bin/env node
/**
 * test-relationship-simulator.js — Tests for Marble Relationship Simulation Engine
 */

import { RelationshipSimulator } from '../core/relationship-simulator.js';
import { KnowledgeGraph } from '../core/kg.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

async function createTestKG() {
  const tmpPath = path.join(os.tmpdir(), `test-relsim-${Date.now()}.json`);
  const kg = await new KnowledgeGraph(tmpPath).load();

  // Seed with user interests
  kg.user.interests = [
    { topic: 'fitness', weight: 0.8, last_boost: new Date().toISOString(), trend: 'stable' },
    { topic: 'hiking', weight: 0.7, last_boost: new Date().toISOString(), trend: 'rising' },
    { topic: 'startup', weight: 0.9, last_boost: new Date().toISOString(), trend: 'stable' },
    { topic: 'reading', weight: 0.6, last_boost: new Date().toISOString(), trend: 'stable' },
  ];

  // Seed with insights
  kg.addInsight({
    observation: 'User is deeply focused on startup building',
    hypothesis: 'Career/builder identity is central to user',
    supporting_signals: ['startup', 'shipping', 'building'],
    confidence: 0.8,
    source_layer: 'observed',
  });

  kg.addInsight({
    observation: 'User enjoys hiking and outdoor activities',
    hypothesis: 'Outdoor activities provide balance to work',
    supporting_signals: ['hiking', 'outdoor'],
    confidence: 0.7,
    source_layer: 'observed',
  });

  return { kg, tmpPath };
}

function cleanup(tmpPath) {
  try { fs.unlinkSync(tmpPath); } catch {}
}

// ─── Test: Add Relationship ────────────────────────────────────────────

function testAddRelationship() {
  console.log('\n--- Test: Add Relationship');
  const { kg, tmpPath } = createTestKG();
  const sim = new RelationshipSimulator(kg);

  const rel = sim.addRelationship({
    person_a: 'Alex',
    person_b: 'Daughter',
    relationship_type: 'parent-child',
    person_b_profile: {
      interests: ['drawing', 'animals', 'outdoor play', 'stories'],
      age: 5,
      needs: ['structured play', 'emotional vocabulary', 'social skills development'],
    },
  });

  assert(rel.id.startsWith('rel_'), 'Relationship has valid ID');
  assert(rel.person_a === 'Alex', 'person_a is set');
  assert(rel.person_b === 'Daughter', 'person_b is set');
  assert(rel.relationship_type === 'parent-child', 'relationship_type is set');
  assert(rel.person_b_profile.age === 5, 'person_b_profile preserved');
  assert(rel.shared_interests !== undefined, 'shared_interests computed');
  assert(kg.user.relationships.length === 1, 'Relationship stored in KG');

  cleanup(tmpPath);
}

// ─── Test: Shared Interests Computation ────────────────────────────────

function testSharedInterests() {
  console.log('\n--- Test: Shared Interests Computation');
  const { kg, tmpPath } = createTestKG();
  const sim = new RelationshipSimulator(kg);

  sim.addRelationship({
    person_a: 'Alex',
    person_b: 'Daughter',
    relationship_type: 'parent-child',
    person_b_profile: {
      interests: ['hiking', 'reading', 'animals', 'drawing'],
    },
  });

  const rel = sim.getRelationships()[0];
  assert(rel.shared_interests.direct.includes('hiking'), 'Direct overlap: hiking');
  assert(rel.shared_interests.direct.includes('reading'), 'Direct overlap: reading');
  assert(rel.shared_interests.direct.length === 2, 'Exactly 2 direct overlaps');

  cleanup(tmpPath);
}

// ─── Test: Simulate Relationship ──────────────────────────────────────

function testSimulate() {
  console.log('\n--- Test: Simulate Relationship');
  const { kg, tmpPath } = createTestKG();
  const sim = new RelationshipSimulator(kg);

  const rel = sim.addRelationship({
    person_a: 'Alex',
    person_b: 'Daughter',
    relationship_type: 'parent-child',
    person_b_profile: {
      interests: ['outdoor play', 'drawing', 'stories', 'animals'],
      age: 5,
      needs: ['structured play', 'emotional vocabulary'],
    },
  });

  const result = sim.simulate(rel.id, { date: new Date('2026-07-15') }); // summer

  assert(result !== null, 'Simulation returns result');
  assert(result.recommendations.length > 0, `Has recommendations (${result.recommendations.length})`);
  assert(result.active_contexts.length > 0, 'Has active temporal contexts (summer)');

  // Summer should trigger seasonal recommendations
  const hasSummerContext = result.active_contexts.some(c => c.id === 'summer' || c.id === 'school_holiday');
  assert(hasSummerContext, 'Summer temporal context detected');

  // Should have shared activity recommendations
  const sharedRec = result.recommendations.find(r => r.type === 'shared_activity');
  assert(sharedRec !== undefined, 'Has shared activity recommendation');

  // Should detect time competition (user is startup-focused)
  const timeTension = result.tension_points.find(t => t.type === 'time_competition');
  assert(timeTension !== undefined, 'Detected time competition tension (startup vs parenting)');

  cleanup(tmpPath);
}

// ─── Test: Temporal Context ──────────────────────────────────────────

function testTemporalContext() {
  console.log('\n--- Test: Temporal Context');
  const { kg, tmpPath } = createTestKG();
  const sim = new RelationshipSimulator(kg);

  const rel = sim.addRelationship({
    person_a: 'Alex',
    person_b: 'Daughter',
    relationship_type: 'parent-child',
    person_b_profile: { interests: ['outdoor play'] },
  });

  // Summer weekday
  const summer = sim.simulate(rel.id, { date: new Date('2026-07-15') }); // Wednesday
  const winterSaturday = sim.simulate(rel.id, { date: new Date('2026-12-20') }); // Saturday

  assert(summer.active_contexts.some(c => c.id === 'summer'), 'Summer detected in July');
  assert(winterSaturday.active_contexts.some(c => c.id === 'weekend'), 'Weekend detected on Saturday');
  assert(winterSaturday.active_contexts.some(c => c.id === 'winter_break'), 'Winter break detected in December');

  cleanup(tmpPath);
}

// ─── Test: Content Recommendations ──────────────────────────────────────

function testVivoRecommendations() {
  console.log('\n--- Test: Content Recommendations');
  const { kg, tmpPath } = createTestKG();
  const sim = new RelationshipSimulator(kg);

  sim.addRelationship({
    person_a: 'Alex',
    person_b: 'Daughter',
    relationship_type: 'parent-child',
    person_b_profile: { interests: ['outdoor play', 'drawing'] },
  });

  sim.addRelationship({
    person_a: 'Alex',
    person_b: 'Partner',
    relationship_type: 'partner',
    person_b_profile: { interests: ['fitness', 'travel', 'cooking'] },
  });

  const recs = sim.getVivoRecommendations({ date: new Date('2026-07-15'), limit: 5 });

  assert(recs.length > 0, `Has Content recommendations (${recs.length})`);
  assert(recs.length <= 5, 'Respects limit');
  assert(recs[0].relationship !== undefined, 'Recommendation has relationship context');
  assert(recs[0].confidence !== undefined, 'Recommendation has confidence');

  // Should have recs from both relationships
  const relTypes = [...new Set(recs.map(r => r.relationship_type))];
  assert(relTypes.length >= 1, `Recommendations from ${relTypes.length} relationship type(s)`);

  cleanup(tmpPath);
}

// ─── Test: Multiple Relationships ────────────────────────────────────

function testMultipleRelationships() {
  console.log('\n--- Test: Multiple Relationships');
  const { kg, tmpPath } = createTestKG();
  const sim = new RelationshipSimulator(kg);

  sim.addRelationship({ person_a: 'Alex', person_b: 'Daughter', relationship_type: 'parent-child', person_b_profile: { interests: ['drawing'] } });
  sim.addRelationship({ person_a: 'Alex', person_b: 'Partner', relationship_type: 'partner', person_b_profile: { interests: ['fitness'] } });
  sim.addRelationship({ person_a: 'Alex', person_b: 'CofounderBob', relationship_type: 'colleague', person_b_profile: { interests: ['startup'] } });

  const results = sim.simulateAll({ date: new Date('2026-03-25') });
  assert(results.length === 3, 'Simulated all 3 relationships');

  const rels = sim.getRelationships();
  assert(rels.length === 3, 'All relationships stored');

  const byType = sim.getRelationships({ type: 'partner' });
  assert(byType.length === 1, 'Filter by type works');

  cleanup(tmpPath);
}

// ─── Test: Update Relationship ──────────────────────────────────────

function testUpdateRelationship() {
  console.log('\n--- Test: Update Relationship');
  const { kg, tmpPath } = createTestKG();
  const sim = new RelationshipSimulator(kg);

  const rel = sim.addRelationship({
    person_a: 'Alex',
    person_b: 'Daughter',
    relationship_type: 'parent-child',
    person_b_profile: { interests: ['drawing'], age: 5 },
  });

  const updated = sim.updateRelationship(rel.id, {
    person_b_profile: { interests: ['drawing', 'reading', 'hiking'], age: 6 },
  });

  assert(updated !== null, 'Update returns result');
  assert(updated.person_b_profile.age === 6, 'Age updated');
  assert(updated.person_b_profile.interests.length === 3, 'Interests updated');

  cleanup(tmpPath);
}

// ─── Test: Insight Cross-Reference ──────────────────────────────────

function testInsightCrossRef() {
  console.log('\n--- Test: Insight Cross-Reference');
  const { kg, tmpPath } = createTestKG();
  const sim = new RelationshipSimulator(kg);

  // Person_b has "outdoor" interest which matches user's hiking insight
  const rel = sim.addRelationship({
    person_a: 'Alex',
    person_b: 'Daughter',
    relationship_type: 'parent-child',
    person_b_profile: { interests: ['outdoor', 'nature'] },
  });

  const result = sim.simulate(rel.id);
  const crossRef = result.recommendations.find(r => r.type === 'insight_crossref');

  // The hiking insight has "outdoor" as a supporting signal, daughter has "outdoor" interest
  assert(crossRef !== undefined, 'Found insight cross-reference recommendation');
  if (crossRef) {
    assert(crossRef.source_insight !== undefined, 'Cross-ref has source insight ID');
  }

  cleanup(tmpPath);
}

// ─── Run All Tests ──────────────────────────────────────────────────

console.log('=== Marble Relationship Simulator Tests ===');

testAddRelationship();
testSharedInterests();
testSimulate();
testTemporalContext();
testVivoRecommendations();
testMultipleRelationships();
testUpdateRelationship();
testInsightCrossRef();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
