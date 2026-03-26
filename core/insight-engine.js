/**
 * insight-engine.js — Marble Signal Cross-Referencing Engine
 *
 * When a new signal arrives, cross-references it against ALL existing signals
 * in the KG to discover latent meaning beyond simple weight updates.
 *
 * Examples of latent insights:
 * - gym + security content + insurance research = "feeling vulnerable, building armor"
 * - has kid + reads routines + avoids spontaneity = "identity shifted from adventurer to protector"
 * - morning gym = routine-driven (discipline). Evening gym = stress release.
 *
 * Works with both real (observed) and synthetic data layers.
 */

import { KnowledgeGraph as MarbleKG } from './kg.js';

// ─── HEURISTIC PATTERN LIBRARY ────────────────────────────────────────────
// Each pattern: { name, tags (topics that must co-occur), hypothesis, predictions }
// tags use lowercase; matching is fuzzy (substring).

const LATENT_PATTERNS = [
  {
    name: 'vulnerability_armor',
    tags: ['gym', 'security', 'insurance'],
    minMatch: 2,
    hypothesis: 'Feeling vulnerable — building physical and financial armor',
    predictions: [
      'Will engage with resilience/self-improvement content',
      'Insurance or personal safety content will score higher than average',
    ],
  },
  {
    name: 'identity_shift_protector',
    tags: ['kid', 'routine', 'parenting', 'schedule', 'family'],
    minMatch: 2,
    hypothesis: 'Identity shifted from adventurer to protector — routine and stability now valued',
    predictions: [
      'Spontaneity-themed content will underperform',
      'Parenting + productivity crossover content will resonate',
    ],
  },
  {
    name: 'career_transition',
    tags: ['startup', 'resume', 'interview', 'freelance', 'side project', 'quit'],
    minMatch: 2,
    hypothesis: 'Exploring career transition — seeking validation and practical playbooks',
    predictions: [
      'Founder stories and career-pivot content will score high',
      'Corporate culture content will score low',
    ],
  },
  {
    name: 'creative_awakening',
    tags: ['art', 'music', 'writing', 'design', 'photography', 'creative'],
    minMatch: 2,
    hypothesis: 'Creative interests emerging — possibly seeking outlet or identity expansion',
    predictions: [
      'Creative tool and process content will engage well',
      'Cross-disciplinary creative content (tech + art) will resonate',
    ],
  },
  {
    name: 'health_optimization',
    tags: ['gym', 'diet', 'sleep', 'supplements', 'biohacking', 'health', 'fitness'],
    minMatch: 2,
    hypothesis: 'Actively optimizing health — disciplined, data-oriented approach to wellbeing',
    predictions: [
      'Quantified-self and health-tech content will score high',
      'Indulgence-themed content will underperform',
    ],
  },
  {
    name: 'financial_anxiety',
    tags: ['investing', 'savings', 'debt', 'budget', 'recession', 'layoff', 'finance'],
    minMatch: 2,
    hypothesis: 'Financial anxiety driving content consumption — seeking control and reassurance',
    predictions: [
      'Practical finance content outperforms theoretical',
      'Success stories about financial recovery will engage',
    ],
  },
  {
    name: 'builder_identity',
    tags: ['coding', 'startup', 'product', 'launch', 'build', 'ship', 'saas'],
    minMatch: 2,
    hypothesis: 'Strong builder identity — values creation and shipping over consumption',
    predictions: [
      'Build-in-public and maker content will score high',
      'Passive consumption content (listicles, news roundups) will underperform',
    ],
  },
  {
    name: 'stress_coping',
    tags: ['meditation', 'gym', 'alcohol', 'gaming', 'netflix', 'stress', 'burnout'],
    minMatch: 2,
    hypothesis: 'Stress coping pattern detected — mix of healthy and unhealthy outlets',
    predictions: [
      'Burnout recovery content will resonate',
      'High-pressure hustle content will score negatively',
    ],
  },
];

// ─── PREDICTION CRITERIA (structured scoring rules per pattern) ───────────
// Maps pattern name → { boost_topics, penalize_topics, expected_delta }

const PREDICTION_CRITERIA = {
  vulnerability_armor: {
    boost_topics: ['resilience', 'self-improvement', 'insurance', 'personal safety', 'self-defense'],
    penalize_topics: ['risk-taking', 'extreme sports', 'gambling'],
    expected_delta: 0.18,
  },
  identity_shift_protector: {
    boost_topics: ['parenting', 'productivity', 'routine', 'family', 'stability'],
    penalize_topics: ['spontaneity', 'nightlife', 'adventure travel', 'impulse'],
    expected_delta: 0.20,
  },
  career_transition: {
    boost_topics: ['founder stories', 'career pivot', 'freelance', 'side project', 'startup playbook'],
    penalize_topics: ['corporate culture', 'office politics', 'promotion ladder'],
    expected_delta: 0.15,
  },
  creative_awakening: {
    boost_topics: ['creative tools', 'creative process', 'art', 'design', 'cross-disciplinary'],
    penalize_topics: ['pure theory', 'academic', 'rote learning'],
    expected_delta: 0.14,
  },
  health_optimization: {
    boost_topics: ['quantified self', 'health tech', 'biohacking', 'fitness data', 'nutrition science'],
    penalize_topics: ['indulgence', 'junk food', 'sedentary'],
    expected_delta: 0.16,
  },
  financial_anxiety: {
    boost_topics: ['practical finance', 'budgeting', 'financial recovery', 'savings tips', 'debt payoff'],
    penalize_topics: ['luxury', 'conspicuous consumption', 'speculative investing'],
    expected_delta: 0.17,
  },
  builder_identity: {
    boost_topics: ['build in public', 'maker', 'shipping', 'product launch', 'indie hacker'],
    penalize_topics: ['listicles', 'news roundup', 'passive consumption'],
    expected_delta: 0.19,
  },
  stress_coping: {
    boost_topics: ['burnout recovery', 'mental health', 'mindfulness', 'work-life balance'],
    penalize_topics: ['hustle culture', 'grind', 'high pressure'],
    expected_delta: 0.15,
  },
};

// ─── TEMPORAL PATTERN DETECTORS ───────────────────────────────────────────

function detectTemporalPattern(signals) {
  const patterns = [];

  // Group signals by hour-of-day
  const byHour = {};
  for (const s of signals) {
    if (!s.timestamp) continue;
    const hour = new Date(s.timestamp).getHours();
    if (!byHour[hour]) byHour[hour] = [];
    byHour[hour].push(s);
  }

  // Morning signals (5-9) vs Evening signals (18-23)
  const morningTopics = [];
  const eveningTopics = [];
  for (const [hour, sigs] of Object.entries(byHour)) {
    const h = parseInt(hour);
    const topics = sigs.map(s => s.topic).filter(Boolean);
    if (h >= 5 && h <= 9) morningTopics.push(...topics);
    if (h >= 18 && h <= 23) eveningTopics.push(...topics);
  }

  if (morningTopics.length >= 2 && eveningTopics.length >= 2) {
    const morningSet = new Set(morningTopics.map(t => t.toLowerCase()));
    const eveningSet = new Set(eveningTopics.map(t => t.toLowerCase()));

    // Find topics that appear only in one time slot
    const morningOnly = [...morningSet].filter(t => !eveningSet.has(t));
    const eveningOnly = [...eveningSet].filter(t => !morningSet.has(t));

    if (morningOnly.length > 0 && eveningOnly.length > 0) {
      patterns.push({
        type: 'temporal_split',
        observation: `Morning focus: ${morningOnly.join(', ')} | Evening focus: ${eveningOnly.join(', ')}`,
        hypothesis: 'Different mindsets at different times — morning = productive/aspirational, evening = reflective/recreational',
        confidence: 0.45,
        predictions: [
          `Serve ${morningOnly.join('/')} content in morning for higher engagement`,
          `Serve ${eveningOnly.join('/')} content in evening for higher engagement`,
        ],
      });
    }
  }

  return patterns;
}

// ─── MAIN ENGINE CLASS ────────────────────────────────────────────────────

export class InsightEngine {
  /**
   * @param {MarbleKG} kg - loaded MarbleKG instance
   * @param {object} [opts]
   * @param {function} [opts.llmCall] - async (prompt: string) => string — LLM completion fn
   * @param {boolean} [opts.useLLM=false] - enable LLM hypothesis generation for novel combos
   * @param {number} [opts.llmMinTopics=3] - min unique topics before triggering LLM
   */
  constructor(kg, opts = {}) {
    this.kg = kg; // MarbleKG instance (must be loaded)
    this.patternLibrary = LATENT_PATTERNS;
    this.llmCall = opts.llmCall || null;
    this.useLLM = opts.useLLM || false;
    this.llmMinTopics = opts.llmMinTopics || 3;
    this.autoSave = opts.autoSave !== undefined ? opts.autoSave : false;
  }

  /**
   * Main entry: process a new signal, cross-reference against existing KG,
   * and return any newly discovered insights.
   * All discovered insights are stored as first-class nodes in the KG.
   * If autoSave is enabled, persists to disk after processing.
   *
   * @param {object} signal - { type, topic, value, context, timestamp }
   * @returns {{ ingested: object[], crossRef: object[], temporal: object[], llm: object[], stored: number }}
   */
  async processNewSignal(signal) {
    // 1. Ingest signal into KG (updates weights + basic insights)
    const ingested = this.kg.ingestSignal(signal);

    // 2. Cross-reference against all existing signals for latent patterns
    const crossRef = this.crossReference(signal);

    // 3. Check temporal patterns across signal history
    const temporal = this.detectTemporalInsights();

    // 4. If LLM enabled and heuristics found nothing novel, try LLM hypothesis
    let llm = [];
    if (this.useLLM && this.llmCall && crossRef.length === 0) {
      llm = await this.generateLLMHypothesis(signal);
    }

    // 5. Index all new insights with edge links back to trigger signal
    const allNew = [...crossRef, ...temporal, ...llm];
    for (const insight of allNew) {
      this._indexInsightEdges(insight, signal);
    }

    // 6. Persist to disk if autoSave enabled
    if (this.autoSave && allNew.length > 0) {
      this.kg.save();
    }

    return { ingested, crossRef, temporal, llm, stored: allNew.length };
  }

