#!/usr/bin/env node
/**
 * test-insight-engine.js — Tests for Marble Signal Cross-Referencing Engine
 *
 * Tests:
 * - Pattern library matching (heuristic latent patterns)
 * - Topic co-occurrence detection
 * - Temporal pattern detection
 * - Confidence calculation
 * - Integration with MarbleKG
 */

import { InsightEngine } from '../core/insight-engine.js';
import { MarbleKG } from '../core/kg.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

function createTestKG() {
  const tmpPath = path.join(os.tmpdir(), `test-kg-${Date.now()}.json`);
  const kg = new MarbleKG(tmpPath).load();
  return { kg, tmpPath };
}

function cleanup(tmpPath) {
  try { fs.unlinkSync(tmpPath); } catch {}
}

async function testBasicSignalIngestion() {
  console.log('\n--- Test: Basic Signal Ingestion via InsightEngine');
  const { kg, tmpPath } = createTestKG();
  const engine = new InsightEngine(kg);

  const result = await engine.processNewSignal({
    type: 'positive_feedback',
    topic: 'AI',
    value: 1,
    context: { source: 'telegram' },
    timestamp: new Date().toISOString(),
  });

  const ok = result.ingested.length >= 1 && kg.data.user.signals.length === 1;
  console.log(ok ? 'PASS' : 'FAIL', `— ingested ${result.ingested.length} insights, ${kg.data.user.signals.length} signal stored`);

  cleanup(tmpPath);
  return ok;
}

async function testHeuristicPatternMatching() {
  console.log('\n--- Test: Heuristic Pattern Matching (vulnerability_armor)');
  const { kg, tmpPath } = createTestKG();
  const engine = new InsightEngine(kg);

  // Ingest signals matching the vulnerability_armor pattern
  const signals = [
    { type: 'positive_feedback', topic: 'gym', value: 1, timestamp: new Date().toISOString() },
    { type: 'positive_feedback', topic: 'security', value: 1, timestamp: new Date().toISOString() },
    { type: 'positive_feedback', topic: 'insurance', value: 1, timestamp: new Date().toISOString() },
  ];

  let patternInsights = [];
  for (const s of signals) {
    const result = await engine.processNewSignal(s);
    patternInsights.push(...result.crossRef);
  }

  const hasVulnerabilityPattern = patternInsights.some(i =>
    i.observation.includes('vulnerability_armor')
  );

  console.log(hasVulnerabilityPattern ? 'PASS' : 'FAIL',
    `— found vulnerability_armor pattern: ${hasVulnerabilityPattern} (${patternInsights.length} latent insights)`);

  cleanup(tmpPath);
  return hasVulnerabilityPattern;
}

async function testIdentityShiftPattern() {
  console.log('\n--- Test: Identity Shift Pattern (protector)');
  const { kg, tmpPath } = createTestKG();
  const engine = new InsightEngine(kg);

  const signals = [
    { type: 'positive_feedback', topic: 'kid', value: 1, timestamp: new Date().toISOString() },
    { type: 'positive_feedback', topic: 'routine', value: 1, timestamp: new Date().toISOString() },
    { type: 'positive_feedback', topic: 'parenting', value: 1, timestamp: new Date().toISOString() },
  ];

  let found = false;
  for (const s of signals) {
    const result = await engine.processNewSignal(s);
    if (result.crossRef.some(i => i.observation.includes('identity_shift_protector'))) {
      found = true;
    }
  }

  console.log(found ? 'PASS' : 'FAIL', `— identity_shift_protector detected: ${found}`);

  cleanup(tmpPath);
  return found;
}

async function testNoFalsePositives() {
  console.log('\n--- Test: No False Positives (unrelated topics)');
  const { kg, tmpPath } = createTestKG();
  const engine = new InsightEngine(kg);

  const signals = [
    { type: 'positive_feedback', topic: 'cooking', value: 1, timestamp: new Date().toISOString() },
    { type: 'positive_feedback', topic: 'gardening', value: 1, timestamp: new Date().toISOString() },
  ];

  let patternInsights = [];
  for (const s of signals) {
    const result = await engine.processNewSignal(s);
    patternInsights.push(...result.crossRef);
  }

  // Should NOT match any predefined heuristic patterns
  const hasHeuristicMatch = patternInsights.some(i =>
    i.observation.includes('[') && i.observation.includes('Latent pattern')
  );

  const ok = !hasHeuristicMatch;
  console.log(ok ? 'PASS' : 'FAIL', `— no false heuristic matches: ${!hasHeuristicMatch}`);

  cleanup(tmpPath);
  return ok;
}

