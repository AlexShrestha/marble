#!/usr/bin/env node
/**
 * test-hypothesis-tester.js — Tests for Marble Hypothesis Testing Engine
 */

import { HypothesisTester, bayesianUpdate } from '../core/hypothesis-tester.js';
import { MarbleKG } from '../core/kg.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function createTestKG() {
  const tmpPath = path.join(os.tmpdir(), `test-hyp-${Date.now()}.json`);
  const kg = new MarbleKG(tmpPath).load();
  return { kg, tmpPath };
}

function cleanup(tmpPath) {
  try { fs.unlinkSync(tmpPath); } catch {}
}

// ─── Bayesian Update Tests ──────────────────────────────────────────────

function testBayesianUpdate() {
  console.log('\n--- Test: Bayesian Confidence Update');

  // Confirmed outcome should increase confidence
  const post1 = bayesianUpdate(0.5, 'confirmed');
  assert(post1 > 0.5, `Confirmed increases confidence: 0.5 → ${post1}`);

  // Denied outcome should decrease confidence
  const post2 = bayesianUpdate(0.5, 'denied');
  assert(post2 < 0.5, `Denied decreases confidence: 0.5 → ${post2}`);

  // Inconclusive should barely change
  const post3 = bayesianUpdate(0.5, 'inconclusive');
  assert(Math.abs(post3 - 0.5) < 0.05, `Inconclusive barely changes: 0.5 → ${post3}`);

  // High confidence + confirmed → stays high, capped at 0.95
  const post4 = bayesianUpdate(0.9, 'confirmed');
  assert(post4 >= 0.9 && post4 <= 0.95, `High conf confirmed stays capped: 0.9 → ${post4}`);

  // Low confidence + denied → goes lower, floor at 0.05
  const post5 = bayesianUpdate(0.1, 'denied');
  assert(post5 >= 0.05 && post5 < 0.1, `Low conf denied floors: 0.1 → ${post5}`);

  // Multiple confirmations compound
  let conf = 0.5;
  for (let i = 0; i < 5; i++) conf = bayesianUpdate(conf, 'confirmed');
  assert(conf > 0.85, `5 confirmations reach high confidence: ${conf}`);

  // Multiple denials compound
  let conf2 = 0.5;
  for (let i = 0; i < 5; i++) conf2 = bayesianUpdate(conf2, 'denied');
  assert(conf2 < 0.15, `5 denials reach low confidence: ${conf2}`);
}

// ─── Hypothesis Selection Tests ─────────────────────────────────────────

function testSelectTestableHypotheses() {
  console.log('\n--- Test: Select Testable Hypotheses');
  const { kg, tmpPath } = createTestKG();

  // Add hypotheses with varying confidence and test history
  kg.addInsight({
    observation: 'User values stability',
    hypothesis: 'User values stability, avoids uncertainty',
    supporting_signals: ['routine', 'planning'],
    confidence: 0.6,
    derived_predictions: ['Spontaneity content will underperform'],
    source_layer: 'synthetic',
  });

  kg.addInsight({
    observation: 'Builder identity detected',
    hypothesis: 'Strong builder identity — values creating and shipping',
    supporting_signals: ['startup', 'coding'],
    confidence: 0.5,
    derived_predictions: ['Maker content will score high'],
    source_layer: 'synthetic',
  });

  kg.addInsight({
    observation: 'Low confidence guess',
    hypothesis: 'Might like cooking',
    supporting_signals: ['food'],
    confidence: 0.15, // Below threshold
    derived_predictions: ['Cooking content engages'],
    source_layer: 'synthetic',
  });

  const tester = new HypothesisTester(kg);
  const selected = tester.selectTestableHypotheses({ limit: 5 });

  assert(selected.length >= 2, `Selected ${selected.length} testable hypotheses (≥2)`);
  assert(!selected.find(s => s.confidence < 0.25), 'Excluded low-confidence hypothesis');

  cleanup(tmpPath);
}

// ─── Test Generation Tests ──────────────────────────────────────────────