  /**
   * Store a manually-created insight as a node in the KG with proper edges.
   * Use this when external code (e.g. editorial, LLM analysis) produces insights
   * that should be tracked in the graph.
   *
   * @param {object} insightData - { observation, hypothesis, supporting_signals, confidence, derived_predictions, source_layer, trigger_signal? }
   * @returns {object} the stored insight node
   */
  storeInsight(insightData) {
    const insight = this.kg.addInsight({
      observation: insightData.observation,
      hypothesis: insightData.hypothesis,
      supporting_signals: insightData.supporting_signals || [],
      confidence: insightData.confidence || 0.5,
      derived_predictions: insightData.derived_predictions || [],
      source_layer: insightData.source_layer || 'synthetic',
    });

    this._indexInsightEdges(insight, insightData.trigger_signal || null);

    if (this.autoSave) {
      this.kg.save();
    }

    return insight;
  }

  /**
   * Retrieve insight nodes by topic — returns insights whose supporting_signals
   * or observations reference the given topic.
   */
  getInsightsByTopic(topic, opts = {}) {
    return this.kg.getInsights({
      topic,
      minConfidence: opts.minConfidence,
      sourceLayer: opts.sourceLayer,
    });
  }

  /**
   * Get insights connected to a specific insight via shared supporting signals.
   * Traverses the insight graph edges.
   */
  getRelatedInsights(insightId) {
    const allInsights = this.kg.data.user.insights || [];
    const target = allInsights.find(i => i.id === insightId);
    if (!target) return [];

    const targetSignals = new Set(target.supporting_signals.map(s => s.toLowerCase()));
    if (targetSignals.size === 0) return [];

    return allInsights.filter(i => {
      if (i.id === insightId) return false;
      return i.supporting_signals.some(s => targetSignals.has(s.toLowerCase()));
    }).sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Get summary stats of all insight nodes in the KG.
   */
  getInsightStats() {
    const insights = this.kg.data.user.insights || [];
    const bySource = {};
    let totalConf = 0;

    for (const i of insights) {
      const src = i.source_layer || 'unknown';
      bySource[src] = (bySource[src] || 0) + 1;
      totalConf += i.confidence || 0;
    }

    return {
      total: insights.length,
      bySource,
      avgConfidence: insights.length > 0 ? Math.round((totalConf / insights.length) * 100) / 100 : 0,
      withPredictions: insights.filter(i => (i.derived_predictions || []).length > 0).length,
      tested: insights.filter(i => (i.test_results || []).length > 0).length,
    };
  }

  /**
   * Cross-reference a new signal against ALL existing signals in KG.
   * Matches against heuristic pattern library + topic co-occurrence.
   *
   * @param {object} newSignal - the signal just ingested
   * @returns {object[]} - newly created insight nodes
   */
  crossReference(newSignal) {
    const allSignals = this.kg.data.user.signals || [];
    const existingInsights = this.kg.data.user.insights || [];
    const newInsights = [];

    // Collect all unique topics from signal history
    const allTopics = this._collectTopics(allSignals);

    // 1. Match against heuristic pattern library
    for (const pattern of this.patternLibrary) {
      // Check if enough pattern tags match the user's topic set
      const matched = pattern.tags.filter(tag =>
        allTopics.some(t => t.includes(tag) || tag.includes(t))
      );

      if (matched.length < pattern.minMatch) continue;

      // Check if this pattern insight already exists
      const alreadyExists = existingInsights.some(i =>
        i.observation && i.observation.includes(pattern.name)
      );

      if (alreadyExists) {
        // Strengthen existing insight
        const existing = existingInsights.find(i =>
          i.observation && i.observation.includes(pattern.name)
        );
        if (existing) {
          existing.confidence = Math.min(1, existing.confidence + 0.03);
          existing.updated_at = new Date().toISOString();
          if (!existing.supporting_signals.includes(newSignal.topic)) {
            existing.supporting_signals.push(newSignal.topic);
          }
        }
        continue;
      }

      // Create new latent insight
      const insight = this.kg.addInsight({
        observation: `[${pattern.name}] Latent pattern: ${matched.join(' + ')} detected`,
        hypothesis: pattern.hypothesis,
        supporting_signals: matched,
        confidence: this._calculatePatternConfidence(matched, pattern, allSignals),
        derived_predictions: pattern.predictions,
        source_layer: 'synthetic',
      });

      newInsights.push(insight);
    }

    // 2. Topic co-occurrence analysis (beyond predefined patterns)
    const coOccurrence = this._findTopicCoOccurrence(newSignal, allSignals);
    for (const cluster of coOccurrence) {
      const clusterKey = cluster.topics.sort().join('+');
      const alreadyExists = existingInsights.some(i =>
        i.supporting_signals &&
        cluster.topics.every(t => i.supporting_signals.includes(t))
      );

      if (!alreadyExists && cluster.topics.length >= 2) {
        // Gather the actual signals that formed this cluster for confidence scoring
        const clusterSignals = allSignals.filter(s =>
          s.topic && cluster.topics.some(t => s.topic.toLowerCase().includes(t))
        );
        const insight = this.kg.addInsight({
          observation: `Co-occurring signals: ${cluster.topics.join(', ')} (${cluster.count} overlaps in ${cluster.windowLabel})`,
          hypothesis: `These topics are connected in user's mental model — content bridging them will resonate`,
          supporting_signals: cluster.topics,
          confidence: this.calculateInsightConfidence(clusterSignals, {
            matchRatio: 0.5,
          }),
          derived_predictions: [
            `Content combining ${cluster.topics.slice(0, 2).join(' + ')} will score higher than either alone`,
          ],
          source_layer: 'synthetic',
        });
        newInsights.push(insight);
      }
    }

    // 3. Enhanced cross-referencing for deeper latent insight discovery
    const enhancedInsights = this.enhanceSignalCrossReference(newSignal);
    newInsights.push(...enhancedInsights);

    return newInsights;
  }

  /**
   * Detect temporal patterns across the full signal history.
   */
  detectTemporalInsights() {
    const allSignals = this.kg.data.user.signals || [];
    if (allSignals.length < 5) return [];

    const temporalPatterns = detectTemporalPattern(allSignals);
    const existingInsights = this.kg.data.user.insights || [];
    const newInsights = [];

    for (const tp of temporalPatterns) {
      const alreadyExists = existingInsights.some(i =>
        i.observation && i.observation.includes('temporal_split')
      );

      if (!alreadyExists) {
        const insight = this.kg.addInsight({
          observation: `[temporal_split] ${tp.observation}`,
          hypothesis: tp.hypothesis,
          supporting_signals: [],
          confidence: tp.confidence,
          derived_predictions: tp.predictions,
          source_layer: 'synthetic',
        });
        newInsights.push(insight);
      }
    }

    return newInsights;
  }

  /**
   * Get all latent insights (pattern-derived, not just direct observations)
   */
  getLatentInsights(minConfidence = 0.3) {
    return this.kg.getInsights({ minConfidence, sourceLayer: 'synthetic' });
  }

  /**
   * Get actionable predictions from latent insights
   */
  getLatentPredictions() {
    const insights = this.getLatentInsights();
    const predictions = [];

    for (const insight of insights) {
      for (const pred of (insight.derived_predictions || [])) {
        predictions.push({
          prediction: pred,
          confidence: insight.confidence,
          source_insight: insight.id,
          pattern: insight.observation,
        });
      }
    }

    return predictions.sort((a, b) => b.confidence - a.confidence);
  }

  // ─── DERIVED PREDICTIONS (testable through content scoring) ─────────

  /**
   * Generate structured, testable predictions from all current insights.
   * Each prediction has scoring criteria so content can be tested against it.
   *
   * @returns {object[]} - DerivedPrediction objects
   */
  generateDerivedPredictions() {
    const insights = this.getLatentInsights(0.25);
    const predictions = [];

    for (const insight of insights) {
      const preds = this._insightToPredictions(insight);
      predictions.push(...preds);
    }

    // Deduplicate by criteria overlap
    const seen = new Set();
    return predictions.filter(p => {
      const key = p.criteria.boost_topics.sort().join(',') + '|' + p.criteria.penalize_topics.sort().join(',');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Score a piece of content against all active derived predictions.
   *
   * @param {object} content - { topics: string[], title?: string, body?: string }
   * @param {object} [opts] - { timeOfDay?: number (0-23), minConfidence?: number }
   * @returns {{ totalDelta: number, matches: { prediction_id, delta, reason }[] }}
   */
  scoreContent(content, opts = {}) {
    const predictions = this.generateDerivedPredictions();
    const contentTopics = (content.topics || []).map(t => t.toLowerCase());
    const contentText = `${content.title || ''} ${content.body || ''}`.toLowerCase();
    const minConf = opts.minConfidence || 0.3;
    const matches = [];

    for (const pred of predictions) {
      if (pred.confidence < minConf) continue;

      // Check time window constraint
      if (pred.criteria.time_window && opts.timeOfDay !== undefined) {
        const [start, end] = pred.criteria.time_window;
        if (opts.timeOfDay < start || opts.timeOfDay > end) continue;
      }

      let delta = 0;
      let reason = '';

      // Boost matches
      const boostHits = pred.criteria.boost_topics.filter(t =>
        contentTopics.some(ct => ct.includes(t) || t.includes(ct)) ||
        contentText.includes(t)
      );
      if (boostHits.length > 0) {
        delta += pred.expected_delta * (boostHits.length / pred.criteria.boost_topics.length) * pred.confidence;
        reason = `Boost: ${boostHits.join(', ')}`;
      }

      // Penalize matches
      const penaltyHits = pred.criteria.penalize_topics.filter(t =>
        contentTopics.some(ct => ct.includes(t) || t.includes(ct)) ||
        contentText.includes(t)
      );
      if (penaltyHits.length > 0) {
        delta -= Math.abs(pred.expected_delta) * 0.5 * (penaltyHits.length / pred.criteria.penalize_topics.length) * pred.confidence;
        reason += (reason ? ' | ' : '') + `Penalize: ${penaltyHits.join(', ')}`;
      }

      if (delta !== 0) {
        matches.push({ prediction_id: pred.id, delta: Math.round(delta * 100) / 100, reason });
      }
    }

    const totalDelta = Math.round(matches.reduce((sum, m) => sum + m.delta, 0) * 100) / 100;
    return { totalDelta, matches };
  }

  /**
   * Validate a prediction against actual engagement.
   * Feeds back into insight confidence via KG.recordTestResult.
   *
   * @param {string} predictionId
   * @param {number} actualScore - actual engagement score
   * @param {number} baselineScore - expected baseline without prediction
   * @returns {object|null} - updated insight, or null if not found
   */
  validatePrediction(predictionId, actualScore, baselineScore) {
    const predictions = this.generateDerivedPredictions();
    const pred = predictions.find(p => p.id === predictionId);
    if (!pred) return null;

    const scoreDiff = actualScore - baselineScore;
    const expectedDirection = pred.expected_delta > 0 ? 'positive' : 'negative';
    const actualDirection = scoreDiff > 0 ? 'positive' : (scoreDiff < 0 ? 'negative' : 'neutral');

    let outcome;
    if (actualDirection === expectedDirection) {
      outcome = 'confirmed';
    } else if (actualDirection === 'neutral') {
      outcome = 'inconclusive';
    } else {
      outcome = 'denied';
    }

    return this.kg.recordTestResult(pred.source_insight_id, pred.hypothesis, outcome);
  }

  /**
   * Convert an insight into structured, testable predictions.
   * @private
   */
  _insightToPredictions(insight) {
    const preds = [];
    const signals = insight.supporting_signals || [];

    // Match against known pattern for structured criteria
    const patternMatch = this.patternLibrary.find(p =>
      insight.observation && insight.observation.includes(p.name)
    );

    if (patternMatch) {
      const criteria = PREDICTION_CRITERIA[patternMatch.name];
      if (criteria) {
        preds.push({
          id: `pred_${insight.id}_${patternMatch.name}`,
          hypothesis: patternMatch.hypothesis,
          criteria: { boost_topics: [...criteria.boost_topics], penalize_topics: [...criteria.penalize_topics] },
          expected_delta: criteria.expected_delta,
          confidence: insight.confidence,
          source_insight_id: insight.id,
          status: 'active',
        });
      }
    }

    // Co-occurrence prediction from supporting signals
    if (signals.length >= 2 && !patternMatch) {
      preds.push({
        id: `pred_${insight.id}_cooccur`,
        hypothesis: insight.hypothesis,
        criteria: {
          boost_topics: signals.slice(0, 4),
          penalize_topics: [],
          combo_required: true,
        },
        expected_delta: 0.12,
        confidence: insight.confidence,
        source_insight_id: insight.id,
        status: 'active',
      });
    }

    // Temporal prediction
    if (insight.observation && insight.observation.includes('temporal_split')) {
      const morningMatch = insight.observation.match(/Morning focus: ([^|]+)/);
      const eveningMatch = insight.observation.match(/Evening focus: (.+)/);
      if (morningMatch && eveningMatch) {
        const morningTopics = morningMatch[1].split(',').map(s => s.trim());
        const eveningTopics = eveningMatch[1].split(',').map(s => s.trim());
        preds.push({
          id: `pred_${insight.id}_morning`,
          hypothesis: 'Morning content aligned with morning interests performs better',
          criteria: { boost_topics: morningTopics, penalize_topics: eveningTopics, time_window: [5, 11] },
          expected_delta: 0.1,
          confidence: insight.confidence,
          source_insight_id: insight.id,
          status: 'active',
        });
        preds.push({
          id: `pred_${insight.id}_evening`,
          hypothesis: 'Evening content aligned with evening interests performs better',
          criteria: { boost_topics: eveningTopics, penalize_topics: morningTopics, time_window: [18, 23] },
          expected_delta: 0.1,
          confidence: insight.confidence,
          source_insight_id: insight.id,
          status: 'active',
        });
      }
    }

    return preds;
  }

  /**
   * Use an LLM to generate a hypothesis for signal combinations that
   * don't match any heuristic pattern. Only called when useLLM=true
   * and a llmCall function is provided.
   *
   * @param {object} newSignal - the signal that triggered this
   * @returns {object[]} - newly created insight nodes (0 or 1)
   */
  async generateLLMHypothesis(newSignal) {
    const allSignals = this.kg.data.user.signals || [];
    const allTopics = this._collectTopics(allSignals);

    if (allTopics.length < this.llmMinTopics) return [];

    // Build prompt with signal context
    const recentTopics = allTopics.slice(-15); // cap context size
    const existingInsights = (this.kg.data.user.insights || [])
      .filter(i => i.confidence >= 0.4)
      .slice(0, 5)
      .map(i => `- ${i.hypothesis} (conf: ${i.confidence})`);

    const prompt = [
      'You are a user behavior analyst for a personalized content system.',
      'Given a user\'s recent signal topics and a new signal, generate ONE hypothesis about what latent meaning connects them.',
      '',
      `Recent topics: ${recentTopics.join(', ')}`,
      `New signal: topic="${newSignal.topic}", type="${newSignal.type}"`,
      existingInsights.length > 0 ? `\nExisting hypotheses (avoid duplicating):\n${existingInsights.join('\n')}` : '',
      '',
      'Respond in JSON: {"hypothesis":"...","predictions":["...","..."],"confidence_note":"why this confidence level"}',
      'hypothesis: a 1-sentence insight about the WHY behind this combination.',
      'predictions: 2 testable predictions for content scoring.',
      'Be specific and non-obvious. Do NOT restate the topics — explain the latent meaning.',
    ].join('\n');

    try {
      const raw = await this.llmCall(prompt);

      // Parse LLM response (tolerant of markdown wrapping)
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.hypothesis) return [];

      // Deduplicate against existing insights
      const existing = this.kg.data.user.insights || [];
      const isDuplicate = existing.some(i =>
        i.hypothesis && i.hypothesis.toLowerCase() === parsed.hypothesis.toLowerCase()
      );
      if (isDuplicate) return [];

      const insight = this.kg.addInsight({
        observation: `[llm_hypothesis] Topics: ${recentTopics.slice(-5).join(', ')} + ${newSignal.topic}`,
        hypothesis: parsed.hypothesis,
        supporting_signals: [newSignal.topic, ...recentTopics.slice(-3)],
        confidence: 0.35, // LLM hypotheses start lower than heuristic matches
        derived_predictions: (parsed.predictions || []).slice(0, 3),
        source_layer: 'synthetic',
      });

      return [insight];
    } catch (err) {
      // LLM failure is non-fatal — log and continue
      console.error('[InsightEngine] LLM hypothesis generation failed:', err.message);
      return [];
    }
  }

  // ─── INTERNAL ────────────────────────────────────────────────────────

  /**
   * Index an insight node with edge metadata linking it to the trigger signal
   * and to other insights that share supporting signals.
   * Mutates the insight in place (adds _edges field).
   */
  _indexInsightEdges(insight, triggerSignal) {
    if (!insight._edges) insight._edges = [];

    // Link to trigger signal
    if (triggerSignal && triggerSignal.topic) {
      insight._edges.push({
        type: 'triggered_by',
        signal_topic: triggerSignal.topic,
        signal_type: triggerSignal.type,
        timestamp: triggerSignal.timestamp || new Date().toISOString(),
      });
    }

    // Link to related insights via shared supporting signals
    const allInsights = this.kg.data.user.insights || [];
    const mySignals = new Set((insight.supporting_signals || []).map(s => s.toLowerCase()));

    for (const other of allInsights) {
      if (other.id === insight.id) continue;
      const overlap = (other.supporting_signals || []).filter(s => mySignals.has(s.toLowerCase()));
      if (overlap.length > 0) {
        // Add edge on this insight pointing to the related one
        const alreadyLinked = insight._edges.some(e => e.type === 'related_to' && e.insight_id === other.id);
        if (!alreadyLinked) {
          insight._edges.push({
            type: 'related_to',
            insight_id: other.id,
            shared_signals: overlap,
          });
        }
        // Add reverse edge on the other insight
        if (!other._edges) other._edges = [];
        const reverseLinked = other._edges.some(e => e.type === 'related_to' && e.insight_id === insight.id);
        if (!reverseLinked) {
          other._edges.push({
            type: 'related_to',
            insight_id: insight.id,
            shared_signals: overlap,
          });
        }
      }
    }
  }

  _collectTopics(signals) {
    const topics = new Set();
    for (const s of signals) {
      if (s.topic) {
        // Split compound topics and add both full and parts
        const parts = s.topic.toLowerCase().split(/[,;/]+/).map(p => p.trim());
        for (const p of parts) {
          if (p) topics.add(p);
        }
      }
    }
    return [...topics];
  }

  /**
   * Find topics that co-occur near the new signal in time
   */
  _findTopicCoOccurrence(newSignal, allSignals) {
    const clusters = [];
    const newTs = new Date(newSignal.timestamp || Date.now()).getTime();
    const newTopic = String(newSignal.topic || '').toLowerCase();

    if (!newTopic) return clusters;

    // Check 24h and 7d windows
    const windows = [
      { ms: 24 * 60 * 60 * 1000, label: '24h' },
      { ms: 7 * 24 * 60 * 60 * 1000, label: '7d' },
    ];

    for (const window of windows) {
      const nearby = allSignals.filter(s => {
        if (!s.timestamp || !s.topic) return false;
        const sTs = new Date(s.timestamp).getTime();
        return Math.abs(sTs - newTs) <= window.ms && s.topic.toLowerCase() !== newTopic;
      });

      // Group by topic
      const topicCounts = {};
      for (const s of nearby) {
        const t = String(s.topic || '').toLowerCase();
        topicCounts[t] = (topicCounts[t] || 0) + 1;
      }

      // Find significant co-occurrences (appeared 2+ times)
      for (const [topic, count] of Object.entries(topicCounts)) {
        if (count >= 2) {
          clusters.push({
            topics: [newTopic, topic],
            count,
            windowLabel: window.label,
          });
        }
      }
    }

    return clusters;
  }

  /**
   * Calculate confidence for a pattern match based on signal evidence.
   * Uses signal count, directional consistency, temporal spread, and source diversity.
   */
  _calculatePatternConfidence(matchedTags, pattern, allSignals) {
    const relevant = allSignals.filter(s =>
      s.topic && matchedTags.some(tag => s.topic.toLowerCase().includes(tag))
    );

    return this.calculateInsightConfidence(relevant, {
      matchRatio: matchedTags.length / pattern.tags.length,
    });
  }

  /**
   * Enhanced confidence scorer with cross-dimensional consistency and signal reinforcement.
   *
   * Factors:
   *   1. Signal count        — more evidence → higher confidence (enhanced logarithmic scale)
   *   2. Multi-dimensional consistency — directional, topical, contextual, and temporal consistency
   *   3. Signal reinforcement — how often similar signals validate the insight
   *   4. Cross-dimensional validation — consistency across semantic, temporal, and contextual axes
   *   5. Confidence decay/refresh — adjust based on signal freshness and validation frequency
   *
   * @param {object[]} signals - Array of signals supporting this insight
   * @param {object} opts - Options: { matchRatio?: number, insight?: object, allSignals?: object[] }
   * @returns {number} confidence 0–0.98
   */
  calculateInsightConfidence(signals, opts = {}) {
    if (!signals || signals.length === 0) return 0.1;

    // ── 1. Enhanced signal count score with progressive thresholds ──
    const enhancedCountScore = this._calculateEnhancedSignalCountScore(signals, opts.allSignals || []);
    const countScore = enhancedCountScore;

    // ── 2. Multi-dimensional consistency with alignment bonuses ──
    const consistencyScores = this._calculateCrossDimensionalConsistency(signals);
    const baseConsistencyScore = Math.min(0.25,
      consistencyScores.directional * 0.08 +
      consistencyScores.topical * 0.06 +
      consistencyScores.contextual * 0.06 +
      consistencyScores.temporal * 0.05
    );

    // Consistency alignment bonus - extra confidence when multiple dimensions align
    const alignmentBonus = this._calculateConsistencyAlignmentBonus(consistencyScores);
    const totalConsistencyScore = baseConsistencyScore + alignmentBonus;

    // ── 3. Cross-dimensional validation ──
    // Signals that are consistent across multiple dimensions get higher confidence
    const crossValidationScore = this._calculateCrossValidationScore(signals);

    // ── 4. Enhanced temporal analysis ──
    const temporalConsistency = this._calculateTemporalConsistency(signals);
    const enhancedTemporalScore = temporalConsistency.spread * 0.12 + temporalConsistency.frequency * 0.08;

    // ── 5. Signal quality and diversity ──
    const qualityScore = this._calculateSignalQuality(signals);
    const diversityScore = this._calculateSourceDiversity(signals);

    // ── 6. Signal cluster quality assessment ──
    const clusterQualityScore = this._calculateSignalClusterQuality(signals);

    // ── 7. Confidence decay based on signal freshness ──
    const freshnessScore = this._calculateFreshnessScore(signals);

    // ── 8. Base + match ratio (for pattern insights) ──
    const matchRatio = opts.matchRatio ?? 0.5;
    const baseScore = 0.12 + matchRatio * 0.15;

    // ── 9. Dynamic adjustment for existing insights ──
    let existingInsightBonus = 0;
    if (opts.insight) {
      existingInsightBonus = this._calculateExistingInsightBonus(opts.insight, signals);
    }

    const raw = baseScore + countScore + totalConsistencyScore + crossValidationScore +
                enhancedTemporalScore + qualityScore + diversityScore + clusterQualityScore +
                freshnessScore + existingInsightBonus;

    return Math.min(0.98, Math.round(raw * 100) / 100);
  }

  /**
   * Calculate signal reinforcement score - how often similar signals validate patterns
   */
  _calculateSignalReinforcement(signals, allSignals) {
    if (allSignals.length === 0 || signals.length < 2) return 0;

    const signalTopics = signals.map(s => String(s.topic || '').toLowerCase()).filter(Boolean);
    const signalContexts = signals.map(s => String(s.context || '').toLowerCase()).filter(Boolean);

    let reinforcementCount = 0;

    // Look for reinforcing signals in the broader signal set
    for (const signal of allSignals) {
      const topic = String(signal.topic || '').toLowerCase();
      const context = String(signal.context || '').toLowerCase();

      // Check if this signal reinforces any of our pattern signals
      const topicMatch = signalTopics.some(t => this._calculateTopicSimilarity(t, topic) > 0.4);
      const contextMatch = signalContexts.some(c => this._calculateContextSimilarity(c, context) > 0.3);

      if (topicMatch || contextMatch) {
        reinforcementCount++;
      }
    }

    // Convert to score: 0-0.10 bonus based on reinforcement density
    const reinforcementRatio = reinforcementCount / Math.max(allSignals.length, 1);
    return Math.min(0.10, reinforcementRatio * 0.8);
  }

  /**
   * Calculate consistency across multiple dimensions (directional, topical, contextual, temporal)
   */
  _calculateCrossDimensionalConsistency(signals) {
    const consistency = {
      directional: 0,
      topical: 0,
      contextual: 0,
      temporal: 0
    };

    if (signals.length < 2) return consistency;

    // ── Directional consistency (existing logic enhanced) ──
    const directions = signals.map(s => {
      if (s.value > 0 || s.type === 'positive_feedback') return 1;
      if (s.value < 0 || s.type === 'negative_feedback') return -1;
      return 0;
    });
    const nonNeutral = directions.filter(d => d !== 0);
    if (nonNeutral.length >= 2) {
      const sum = nonNeutral.reduce((a, b) => a + b, 0);
      consistency.directional = Math.abs(sum) / nonNeutral.length;
    }

    // ── Topical consistency ──
    const topics = signals.map(s => String(s.topic || '').toLowerCase()).filter(Boolean);
    if (topics.length >= 2) {
      let topicalSimilarity = 0;
      let comparisons = 0;
      for (let i = 0; i < topics.length - 1; i++) {
        for (let j = i + 1; j < topics.length; j++) {
          topicalSimilarity += this._calculateTopicSimilarity(topics[i], topics[j]);
          comparisons++;
        }
      }
      consistency.topical = comparisons > 0 ? topicalSimilarity / comparisons : 0;
    }

    // ── Contextual consistency ──
    const contexts = signals.map(s => String(s.context || '').toLowerCase()).filter(Boolean);
    if (contexts.length >= 2) {
      let contextualSimilarity = 0;
      let comparisons = 0;
      for (let i = 0; i < contexts.length - 1; i++) {
        for (let j = i + 1; j < contexts.length; j++) {
          contextualSimilarity += this._calculateContextSimilarity(contexts[i], contexts[j]);
          comparisons++;
        }
      }
      consistency.contextual = comparisons > 0 ? contextualSimilarity / comparisons : 0;
    }

    // ── Temporal consistency (clustering vs spread) ──
    const timestamps = signals.map(s => new Date(s.timestamp || 0).getTime()).filter(t => t > 0);
    if (timestamps.length >= 2) {
      timestamps.sort((a, b) => a - b);
      const timeSpan = timestamps[timestamps.length - 1] - timestamps[0];
      const avgInterval = timeSpan / (timestamps.length - 1);

      // More consistent intervals = higher temporal consistency
      let intervalVariance = 0;
      for (let i = 0; i < timestamps.length - 1; i++) {
        const interval = timestamps[i + 1] - timestamps[i];
        intervalVariance += Math.abs(interval - avgInterval);
      }

      const normalizedVariance = intervalVariance / (timeSpan || 1);
      consistency.temporal = Math.max(0, 1 - normalizedVariance);
    }

    return consistency;
  }

  /**
   * Calculate cross-dimensional validation score
   */
  _calculateCrossValidationScore(signals) {
    if (signals.length < 3) return 0;

    // Count signals that have high similarity across multiple dimensions
    let crossValidated = 0;

    for (let i = 0; i < signals.length - 1; i++) {
      for (let j = i + 1; j < signals.length; j++) {
        const s1 = signals[i];
        const s2 = signals[j];

        let validationDimensions = 0;

        // Topic validation
        if (s1.topic && s2.topic) {
          const topicSim = this._calculateTopicSimilarity(
            String(s1.topic).toLowerCase(),
            String(s2.topic).toLowerCase()
          );
          if (topicSim > 0.3) validationDimensions++;
        }

        // Context validation
        if (s1.context && s2.context) {
          const contextSim = this._calculateContextSimilarity(
            String(s1.context).toLowerCase(),
            String(s2.context).toLowerCase()
          );
          if (contextSim > 0.2) validationDimensions++;
        }

        // Temporal validation (within reasonable window)
        if (s1.timestamp && s2.timestamp) {
          const timeDiff = Math.abs(new Date(s1.timestamp).getTime() - new Date(s2.timestamp).getTime());
          if (timeDiff < 7 * 24 * 60 * 60 * 1000) validationDimensions++; // Within 7 days
        }

        // If validated across 2+ dimensions, count it
        if (validationDimensions >= 2) {
          crossValidated++;
        }
      }
    }

    // Convert to score: more cross-validated pairs = higher confidence
    const maxPossiblePairs = (signals.length * (signals.length - 1)) / 2;
    return Math.min(0.15, (crossValidated / maxPossiblePairs) * 0.15);
  }

  /**
   * Enhanced temporal consistency analysis
   */
  _calculateTemporalConsistency(signals) {
    const result = { spread: 0, frequency: 0 };

    const timestamps = signals.map(s => new Date(s.timestamp || 0).getTime()).filter(t => t > 0);
    if (timestamps.length < 2) return result;

    timestamps.sort((a, b) => a - b);

    // Spread analysis (signals across multiple days)
    const uniqueDays = new Set(timestamps.map(t => new Date(t).toISOString().slice(0, 10)));
    const dayCount = uniqueDays.size;
    result.spread = dayCount <= 1 ? 0 :
      dayCount <= 2 ? 0.3 :
      dayCount <= 6 ? 0.6 :
      dayCount <= 14 ? 0.8 : 1.0;

    // Frequency analysis (consistent intervals)
    const intervals = [];
    for (let i = 1; i < timestamps.length; i++) {
      intervals.push(timestamps[i] - timestamps[i-1]);
    }

    if (intervals.length > 1) {
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const variance = intervals.reduce((sum, interval) => sum + Math.pow(interval - avgInterval, 2), 0) / intervals.length;
      const coefficientOfVariation = Math.sqrt(variance) / avgInterval;

      // Lower coefficient of variation = more consistent timing = higher score
      result.frequency = Math.max(0, 1 - coefficientOfVariation / 2);
    }

    return result;
  }

  /**
   * Calculate bonus when multiple consistency dimensions align strongly
   *
   * Provides extra confidence when patterns show consistent behavior across
   * multiple dimensions (temporal + topical + directional + contextual).
   * Strong alignment across dimensions indicates robust, reliable patterns.
   */
  _calculateConsistencyAlignmentBonus(consistencyScores) {
    const { directional, topical, contextual, temporal } = consistencyScores;

    // Define strong consistency thresholds
    const STRONG_THRESHOLD = 0.7;
    const MODERATE_THRESHOLD = 0.5;

    let strongDimensions = 0;
    let moderateDimensions = 0;

    // Count dimensions with strong/moderate consistency
    [directional, topical, contextual, temporal].forEach(score => {
      if (score >= STRONG_THRESHOLD) strongDimensions++;
      else if (score >= MODERATE_THRESHOLD) moderateDimensions++;
    });

    let alignmentBonus = 0;

    // Multi-dimensional strong alignment bonuses
    if (strongDimensions >= 3) alignmentBonus += 0.08; // Triple alignment
    else if (strongDimensions >= 2) alignmentBonus += 0.05; // Dual alignment

    // Mixed strong/moderate alignment bonuses
    if (strongDimensions >= 1 && moderateDimensions >= 2) alignmentBonus += 0.03;

    // Temporal consistency multiplier (temporal patterns are especially valuable)
    if (temporal >= STRONG_THRESHOLD && strongDimensions >= 1) {
      alignmentBonus *= 1.2; // 20% bonus for strong temporal alignment
    }

    return Math.min(0.12, alignmentBonus); // Cap alignment bonus at 12%
  }

  /**
   * Calculate signal quality based on completeness and richness
   */
  _calculateSignalQuality(signals) {
    if (signals.length === 0) return 0;

    let totalQuality = 0;

    for (const signal of signals) {
      let quality = 0.3; // Base quality

      // Completeness bonuses
      if (signal.topic && signal.topic.length > 5) quality += 0.15;
      if (signal.context && signal.context.length > 10) quality += 0.15;
      if (signal.timestamp) quality += 0.1;
      if (signal.value !== undefined && signal.value !== null) quality += 0.1;
      if (signal.type) quality += 0.05;

      // Richness bonuses (longer, more descriptive content)
      const topicLength = String(signal.topic || '').length;
      const contextLength = String(signal.context || '').length;

      if (topicLength > 20) quality += 0.1;
      if (contextLength > 50) quality += 0.15;

      totalQuality += Math.min(1.0, quality);
    }

    const avgQuality = totalQuality / signals.length;
    return Math.min(0.12, avgQuality * 0.12);
  }

  /**
   * Enhanced source diversity calculation
   */
  _calculateSourceDiversity(signals) {
    const uniqueTypes = new Set(signals.map(s => s.type).filter(Boolean));
    const uniqueSources = new Set(signals.map(s => s.source).filter(Boolean));

    let diversityScore = 0;

    // Type diversity
    if (uniqueTypes.size <= 1) diversityScore += 0;
    else if (uniqueTypes.size <= 2) diversityScore += 0.04;
    else if (uniqueTypes.size <= 3) diversityScore += 0.07;
    else diversityScore += 0.10;

    // Source diversity
    if (uniqueSources.size > 1) {
      diversityScore += Math.min(0.05, uniqueSources.size * 0.015);
    }

    return diversityScore;
  }

  /**
   * Calculate signal cluster quality - how well signals group together thematically
   */
  _calculateSignalClusterQuality(signals) {
    if (signals.length <= 1) return 0.5;

    let clusterScore = 0;
    const topics = signals.map(s => s.topic).filter(Boolean);
    const contexts = signals.map(s => s.context).filter(Boolean);

    // Topic clustering
    const topicSimilarity = this._calculateTopicSimilarity(topics);
    clusterScore += topicSimilarity * 0.6;

    // Context clustering
    const contextSimilarity = this._calculateContextSimilarity(contexts);
    clusterScore += contextSimilarity * 0.4;

    return Math.min(1.0, Math.max(0.0, clusterScore));
  }

  _calculateTopicSimilarity(topics) {
    if (topics.length <= 1) return 0.5;

    let similaritySum = 0;
    let comparisons = 0;

    for (let i = 0; i < topics.length - 1; i++) {
      for (let j = i + 1; j < topics.length; j++) {
        const similarity = this._calculateStringSimilarity(topics[i], topics[j]);
        similaritySum += similarity;
        comparisons++;
      }
    }

    return comparisons > 0 ? similaritySum / comparisons : 0;
  }

  _calculateContextSimilarity(contexts) {
    if (contexts.length <= 1) return 0.5;

    let similaritySum = 0;
    let comparisons = 0;

    for (let i = 0; i < contexts.length - 1; i++) {
      for (let j = i + 1; j < contexts.length; j++) {
        const similarity = this._calculateStringSimilarity(contexts[i], contexts[j]);
        similaritySum += similarity;
        comparisons++;
      }
    }

    return comparisons > 0 ? similaritySum / comparisons : 0;
  }

  _calculateStringSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;

    const words1 = str1.toLowerCase().split(/\W+/).filter(w => w.length > 2);
    const words2 = str2.toLowerCase().split(/\W+/).filter(w => w.length > 2);

    if (words1.length === 0 || words2.length === 0) return 0;

    const commonWords = words1.filter(w => words2.includes(w));
    const maxLength = Math.max(words1.length, words2.length);

    return commonWords.length / maxLength;
  }

  /**
   * Calculate freshness score - more recent signals contribute more to confidence
   */
  _calculateFreshnessScore(signals) {
    if (signals.length === 0) return 0;

    const now = Date.now();
    let freshnessSum = 0;
    let validTimestamps = 0;

    for (const signal of signals) {
      if (signal.timestamp) {
        const age = now - new Date(signal.timestamp).getTime();
        const dayAge = age / (24 * 60 * 60 * 1000);

        // Exponential decay: fresh signals (< 1 day) = 1.0, 7 days = 0.5, 30 days = 0.1
        const freshness = Math.exp(-dayAge / 10);
        freshnessSum += freshness;
        validTimestamps++;
      }
    }

    if (validTimestamps === 0) return 0;

    const avgFreshness = freshnessSum / validTimestamps;
    return Math.min(0.08, avgFreshness * 0.08);
  }

  /**
   * Calculate signal cluster quality - how well signals group into coherent patterns
   */
  _calculateSignalClusterQuality(signals) {
    if (signals.length < 3) return 0.02;

    let clusterScore = 0;

    // Topic clustering quality
    const topicClusters = this._analyzeTopicClusters(signals);
    clusterScore += topicClusters * 0.06;

    // Temporal clustering quality
    const temporalClusters = this._analyzeTemporalClusters(signals);
    clusterScore += temporalClusters * 0.04;

    // Cross-dimensional coherence
    const crossCoherence = this._analyzeCrossDimensionalCoherence(signals);
    clusterScore += crossCoherence * 0.06;

    return Math.min(0.16, clusterScore);
  }

  /**
   * Analyze topic clustering quality
   */
  _analyzeTopicClusters(signals) {
    const topics = signals.map(s => String(s.topic || '').toLowerCase()).filter(Boolean);
    if (topics.length < 2) return 0;

    let clustered = 0;
    const visited = new Set();

    for (let i = 0; i < topics.length; i++) {
      if (visited.has(i)) continue;

      for (let j = i + 1; j < topics.length; j++) {
        if (visited.has(j)) continue;

        if (this._calculateTopicSimilarity(topics[i], topics[j]) > 0.4) {
          clustered += 2;
          visited.add(i);
          visited.add(j);
        }
      }
    }

    return clustered / topics.length;
  }

  /**
   * Analyze temporal clustering quality
   */
  _analyzeTemporalClusters(signals) {
    const timestamped = signals.filter(s => s.timestamp);
    if (timestamped.length < 2) return 0;

    timestamped.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    let clustered = 0;
    const CLUSTER_WINDOW = 4 * 60 * 60 * 1000; // 4 hours

    for (let i = 0; i < timestamped.length - 1; i++) {
      const timeDiff = new Date(timestamped[i+1].timestamp).getTime() -
                      new Date(timestamped[i].timestamp).getTime();
      if (timeDiff <= CLUSTER_WINDOW) {
        clustered++;
      }
    }

    return clustered / (timestamped.length - 1);
  }

  /**
   * Analyze cross-dimensional coherence
   */
  _analyzeCrossDimensionalCoherence(signals) {
    if (signals.length < 3) return 0;

    let coherentPairs = 0;
    let totalPairs = 0;

    for (let i = 0; i < signals.length - 1; i++) {
      for (let j = i + 1; j < signals.length; j++) {
        const s1 = signals[i];
        const s2 = signals[j];
        let coherenceDimensions = 0;

        // Topic coherence
        if (s1.topic && s2.topic && this._calculateTopicSimilarity(s1.topic, s2.topic) > 0.3) {
          coherenceDimensions++;
        }

        // Temporal coherence (within 6 hours)
        if (s1.timestamp && s2.timestamp) {
          const timeDiff = Math.abs(new Date(s1.timestamp).getTime() - new Date(s2.timestamp).getTime());
          if (timeDiff < 6 * 60 * 60 * 1000) coherenceDimensions++;
        }

        if (coherenceDimensions >= 2) coherentPairs++;
        totalPairs++;
      }
    }

    return totalPairs > 0 ? coherentPairs / totalPairs : 0;
  }

  /**
   * Calculate bonus for updating existing insights with new evidence
   */
  _calculateExistingInsightBonus(insight, newSignals) {
    if (!insight || !newSignals || newSignals.length === 0) return 0;

    const currentConfidence = insight.confidence || 0.5;
    const signalCount = (insight.supporting_signals || []).length;

    // Bonus for reinforcing high-confidence insights
    let bonus = 0;
    if (currentConfidence > 0.7 && signalCount >= 3) {
      bonus += 0.03; // Compound high-confidence insights
    }

    // Bonus for consistency with existing predictions
    if (insight.derived_predictions && insight.derived_predictions.length > 0) {
      // This would require validation against actual outcomes
      bonus += 0.02; // Placeholder for prediction accuracy bonus
    }

    return Math.min(0.05, bonus);
  }

  /**
   * Update confidence for existing insights when new reinforcing signals arrive
   */
  _updateExistingInsightConfidence(newSignal, relatedSignals, existingInsights, allSignals) {
    if (!existingInsights || existingInsights.length === 0) return;

    const newSignalTopic = String(newSignal.topic || '').toLowerCase();
    const newSignalContext = String(newSignal.context || '').toLowerCase();

    for (const insight of existingInsights) {
      if (!insight.supporting_signals) continue;

      let reinforcementStrength = 0;
      let reinforced = false;

      // Check if new signal reinforces this insight
      for (const supportingSignal of insight.supporting_signals) {
        const supportingTopic = String(supportingSignal).toLowerCase();

        // Topic reinforcement
        const topicSimilarity = this._calculateTopicSimilarity(newSignalTopic, supportingTopic);
        if (topicSimilarity > 0.4) {
          reinforcementStrength += topicSimilarity * 0.6;
          reinforced = true;
        }

        // Context reinforcement
        if (newSignalContext && supportingTopic.includes(newSignalContext.split(' ')[0])) {
          reinforcementStrength += 0.3;
          reinforced = true;
        }
      }

      // Check reinforcement from related signals
      const reinforcingRelatedSignals = relatedSignals.strongMatches.filter(match => {
        return insight.supporting_signals.some(supportingSignal => {
          const supportingTopic = String(supportingSignal).toLowerCase();
          const matchTopic = String(match.signal.topic || '').toLowerCase();
          return this._calculateTopicSimilarity(supportingTopic, matchTopic) > 0.3;
        });
      });

      if (reinforcingRelatedSignals.length > 0) {
        reinforcementStrength += Math.min(0.4, reinforcingRelatedSignals.length * 0.1);
        reinforced = true;
      }

      // Apply confidence boost if reinforced
      if (reinforced && reinforcementStrength > 0.2) {
        const currentConfidence = insight.confidence || 0.5;

        // Calculate new confidence with all supporting signals
        const supportingSignalObjects = this._findSignalsByTopics(insight.supporting_signals, allSignals);
        supportingSignalObjects.push(newSignal); // Add the new reinforcing signal

        const newConfidence = this.calculateInsightConfidence(supportingSignalObjects, {
          insight: insight,
          allSignals: allSignals,
          matchRatio: 0.7
        });

        // Apply gradual confidence increase (prevent dramatic jumps)
        const confidenceIncrease = Math.min(0.15, (newConfidence - currentConfidence) * 0.8);
        insight.confidence = Math.min(0.98, currentConfidence + confidenceIncrease);

        // Add timestamp for confidence update tracking
        if (!insight.confidence_updates) insight.confidence_updates = [];
        insight.confidence_updates.push({
          timestamp: new Date().toISOString(),
          old_confidence: currentConfidence,
          new_confidence: insight.confidence,
          reinforcing_signal: {
            topic: newSignal.topic,
            strength: reinforcementStrength
          }
        });

        // Add new signal to supporting signals if not already present
        const signalKey = newSignal.topic || newSignal.context?.slice(0, 20);
        if (signalKey && !insight.supporting_signals.includes(signalKey)) {
          insight.supporting_signals.push(signalKey);
        }
      }
    }
  }

  /**
   * Find actual signal objects by topic names from the supporting signals list
   */
  _findSignalsByTopics(supportingSignalTopics, allSignals) {
    const foundSignals = [];

    for (const topic of supportingSignalTopics) {
      const topicLower = String(topic).toLowerCase();

      // Find signals that match this topic
      const matchingSignals = allSignals.filter(signal => {
        const signalTopic = String(signal.topic || '').toLowerCase();
        const signalContext = String(signal.context || '').toLowerCase();

        return signalTopic.includes(topicLower) ||
               topicLower.includes(signalTopic) ||
               signalContext.includes(topicLower) ||
               this._calculateTopicSimilarity(signalTopic, topicLower) > 0.4;
      });

      // Take the most recent matching signal
      if (matchingSignals.length > 0) {
        const mostRecent = matchingSignals.sort((a, b) =>
          new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime()
        )[0];
        foundSignals.push(mostRecent);
      } else {
        // Create a synthetic signal object if no exact match found
        foundSignals.push({
          topic: topic,
          context: `synthetic reference to ${topic}`,
          timestamp: new Date().toISOString(),
          type: 'reference_signal',
          value: 0.5
        });
      }
    }

    return foundSignals;
  }

  /**
   * Enhanced signal count scoring with progressive thresholds and quality weighting
   *
   * Confidence bonuses at key thresholds:
   * - 3+ signals: validation threshold (basic confidence)
   * - 5+ signals: pattern threshold (moderate confidence)
   * - 8+ signals: strong pattern (high confidence)
   * - 12+ signals: very strong pattern (very high confidence)
   * - 20+ signals: exceptional pattern (maximum confidence)
   */
  _calculateEnhancedSignalCountScore(signals, allSignals = []) {
    if (!signals || signals.length === 0) return 0.05;

    const count = signals.length;

    // Base logarithmic scaling with enhanced curve
    let baseScore = Math.min(0.25, Math.log2(count + 1) * 0.06);

    // Progressive threshold bonuses for meaningful confidence levels
    let thresholdBonus = 0;
    if (count >= 3) thresholdBonus += 0.06;      // Validation threshold
    if (count >= 5) thresholdBonus += 0.05;      // Pattern threshold
    if (count >= 8) thresholdBonus += 0.04;      // Strong pattern
    if (count >= 12) thresholdBonus += 0.03;     // Very strong pattern
    if (count >= 20) thresholdBonus += 0.02;     // Exceptional pattern

    // Quality-weighted count adjustment
    const qualityWeight = this._calculateSignalQualityWeight(signals);
    const qualityAdjustment = qualityWeight * 0.08;

    // Signal reinforcement with enhanced algorithm
    const reinforcementScore = this._calculateSignalReinforcement(signals, allSignals);

    // Independent source validation bonus
    const independentSourceBonus = this._calculateIndependentSourceBonus(signals);

    const totalScore = baseScore + thresholdBonus + qualityAdjustment + reinforcementScore + independentSourceBonus;

    return Math.min(0.50, totalScore); // Cap at 50% to leave room for other factors
  }

  /**
   * Calculate quality weight for signals based on completeness and coherence
   */
  _calculateSignalQualityWeight(signals) {
    if (signals.length === 0) return 0;

    let totalWeight = 0;
    for (const signal of signals) {
      let weight = 0.3; // Base weight

      // Completeness factors
      if (signal.topic && signal.topic.length > 10) weight += 0.2;
      if (signal.context && signal.context.length > 20) weight += 0.2;
      if (signal.timestamp) weight += 0.1;
      if (signal.value !== undefined) weight += 0.1;
      if (signal.type) weight += 0.1;

      totalWeight += Math.min(1.0, weight);
    }

    return totalWeight / signals.length; // Average quality weight
  }

  /**
   * Calculate bonus for signals from independent sources
   */
  _calculateIndependentSourceBonus(signals) {
    const sources = new Set();
    const types = new Set();

    for (const signal of signals) {
      if (signal.source) sources.add(signal.source);
      if (signal.type) types.add(signal.type);
    }

    let bonus = 0;

    // Bonus for source diversity
    if (sources.size >= 2) bonus += 0.03;
    if (sources.size >= 3) bonus += 0.02;
    if (sources.size >= 4) bonus += 0.02;

    // Bonus for signal type diversity
    if (types.size >= 2) bonus += 0.02;
    if (types.size >= 3) bonus += 0.01;

    return Math.min(0.10, bonus);
  }

  /**
   * Query existing KG for signals related to a target signal using multiple criteria
   * @param {object} targetSignal - Signal to find relationships for
   * @param {object} options - Query options
   * @returns {object} - Categorized related signals
   */
  queryRelatedSignals(targetSignal, options = {}) {
    const {
      temporalWindow = 7 * 24 * 60 * 60 * 1000, // 7 days default
      semanticThreshold = 0.3,
      includeTopicSimilarity = true,
      includeTemporalProximity = true,
      includeContextualOverlap = true,
      maxResults = 50
    } = options;

    const allSignals = this.kg.data.user.signals || [];
    const targetTs = new Date(targetSignal.timestamp || Date.now()).getTime();
    const targetTopic = String(targetSignal.topic || '').toLowerCase();
    const targetContext = String(targetSignal.context || '').toLowerCase();

    const related = {
      temporallyClose: [],
      topicallyClose: [],
      contextuallyClose: [],
      semanticallyClose: [],
      strongMatches: []
    };

    for (const signal of allSignals) {
      if (signal === targetSignal) continue;

      const signalTs = new Date(signal.timestamp || 0).getTime();
      const signalTopic = String(signal.topic || '').toLowerCase();
      const signalContext = String(signal.context || '').toLowerCase();

      let relationScore = 0;
      const relationTypes = [];

      // 1. Temporal proximity analysis
      if (includeTemporalProximity && signal.timestamp) {
        const timeDiff = Math.abs(signalTs - targetTs);
        if (timeDiff <= temporalWindow) {
          const proximityScore = 1 - (timeDiff / temporalWindow);
          relationScore += proximityScore * 0.3;
          relationTypes.push('temporal');
          related.temporallyClose.push({ signal, score: proximityScore, timeDiff });
        }
      }

      // 2. Topic similarity analysis
      if (includeTopicSimilarity && signalTopic && targetTopic) {
        const topicOverlap = this._calculateTopicSimilarity(targetTopic, signalTopic);
        if (topicOverlap > semanticThreshold) {
          relationScore += topicOverlap * 0.4;
          relationTypes.push('topical');
          related.topicallyClose.push({ signal, score: topicOverlap });
        }
      }

      // 3. Contextual overlap analysis
      if (includeContextualOverlap && signalContext && targetContext) {
        const contextOverlap = this._calculateContextSimilarity(targetContext, signalContext);
        if (contextOverlap > semanticThreshold) {
          relationScore += contextOverlap * 0.3;
          relationTypes.push('contextual');
          related.contextuallyClose.push({ signal, score: contextOverlap });
        }
      }

      // 4. Identify strong multi-dimensional matches (lowered threshold for better discovery)
      if (relationScore > 0.3 && relationTypes.length >= 2) {
        related.strongMatches.push({
          signal,
          totalScore: relationScore,
          relationTypes,
          timeDiff: Math.abs(signalTs - targetTs)
        });
      } else if (relationScore > 0.6) {
        // Single dimension but very high score
        related.strongMatches.push({
          signal,
          totalScore: relationScore,
          relationTypes,
          timeDiff: Math.abs(signalTs - targetTs)
        });
      }
    }

    // Sort and limit results
    related.temporallyClose.sort((a, b) => b.score - a.score).splice(maxResults);
    related.topicallyClose.sort((a, b) => b.score - a.score).splice(maxResults);
    related.contextuallyClose.sort((a, b) => b.score - a.score).splice(maxResults);
    related.strongMatches.sort((a, b) => b.totalScore - a.totalScore).splice(maxResults);

    return related;
  }

  /**
   * Enhanced signal cross-referencing for latent insight discovery with improved confidence calculation
   * @param {object} newSignal - The signal to cross-reference
   * @returns {object[]} - Discovered latent insights
   */
  enhanceSignalCrossReference(newSignal) {
    const existingInsights = this.kg.data.user.insights || [];
    const allSignals = this.kg.data.user.signals || [];
    const newInsights = [];

    // Query for related signals using the enhanced engine
    const relatedSignals = this.queryRelatedSignals(newSignal, {
      temporalWindow: 14 * 24 * 60 * 60 * 1000, // 2 weeks
      semanticThreshold: 0.3, // Lowered threshold for better discovery
      maxResults: 40
    });

    // Update confidence for existing insights that are reinforced by this new signal
    this._updateExistingInsightConfidence(newSignal, relatedSignals, existingInsights, allSignals);

    // 1. Analyze strong multi-dimensional matches for latent patterns
    if (relatedSignals.strongMatches.length >= 2) {
      const cluster = relatedSignals.strongMatches.slice(0, 5);
      const clusterSignals = [newSignal, ...cluster.map(m => m.signal)];
      const topics = [...new Set(clusterSignals.map(s => s.topic).filter(Boolean))];

      const clusterKey = `latent_cluster_${topics.sort().join('_')}`;
      const alreadyExists = existingInsights.some(i =>
        i.observation && i.observation.includes(clusterKey)
      );

      if (!alreadyExists && topics.length >= 2) {
        const relationTypes = [...new Set(cluster.flatMap(m => m.relationTypes))];

        // Use enhanced confidence calculation
        const confidence = this.calculateInsightConfidence(clusterSignals, {
          matchRatio: 0.8, // High match ratio for strong multi-dimensional matches
          allSignals: allSignals
        });

        const insight = this.kg.addInsight({
          observation: `[${clusterKey}] Multi-dimensional signal cluster: ${topics.join(' ↔ ')}`,
          hypothesis: `Strong latent connection between ${topics.slice(0,3).join(', ')} (${relationTypes.join(' + ')} relationships)`,
          supporting_signals: topics,
          confidence: confidence,
          derived_predictions: [
            `Content bridging ${topics[0]} and ${topics[1]} will achieve 15-25% higher engagement`,
            `User shows consistent interest patterns across ${relationTypes.join('-')} dimensions`,
            `Cross-dimensional content will outperform single-topic content by ${Math.round(confidence * 30)}%`
          ],
          source_layer: 'synthetic'
        });
        newInsights.push(insight);
      }
    }

    // 2. Temporal sequence pattern analysis
    const temporallyClose = relatedSignals.temporallyClose
      .filter(r => r.timeDiff < 2 * 60 * 60 * 1000) // Within 2 hours
      .sort((a, b) => a.timeDiff - b.timeDiff);

    if (temporallyClose.length >= 2) {
      const sequence = [newSignal, ...temporallyClose.map(r => r.signal)];
      const sequenceTopics = sequence.map(s => s.topic).filter(Boolean);

      if (sequenceTopics.length >= 3) {
        const sequenceKey = `temporal_sequence_${sequenceTopics.join('_to_')}`;
        const alreadyExists = existingInsights.some(i =>
          i.observation && i.observation.includes('temporal_sequence')
        );

        if (!alreadyExists) {
          const insight = this.kg.addInsight({
            observation: `[temporal_sequence] Rapid interest progression: ${sequenceTopics.join(' → ')}`,
            hypothesis: 'User exhibits focused learning/exploration sessions with predictable topic transitions',
            supporting_signals: sequenceTopics,
            confidence: Math.min(0.85, temporallyClose[0].score * 0.9),
            derived_predictions: [
              `Next session likely to continue with ${sequenceTopics[sequenceTopics.length - 1]}-adjacent topics`,
              `Sequential content paths will outperform isolated pieces by 20-30%`
            ],
            source_layer: 'synthetic'
          });
          newInsights.push(insight);
        }
      }
    }

    // 3. Cross-domain connection discovery
    const crossDomainPairs = this._findCrossDomainConnections(newSignal, relatedSignals);
    for (const pair of crossDomainPairs) {
      const pairKey = `cross_domain_${pair.domains.sort().join('_')}`;
      const alreadyExists = existingInsights.some(i =>
        i.observation && i.observation.includes(pairKey)
      );

      if (!alreadyExists) {
        const insight = this.kg.addInsight({
          observation: `[${pairKey}] Cross-domain bridge: ${pair.domains.join(' ↔ ')}`,
          hypothesis: `User connects ${pair.domains[0]} and ${pair.domains[1]} concepts — interdisciplinary thinking pattern`,
          supporting_signals: pair.topics,
          confidence: pair.strength,
          derived_predictions: [
            `Content combining ${pair.domains[0]} and ${pair.domains[1]} perspectives will resonate strongly`,
            `User values synthesis over specialization in these domains`
          ],
          source_layer: 'synthetic'
        });
        newInsights.push(insight);
      }
    }

    return newInsights;
  }

  /**
   * Enhanced topic similarity using semantic analysis and abbreviation matching
   */
  _calculateTopicSimilarity(topic1, topic2) {
    if (!topic1 || !topic2) return 0;

    const t1 = topic1.toLowerCase().trim();
    const t2 = topic2.toLowerCase().trim();

    // Direct match
    if (t1 === t2) return 1.0;

    // Substring match (one contains the other)
    if (t1.includes(t2) || t2.includes(t1)) {
      return 0.7 + (Math.min(t1.length, t2.length) / Math.max(t1.length, t2.length)) * 0.2;
    }

    const words1 = t1.split(/\W+/).filter(w => w.length > 1);
    const words2 = t2.split(/\W+/).filter(w => w.length > 1);

    if (words1.length === 0 || words2.length === 0) return 0;

    // Enhanced word matching with synonyms and abbreviations
    const matchedWords = new Set();
    let totalMatches = 0;

    for (const word1 of words1) {
      for (const word2 of words2) {
        const similarity = this._calculateWordSimilarity(word1, word2);
        if (similarity > 0.5) {
          matchedWords.add(`${word1}_${word2}`);
          totalMatches += similarity;
        }
      }
    }

    if (matchedWords.size === 0) return 0;

    // Jaccard similarity with semantic enhancement
    const intersection = matchedWords.size;
    const union = words1.length + words2.length - intersection;
    const jaccardSimilarity = intersection / union;

    // Semantic boost based on match quality
    const avgMatchQuality = totalMatches / matchedWords.size;
    const semanticBoost = (avgMatchQuality - 0.5) * 0.3; // Up to 0.15 boost

    return Math.min(1.0, jaccardSimilarity + semanticBoost);
  }

  /**
   * Calculate word-level similarity with abbreviation and synonym detection
   */
  _calculateWordSimilarity(word1, word2) {
    if (word1 === word2) return 1.0;

    // Common abbreviations and synonyms mapping
    const synonymMap = {
      'ai': ['artificial', 'intelligence', 'artifical'], // typo included
      'ml': ['machine', 'learning'],
      'dl': ['deep', 'learning'],
      'nn': ['neural', 'network'],
      'nlp': ['natural', 'language', 'processing'],
      'cv': ['computer', 'vision'],
      'algorithm': ['algo', 'algorithms'],
      'optimization': ['optimize', 'optimizing', 'optimized'],
      'research': ['study', 'studies', 'studying'],
      'development': ['dev', 'developing', 'build', 'building'],
      'technology': ['tech', 'technologies'],
      'application': ['app', 'applications', 'applied'],
      'framework': ['frameworks', 'library', 'libraries'],
      'data': ['dataset', 'datasets'],
      'model': ['models', 'modeling'],
      'training': ['train', 'trained'],
      'network': ['networks', 'networking'],
      'system': ['systems'],
      'analysis': ['analyze', 'analyzing', 'analytical'],
      'science': ['scientific'],
      'engineering': ['engineer', 'engineered']
    };

    // Check if either word is an abbreviation of the other
    for (const [abbrev, synonyms] of Object.entries(synonymMap)) {
      if ((word1 === abbrev && synonyms.includes(word2)) ||
          (word2 === abbrev && synonyms.includes(word1)) ||
          (synonyms.includes(word1) && synonyms.includes(word2))) {
        return 0.85; // High similarity for synonyms/abbreviations
      }
    }

    // Check for substring matches (prefix/suffix matching)
    const longer = word1.length > word2.length ? word1 : word2;
    const shorter = word1.length > word2.length ? word2 : word1;

    if (longer.startsWith(shorter) || longer.endsWith(shorter)) {
      return 0.6 + (shorter.length / longer.length) * 0.2;
    }

    // Edit distance similarity for typos and variations
    const editDistance = this._calculateEditDistance(word1, word2);
    const maxLength = Math.max(word1.length, word2.length);

    if (editDistance <= 2 && maxLength > 3) {
      return Math.max(0, 1 - editDistance / maxLength);
    }

    return 0;
  }

  /**
   * Calculate edit distance between two words
   */
  _calculateEditDistance(word1, word2) {
    const m = word1.length;
    const n = word2.length;

    if (m === 0) return n;
    if (n === 0) return m;

    const dp = Array(m + 1).fill().map(() => Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (word1[i - 1] === word2[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1];
        } else {
          dp[i][j] = Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]) + 1;
        }
      }
    }