async function testTopicCoOccurrence() {
  console.log('\n--- Test: Topic Co-Occurrence Detection');
  const { kg, tmpPath } = createTestKG();
  const engine = new InsightEngine(kg);

  const now = Date.now();
  // Inject multiple signals with same topic in same time window
  const signals = [
    { type: 'positive_feedback', topic: 'blockchain', value: 1, timestamp: new Date(now - 1000).toISOString() },
    { type: 'positive_feedback', topic: 'blockchain', value: 1, timestamp: new Date(now - 2000).toISOString() },
    { type: 'positive_feedback', topic: 'blockchain', value: 1, timestamp: new Date(now - 3000).toISOString() },
  ];

  for (const s of signals) {
    kg.ingestSignal(s); // Pre-populate
  }

  // Now add a new signal in the same window
  const result = await engine.processNewSignal({
    type: 'positive_feedback',
    topic: 'regulation',
    value: 1,
    timestamp: new Date(now).toISOString(),
  });

  const hasCoOccurrence = result.crossRef.some(i =>
    i.observation.includes('Co-occurring')
  );

  console.log(hasCoOccurrence ? 'PASS' : 'FAIL',
    `— co-occurrence detected: ${hasCoOccurrence} (${result.crossRef.length} cross-ref insights)`);

  cleanup(tmpPath);
  return hasCoOccurrence;
}

async function testTemporalPatterns() {
  console.log('\n--- Test: Temporal Pattern Detection');
  const { kg, tmpPath } = createTestKG();
  const engine = new InsightEngine(kg);

  // Create signals at morning and evening times
  const today = new Date();
  const morning = new Date(today); morning.setHours(7, 0, 0);
  const evening = new Date(today); evening.setHours(20, 0, 0);

  const signals = [
    { type: 'positive_feedback', topic: 'productivity', value: 1, timestamp: morning.toISOString() },
    { type: 'positive_feedback', topic: 'coding', value: 1, timestamp: morning.toISOString() },
    { type: 'positive_feedback', topic: 'productivity', value: 1, timestamp: new Date(morning.getTime() + 60000).toISOString() },
    { type: 'positive_feedback', topic: 'gaming', value: 1, timestamp: evening.toISOString() },
    { type: 'positive_feedback', topic: 'movies', value: 1, timestamp: evening.toISOString() },
    { type: 'positive_feedback', topic: 'gaming', value: 1, timestamp: new Date(evening.getTime() + 60000).toISOString() },
  ];

  for (const s of signals) {
    kg.ingestSignal(s);
  }

  const temporal = engine.detectTemporalInsights();
  const hasTemporal = temporal.length > 0;

  console.log(hasTemporal ? 'PASS' : 'FAIL',
    `— temporal insights: ${temporal.length}`);
  if (temporal.length > 0) {
    console.log(`  Observation: ${temporal[0].observation}`);
  }

  cleanup(tmpPath);
  return hasTemporal;
}

async function testConfidenceGrowsWithEvidence() {
  console.log('\n--- Test: Confidence Grows with Repeated Evidence');
  const { kg, tmpPath } = createTestKG();
  const engine = new InsightEngine(kg);

  // First round — create pattern
  engine.processNewSignal({ type: 'positive_feedback', topic: 'gym', value: 1, timestamp: new Date().toISOString() });
  engine.processNewSignal({ type: 'positive_feedback', topic: 'security', value: 1, timestamp: new Date().toISOString() });

  const initialInsight = kg.data.user.insights.find(i =>
    i.observation && i.observation.includes('vulnerability_armor')
  );
  const initialConf = initialInsight ? initialInsight.confidence : 0;

  // More evidence
  engine.processNewSignal({ type: 'positive_feedback', topic: 'insurance', value: 1, timestamp: new Date().toISOString() });
  engine.processNewSignal({ type: 'positive_feedback', topic: 'gym', value: 1, timestamp: new Date().toISOString() });

  const updatedInsight = kg.data.user.insights.find(i =>
    i.observation && i.observation.includes('vulnerability_armor')
  );
  const updatedConf = updatedInsight ? updatedInsight.confidence : 0;

  const ok = updatedConf >= initialConf && initialConf > 0;
  console.log(ok ? 'PASS' : 'FAIL',
    `— confidence: ${initialConf.toFixed(2)} -> ${updatedConf.toFixed(2)}`);

  cleanup(tmpPath);
  return ok;
}

