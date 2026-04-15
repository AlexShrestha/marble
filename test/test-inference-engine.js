/**
 * Test: L2 Inference Engine
 *
 * Verifies:
 * - Inference candidates generated from L1 facts
 * - Gate logic (confidence >= 0.65, >=2 supporting facts)
 * - Queue operations (dequeue, peek, clearQueue)
 * - Second-order effects populated
 */

import { KnowledgeGraph } from '../core/kg.js';
import { InferenceEngine } from '../core/inference-engine.js';

async function test() {
  console.log('=== L2 Inference Engine Test ===\n');

  // Setup KG with test L1 facts
  const kg = new KnowledgeGraph(':memory:');
  kg.user = {
    beliefs: [
      {
        topic: 'AI',
        claim: 'LLMs will transform business processes',
        strength: 0.8,
        evidence_count: 3,
        valid_from: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
        valid_to: null,
        recorded_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
      },
      {
        topic: 'automation',
        claim: 'Automation reduces human error',
        strength: 0.85,
        evidence_count: 4,
        valid_from: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
        valid_to: null,
        recorded_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
      },
      {
        topic: 'tech_risk',
        claim: 'Technology introduces new attack vectors',
        strength: 0.7,
        evidence_count: 2,
        valid_from: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
        valid_to: null,
        recorded_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
      }
    ],
    preferences: [
      {
        type: 'learning_style',
        description: 'hands-on experimentation',
        strength: 0.75,
        valid_from: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
        valid_to: null,
        recorded_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
      },
      {
        type: 'content_style',
        description: 'case studies over theory',
        strength: 0.65,
        valid_from: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
        valid_to: null,
        recorded_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
      }
    ],
    identities: [
      {
        role: 'engineer',
        context: 'Systems design and implementation',
        salience: 0.9,
        valid_from: new Date().toISOString(),
        valid_to: null,
        recorded_at: new Date().toISOString()
      },
      {
        role: 'learner',
        context: 'Continuous improvement mindset',
        salience: 0.8,
        valid_from: new Date().toISOString(),
        valid_to: null,
        recorded_at: new Date().toISOString()
      }
    ],
    confidence: {
      'AI': 0.6,
      'automation': 0.8,
      'tech_risk': 0.4
    },
    interests: [],
    history: [],
    source_trust: {},
    context: {}
  };

  // Create and run inference engine
  const engine = new InferenceEngine(kg, {
    confidenceThreshold: 0.65,
    minSupportingFacts: 2
  });

  console.log('Running inference...');
  const candidates = await engine.run();
  console.log(`✓ Generated ${candidates.length} candidates that passed the gate\n`);

  // Display candidates
  for (const [i, candidate] of candidates.entries()) {
    console.log(`\n📌 Candidate ${i + 1}`);
    console.log(`   Question: ${candidate.question}`);
    console.log(`   Confidence: ${(candidate.confidence * 100).toFixed(1)}%`);
    console.log(`   Supporting Facts: ${candidate.supporting_L1_facts.length}`);
    console.log(`   Source: ${candidate.source}`);
    console.log(`   Second-Order Effects:`);
    for (const effect of candidate.second_order_effects) {
      console.log(`     - ${effect}`);
    }
  }

  // Test queue operations
  console.log(`\n📋 Queue Operations:`);
  console.log(`   Total in queue: ${engine.getQueue().length}`);
  console.log(`   Peek next: ${engine.peek()?.source || 'empty'}`);

  const dequeued = engine.dequeue();
  console.log(`   Dequeued: ${dequeued?.source || 'empty'}`);
  console.log(`   Remaining: ${engine.getQueue().length}`);

  // Test stats
  console.log(`\n📊 Engine Stats:`);
  const stats = engine.getStats();
  console.log(`   Processed Facts: ${stats.processedFacts}`);
  console.log(`   Queue Length: ${stats.queueLength}`);
  console.log(`   Confidence Threshold: ${stats.confidenceThreshold}`);
  console.log(`   Min Supporting Facts: ${stats.minSupportingFacts}`);

  // Verify gate logic
  console.log(`\n✅ Gate Logic Verification:`);
  console.log(`   All candidates have confidence >= 0.65: ${candidates.every(c => c.confidence >= 0.65)}`);
  console.log(`   All candidates have >= 2 supporting facts: ${candidates.every(c => c.supporting_L1_facts.length >= 2)}`);

  console.log('\n=== Test Complete ===');
}

test().catch(console.error);