function testGenerateTest() {
  console.log('\n--- Test: Generate Hypothesis Test');
  const { kg, tmpPath } = createTestKG();

  const insight = kg.addInsight({
    observation: 'Pattern: user avoids uncertainty',
    hypothesis: 'User values stability, avoids uncertainty and risk',
    supporting_signals: ['routine', 'planning', 'predictability'],
    confidence: 0.6,
    derived_predictions: ['Spontaneous content will underperform'],
    source_layer: 'synthetic',
  });

  const tester = new HypothesisTester(kg);
  const test = tester.generateTest(insight.id);

  assert(test !== null, 'Test generated successfully');
  assert(test.insight_id === insight.id, 'Test references correct insight');
  assert(test.challenge.topics.length > 0, `Challenge topics: ${test.challenge.topics.join(', ')}`);
  assert(test.confirm.topics.length > 0, `Confirm topics: ${test.confirm.topics.join(', ')}`);
  assert(test.status === 'pending', 'Test starts as pending');
  assert(test.label === 'stability_vs_spontaneity', `Template matched: ${test.label}`);

  // Challenge topics should be opposite of hypothesis
  assert(
    test.challenge.topics.some(t => t.includes('spontaneous') || t.includes('adventure') || t.includes('risk')),
    'Challenge topics oppose the hypothesis'
  );

  cleanup(tmpPath);
}

// ─── Test Injection Tests ───────────────────────────────────────────────

function testGetTestInjections() {
  console.log('\n--- Test: Get Test Injections for Scorer');
  const { kg, tmpPath } = createTestKG();

  const insight = kg.addInsight({
    observation: 'Health optimization detected',
    hypothesis: 'Actively optimizing health and fitness with discipline',
    supporting_signals: ['gym', 'diet'],
    confidence: 0.65,
    source_layer: 'synthetic',
  });

  const tester = new HypothesisTester(kg);
  tester.generateTest(insight.id);

  const injections = tester.getTestInjections();
  assert(injections.length === 1, `Got ${injections.length} injection(s)`);
  assert(injections[0].boost === 0.05, 'Boost is small (0.05)');
  assert(injections[0].test_type === 'challenge', 'Injection is challenge type');
  assert(injections[0].topics.length > 0, 'Injection has topics');

  cleanup(tmpPath);
}

// ─── Result Recording Tests ─────────────────────────────────────────────

function testRecordResult_Confirmed() {
  console.log('\n--- Test: Record Result — Hypothesis Confirmed (user ignores challenge)');
  const { kg, tmpPath } = createTestKG();

  const insight = kg.addInsight({
    observation: 'Stability pattern',
    hypothesis: 'User values stability, avoids uncertainty',
    supporting_signals: ['routine'],
    confidence: 0.6,
    source_layer: 'synthetic',
  });

  const tester = new HypothesisTester(kg);
  const test = tester.generateTest(insight.id);

  // User IGNORES challenge content → confirms hypothesis
  const result = tester.recordResult(test.test_id, { engaged: false, reaction: 'ignore' });

  assert(result !== null, 'Result recorded');
  assert(result.outcome === 'confirmed', `Outcome: ${result.outcome}`);
  assert(result.confidence_after > result.confidence_before, `Confidence increased: ${result.confidence_before} → ${result.confidence_after}`);
  assert(result.test.status === 'completed', 'Test marked completed');

  // Check KG was updated
  const updated = kg.data.user.insights.find(i => i.id === insight.id);
  assert(updated.test_results.length === 1, 'Test result stored in KG');
  assert(updated.test_results[0].outcome === 'confirmed', 'KG test result is confirmed');

  cleanup(tmpPath);
}

function testRecordResult_Denied() {
  console.log('\n--- Test: Record Result — Hypothesis Denied (user engages challenge)');
  const { kg, tmpPath } = createTestKG();

  const insight = kg.addInsight({
    observation: 'Stability pattern',
    hypothesis: 'User values stability, avoids uncertainty',
    supporting_signals: ['routine'],
    confidence: 0.6,
    source_layer: 'synthetic',
  });

  const tester = new HypothesisTester(kg);
  const test = tester.generateTest(insight.id);

  // User ENGAGES with challenge content → denies hypothesis
  const result = tester.recordResult(test.test_id, { engaged: true, reaction: 'up', score: 0.8 });

  assert(result.outcome === 'denied', `Outcome: ${result.outcome}`);
  assert(result.confidence_after < result.confidence_before, `Confidence decreased: ${result.confidence_before} → ${result.confidence_after}`);

  // Check contradicting signal was added
  const updated = kg.data.user.insights.find(i => i.id === insight.id);
  assert(
    updated.contradicting_signals.some(s => s.includes('challenge_engaged')),
    'Contradicting signal added to KG'
  );

  cleanup(tmpPath);
}