async function testLatentPredictions() {
  console.log('\n--- Test: Latent Predictions API');
  const { kg, tmpPath } = createTestKG();
  const engine = new InsightEngine(kg);

  // Build up a pattern
  engine.processNewSignal({ type: 'positive_feedback', topic: 'coding', value: 1, timestamp: new Date().toISOString() });
  engine.processNewSignal({ type: 'positive_feedback', topic: 'startup', value: 1, timestamp: new Date().toISOString() });
  engine.processNewSignal({ type: 'positive_feedback', topic: 'product', value: 1, timestamp: new Date().toISOString() });

  const predictions = engine.getLatentPredictions();
  const ok = predictions.length > 0;

  console.log(ok ? 'PASS' : 'FAIL',
    `— ${predictions.length} latent predictions generated`);
  if (predictions.length > 0) {
    console.log(`  Top prediction: "${predictions[0].prediction}" (conf: ${predictions[0].confidence.toFixed(2)})`);
  }

  cleanup(tmpPath);
  return ok;
}

async function testSyntheticAndObservedLayers() {
  console.log('\n--- Test: Works with Both Data Layers');
  const { kg, tmpPath } = createTestKG();
  const engine = new InsightEngine(kg);

  // Add an observed insight manually
  kg.addInsight({
    observation: 'User explicitly said they like fitness content',
    hypothesis: 'Fitness is a core interest',
    supporting_signals: ['fitness'],
    confidence: 0.8,
    source_layer: 'observed',
  });

  // Process signals that create synthetic insights
  engine.processNewSignal({ type: 'positive_feedback', topic: 'gym', value: 1, timestamp: new Date().toISOString() });
  engine.processNewSignal({ type: 'positive_feedback', topic: 'diet', value: 1, timestamp: new Date().toISOString() });

  const observed = kg.getInsights({ sourceLayer: 'observed' });
  const synthetic = kg.getInsights({ sourceLayer: 'synthetic' });

  const ok = observed.length >= 1 && synthetic.length >= 1;
  console.log(ok ? 'PASS' : 'FAIL',
    `— observed: ${observed.length}, synthetic: ${synthetic.length}`);

  cleanup(tmpPath);
  return ok;
}

async function testConfidenceScalesWithSignalCount() {
  console.log('\n--- Test: Confidence Scales with Signal Count');
  const { kg, tmpPath } = createTestKG();
  const engine = new InsightEngine(kg);

  const fewSignals = [
    { type: 'positive_feedback', topic: 'gym', value: 1, timestamp: '2026-03-20T08:00:00Z' },
  ];
  const lowConf = engine.calculateInsightConfidence(fewSignals);

  const manySignals = [];
  for (let i = 0; i < 10; i++) {
    manySignals.push({ type: 'positive_feedback', topic: 'gym', value: 1, timestamp: `2026-03-${10 + i}T08:00:00Z` });
  }
  const highConf = engine.calculateInsightConfidence(manySignals);

  const ok = highConf > lowConf;
  console.log(ok ? 'PASS' : 'FAIL',
    `— 1 signal conf: ${lowConf.toFixed(2)}, 10 signals conf: ${highConf.toFixed(2)}`);
  cleanup(tmpPath);
  return ok;
}

async function testConfidenceBoostsForConsistency() {
  console.log('\n--- Test: Confidence Boosts for Directional Consistency');
  const { kg, tmpPath } = createTestKG();
  const engine = new InsightEngine(kg);

  const consistent = [
    { type: 'positive_feedback', topic: 'gym', value: 1, timestamp: '2026-03-20T08:00:00Z' },
    { type: 'positive_feedback', topic: 'gym', value: 1, timestamp: '2026-03-21T08:00:00Z' },
    { type: 'positive_feedback', topic: 'gym', value: 1, timestamp: '2026-03-22T08:00:00Z' },
    { type: 'positive_feedback', topic: 'gym', value: 1, timestamp: '2026-03-23T08:00:00Z' },
  ];
  const consistentConf = engine.calculateInsightConfidence(consistent);

  const inconsistent = [
    { type: 'positive_feedback', topic: 'gym', value: 1, timestamp: '2026-03-20T08:00:00Z' },
    { type: 'negative_feedback', topic: 'gym', value: -1, timestamp: '2026-03-21T08:00:00Z' },
    { type: 'positive_feedback', topic: 'gym', value: 1, timestamp: '2026-03-22T08:00:00Z' },
    { type: 'negative_feedback', topic: 'gym', value: -1, timestamp: '2026-03-23T08:00:00Z' },
  ];
  const inconsistentConf = engine.calculateInsightConfidence(inconsistent);

  const ok = consistentConf > inconsistentConf;
  console.log(ok ? 'PASS' : 'FAIL',
    `— consistent: ${consistentConf.toFixed(2)}, inconsistent: ${inconsistentConf.toFixed(2)}`);
  cleanup(tmpPath);
  return ok;
}

