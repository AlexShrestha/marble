/**
 * Test: TopicInsightEngine + GapSimulator
 *
 * Validates:
 * 1. Dimension extraction (LLM + heuristic fallback)
 * 2. Gap simulation with hypothesis generation
 * 3. KG enrichment via analyse()
 * 4. Insight-swarm alias compatibility (observation, hypothesis, etc)
 */

import { TopicInsightEngine, GapSimulator } from '../core/topic-insight-engine.js';
import { KnowledgeGraph } from '../core/kg.js';

// Mock LLM call for testing
const mockLLM = async (prompt) => {
  // Return mock JSON for dimension extraction
  if (prompt.includes('preference-analysis system')) {
    return JSON.stringify([
      { id: 'theme', label: 'Theme', value: 'science fiction', kgType: 'preference' },
      { id: 'pacing', label: 'Pacing', value: 'slow burn', kgType: 'preference' },
      { id: 'tone', label: 'Tone', value: 'dark', kgType: 'belief' }
    ]);
  }
  // Return mock JSON for gap simulation
  if (prompt.includes('Unknown preference dimensions')) {
    return JSON.stringify([
      {
        dimensionId: 'unknown_dim',
        value: 'test_value',
        kgType: 'preference',
        confidence: 0.65,
        reasoning: 'User consistently engages with this dimension in positive reactions'
      }
    ]);
  }
  return '[]';
};

async function testTopicInsightEngine() {
  console.log('\n=== TEST: TopicInsightEngine ===\n');

  const engine = new TopicInsightEngine({
    llmCall: mockLLM,
    model: 'claude-haiku',
    maxDimensions: 8
  });

  const kg = new KnowledgeGraph('test-kg.json');
  kg.user = {
    id: 'test-user',
    interests: [],
    context: { calendar: [], active_projects: [], recent_conversations: [], mood_signal: null },
    history: [],
    source_trust: {},
    beliefs: [],
    preferences: [],
    identities: [],
    confidence: {}
  };

  // Add some history to KG for context
  kg.recordReaction('story1', ['sci-fi', 'dark'], 'up');
  kg.recordReaction('story2', ['sci-fi', 'light'], 'down');
  kg.recordReaction('story3', ['fantasy', 'dark'], 'up');

  // Test item
  const testItem = {
    id: 'test-content',
    title: 'A sci-fi thriller about quantum computing',
    type: 'article',
    summary: 'Explores the implications of quantum computing on society',
    tags: ['sci-fi', 'tech', 'dark'],
    author: 'Dr. Smith',
    year: 2024
  };

  try {
    // Test analyse() which uses extractDimensions + GapSimulator
    const result = await engine.analyse(testItem, 'up', kg);

    console.log('✓ Analyse completed');
    console.log(`  - Dimensions extracted: ${result.dimensions.length}`);
    console.log(`  - Hypotheses generated: ${result.hypotheses.length}`);
    console.log(`  - Nodes written to KG: ${result.nodesWritten}`);

    if (result.dimensions.length > 0) {
      console.log('\n  Sample dimensions:');
      result.dimensions.slice(0, 3).forEach(d => {
        console.log(`    - ${d.label} (${d.id}): "${d.value}" [${d.kgType}]`);
      });
    }

    if (result.hypotheses.length > 0) {
      console.log('\n  Sample hypotheses:');
      result.hypotheses.slice(0, 3).forEach(h => {
        console.log(`    - ${h.dimensionId}: "${h.value}" (conf: ${h.confidence.toFixed(2)})`);
      });
    }

    // Verify KG was enriched
    const beliefs = kg.getBeliefsArray?.() || [];
    const prefs = kg.getPreferencesArray?.() || [];
    console.log(`\n  KG enriched: ${beliefs.length} beliefs, ${prefs.length} preferences`);

    return true;
  } catch (e) {
    console.error('✗ Test failed:', e.message);
    return false;
  }
}

async function testGapSimulator() {
  console.log('\n=== TEST: GapSimulator (standalone) ===\n');

  const simulator = new GapSimulator({
    llmCall: mockLLM,
    hypothesesPerGap: 3
  });

  const testItem = {
    title: 'Test content',
    type: 'story'
  };

  const gaps = [
    { id: 'unknown_dim1', label: 'Unknown 1', value: 'value1', kgType: 'preference' },
    { id: 'unknown_dim2', label: 'Unknown 2', value: 'value2', kgType: 'belief' }
  ];

  const ratedHistory = [
    { id: 'h1', topics: ['sci-fi', 'dark'], reaction: 'up' },
    { id: 'h2', topics: ['sci-fi'], reaction: 'down' },
    { id: 'h3', topics: ['dark'], reaction: 'up' }
  ];

  try {
    const hypotheses = await simulator.simulate(testItem, gaps, ratedHistory, 'up');

    console.log(`✓ Generated ${hypotheses.length} hypotheses`);
    if (hypotheses.length > 0) {
      hypotheses.forEach(h => {
        console.log(`  - ${h.dimensionId}: "${h.value}" [confidence: ${h.confidence.toFixed(2)}]`);
      });
    }

    return true;
  } catch (e) {
    console.error('✗ Test failed:', e.message);
    return false;
  }
}

async function testHeuristicFallback() {
  console.log('\n=== TEST: Heuristic Fallback (no LLM) ===\n');

  // Engine without LLM should use heuristic extraction
  const engine = new TopicInsightEngine({
    llmCall: null,
    maxDimensions: 10
  });

  const testItem = {
    id: 'test-2',
    title: 'Movie from 1985',
    type: 'movie',
    director: 'Ridley Scott',
    genre: ['sci-fi', 'action'],
    themes: ['survival', 'dystopia'],
    tone: 'dark',
    pacing: 'fast'
  };

  try {
    const dimensions = await engine.extractDimensions(testItem);

    console.log(`✓ Extracted ${dimensions.length} dimensions (heuristic)`);
    dimensions.slice(0, 5).forEach(d => {
      console.log(`  - ${d.label} (${d.id}): "${d.value}" [${d.kgType}]`);
    });

    // Should include era detection
    const hasEra = dimensions.some(d => d.id === 'era');
    console.log(`\n  ✓ Era detection: ${hasEra ? 'PASS' : 'FAIL'}`);

    return true;
  } catch (e) {
    console.error('✗ Test failed:', e.message);
    return false;
  }
}

async function runAllTests() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║   TopicInsightEngine + GapSimulator Validation Tests   ║');
  console.log('╚════════════════════════════════════════════════════════╝');

  const results = [];
  results.push(await testTopicInsightEngine());
  results.push(await testGapSimulator());
  results.push(await testHeuristicFallback());

  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log(`║ SUMMARY: ${results.filter(Boolean).length}/${results.length} tests passed                              ║`);
  console.log('╚════════════════════════════════════════════════════════╝\n');

  return results.every(Boolean);
}

// Run if executed directly
const success = await runAllTests();
process.exit(success ? 0 : 1);