function testRecordResult_Inconclusive() {
  console.log('\n--- Test: Record Result — Inconclusive');
  const { kg, tmpPath } = createTestKG();

  const insight = kg.addInsight({
    observation: 'Stability pattern',
    hypothesis: 'User values stability, avoids uncertainty',
    supporting_signals: ['routine'],
    confidence: 0.6,
    source_layer: 'synthetic',
  });

  const tester = new HypothesisTester(kg);
  const test = tester.generateTest(insight.id);

  // Ambiguous reaction
  const result = tester.recordResult(test.test_id, { engaged: false, score: 0 });

  assert(result.outcome === 'confirmed', `No engagement = confirmed: ${result.outcome}`);

  cleanup(tmpPath);
}

// ─── Full Flow Integration Test ─────────────────────────────────────────

function testFullFlow() {
  console.log('\n--- Test: Full Hypothesis Testing Flow');
  const { kg, tmpPath } = createTestKG();

  // 1. Ingest signals that create a hypothesis
  kg.addInsight({
    observation: '[identity_shift_protector] Latent pattern: kid + routine detected',
    hypothesis: 'Identity shifted from adventurer to protector — routine and stability now valued',
    supporting_signals: ['kid', 'routine'],
    confidence: 0.55,
    derived_predictions: ['Spontaneity-themed content will underperform'],
    source_layer: 'synthetic',
  });

  const tester = new HypothesisTester(kg);

  // 2. Select testable hypotheses
  const testable = tester.selectTestableHypotheses();
  assert(testable.length > 0, 'Found testable hypothesis');

  // 3. Generate test
  const test = tester.generateTest(testable[0].id);
  assert(test !== null, 'Generated test');
  assert(test.challenge.topics.length > 0, 'Has challenge topics');

  // 4. Get injections for scorer
  const injections = tester.getTestInjections();
  assert(injections.length > 0, 'Has scorer injections');

  // 5. Simulate: user ignores challenge content
  const result = tester.recordResult(test.test_id, { engaged: false, reaction: 'ignore' });
  assert(result.outcome === 'confirmed', 'Hypothesis confirmed');
  assert(result.confidence_after > 0.55, `Confidence rose: ${result.confidence_after}`);

  // 6. Check stats
  const stats = tester.getTestStats();
  assert(stats.totalTests === 1, `Total tests: ${stats.totalTests}`);
  assert(stats.confirmed === 1, `Confirmed: ${stats.confirmed}`);

  // 7. No more active tests
  assert(tester.getActiveTests().length === 0, 'No active tests remaining');
  assert(tester.getCompletedTests().length === 1, '1 completed test');

  cleanup(tmpPath);
}

// ─── Custom Template Fallback Test ──────────────────────────────────────

function testCustomHypothesisWithoutTemplate() {
  console.log('\n--- Test: Custom Hypothesis Without Template');
  const { kg, tmpPath } = createTestKG();

  const insight = kg.addInsight({
    observation: 'Unusual pattern',
    hypothesis: 'User prefers long-form philosophical content over quick tips',
    supporting_signals: ['philosophy', 'deep thinking', 'essays'],
    confidence: 0.5,
    source_layer: 'synthetic',
  });

  const tester = new HypothesisTester(kg);
  const test = tester.generateTest(insight.id);

  assert(test !== null, 'Test generated for non-template hypothesis');
  assert(test.label === 'custom', `Label is custom: ${test.label}`);
  assert(test.challenge.topics.length > 0, `Inferred challenge topics: ${test.challenge.topics.join(', ')}`);

  cleanup(tmpPath);
}