async function testConfidenceBoostsForTemporalSpread() {
  console.log('\n--- Test: Confidence Boosts for Temporal Spread');
  const { kg, tmpPath } = createTestKG();
  const engine = new InsightEngine(kg);

  const sameDay = [
    { type: 'positive_feedback', topic: 'gym', value: 1, timestamp: '2026-03-20T08:00:00Z' },
    { type: 'positive_feedback', topic: 'gym', value: 1, timestamp: '2026-03-20T12:00:00Z' },
    { type: 'positive_feedback', topic: 'gym', value: 1, timestamp: '2026-03-20T18:00:00Z' },
  ];
  const sameDayConf = engine.calculateInsightConfidence(sameDay);

  const multiDay = [
    { type: 'positive_feedback', topic: 'gym', value: 1, timestamp: '2026-03-18T08:00:00Z' },
    { type: 'positive_feedback', topic: 'gym', value: 1, timestamp: '2026-03-20T08:00:00Z' },
    { type: 'positive_feedback', topic: 'gym', value: 1, timestamp: '2026-03-22T08:00:00Z' },
  ];
  const multiDayConf = engine.calculateInsightConfidence(multiDay);

  const ok = multiDayConf > sameDayConf;
  console.log(ok ? 'PASS' : 'FAIL',
    `— same-day: ${sameDayConf.toFixed(2)}, multi-day: ${multiDayConf.toFixed(2)}`);
  cleanup(tmpPath);
  return ok;
}

async function testConfidenceBoostsForSourceDiversity() {
  console.log('\n--- Test: Confidence Boosts for Source Diversity');
  const { kg, tmpPath } = createTestKG();
  const engine = new InsightEngine(kg);

  const singleSource = [
    { type: 'positive_feedback', topic: 'gym', value: 1, timestamp: '2026-03-20T08:00:00Z' },
    { type: 'positive_feedback', topic: 'gym', value: 1, timestamp: '2026-03-21T08:00:00Z' },
  ];
  const singleConf = engine.calculateInsightConfidence(singleSource);

  const multiSource = [
    { type: 'positive_feedback', topic: 'gym', value: 1, timestamp: '2026-03-20T08:00:00Z' },
    { type: 'link_click', topic: 'gym', value: 1, timestamp: '2026-03-21T08:00:00Z' },
  ];
  const multiConf = engine.calculateInsightConfidence(multiSource);

  const ok = multiConf > singleConf;
  console.log(ok ? 'PASS' : 'FAIL',
    `— single-source: ${singleConf.toFixed(2)}, multi-source: ${multiConf.toFixed(2)}`);
  cleanup(tmpPath);
  return ok;
}

async function testConfidenceCapsAt095() {
  console.log('\n--- Test: Confidence Caps at 0.95');
  const { kg, tmpPath } = createTestKG();
  const engine = new InsightEngine(kg);

  const signals = [];
  for (let i = 0; i < 50; i++) {
    signals.push({
      type: i % 3 === 0 ? 'positive_feedback' : i % 3 === 1 ? 'link_click' : 'forward',
      topic: 'gym', value: 1,
      timestamp: `2026-03-${String(1 + (i % 28)).padStart(2, '0')}T08:00:00Z`,
    });
  }
  const conf = engine.calculateInsightConfidence(signals, { matchRatio: 1.0 });

  const ok = conf <= 0.95;
  console.log(ok ? 'PASS' : 'FAIL', `— max confidence: ${conf.toFixed(2)} (cap 0.95)`);
  cleanup(tmpPath);
  return ok;
}

async function testZeroSignalsLowConfidence() {
  console.log('\n--- Test: Zero Signals Returns Low Confidence');
  const { kg, tmpPath } = createTestKG();
  const engine = new InsightEngine(kg);

  const conf = engine.calculateInsightConfidence([]);
  const ok = conf <= 0.15;
  console.log(ok ? 'PASS' : 'FAIL', `— empty signals: ${conf.toFixed(2)}`);
  cleanup(tmpPath);
  return ok;
}

// ─── DERIVED PREDICTIONS TESTS ─────────────────────────────────────────