    return dp[m][n];
  }

  /**
   * Enhanced contextual similarity with semantic understanding
   */
  _calculateContextSimilarity(context1, context2) {
    if (!context1 || !context2) return 0;

    const c1 = context1.toLowerCase().trim();
    const c2 = context2.toLowerCase().trim();

    // Direct or substring match
    if (c1 === c2) return 1.0;
    if (c1.includes(c2) || c2.includes(c1)) return 0.7;

    // Extract key phrases and concepts
    const phrases1 = this._extractKeyPhrases(c1);
    const phrases2 = this._extractKeyPhrases(c2);

    let semanticMatches = 0;
    let totalComparisons = 0;

    for (const phrase1 of phrases1) {
      for (const phrase2 of phrases2) {
        totalComparisons++;
        const similarity = this._calculateTopicSimilarity(phrase1, phrase2);
        if (similarity > 0.3) {
          semanticMatches += similarity;
        }
      }
    }

    if (totalComparisons === 0) return 0;

    const avgSimilarity = semanticMatches / totalComparisons;

    // Boost score if there are multiple good matches
    const matchBoost = Math.min(0.2, (semanticMatches / phrases1.length) * 0.1);

    return Math.min(1.0, avgSimilarity + matchBoost);
  }

  /**
   * Extract key phrases from context text
   */
  _extractKeyPhrases(text) {
    // Split into meaningful chunks
    const sentences = text.split(/[.!?;]/).filter(s => s.trim().length > 3);
    const phrases = [];

    for (const sentence of sentences) {
      // Extract noun phrases and important words
      const words = sentence.split(/\s+/).filter(w => w.length > 2);

      // Add individual important words
      phrases.push(...words.filter(w => !this._isStopWord(w)));

      // Add bigrams for better context
      for (let i = 0; i < words.length - 1; i++) {
        if (!this._isStopWord(words[i]) && !this._isStopWord(words[i + 1])) {
          phrases.push(`${words[i]} ${words[i + 1]}`);
        }
      }
    }

    // Also split by commas and extract phrases
    const commaPhrases = text.split(',').map(p => p.trim()).filter(p => p.length > 3);
    phrases.push(...commaPhrases);

    return [...new Set(phrases)]; // Remove duplicates
  }

  /**
   * Check if word is a stop word (common words to ignore)
   */
  _isStopWord(word) {
    const stopWords = new Set([
      'the', 'is', 'at', 'which', 'on', 'and', 'a', 'to', 'an', 'as',
      'are', 'was', 'were', 'been', 'be', 'have', 'has', 'had', 'do',
      'does', 'did', 'will', 'would', 'should', 'could', 'can', 'may',
      'might', 'must', 'shall', 'for', 'of', 'with', 'by', 'in', 'about',
      'into', 'through', 'during', 'before', 'after', 'above', 'below',
      'up', 'down', 'out', 'off', 'over', 'under', 'again', 'further',
      'then', 'once', 'than', 'very', 'too', 'so', 'just', 'really'
    ]);
    return stopWords.has(word.toLowerCase());
  }

  /**
   * Find cross-domain connections between topics
   */
  _findCrossDomainConnections(newSignal, relatedSignals) {
    const connections = [];
    const domains = {
      'tech': ['ai', 'software', 'programming', 'code', 'development', 'computer'],
      'business': ['market', 'strategy', 'growth', 'revenue', 'customer', 'sales'],
      'science': ['research', 'experiment', 'data', 'analysis', 'study', 'method'],
      'creativity': ['design', 'art', 'creative', 'writing', 'content', 'visual'],
      'learning': ['education', 'tutorial', 'course', 'skill', 'knowledge', 'training']
    };

    const newDomain = this._classifyDomain(newSignal.topic, domains);
    if (!newDomain) return connections;

    for (const match of relatedSignals.strongMatches) {
      const matchDomain = this._classifyDomain(match.signal.topic, domains);
      if (matchDomain && matchDomain !== newDomain && match.totalScore > 0.6) {
        connections.push({
          domains: [newDomain, matchDomain],
          topics: [newSignal.topic, match.signal.topic],
          strength: Math.min(0.8, match.totalScore * 0.9)
        });
      }
    }

    return connections;
  }

  /**
   * Classify topic into domain
   */
  _classifyDomain(topic, domains) {
    if (!topic) return null;
    const lowerTopic = String(topic).toLowerCase();

    for (const [domain, keywords] of Object.entries(domains)) {
      if (keywords.some(keyword => lowerTopic.includes(keyword))) {
        return domain;
      }
    }
    return null;
  }
}

/**
 * Convenience: create an InsightEngine from a KG file path
 */
export function createInsightEngine(kgPath) {
  const kg = new MarbleKG(kgPath).load();
  return new InsightEngine(kg);
}

export default InsightEngine;