// ─── Stats Test ─────────────────────────────────────────────────────────

function testStats() {
  console.log('\n--- Test: Test Statistics');
  const { kg, tmpPath } = createTestKG();

  // Add insight with existing test results
  const insight = kg.addInsight({
    observation: 'Test',
    hypothesis: 'User values stability',
    supporting_signals: ['routine'],
    confidence: 0.6,
    source_layer: 'synthetic',
  });
  insight.test_results = [
    { prediction: 'test', outcome: 'confirmed', date: new Date().toISOString() },
    { prediction: 'test2', outcome: 'denied', date: new Date().toISOString() },
    { prediction: 'test3', outcome: 'confirmed', date: new Date().toISOString() },
  ];

  const tester = new HypothesisTester(kg);
  const stats = tester.getTestStats();

  assert(stats.totalTests === 3, `Total: ${stats.totalTests}`);
  assert(stats.confirmed === 2, `Confirmed: ${stats.confirmed}`);
  assert(stats.denied === 1, `Denied: ${stats.denied}`);
  assert(stats.accuracy === 67, `Accuracy: ${stats.accuracy}%`);

  cleanup(tmpPath);
}

// ─── Confidence Propagation Tests ────────────────────────────────────

function testPropagateConfidence_ParentLink() {
  console.log('\n--- Test: Confidence Propagates to Child Insights (parent_insight_id)');
  const { kg, tmpPath } = createTestKG();

  const parent = kg.addInsight({
    observation: 'Stability pattern',
    hypothesis: 'User values stability, avoids uncertainty',
    supporting_signals: ['routine', 'planning'],
    confidence: 0.6,
    derived_predictions: ['Spontaneity content will underperform'],
    source_layer: 'synthetic',
  });

  const child = kg.addInsight({
    observation: 'Derived: routine content preference',
    hypothesis: 'User prefers structured, planned content over spontaneous',
    supporting_signals: ['routine'],
    confidence: 0.5,
    derived_predictions: ['List-style content outperforms freeform'],
    source_layer: 'synthetic',
  });
  child.parent_insight_id = parent.id;

  const tester = new HypothesisTester(kg);
  const test = tester.generateTest(parent.id);

  const result = tester.recordResult(test.test_id, { engaged: false, reaction: 'ignore' });

  assert(result.propagated_updates.length === 1, `Propagated to ${result.propagated_updates.length} dependent(s)`);
  assert(result.propagated_updates[0].id === child.id, 'Propagated to correct child');
  assert(result.propagated_updates[0].confidence_after > 0.5, `Child confidence increased: ${result.propagated_updates[0].confidence_before} → ${result.propagated_updates[0].confidence_after}`);

  cleanup(tmpPath);
}

function testPropagateConfidence_SignalLink() {
  console.log('\n--- Test: Confidence Propagates via Supporting Signal Reference');
  const { kg, tmpPath } = createTestKG();

  const parent = kg.addInsight({
    observation: 'Builder identity',
    hypothesis: 'Strong builder identity — values creating and shipping',
    supporting_signals: ['startup', 'coding'],
    confidence: 0.6,
    derived_predictions: ['Maker content will score high'],
    source_layer: 'synthetic',
  });

  const dependent = kg.addInsight({
    observation: 'Derived from builder identity',
    hypothesis: 'User prefers tools and tutorials over entertainment',
    supporting_signals: [`derived_from:${parent.id}`, 'coding'],
    confidence: 0.55,
    source_layer: 'synthetic',
  });

  const tester = new HypothesisTester(kg);
  const test = tester.generateTest(parent.id);

  const result = tester.recordResult(test.test_id, { engaged: true, reaction: 'up', score: 0.9 });

  assert(result.propagated_updates.length === 1, `Propagated to ${result.propagated_updates.length} dependent(s)`);
  assert(result.propagated_updates[0].confidence_after < 0.55, `Dependent confidence decreased: ${result.propagated_updates[0].confidence_before} → ${result.propagated_updates[0].confidence_after}`);

  cleanup(tmpPath);
}