async function testGenerateDerivedPredictions() {
  console.log('\n--- Test: Generate Derived Predictions (structured)');
  const { kg, tmpPath } = createTestKG();
  const engine = new InsightEngine(kg);

  // Build up builder_identity pattern
  await engine.processNewSignal({ type: 'positive_feedback', topic: 'coding', value: 1, timestamp: new Date().toISOString() });
  await engine.processNewSignal({ type: 'positive_feedback', topic: 'startup', value: 1, timestamp: new Date().toISOString() });
  await engine.processNewSignal({ type: 'positive_feedback', topic: 'product', value: 1, timestamp: new Date().toISOString() });

  const preds = engine.generateDerivedPredictions();
  const ok = preds.length > 0 &&
    preds[0].criteria &&
    preds[0].criteria.boost_topics.length > 0 &&
    typeof preds[0].expected_delta === 'number' &&
    preds[0].source_insight_id;

  console.log(ok ? 'PASS' : 'FAIL',
    `— ${preds.length} structured predictions, first has ${preds[0]?.criteria?.boost_topics?.length || 0} boost topics`);
  cleanup(tmpPath);
  return ok;
}

async function testScoreContentBoost() {
  console.log('\n--- Test: Score Content — Boost Match');
  const { kg, tmpPath } = createTestKG();
  const engine = new InsightEngine(kg);

  // Build builder_identity pattern
  await engine.processNewSignal({ type: 'positive_feedback', topic: 'coding', value: 1, timestamp: new Date().toISOString() });
  await engine.processNewSignal({ type: 'positive_feedback', topic: 'startup', value: 1, timestamp: new Date().toISOString() });

  const result = engine.scoreContent({
    topics: ['indie hacker', 'shipping'],
    title: 'How I built and shipped my SaaS in 30 days',
  });

  const ok = result.totalDelta > 0 && result.matches.length > 0;
  console.log(ok ? 'PASS' : 'FAIL',
    `— totalDelta: ${result.totalDelta}, matches: ${result.matches.length}`);
  cleanup(tmpPath);
  return ok;
}

async function testScoreContentPenalize() {
  console.log('\n--- Test: Score Content — Penalize Match');
  const { kg, tmpPath } = createTestKG();
  const engine = new InsightEngine(kg);

  // Build builder_identity pattern
  await engine.processNewSignal({ type: 'positive_feedback', topic: 'coding', value: 1, timestamp: new Date().toISOString() });
  await engine.processNewSignal({ type: 'positive_feedback', topic: 'startup', value: 1, timestamp: new Date().toISOString() });

  const result = engine.scoreContent({
    topics: ['listicles', 'news roundup'],
    title: '10 things you missed this week',
  });

  const ok = result.totalDelta < 0;
  console.log(ok ? 'PASS' : 'FAIL',
    `— penalized content totalDelta: ${result.totalDelta}`);
  cleanup(tmpPath);
  return ok;
}

async function testScoreContentNeutral() {
  console.log('\n--- Test: Score Content — No Match Returns Zero');
  const { kg, tmpPath } = createTestKG();
  const engine = new InsightEngine(kg);

  await engine.processNewSignal({ type: 'positive_feedback', topic: 'coding', value: 1, timestamp: new Date().toISOString() });
  await engine.processNewSignal({ type: 'positive_feedback', topic: 'startup', value: 1, timestamp: new Date().toISOString() });

  const result = engine.scoreContent({
    topics: ['gardening', 'recipes'],
    title: 'Best tomato varieties for spring',
  });

  const ok = result.totalDelta === 0 && result.matches.length === 0;
  console.log(ok ? 'PASS' : 'FAIL',
    `— unrelated content: delta=${result.totalDelta}, matches=${result.matches.length}`);
  cleanup(tmpPath);
  return ok;
}

async function testValidatePredictionConfirmed() {
  console.log('\n--- Test: Validate Prediction — Confirmed');
  const { kg, tmpPath } = createTestKG();
  const engine = new InsightEngine(kg);

  await engine.processNewSignal({ type: 'positive_feedback', topic: 'coding', value: 1, timestamp: new Date().toISOString() });
  await engine.processNewSignal({ type: 'positive_feedback', topic: 'startup', value: 1, timestamp: new Date().toISOString() });

  const preds = engine.generateDerivedPredictions();
  if (preds.length === 0) { console.log('FAIL — no predictions'); cleanup(tmpPath); return false; }

  const updated = engine.validatePrediction(preds[0].id, 0.85, 0.50); // actual > baseline = confirmed
  const ok = updated && updated.test_results.length > 0 && updated.test_results[0].outcome === 'confirmed';
  console.log(ok ? 'PASS' : 'FAIL',
    `— validation outcome: ${updated?.test_results?.[0]?.outcome || 'none'}`);
  cleanup(tmpPath);
  return ok;
}

async function testValidatePredictionDenied() {
  console.log('\n--- Test: Validate Prediction — Denied');
  const { kg, tmpPath } = createTestKG();
  const engine = new InsightEngine(kg);

  await engine.processNewSignal({ type: 'positive_feedback', topic: 'coding', value: 1, timestamp: new Date().toISOString() });
  await engine.processNewSignal({ type: 'positive_feedback', topic: 'startup', value: 1, timestamp: new Date().toISOString() });

  const preds = engine.generateDerivedPredictions();
  if (preds.length === 0) { console.log('FAIL — no predictions'); cleanup(tmpPath); return false; }

  const updated = engine.validatePrediction(preds[0].id, 0.20, 0.50); // actual < baseline = denied
  const ok = updated && updated.test_results.length > 0 && updated.test_results[0].outcome === 'denied';
  console.log(ok ? 'PASS' : 'FAIL',
    `— validation outcome: ${updated?.test_results?.[0]?.outcome || 'none'}`);
  cleanup(tmpPath);
  return ok;
}

async function testCoOccurrencePredictions() {
  console.log('\n--- Test: Co-Occurrence Generates Testable Predictions');
  const { kg, tmpPath } = createTestKG();
  const engine = new InsightEngine(kg);

  const now = Date.now();
  // Create co-occurrence: blockchain appears 3x near regulation
  for (let i = 0; i < 3; i++) {
    kg.ingestSignal({ type: 'positive_feedback', topic: 'blockchain', value: 1, timestamp: new Date(now - i * 1000).toISOString() });
  }
  await engine.processNewSignal({ type: 'positive_feedback', topic: 'regulation', value: 1, timestamp: new Date(now).toISOString() });

  const preds = engine.generateDerivedPredictions();
  const cooccurPred = preds.find(p => p.id.includes('cooccur'));
  const ok = cooccurPred && cooccurPred.criteria.boost_topics.length >= 2;

  console.log(ok ? 'PASS' : 'FAIL',
    `— co-occurrence prediction: ${cooccurPred ? 'found' : 'missing'}, boost_topics: ${cooccurPred?.criteria?.boost_topics?.join(', ') || 'none'}`);
  cleanup(tmpPath);
  return ok;
}

async function testLLMHypothesisGeneration() {
  console.log('\n--- Test: LLM Hypothesis Generation (mock)');
  const { kg, tmpPath } = createTestKG();

  // Mock LLM that returns a valid hypothesis
  const mockLLM = async (prompt) => JSON.stringify({
    hypothesis: 'User is building a personal brand around technical expertise',
    predictions: ['Personal branding content will score high', 'Technical deep-dives outperform listicles'],
    confidence_note: 'Strong signal cluster around creation and sharing',
  });

  const engine = new InsightEngine(kg, { useLLM: true, llmCall: mockLLM, llmMinTopics: 3 });

  // Pre-populate with enough unrelated topics (no heuristic match)
  const now = Date.now();
  for (const topic of ['blogging', 'twitter', 'analytics']) {
    kg.ingestSignal({ type: 'positive_feedback', topic, value: 1, timestamp: new Date(now).toISOString() });
  }

  // Process a new signal — no heuristic pattern matches, so LLM should fire
  const result = await engine.processNewSignal({
    type: 'positive_feedback',
    topic: 'personal-website',
    value: 1,
    timestamp: new Date(now).toISOString(),
  });

  const hasLLM = result.llm.length > 0;
  const ok = hasLLM && result.llm[0].hypothesis.includes('personal brand');
  console.log(ok ? 'PASS' : 'FAIL',
    `— LLM hypothesis generated: ${hasLLM}, hypothesis: "${result.llm[0]?.hypothesis || 'none'}"`);

  cleanup(tmpPath);
  return ok;
}

async function testLLMSkippedWhenHeuristicMatches() {
  console.log('\n--- Test: LLM Skipped When Heuristic Matches');
  const { kg, tmpPath } = createTestKG();

  let llmCalled = false;
  const mockLLM = async () => { llmCalled = true; return '{}'; };

  const engine = new InsightEngine(kg, { useLLM: true, llmCall: mockLLM, llmMinTopics: 2 });

  // These topics match the builder_identity heuristic pattern
  await engine.processNewSignal({ type: 'positive_feedback', topic: 'coding', value: 1, timestamp: new Date().toISOString() });
  await engine.processNewSignal({ type: 'positive_feedback', topic: 'startup', value: 1, timestamp: new Date().toISOString() });

  const ok = !llmCalled;
  console.log(ok ? 'PASS' : 'FAIL', `— LLM not called when heuristic matched: ${!llmCalled}`);

  cleanup(tmpPath);
  return ok;
}