function testPropagateConfidence_Damping() {
  console.log('\n--- Test: Propagation Is Damped (attenuated)');
  const { kg, tmpPath } = createTestKG();

  const parent = kg.addInsight({
    observation: 'Stability pattern',
    hypothesis: 'User values stability, avoids uncertainty',
    supporting_signals: ['routine'],
    confidence: 0.6,
    derived_predictions: ['Spontaneity underperforms'],
    source_layer: 'synthetic',
  });

  const child = kg.addInsight({
    observation: 'Derived',
    hypothesis: 'Derived prediction about content structure',
    supporting_signals: ['routine'],
    confidence: 0.5,
    source_layer: 'synthetic',
  });
  child.parent_insight_id = parent.id;

  const tester = new HypothesisTester(kg);
  const test = tester.generateTest(parent.id);
  const result = tester.recordResult(test.test_id, { engaged: false, reaction: 'ignore' });

  const parentDelta = result.confidence_after - result.confidence_before;
  const childUpdate = result.propagated_updates[0];
  const childDelta = childUpdate.confidence_after - childUpdate.confidence_before;

  assert(Math.abs(childDelta) < Math.abs(parentDelta), `Child delta (${childDelta.toFixed(3)}) < parent delta (${parentDelta.toFixed(3)})`);
  assert(Math.abs(childDelta - parentDelta * 0.5) < 0.02, `Child delta approx 50% of parent delta`);

  cleanup(tmpPath);
}

function testPropagateConfidence_NoDependents() {
  console.log('\n--- Test: No Propagation When No Dependents');
  const { kg, tmpPath } = createTestKG();

  const standalone = kg.addInsight({
    observation: 'Standalone insight',
    hypothesis: 'User values stability, avoids uncertainty',
    supporting_signals: ['routine'],
    confidence: 0.6,
    source_layer: 'synthetic',
  });

  const tester = new HypothesisTester(kg);
  const test = tester.generateTest(standalone.id);
  const result = tester.recordResult(test.test_id, { engaged: false, reaction: 'ignore' });

  assert(result.propagated_updates.length === 0, 'No propagation for standalone insight');

  cleanup(tmpPath);
}

function testPropagateConfidence_MultipleChildren() {
  console.log('\n--- Test: Propagation to Multiple Dependent Insights');
  const { kg, tmpPath } = createTestKG();

  const parent = kg.addInsight({
    observation: 'Introvert pattern',
    hypothesis: 'User is introverted, avoids social content',
    supporting_signals: ['solitary', 'quiet'],
    confidence: 0.6,
    derived_predictions: ['Social content underperforms'],
    source_layer: 'synthetic',
  });

  const child1 = kg.addInsight({
    observation: 'Derived: solo content preference',
    hypothesis: 'Solo hobby content preferred',
    supporting_signals: ['solitary'],
    confidence: 0.5,
    source_layer: 'synthetic',
  });
  child1.parent_insight_id = parent.id;

  const child2 = kg.addInsight({
    observation: 'Derived: networking aversion',
    hypothesis: 'User avoids networking content',
    supporting_signals: [`derived_from:${parent.id}`],
    confidence: 0.45,
    source_layer: 'synthetic',
  });

  const tester = new HypothesisTester(kg);
  const test = tester.generateTest(parent.id);
  const result = tester.recordResult(test.test_id, { engaged: false, reaction: 'ignore' });

  assert(result.propagated_updates.length === 2, `Propagated to ${result.propagated_updates.length} dependents`);
  assert(result.propagated_updates.every(u => u.confidence_after > u.confidence_before), 'All children confidence increased');

  cleanup(tmpPath);
}

// ─── Run All ────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Hypothesis Tester Tests ===');

  testBayesianUpdate();
  testSelectTestableHypotheses();
  testGenerateTest();
  testGetTestInjections();
  testRecordResult_Confirmed();
  testRecordResult_Denied();
  testRecordResult_Inconclusive();
  testFullFlow();
  testCustomHypothesisWithoutTemplate();
  testStats();
  testPropagateConfidence_ParentLink();
  testPropagateConfidence_SignalLink();
  testPropagateConfidence_Damping();
  testPropagateConfidence_NoDependents();
  testPropagateConfidence_MultipleChildren();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