async function testLLMFailureIsNonFatal() {
  console.log('\n--- Test: LLM Failure is Non-Fatal');
  const { kg, tmpPath } = createTestKG();

  const brokenLLM = async () => { throw new Error('API timeout'); };
  const engine = new InsightEngine(kg, { useLLM: true, llmCall: brokenLLM, llmMinTopics: 3 });

  for (const topic of ['quantum', 'philosophy', 'poetry']) {
    kg.ingestSignal({ type: 'positive_feedback', topic, value: 1, timestamp: new Date().toISOString() });
  }

  let threw = false;
  try {
    const result = await engine.processNewSignal({
      type: 'positive_feedback', topic: 'abstract-math', value: 1, timestamp: new Date().toISOString(),
    });
    threw = false;
  } catch {
    threw = true;
  }

  const ok = !threw;
  console.log(ok ? 'PASS' : 'FAIL', `— engine survived LLM failure: ${!threw}`);

  cleanup(tmpPath);
  return ok;
}

// ─── KG STORAGE TESTS ────────────────────────────────────────────────

async function testStoreInsightManually() {
  console.log('\n--- Test: storeInsight stores node in KG');
  const { kg, tmpPath } = createTestKG();
  const engine = new InsightEngine(kg);

  const insight = engine.storeInsight({
    observation: 'User combines fitness and tech topics frequently',
    hypothesis: 'Health-tech crossover persona',
    supporting_signals: ['gym', 'wearables', 'health data'],
    confidence: 0.6,
    derived_predictions: ['Health-tech content will score high'],
    source_layer: 'synthetic',
  });

  const stored = kg.data.user.insights.find(i => i.id === insight.id);
  const ok = !!stored && stored.hypothesis === 'Health-tech crossover persona';
  console.log(ok ? 'PASS' : 'FAIL', `— insight stored in KG: ${!!stored}`);
  cleanup(tmpPath);
  return ok;
}

async function testAutoSavePersistsToDisk() {
  console.log('\n--- Test: autoSave persists insights to disk');
  const { kg, tmpPath } = createTestKG();
  const engine = new InsightEngine(kg, { autoSave: true });

  // Build a pattern that creates cross-ref insights
  await engine.processNewSignal({ type: 'positive_feedback', topic: 'gym', value: 1, timestamp: new Date().toISOString() });
  await engine.processNewSignal({ type: 'positive_feedback', topic: 'security', value: 1, timestamp: new Date().toISOString() });

  // Read from disk — should have persisted
  const onDisk = JSON.parse(fs.readFileSync(tmpPath, 'utf8'));
  const hasInsights = (onDisk.user.insights || []).some(i =>
    i.observation && i.observation.includes('vulnerability_armor')
  );
  console.log(hasInsights ? 'PASS' : 'FAIL', `— insights persisted to disk: ${hasInsights}`);
  cleanup(tmpPath);
  return hasInsights;
}

async function testInsightEdgesIndexed() {
  console.log('\n--- Test: Insight edges are indexed (triggered_by + related_to)');
  const { kg, tmpPath } = createTestKG();
  const engine = new InsightEngine(kg);

  await engine.processNewSignal({ type: 'positive_feedback', topic: 'gym', value: 1, timestamp: new Date().toISOString() });
  await engine.processNewSignal({ type: 'positive_feedback', topic: 'security', value: 1, timestamp: new Date().toISOString() });

  // The vulnerability_armor insight should have _edges
  const armorInsight = kg.data.user.insights.find(i =>
    i.observation && i.observation.includes('vulnerability_armor')
  );

  const hasEdges = armorInsight && armorInsight._edges && armorInsight._edges.length > 0;
  const hasTriggeredBy = armorInsight && (armorInsight._edges || []).some(e => e.type === 'triggered_by');

  const ok = hasEdges && hasTriggeredBy;
  console.log(ok ? 'PASS' : 'FAIL',
    `— edges: ${armorInsight?._edges?.length || 0}, has triggered_by: ${hasTriggeredBy}`);
  cleanup(tmpPath);
  return ok;
}

async function testGetRelatedInsights() {
  console.log('\n--- Test: getRelatedInsights returns connected insights');
  const { kg, tmpPath } = createTestKG();
  const engine = new InsightEngine(kg);

  // Create two patterns that share 'gym'
  await engine.processNewSignal({ type: 'positive_feedback', topic: 'gym', value: 1, timestamp: new Date().toISOString() });
  await engine.processNewSignal({ type: 'positive_feedback', topic: 'security', value: 1, timestamp: new Date().toISOString() });
  await engine.processNewSignal({ type: 'positive_feedback', topic: 'diet', value: 1, timestamp: new Date().toISOString() });

  // Find vulnerability_armor and health_optimization — both share 'gym'
  const armorInsight = kg.data.user.insights.find(i =>
    i.observation && i.observation.includes('vulnerability_armor')
  );
  const healthInsight = kg.data.user.insights.find(i =>
    i.observation && i.observation.includes('health_optimization')
  );

  if (!armorInsight || !healthInsight) {
    console.log('FAIL — patterns not created');
    cleanup(tmpPath);
    return false;
  }

  const related = engine.getRelatedInsights(armorInsight.id);
  const isConnected = related.some(i => i.id === healthInsight.id);

  console.log(isConnected ? 'PASS' : 'FAIL',
    `— armor related to health: ${isConnected} (${related.length} related insights)`);
  cleanup(tmpPath);
  return isConnected;
}

async function testGetInsightsByTopic() {
  console.log('\n--- Test: getInsightsByTopic returns matching insights');
  const { kg, tmpPath } = createTestKG();
  const engine = new InsightEngine(kg);

  await engine.processNewSignal({ type: 'positive_feedback', topic: 'coding', value: 1, timestamp: new Date().toISOString() });
  await engine.processNewSignal({ type: 'positive_feedback', topic: 'startup', value: 1, timestamp: new Date().toISOString() });

  const results = engine.getInsightsByTopic('coding');
  const ok = results.length > 0;
  console.log(ok ? 'PASS' : 'FAIL', `— insights for 'coding': ${results.length}`);
  cleanup(tmpPath);
  return ok;
}

async function testGetInsightStats() {
  console.log('\n--- Test: getInsightStats returns correct counts');
  const { kg, tmpPath } = createTestKG();
  const engine = new InsightEngine(kg);

  await engine.processNewSignal({ type: 'positive_feedback', topic: 'coding', value: 1, timestamp: new Date().toISOString() });
  await engine.processNewSignal({ type: 'positive_feedback', topic: 'startup', value: 1, timestamp: new Date().toISOString() });

  const stats = engine.getInsightStats();
  const ok = stats.total > 0 && stats.avgConfidence > 0 && stats.withPredictions > 0;
  console.log(ok ? 'PASS' : 'FAIL',
    `— total: ${stats.total}, avgConf: ${stats.avgConfidence}, withPredictions: ${stats.withPredictions}`);
  cleanup(tmpPath);
  return ok;
}

async function testStoredCountInProcessResult() {
  console.log('\n--- Test: processNewSignal returns stored count');
  const { kg, tmpPath } = createTestKG();
  const engine = new InsightEngine(kg);

  await engine.processNewSignal({ type: 'positive_feedback', topic: 'gym', value: 1, timestamp: new Date().toISOString() });
  const result = await engine.processNewSignal({ type: 'positive_feedback', topic: 'security', value: 1, timestamp: new Date().toISOString() });

  const ok = typeof result.stored === 'number' && result.stored >= 0;
  console.log(ok ? 'PASS' : 'FAIL', `— stored count: ${result.stored}`);
  cleanup(tmpPath);
  return ok;
}

async function runAllTests() {
  console.log('Marble Insight Engine Test Suite');
  console.log('='.repeat(50));

  const tests = [
    testBasicSignalIngestion,
    testHeuristicPatternMatching,
    testIdentityShiftPattern,
    testNoFalsePositives,
    testTopicCoOccurrence,
    testTemporalPatterns,
    testConfidenceGrowsWithEvidence,
    testLatentPredictions,
    testSyntheticAndObservedLayers,
    testConfidenceScalesWithSignalCount,
    testConfidenceBoostsForConsistency,
    testConfidenceBoostsForTemporalSpread,
    testConfidenceBoostsForSourceDiversity,
    testConfidenceCapsAt095,
    testZeroSignalsLowConfidence,
    testGenerateDerivedPredictions,
    testScoreContentBoost,
    testScoreContentPenalize,
    testScoreContentNeutral,
    testValidatePredictionConfirmed,
    testValidatePredictionDenied,
    testCoOccurrencePredictions,
    testLLMHypothesisGeneration,
    testLLMSkippedWhenHeuristicMatches,
    testLLMFailureIsNonFatal,
    // KG Storage tests
    testStoreInsightManually,
    testAutoSavePersistsToDisk,
    testInsightEdgesIndexed,
    testGetRelatedInsights,
    testGetInsightsByTopic,
    testGetInsightStats,
    testStoredCountInProcessResult,
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      const result = await test();
      if (result) passed++;
      else failed++;
    } catch (error) {
      console.log('FAIL (error):', error.message);
      failed++;
    }
  }

  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed}`);

  return failed === 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAllTests()
    .then(success => process.exit(success ? 0 : 1))
    .catch(error => { console.error('Suite error:', error); process.exit(1); });
}

export { runAllTests };
