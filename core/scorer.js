/**
 * Marble Content Scorer
 *
 * Computes composite relevance scores for content items using multi-dimensional scoring.
 * Temporal relevance receives highest weight in current experimental configuration.
 */

import { SCORE_WEIGHTS, MetricConfiguration, USE_CASE_CONFIGS } from './types.js';
import { embeddings } from './embeddings.js';
import { MetricDrivenScoringEngine } from './enterprise/metric-driven-scoring-engine.js';
import { swarmScore, generateAgentFleet } from './swarm.js';
import { globalCollaborativeFilter } from './collaborative-filter.js';
import { extractEntityAttributes, attributeCount } from './entity-extractor.js';
import { getWorldContextFromCache } from './worldsim-bridge.js';

export class Scorer {
  constructor(kg, options = {}) {
    this.kg = kg;
    this.useCase = options.useCase || 'content_curation';
    this.metricConfig = options.metricConfig;
    this.mode = options.mode || 'content_curation'; // Support decision_compression mode
    this.userId = options.userId || kg?.user?.id || 'default_user';
    this.enableCollaborativeFiltering = options.enableCollaborativeFiltering !== false; // Default true
    this.enableSessionAdaptation = options.enableSessionAdaptation !== false; // Default true
    this.signalProcessor = options.signalProcessor || null; // Pass signal processor for session access

    // Initialize metric-driven scoring engine
    if (this.metricConfig) {
      this.metricEngine = new MetricDrivenScoringEngine({
        useCase: this.useCase,
        targetMetrics: this.metricConfig.targetMetrics,
        initialWeights: this.metricConfig.weights
      });
    } else if (USE_CASE_CONFIGS[this.useCase]) {
      // Use default config for the use case
      this.metricEngine = new MetricDrivenScoringEngine({
        useCase: this.useCase,
        ...USE_CASE_CONFIGS[this.useCase]
      });
    }

    this.legacyMode = !this.metricEngine;
  }

  /**
   * Score a batch of stories against the user's KG
   * @param {Story[]} stories - Raw stories to score
   * @returns {Promise<ScoredStory[]>} - Stories with computed scores, sorted descending
   *
   * Note: rank() (via swarmRank export) is the default benchmark/prediction API for evaluation.
   * select() method (when implemented) should be used for narrative layer only.
   * The typed alignment components (belief, preference, identity, institution) provide
   * improved opinion/preference prediction over the legacy interest_match bucket.
   */
  async score(stories) {
    // Fix 1: compute slate-level max rating count for normalized popularity_score
    const maxRatingCount = Math.max(1, ...stories.map(s =>
      s.rating_count || s.vote_count || s.num_ratings || s.ratings_count || 0
    ));
    const scored = await Promise.all(stories.map(story => this.#scoreOne(story, { maxRatingCount })));
    // Fix 3: tie-breaking within epsilon — use popularity as secondary sort to reduce noise
    const EPSILON = 0.01;
    return scored.sort((a, b) => {
      const diff = b.relevance_score - a.relevance_score;
      if (Math.abs(diff) < EPSILON) {
        return (b.popularity_score || 0) - (a.popularity_score || 0);
      }
      return diff;
    });
  }

  /**
   * Rank stories using use-case specific weights
   * @param {Story[]} stories - Stories to rank
   * @param {Object} options - Ranking options
   * @param {string} [options.useCase] - Use case profile (survey_opinion, preference_ranking, etc.)
   * @returns {Promise<ScoredStory[]>} - Stories ranked according to use case
   */
  async rank(stories, options = {}) {
    const { useCase } = options;

    // If useCase is specified and differs from instance useCase, create temporary scorer
    if (useCase && useCase !== this.useCase && USE_CASE_CONFIGS[useCase]) {
      const tempScorer = new Scorer(this.kg, {
        ...this,
        useCase,
        metricConfig: undefined // Let it use USE_CASE_CONFIGS
      });
      return await tempScorer.score(stories);
    }

    // Use instance scoring
    return await this.score(stories);
  }

  /**
   * Decision compression - turns information overload into clear action
   * Enhanced with swarm agent reasoning - each agent contributes to the "why"
   * @param {Object} params - Compression parameters
   * @param {Array} params.inputs - Raw inputs to compress (emails, reports, etc.)
   * @param {string} [params.output] - Output format ('what_matters_why_do_next')
   * @param {string} [params.timeframe] - Timeframe for decisions ('today', 'this_week')
   * @param {boolean} [params.useSwarm=true] - Whether to use swarm agents for enhanced reasoning
   * @returns {Promise<Object>} - Compressed decisions with critical items
   */
  async compress(params) {
    const { inputs = [], output = 'what_matters_why_do_next', timeframe = 'today', useSwarm = true } = params;

    // Convert inputs to story-like format for scoring
    const stories = inputs.map((input, index) => ({
      id: input.id || `input_${index}_${Date.now()}`,
      title: input.title || input.subject || this.#extractTitle(input),
      summary: input.summary || input.content || input.body || this.#extractSummary(input),
      source: input.source || 'decision_input',
      published_at: input.timestamp || input.date || new Date().toISOString(),
      topics: input.topics || this.#extractTopics(input),
      type: input.type || 'decision_item'
    }));

    let scored;

    if (useSwarm && this.#hasSwarmCapabilities()) {
      // Use swarm agents for enhanced multi-perspective scoring
      scored = await this.#scoreWithSwarm(stories);
    } else {
      // Fallback to regular scoring logic
      scored = await this.score(stories);
    }

    // Filter for critical items (top scoring and actionable)
    // Use more lenient thresholds for decision compression mode
    const relevanceThreshold = this.mode === 'decision_compression' ? 0.2 : 0.4;
    const actionabilityThreshold = this.mode === 'decision_compression' ? 0.2 : 0.3;

    const critical = scored
      .filter(item => item.relevance_score > relevanceThreshold && (item.actionability || 0.5) > actionabilityThreshold)
      .slice(0, 5) // Limit to top 5 critical decisions
      .map(item => ({
        matter: this.#extractWhatMatters(item),
        why: this.#buildSwarmWhy(item),
        do_next: this.#extractNextAction(item)
      }));

    // Add deferred items for context
    const defer = scored
      .filter(item => item.relevance_score <= relevanceThreshold || (item.actionability || 0.5) <= actionabilityThreshold)
      .slice(0, 3)
      .map(item => ({
        matter: this.#extractWhatMatters(item),
        why: 'Lower priority - ' + this.#buildSwarmWhy(item, true),
        do_next: 'Review later or delegate'
      }));

    return {
      critical,
      defer,
      total_processed: inputs.length,
      compression_ratio: critical.length / inputs.length,
      timeframe,
      scoring_mode: useSwarm && this.#hasSwarmCapabilities() ? 'swarm_enhanced' : 'legacy'
    };
  }

  async #scoreOne(story, { maxRatingCount = 1 } = {}) {
    // If using metric-driven scoring, delegate to the engine
    if (!this.legacyMode && this.metricEngine) {
      const legacyScores = await this.#computeLegacyScores(story);
      const result = await this.metricEngine.scoreContent(story, {
        legacyScores,
        kg: this.kg
      });

      const freshness = this.#freshnessDecay(story);
      const sessionBoost = this.#calculateSessionBoost(story);
      const baseScore = result.magic_score * freshness;
      const relevance_score = Math.max(0, Math.min(1, baseScore + sessionBoost));

      // Blend entity_affinity into metric-driven score
      const entityAffinity = legacyScores.entity_affinity || 0;
      const secondaryNodeCount = legacyScores.entity_affinity_details?.matchedDimensions || 0;
      const entityBoost = secondaryNodeCount >= 2 ? entityAffinity * 0.15 : entityAffinity * 0.05;
      const boostedScore = Math.max(0, Math.min(1, relevance_score + entityBoost));

      // Fix 1: Bayesian popularity blend — sparse profiles lean on popularity, rich profiles lean on Marble
      const rawPopCount = story.rating_count || story.vote_count || story.num_ratings || story.ratings_count || 0;
      const popularity_score = rawPopCount > 0 ? rawPopCount / maxRatingCount : (story.avg_rating ? story.avg_rating / 5.0 : 0);
      const userSignalCount = (this.kg?.user?.history || this.kg?.history || []).length;
      const personalization_confidence = Math.min(1.0, userSignalCount / 50);
      const final_score = popularity_score * (1 - personalization_confidence) + boostedScore * personalization_confidence;

      return {
        story,
        relevance_score: Math.max(0, Math.min(1, final_score)),
        popularity_score,
        magic_score: result.magic_score,
        interest_match: legacyScores.interest_match,
        belief_alignment: legacyScores.belief_alignment,
        preference_alignment: legacyScores.preference_alignment,
        identity_alignment: legacyScores.identity_alignment,
        institution_alignment: legacyScores.institution_alignment,
        entity_affinity: entityAffinity,
        entity_affinity_details: legacyScores.entity_affinity_details,
        temporal_relevance: legacyScores.temporal_relevance,
        novelty: legacyScores.novelty,
        actionability: legacyScores.actionability,
        source_trust: legacyScores.source_trust,
        session_boost: sessionBoost, // Expose for debugging
        arc_position: 0,
        dimension_scores: result.dimension_scores,
        business_predictions: result.business_predictions,
        confidence: result.confidence,
        use_case: result.use_case,
        current_weights: result.current_weights,
        calibration_status: this.#getCalibrationStatus(),
        calibration_data_points: this.metricEngine?.calibrationHistory?.length || 0,
        auto_tuning_active: this.metricEngine?.calibrationHistory?.length >= 15 || false,
        why: result.reasoning || this.#explainScore(legacyScores, sessionBoost)
      };
    }

    // Legacy scoring path
    const legacyScores = await this.#computeLegacyScores(story);
    const freshness = this.#freshnessDecay(story);

    // Use calibrated weights from metric engine if available and sufficiently calibrated
    let weights = SCORE_WEIGHTS; // Default fallback

    // Check for new calibration API with real correlation math and auto-tuning
    if (this.metricEngine && this.metricEngine.weights) {
      const calibratedWeights = this.metricEngine.weights.getCurrentWeights();

      // Check if we have sufficient calibration data (15+ samples for auto-tuning)
      const hasSufficientData = this.metricEngine.calibrationHistory &&
                               this.metricEngine.calibrationHistory.length >= 15;

      if (hasSufficientData) {
        // Use auto-tuned weights based on real correlation math
        weights = {
          interest_match: calibratedWeights.interest_match || calibratedWeights.personalization_depth || SCORE_WEIGHTS.interest_match,
          temporal_relevance: calibratedWeights.temporal_relevance || SCORE_WEIGHTS.temporal_relevance,
          novelty: calibratedWeights.novelty || calibratedWeights.psychological_resonance || SCORE_WEIGHTS.novelty,
          actionability: calibratedWeights.actionability || SCORE_WEIGHTS.actionability,
          source_trust: calibratedWeights.source_trust || calibratedWeights.trust_indicators || SCORE_WEIGHTS.source_trust,
          collaborative_filtering: SCORE_WEIGHTS.collaborative_filtering // CF weight handled separately
        };
      } else if (this.metricEngine.calibrationHistory && this.metricEngine.calibrationHistory.length >= 5) {
        // Use partially calibrated weights for 5-14 samples (interpolated between defaults and calibrated)
        const calibrationProgress = Math.min(1, this.metricEngine.calibrationHistory.length / 15);

        weights = {
          interest_match: this.#interpolateWeight(SCORE_WEIGHTS.interest_match,
                                                calibratedWeights.interest_match || calibratedWeights.personalization_depth,
                                                calibrationProgress),
          temporal_relevance: this.#interpolateWeight(SCORE_WEIGHTS.temporal_relevance,
                                                    calibratedWeights.temporal_relevance,
                                                    calibrationProgress),
          novelty: this.#interpolateWeight(SCORE_WEIGHTS.novelty,
                                         calibratedWeights.novelty || calibratedWeights.psychological_resonance,
                                         calibrationProgress),
          actionability: this.#interpolateWeight(SCORE_WEIGHTS.actionability,
                                               calibratedWeights.actionability,
                                               calibrationProgress),
          source_trust: this.#interpolateWeight(SCORE_WEIGHTS.source_trust,
                                              calibratedWeights.source_trust || calibratedWeights.trust_indicators,
                                              calibrationProgress),
          collaborative_filtering: SCORE_WEIGHTS.collaborative_filtering
        };
      }
    }

    // Include collaborative filtering in the scoring computation
    // CF weight is dynamic based on confidence (more similar users = higher weight)
    const cfWeight = legacyScores.cf_confidence * 0.15; // Max 15% of total score
    // Exclude collaborative_filtering from base weights — it's replaced by dynamic cfWeight above
    const { collaborative_filtering: _cfw, ...scoringWeights } = weights;
    const baseWeightTotal = Object.values(scoringWeights).reduce((sum, w) => sum + w, 0);
    const normalizedBaseWeights = baseWeightTotal > 0 ? baseWeightTotal : 1;

    // Use typed alignment components for better opinion prediction
    // Fall back to legacy interest_match if typed components not available
    const alignmentScore = legacyScores.belief_alignment !== undefined ?
      (legacyScores.belief_alignment * 0.30 +
       legacyScores.preference_alignment * 0.25 +
       legacyScores.identity_alignment * 0.25 +
       legacyScores.institution_alignment * 0.20) :
      legacyScores.interest_match;

    // Entity affinity: weight scales with secondary context density
    // Few secondary nodes → entity_affinity has low weight, fall back to surface interest_match
    // Many secondary nodes → entity_affinity gets higher weight for better predictions
    const entityAffinity = legacyScores.entity_affinity || 0;
    const secondaryNodeCount = legacyScores.entity_affinity_details?.matchedDimensions || 0;
    const entityAffinityWeight = secondaryNodeCount >= 4 ? 0.20 :
                                  secondaryNodeCount >= 2 ? 0.12 :
                                  secondaryNodeCount >= 1 ? 0.06 : 0;

    // World context boost from warm cache (max 5% lift — psychographic alignment)
    const worldContextWeight = legacyScores.world_context_score > 0 ? 0.05 : 0;

    const raw = (
      alignmentScore * weights.interest_match +
      legacyScores.temporal_relevance * weights.temporal_relevance +
      legacyScores.novelty * weights.novelty +
      legacyScores.actionability * weights.actionability +
      legacyScores.source_trust * weights.source_trust +
      legacyScores.collaborative_filtering * cfWeight +
      entityAffinity * entityAffinityWeight +
      legacyScores.world_context_score * worldContextWeight
    ) / (normalizedBaseWeights + cfWeight + entityAffinityWeight + worldContextWeight);

    // Apply session-scoped adjustments
    const sessionBoost = this.#calculateSessionBoost(story);
    const baseScore = raw * freshness;
    const marbleScore = Math.max(0, Math.min(1, baseScore + sessionBoost));

    // Fix 1: Bayesian popularity blend — sparse profiles lean on popularity, rich profiles lean on Marble
    const rawPopCount = story.rating_count || story.vote_count || story.num_ratings || story.ratings_count || 0;
    const popularity_score = rawPopCount > 0 ? rawPopCount / maxRatingCount : (story.avg_rating ? story.avg_rating / 5.0 : 0);
    const userSignalCount = (this.kg?.user?.history || this.kg?.history || []).length;
    const personalization_confidence = Math.min(1.0, userSignalCount / 50);
    const relevance_score = popularity_score > 0
      ? Math.max(0, Math.min(1, popularity_score * (1 - personalization_confidence) + marbleScore * personalization_confidence))
      : marbleScore;

    return {
      story,
      relevance_score,
      popularity_score,
      interest_match: legacyScores.interest_match,
      belief_alignment: legacyScores.belief_alignment,
      preference_alignment: legacyScores.preference_alignment,
      identity_alignment: legacyScores.identity_alignment,
      institution_alignment: legacyScores.institution_alignment,
      entity_affinity: entityAffinity,
      entity_affinity_details: legacyScores.entity_affinity_details,
      temporal_relevance: legacyScores.temporal_relevance,
      novelty: legacyScores.novelty,
      actionability: legacyScores.actionability,
      source_trust: legacyScores.source_trust,
      collaborative_filtering: legacyScores.collaborative_filtering,
      cf_confidence: legacyScores.cf_confidence,
      world_context_score: legacyScores.world_context_score,
      session_boost: sessionBoost, // Expose for debugging
      arc_position: 0,
      current_weights: { ...weights, entity_affinity: entityAffinityWeight, world_context: worldContextWeight },
      calibration_status: this.#getCalibrationStatus(),
      calibration_data_points: this.metricEngine?.calibrationHistory?.length || 0,
      auto_tuning_active: this.metricEngine?.calibrationHistory?.length >= 15 || false,
      why: this.#explainScore(legacyScores)
    };
  }

  async #computeLegacyScores(story) {
    const cfScore = this.enableCollaborativeFiltering ?
      await this.#collaborativeScore(story) :
      { score: 0, confidence: 0 };

    // Split interest_match into typed alignment components for better opinion prediction
    const alignmentScores = await this.#computeTypedAlignments(story);

    // Compute entity affinity from secondary-context KG nodes
    const entityAffinity = this.#entityAffinityScore(story);

    // World context alignment from warm cache — no on-demand WorldSim calls
    const worldContextScore = this.#worldContextScore(story);

    return {
      interest_match: alignmentScores.composite, // Maintain backward compatibility
      belief_alignment: alignmentScores.belief_alignment,
      preference_alignment: alignmentScores.preference_alignment,
      identity_alignment: alignmentScores.identity_alignment,
      institution_alignment: alignmentScores.institution_alignment,
      entity_affinity: entityAffinity.score,
      entity_affinity_details: entityAffinity.details,
      temporal_relevance: this.#temporalRelevance(story),
      novelty: this.#noveltyScore(story),
      actionability: this.#actionability(story),
      source_trust: this.#sourceTrust(story),
      collaborative_filtering: cfScore.score,
      cf_confidence: cfScore.confidence,
      world_context_score: worldContextScore
    };
  }

  /**
   * World context alignment from warm KG cache
   * Matches story against cached WorldSim psychographics (goals, pain points, buying triggers).
   * Reads only from warm cache — no on-demand cross-module calls.
   */
  #worldContextScore(story) {
    const worldCtx = getWorldContextFromCache(this.kg);
    if (!worldCtx) return 0;

    const storyText = `${story.title || ''} ${story.summary || ''}`.toLowerCase();
    const goals = worldCtx.goals || [];
    const painPoints = worldCtx.psychographics?.pain_points || [];
    const buyingTriggers = worldCtx.psychographics?.buying_triggers || [];

    let score = 0;
    for (const goal of goals) {
      if (goal && storyText.includes(goal.toLowerCase())) score += 0.3;
    }
    for (const trigger of buyingTriggers) {
      if (trigger && storyText.includes(trigger.toLowerCase())) score += 0.2;
    }
    for (const pain of painPoints) {
      if (pain && storyText.includes(pain.toLowerCase())) score += 0.1;
    }

    return Math.min(1, score);
  }

  /**
   * Compute typed alignment components for better opinion/preference prediction
   * Splits the single interest_match bucket into specialized alignment types
   */
  async #computeTypedAlignments(story) {
    const belief_alignment = await this.#beliefAlignment(story);
    const preference_alignment = await this.#preferenceAlignment(story);
    const identity_alignment = await this.#identityAlignment(story);
    const institution_alignment = await this.#institutionAlignment(story);

    // Composite score for backward compatibility - weighted average of components
    const composite = (
      belief_alignment * 0.30 +        // Political beliefs, ideology - highest weight for opinion prediction
      preference_alignment * 0.25 +    // Genre, product preferences
      identity_alignment * 0.25 +      // Demographics, social identity
      institution_alignment * 0.20     // Trust in institutions
    );

    return {
      belief_alignment,
      preference_alignment,
      identity_alignment,
      institution_alignment,
      composite: Math.min(1, composite)
    };
  }

  /**
   * Belief alignment: exact + family match on belief nodes (gunlaw, party, etc.)
   * Handles political beliefs, ideological positions, moral stances
   */
  async #beliefAlignment(story) {
    if (!story.topics?.length) return 0.2;

    const storyText = `${story.title} ${story.summary || ''}`.trim().toLowerCase();
    const userBeliefs = this.#extractUserBeliefs();

    let exactMatches = 0;
    let familyMatches = 0;
    let latentMatches = 0;

    // Exact match: party:democrat vs party:democrat
    for (const belief of userBeliefs) {
      if (storyText.includes(belief.key.toLowerCase()) && storyText.includes(belief.value.toLowerCase())) {
        exactMatches += belief.confidence * 0.4; // High weight for exact matches
      }
    }

    // Family match: abany:yes vs abdefect:yes (same issue family)
    const issueFamilies = this.#getIssueFamilies();
    for (const [family, issues] of Object.entries(issueFamilies)) {
      const storyIssues = issues.filter(issue => storyText.includes(issue.toLowerCase()));
      const userFamilyBeliefs = userBeliefs.filter(b => issues.includes(b.key));

      if (storyIssues.length > 0 && userFamilyBeliefs.length > 0) {
        const avgConfidence = userFamilyBeliefs.reduce((sum, b) => sum + b.confidence, 0) / userFamilyBeliefs.length;
        familyMatches += avgConfidence * 0.25; // Medium weight for family matches
      }
    }

    // Latent correlation: gunlaw:favor + ideology:liberal correlation
    const correlations = this.#getBeliefCorrelations();
    for (const correlation of correlations) {
      if (storyText.includes(correlation.trigger.toLowerCase())) {
        const userBelief = userBeliefs.find(b => b.key === correlation.belief);
        if (userBelief && userBelief.value === correlation.expected_value) {
          latentMatches += userBelief.confidence * correlation.strength * 0.15; // Lower weight for correlations
        }
      }
    }

    return Math.min(1, exactMatches + familyMatches + latentMatches);
  }

  /**
   * Preference alignment: explicit preference history (genre, product, etc.)
   * Handles content preferences, product choices, behavioral patterns
   */
  async #preferenceAlignment(story) {
    if (!story.topics?.length) return 0.2;

    const storyText = `${story.title} ${story.summary || ''}`.trim();
    const userPreferences = this.#extractUserPreferences();

    try {
      // Use semantic matching for preference alignment
      const preferenceTexts = userPreferences.map(p => p.description).filter(Boolean);
      const bestMatch = await embeddings.findMostSimilar(storyText, preferenceTexts, 0.15);

      if (bestMatch.similarity > 0) {
        const matchedPreference = userPreferences[bestMatch.index];
        return Math.min(1, bestMatch.similarity * matchedPreference.strength * 1.3);
      }

      // Fallback to topic-based preference matching
      let score = 0;
      for (const topic of story.topics) {
        const preference = userPreferences.find(p => p.topic === topic);
        if (preference) {
          score = Math.max(score, preference.strength);
        }
      }

      return score;

    } catch (error) {
      // Embeddings unavailable — fall back to topic-based preference matching
      console.warn(`[scorer] preference alignment embedding failed (${error.message}), using topic fallback`);
      let score = 0;
      for (const topic of story.topics) {
        const preference = userPreferences.find(p => p.topic === topic);
        if (preference) score = Math.max(score, preference.strength);
      }
      return score;
    }
  }

  /**
   * Identity alignment: demographic + identity markers
   * Handles age, location, profession, social group membership
   */
  async #identityAlignment(story) {
    if (!story.topics?.length) return 0.3; // Neutral baseline

    const storyText = `${story.title} ${story.summary || ''}`.trim().toLowerCase();
    const userIdentity = this.#extractUserIdentity();

    let identityScore = 0;

    // Demographic matching (age groups, location, profession)
    for (const demographic of userIdentity.demographics || []) {
      if (storyText.includes(demographic.key.toLowerCase()) ||
          storyText.includes(demographic.value.toLowerCase())) {
        identityScore += demographic.relevance * 0.3;
      }
    }

    // Social group membership
    for (const group of userIdentity.social_groups || []) {
      if (storyText.includes(group.name.toLowerCase()) ||
          group.keywords.some(k => storyText.includes(k.toLowerCase()))) {
        identityScore += group.affinity * 0.25;
      }
    }

    // Professional identity
    const profession = userIdentity.profession;
    if (profession && (storyText.includes(profession.field.toLowerCase()) ||
        profession.keywords.some(k => storyText.includes(k.toLowerCase())))) {
      identityScore += profession.relevance * 0.35;
    }

    return Math.min(1, identityScore);
  }

  /**
   * Institution alignment: confidence in institutions
   * Handles trust in government, media, corporations, academia, etc.
   */
  async #institutionAlignment(story) {
    const storyText = `${story.title} ${story.summary || ''}`.trim().toLowerCase();
    const institutionTrust = this.#extractInstitutionTrust();

    let trustScore = 0.5; // Neutral baseline

    // Check if story mentions specific institutions
    const mentionedInstitutions = [];
    for (const [institution, trustData] of Object.entries(institutionTrust)) {
      if (storyText.includes(institution.toLowerCase()) ||
          trustData.aliases?.some(alias => storyText.includes(alias.toLowerCase()))) {
        mentionedInstitutions.push({ institution, ...trustData });
      }
    }

    if (mentionedInstitutions.length > 0) {
      // Weight by trust level and recency of trust updates
      const weightedTrust = mentionedInstitutions.reduce((sum, inst) => {
        const recencyWeight = this.#calculateRecencyWeight(inst.last_updated);
        return sum + (inst.trust_level * recencyWeight);
      }, 0) / mentionedInstitutions.length;

      trustScore = weightedTrust;
    }

    return Math.min(1, Math.max(0, trustScore));
  }

  /**
   * Entity affinity: compare candidate item attributes against stored typed preference KG nodes.
   * Uses secondary-context nodes from topic-insight-engine to match specific entity attributes
   * (director, era, genre, themes, cast) against user's typed preferences/beliefs/identities.
   *
   * Score = weighted sum of matching dimensions. More secondary nodes → higher confidence.
   * Returns 0 when no matching secondary context exists.
   */
  #entityAffinityScore(story) {
    const { domain, attributes } = extractEntityAttributes(story);

    if (!domain || Object.keys(attributes).length === 0) {
      return { score: 0, details: { domain: null, matchedDimensions: 0, matches: [] } };
    }

    // Collect all typed KG nodes (beliefs, preferences, identities)
    const userBeliefs = this.kg?.getActiveBeliefs?.() || [];
    const userPreferences = this.kg?.getActivePreferences?.() || [];
    const userIdentities = this.kg?.getActiveIdentities?.() || [];

    let totalScore = 0;
    let matchCount = 0;
    const matches = [];

    // Match each candidate attribute against KG nodes
    for (const [kgKey, attrList] of Object.entries(attributes)) {
      for (const attr of attrList) {
        let matched = false;
        let matchStrength = 0;

        // Check beliefs (e.g., director_style:auteur_visual)
        if (attr.kgType === 'belief') {
          for (const belief of userBeliefs) {
            const beliefTopic = belief.topic?.toLowerCase();
            const beliefClaim = belief.claim?.toLowerCase();
            if (beliefTopic === kgKey || beliefTopic === attr.attribute) {
              // Check if the candidate's attribute value matches the user's belief claim
              if (beliefClaim === attr.value || beliefClaim?.includes(attr.value) || attr.value?.includes(beliefClaim)) {
                matchStrength = Math.max(matchStrength, belief.strength ?? 0.7);
                matched = true;
              }
            }
          }
        }

        // Check preferences (e.g., film_era:modern_2010s_plus, genre_preference:drama)
        if (attr.kgType === 'preference' || !matched) {
          for (const pref of userPreferences) {
            const prefType = pref.type?.toLowerCase();
            const prefDesc = pref.description?.toLowerCase();
            if (prefType === kgKey || prefType === attr.attribute) {
              if (prefDesc === attr.value || prefDesc?.includes(attr.value) || attr.value?.includes(prefDesc)) {
                matchStrength = Math.max(matchStrength, Math.abs(pref.strength ?? 0.7));
                matched = true;
              }
            }
          }
        }

        // Check identities (e.g., theme:existential)
        if (attr.kgType === 'identity' || !matched) {
          for (const id of userIdentities) {
            const idRole = id.role?.toLowerCase();
            const idContext = id.context?.toLowerCase();
            if (idRole === kgKey || idRole === attr.attribute) {
              if (idContext === attr.value || idContext?.includes(attr.value) || attr.value?.includes(idContext)) {
                matchStrength = Math.max(matchStrength, id.salience ?? 0.7);
                matched = true;
              }
            }
          }
        }

        if (matched) {
          totalScore += matchStrength;
          matchCount++;
          matches.push({ kgKey, value: attr.value, strength: matchStrength });
        }
      }
    }

    // Normalize: average match strength across matched dimensions
    const dimensionCount = Object.keys(attributes).length;
    const score = matchCount > 0 ? totalScore / dimensionCount : 0;

    return {
      score: Math.min(1, score),
      details: {
        domain,
        matchedDimensions: matchCount,
        totalDimensions: dimensionCount,
        matches
      }
    };
  }

  /**
   * How well does this story match the user's interest graph?
   * Uses semantic embeddings for better matching (e.g., "EU digital markets act" matches "Shopify compliance")
   * @deprecated - kept for backward compatibility, use #computeTypedAlignments instead
   */
  async #interestMatch(story) {
    if (!story.topics?.length) return 0.3; // neutral for untagged

    // Get story content for semantic analysis
    const storyText = `${story.title} ${story.summary || ''}`.trim();
    if (!storyText) return 0.3;

    try {
      // Get user interests from knowledge graph
      const userInterests = this.kg.getTopInterests?.() || [];
      if (!userInterests.length) {
        // Fallback to topic-based scoring if no interests available
        const weights = story.topics.map(t => this.kg?.getInterestWeight?.(t) || 0);
        if (weights.every(w => w === 0)) return 0.1;
        const max = Math.max(...weights);
        const matchCount = weights.filter(w => w > 0).length;
        const multiBonus = Math.min(0.1, matchCount * 0.03);
        return Math.min(1, max + multiBonus);
      }

      // Use semantic similarity for matching
      const interestTexts = userInterests.map(interest =>
        typeof interest === 'string' ? interest : interest.name || interest.topic
      ).filter(Boolean);

      const bestMatch = await embeddings.findMostSimilar(storyText, interestTexts, 0.2);

      if (bestMatch.similarity > 0) {
        // Convert similarity score (0-1) to interest match score with some boosting
        const semanticScore = Math.min(1, bestMatch.similarity * 1.2);

        // Blend with traditional topic matching if available
        const topicWeights = story.topics.map(t => this.kg?.getInterestWeight?.(t) || 0);
        const maxTopicWeight = Math.max(0, ...topicWeights);

        // Use the higher of semantic or topic-based score
        return Math.max(semanticScore, maxTopicWeight * 0.8);
      }

      // Fallback to topic-based matching
      const weights = story.topics.map(t => this.kg?.getInterestWeight?.(t) || 0);
      if (weights.every(w => w === 0)) return 0.1;
      const max = Math.max(...weights);
      return max * 0.8; // Slightly lower for non-semantic matches

    } catch (error) {
      // Embeddings unavailable — fall back to topic-based interest matching
      console.warn(`[scorer] interest match embedding failed (${error.message}), using topic fallback`);
      const weights = story.topics.map(t => this.kg?.getInterestWeight?.(t) || 0);
      if (weights.every(w => w === 0)) return 0.1;
      return Math.max(...weights) * 0.8;
    }
  }

  /**
   * How relevant is this story to what's happening in the user's life TODAY?
   * This is the key temporal dimension — calendar, projects, conversations.
   */
  #temporalRelevance(story) {
    const ctx = this.kg?.user?.context || {};
    let score = 0.2; // baseline

    const storyText = `${story.title} ${story.summary}`.toLowerCase();

    // Check against active projects
    for (const project of ctx.active_projects || []) {
      if (storyText.includes(project.toLowerCase())) {
        score += 0.3;
        break;
      }
    }

    // Check against today's calendar
    for (const event of ctx.calendar || []) {
      const eventWords = event.toLowerCase().split(/\s+/);
      if (eventWords.some(w => w.length > 3 && storyText.includes(w))) {
        score += 0.25;
        break;
      }
    }

    // Check against recent conversation topics
    for (const convo of ctx.recent_conversations || []) {
      if (storyText.includes(convo.toLowerCase())) {
        score += 0.15;
        break;
      }
    }

    return Math.min(1, score);
  }

  /**
   * Record user interaction with content for collaborative filtering
   * Call this when users engage with content (view, like, save, etc.)
   */
  recordInteraction(storyId, interactionType = 'view', weight = 1.0) {
    if (!this.enableCollaborativeFiltering) return false;

    try {
      return globalCollaborativeFilter.recordInteraction(
        this.userId,
        storyId,
        this.kg,
        interactionType,
        weight
      );
    } catch (error) {
      console.warn('Failed to record interaction:', error.message);
      return false;
    }
  }

  /**
   * Get collaborative filtering recommendations for the user
   */
  getCollaborativeRecommendations(limit = 20) {
    if (!this.enableCollaborativeFiltering) return [];

    try {
      return globalCollaborativeFilter.getRecommendations(
        this.userId,
        this.kg,
        limit
      );
    } catch (error) {
      console.warn('Failed to get CF recommendations:', error.message);
      return [];
    }
  }

  /**
   * How novel/surprising is this story?
   * Stories the user has already seen or on over-saturated topics score lower.
   */
  #noveltyScore(story) {
    // Already seen = 0
    if (this.kg?.hasSeen?.(story.id)) return 0;

    // Check topic saturation in recent history
    const recentHistory = this.kg?.user?.history?.slice(-50) || [];
    const topicCounts = {};
    for (const h of recentHistory) {
      for (const t of h.topics || []) {
        topicCounts[t] = (topicCounts[t] || 0) + 1;
      }
    }

    // Stories with over-represented topics get novelty penalty
    let saturation = 0;
    for (const topic of story.topics || []) {
      saturation += (topicCounts[topic] || 0);
    }

    const novelty = Math.max(0.1, 1 - (saturation / 20));
    return novelty;
  }

  /**
   * Can the user DO something with this story today?
   */
  #actionability(story) {
    // If story has explicit actionability tag, use it
    if (typeof story.actionability === 'number') return story.actionability;

    // Heuristic: stories mentioning tools, launches, deadlines, opportunities
    const actionWords = ['launch', 'deadline', 'opportunity', 'available', 'release',
      'update', 'new feature', 'apply', 'register', 'open source', 'free'];
    const text = `${story.title} ${story.summary}`.toLowerCase();
    const matches = actionWords.filter(w => text.includes(w)).length;

    return Math.min(1, 0.2 + matches * 0.15);
  }

  /**
   * How much does the user trust this source?
   */
  #sourceTrust(story) {
    return this.kg?.getSourceTrust?.(story.source) || 0.5; // Default neutral trust
  }

  /**
   * Collaborative filtering score - "users like you" signal
   * Complements clone evolution with actual user behavior data
   */
  async #collaborativeScore(story) {
    if (!this.enableCollaborativeFiltering) {
      return { score: 0, confidence: 0, reason: 'CF disabled' };
    }

    try {
      const cfResult = await globalCollaborativeFilter.getCollaborativeScore(
        this.userId,
        story.id,
        this.kg
      );

      // Use raw CF score — confidence is used to weight CF's contribution
      // in the composite score, not to penalize CF score itself
      return {
        score: cfResult.cf_score || 0,
        confidence: cfResult.confidence || 0,
        reason: cfResult.reason,
        similarUsers: cfResult.similar_users_count || 0,
        isNewItem: cfResult.cold_start || false,
        isColdStart: cfResult.cold_start || false
      };
    } catch (error) {
      console.warn('Collaborative filtering failed:', error.message);
      return { score: 0, confidence: 0, reason: 'CF error' };
    }
  }

  /**
   * Build structured KG summary with typed nodes for swarm agents.
   * Includes beliefs, preferences, identities sorted by strength,
   * with graceful degradation when typed nodes are empty.
   */
  #buildKgSummaryForSwarm() {
    const kgUser = this.kg?.user || {};
    const now = Date.now();
    const isActive = node => {
      const from = node.valid_from ? new Date(node.valid_from).getTime() : 0;
      const to = node.valid_to ? new Date(node.valid_to).getTime() : Infinity;
      return from <= now && now < to;
    };

    const beliefs = (kgUser.beliefs || [])
      .filter(isActive)
      .sort((a, b) => (b.strength || 0) - (a.strength || 0))
      .slice(0, 10)
      .map(b => ({ topic: b.topic, claim: b.claim, confidence: b.strength }));

    const preferences = (kgUser.preferences || [])
      .filter(isActive)
      .sort((a, b) => Math.abs(b.strength || 0) - Math.abs(a.strength || 0))
      .slice(0, 15)
      .map(p => ({ type: p.type, description: p.description, strength: p.strength }));

    const identities = (kgUser.identities || [])
      .filter(isActive)
      .sort((a, b) => (b.salience || 0) - (a.salience || 0))
      .slice(0, 5)
      .map(id => ({ role: id.role, context: id.context, salience: id.salience }));

    const history = (kgUser.history || []).slice(-10).map(h => ({
      title: h.story_id || h.title || h.topic || '',
      reaction: h.reaction || '',
      topics: h.topics || [],
    }));

    const role = identities[0]?.role || kgUser.role || '';

    return {
      role,
      interests: (kgUser.interests || []).slice(0, 15).map(i =>
        typeof i === 'string' ? { topic: i } : i
      ),
      beliefs,
      preferences,
      identities,
      history,
      recentEngagement: history,
      avoidPatterns: kgUser.avoid_patterns || kgUser.avoidPatterns || [],
    };
  }

  /**
   * Freshness decay — older stories get penalized
   */
  #freshnessDecay(story) {
    const hoursOld = (Date.now() - new Date(story.published_at).getTime()) / 3600000;
    if (hoursOld < 2) return 1.0;
    if (hoursOld < 6) return 0.95;
    if (hoursOld < 12) return 0.85;
    if (hoursOld < 24) return 0.7;
    if (hoursOld < 48) return 0.5;
    return 0.3;
  }

  /**
   * Generate human-readable explanation for why a story was selected
   */
  #explainScore(legacyScores, sessionBoost = 0) {
    const reasons = [];
    if (legacyScores.temporal_relevance > 0.5) reasons.push('relevant to your day');

    // Use typed alignment explanations if available
    if (legacyScores.belief_alignment !== undefined) {
      if (legacyScores.belief_alignment > 0.6) reasons.push('aligns with your beliefs');
      if (legacyScores.preference_alignment > 0.6) reasons.push('matches your preferences');
      if (legacyScores.identity_alignment > 0.5) reasons.push('relevant to your identity');
      if (legacyScores.institution_alignment > 0.7) reasons.push('from trusted institutions');
    } else if (legacyScores.interest_match > 0.6) {
      reasons.push('matches your interests');
    }

    if (legacyScores.novelty > 0.7) reasons.push('fresh perspective');
    if (legacyScores.actionability > 0.5) reasons.push('actionable');
    if (legacyScores.source_trust > 0.7) reasons.push('trusted source');

    // Include collaborative filtering when it contributes meaningfully
    if (legacyScores.collaborative_filtering > 0.3 && legacyScores.cf_confidence > 0.3) {
      reasons.push('similar users engaged');
    }

    // Include session adaptation reasons
    if (sessionBoost > 0.05) {
      reasons.push('similar topics engaged this session');
    } else if (sessionBoost < -0.05) {
      reasons.push('similar topics skipped this session');
    }

    return reasons.join(', ') || 'general relevance';
  }

  // Decision compression helper methods

  #extractTitle(input) {
    if (typeof input === 'string') {
      return input.split('\n')[0].substring(0, 100) + '...';
    }
    return input.title || input.subject || 'Decision item';
  }

  #extractSummary(input) {
    if (typeof input === 'string') {
      return input.substring(0, 500) + '...';
    }
    return input.summary || input.content || input.body || '';
  }

  #extractTopics(input) {
    const text = (input.title || input.subject || '') + ' ' + (input.content || input.body || '');
    const commonTopics = ['meeting', 'project', 'deadline', 'decision', 'review', 'update', 'launch', 'strategy'];
    return commonTopics.filter(topic => text.toLowerCase().includes(topic));
  }

  #extractWhatMatters(scoredItem) {
    const story = scoredItem.story;
    const title = story.title;

    // If high temporal relevance, emphasize the timing aspect
    if (scoredItem.temporal_relevance > 0.6) {
      return `${title} (time-sensitive)`;
    }

    // If high actionability, emphasize the action needed
    if (scoredItem.actionability > 0.6) {
      return `${title} (requires action)`;
    }

    return title;
  }

  #explainDecision(scoredItem) {
    const reasons = [];

    if (scoredItem.temporal_relevance > 0.5) {
      reasons.push('impacts current projects/schedule');
    }
    if (scoredItem.actionability > 0.5) {
      reasons.push('requires immediate action');
    }
    if (scoredItem.interest_match > 0.6) {
      reasons.push('aligns with your focus areas');
    }
    if (scoredItem.source_trust > 0.7) {
      reasons.push('from trusted source');
    }

    return reasons.join(', ') || 'general importance';
  }

  #extractNextAction(scoredItem) {
    const story = scoredItem.story;
    const text = (story.title + ' ' + story.summary).toLowerCase();

    // Look for explicit action indicators
    if (text.includes('meeting')) return 'Schedule or attend meeting';
    if (text.includes('deadline')) return 'Check deadline and plan completion';
    if (text.includes('review')) return 'Complete review';
    if (text.includes('decision')) return 'Make decision or gather info needed';
    if (text.includes('update')) return 'Review update and respond if needed';
    if (text.includes('launch')) return 'Prepare for or support launch';
    if (text.includes('approve')) return 'Review and approve/decline';

    // Generic actions based on scoring dimensions
    if (scoredItem.temporal_relevance > 0.7) {
      return 'Address today - high time relevance';
    }
    if (scoredItem.actionability > 0.7) {
      return 'Take specific action (see details)';
    }

    return 'Review and determine next steps';
  }

  // ─── SWARM INTEGRATION HELPERS ─────────────────────────────────────────────

  /**
   * Check if swarm capabilities are available
   */
  #hasSwarmCapabilities() {
    try {
      // Check if KG has sufficient data for swarm agents
      return this.kg.getUser && this.kg.getInsights && typeof swarmScore === 'function';
    } catch (error) {
      console.warn('Swarm capabilities check failed:', error.message);
      return false;
    }
  }

  /**
   * Score stories using swarm agents for enhanced multi-perspective analysis
   */
  async #scoreWithSwarm(stories) {
    const swarmed = [];

    // Build dynamic agent fleet once for the batch (domain from first story)
    let fleet = null;
    try {
      const sample = stories[0];
      const contentSample = `${sample?.title || ''} ${sample?.summary || ''}`.trim();
      const domain = sample?.domain || 'unknown';
      const kgSummary = this.#buildKgSummaryForSwarm();
      const activeClones = typeof this.kg?.getActiveClones === 'function'
        ? this.kg.getActiveClones()
        : (this.kg?.user?.clones || []).filter(c => c.status === 'active');
      fleet = await generateAgentFleet(domain, contentSample, kgSummary, null, activeClones.length ? activeClones : null);
    } catch (err) {
      console.warn('[Scorer] Fleet generation failed, falling back to static frames:', err.message);
    }

    for (const story of stories) {
      try {
        const swarmResult = swarmScore(story, this.kg, { fleet });

        // Convert swarm score to format compatible with existing scorer
        const legacyScores = await this.#computeLegacyScores(story);
        const freshness = this.#freshnessDecay(story);
        const relevance_score = swarmResult.score * freshness;

        const scoredItem = {
          story,
          relevance_score,
          interest_match: legacyScores.interest_match,
          temporal_relevance: legacyScores.temporal_relevance,
          novelty: legacyScores.novelty,
          actionability: legacyScores.actionability,
          source_trust: legacyScores.source_trust,
          arc_position: 0,
          swarm_score: swarmResult.score,
          agent_scores: swarmResult.agentScores,
          swarm_reasons: swarmResult.reasons,
          why: this.#explainScore(legacyScores, 0)
        };

        swarmed.push(scoredItem);
      } catch (error) {
        console.warn(`Swarm scoring failed for story ${story.id}:`, error.message);
        // Fallback to legacy scoring
        const legacyResult = await this.#scoreOne(story);
        swarmed.push(legacyResult);
      }
    }

    return swarmed.sort((a, b) => b.relevance_score - a.relevance_score);
  }

  /**
   * Build enhanced "why" explanation using swarm agent reasoning
   */
  #buildSwarmWhy(scoredItem, brief = false) {
    if (!scoredItem.swarm_reasons || !Array.isArray(scoredItem.swarm_reasons)) {
      return scoredItem.why || this.#explainDecision(scoredItem);
    }

    // Group reasons by agent for better organization
    const reasonsByAgent = {};
    scoredItem.swarm_reasons.forEach(({ agent, reason }) => {
      if (!reasonsByAgent[agent]) reasonsByAgent[agent] = [];
      reasonsByAgent[agent].push(reason);
    });

    // Build agent-contributed explanations
    const agentExplanations = [];
    const agentPriority = ['timing', 'career', 'growth', 'serendipity', 'contrarian'];

    for (const agent of agentPriority) {
      if (reasonsByAgent[agent] && reasonsByAgent[agent].length > 0) {
        const topReason = reasonsByAgent[agent][0]; // Use the most important reason
        const agentScore = scoredItem.agent_scores?.[agent] || 0;

        if (agentScore > 0.3) { // Only include agents with meaningful scores
          const agentLabel = agent.charAt(0).toUpperCase() + agent.slice(1);
          agentExplanations.push(`${agentLabel}: ${topReason}`);
        }
      }
    }

    if (brief) {
      // For deferred items, show only the top contributing agent
      return agentExplanations.length > 0 ? agentExplanations[0].split(': ')[1] : 'limited immediate relevance';
    }

    // For critical items, show multi-agent perspective
    if (agentExplanations.length > 0) {
      return agentExplanations.join(' | ');
    }

    // Fallback to legacy explanation
    return scoredItem.why || this.#explainDecision(scoredItem);
  }

  /**
   * Interpolate between default weight and calibrated weight based on calibration progress
   */
  #interpolateWeight(defaultWeight, calibratedWeight, progress) {
    if (calibratedWeight === undefined || calibratedWeight === null) {
      return defaultWeight;
    }
    return defaultWeight * (1 - progress) + calibratedWeight * progress;
  }

  /**
   * Get current calibration status based on real correlation math and auto-tuning
   */
  #getCalibrationStatus() {
    if (!this.metricEngine?.calibrationHistory) {
      return 'not_calibrated';
    }

    const dataPoints = this.metricEngine.calibrationHistory.length;

    if (dataPoints >= 15) {
      return 'auto_tuned'; // Real correlation math active
    } else if (dataPoints >= 5) {
      return 'learning'; // Partially calibrated
    } else if (dataPoints > 0) {
      return 'insufficient_data'; // Some data but not enough
    }

    return 'using_defaults'; // No calibration data
  }

  /**
   * Calculate session-scoped boost for story relevance
   * Returns boost value to add to base score (can be positive or negative)
   */
  #calculateSessionBoost(story) {
    if (!this.enableSessionAdaptation || !this.signalProcessor) {
      return 0; // No session adaptation
    }

    const topics = story.topics || [];
    if (!topics.length) return 0;

    let totalBoost = 0;
    let boostCount = 0;

    // Calculate weighted average of topic modifiers
    for (const topic of topics) {
      const modifier = this.signalProcessor.getSessionTopicModifier(topic);
      if (modifier !== 0) {
        totalBoost += modifier;
        boostCount++;
      }
    }

    // Return average boost across all story topics
    return boostCount > 0 ? totalBoost / boostCount : 0;
  }

  /**
   * Record user engagement for session adaptation
   * Call this when user engages with content in real-time
   */
  recordEngagement(storyId, signalType, metadata = {}) {
    if (!this.enableSessionAdaptation || !this.signalProcessor) {
      return false;
    }

    return this.signalProcessor.recordSessionSignal(storyId, signalType, metadata);
  }

  /**
   * End current session and feed accumulated signals to daily KG evolution
   * Call this when user session ends (app close, timeout, etc.)
   */
  endSession() {
    if (!this.enableSessionAdaptation || !this.signalProcessor) {
      return [];
    }

    return this.signalProcessor.sessionAdapter?.endSession() || [];
  }

  /**
   * Clear session without persisting signals (for testing/debugging)
   */
  clearSession() {
    if (!this.enableSessionAdaptation || !this.signalProcessor) {
      return false;
    }

    this.signalProcessor.clearSession();
    return true;
  }

  /**
   * Get current session state for debugging
   */
  getSessionState() {
    if (!this.enableSessionAdaptation || !this.signalProcessor) {
      return null;
    }

    return this.signalProcessor.getSessionState();
  }

  // ─── TYPED ALIGNMENT HELPER METHODS ────────────────────────────────────────

  /**
   * Extract user beliefs from KG (political positions, ideological stances)
   */
  #extractUserBeliefs() {
    // Prefer bi-temporal typed nodes from KG (no decay distortion)
    if (this.kg?.getActiveBeliefs) {
      const activeBeliefs = this.kg.getActiveBeliefs();
      if (activeBeliefs.length > 0) {
        return activeBeliefs.map(b => ({
          key: b.topic,
          value: b.claim,
          confidence: b.strength ?? 0.7,
          evidence_count: b.evidence_count || 1
        }));
      }
    }

    // Fallback: infer from reaction history (legacy heuristic)
    const beliefs = [];
    const history = this.kg?.user?.history || [];
    const politicalTopics = ['democrat', 'republican', 'liberal', 'conservative', 'progressive',
                           'gunlaw', 'abortion', 'immigration', 'healthcare', 'climate'];

    for (const topic of politicalTopics) {
      const reactions = history.filter(h =>
        h.topics?.some(t => t.toLowerCase().includes(topic.toLowerCase()))
      );

      if (reactions.length >= 3) {
        const positiveReactions = reactions.filter(r => r.reaction === 'up' || r.reaction === 'share').length;
        const confidence = positiveReactions / reactions.length;

        beliefs.push({
          key: topic,
          value: confidence > 0.6 ? 'favor' : confidence < 0.4 ? 'oppose' : 'neutral',
          confidence: Math.abs(confidence - 0.5) * 2,
          evidence_count: reactions.length
        });
      }
    }

    return beliefs;
  }

  /**
   * Get issue families for family matching
   */
  #getIssueFamilies() {
    return {
      abortion_rights: ['abany', 'abdefect', 'abnomore', 'abpoor', 'absingle'],
      gun_policy: ['gunlaw', 'owngun', 'hunt', 'shotgun'],
      social_policy: ['welfare', 'natspac', 'natenvir', 'nateduc'],
      economic_policy: ['eqwlth', 'tax', 'spending', 'budget'],
      civil_rights: ['racmar', 'homosex', 'divlaw', 'prayer'],
      immigration: ['letin1', 'immampt', 'immlimit', 'immcult']
    };
  }

  /**
   * Get belief correlations for latent matching
   */
  #getBeliefCorrelations() {
    return [
      { trigger: 'gun control', belief: 'ideology', expected_value: 'liberal', strength: 0.7 },
      { trigger: 'abortion', belief: 'party', expected_value: 'democrat', strength: 0.8 },
      { trigger: 'climate', belief: 'ideology', expected_value: 'liberal', strength: 0.9 },
      { trigger: 'immigration', belief: 'party', expected_value: 'republican', strength: 0.6 },
      { trigger: 'healthcare', belief: 'ideology', expected_value: 'liberal', strength: 0.7 },
      { trigger: 'business regulation', belief: 'ideology', expected_value: 'conservative', strength: 0.6 }
    ];
  }

  /**
   * Extract user preferences from interaction history
   */
  #extractUserPreferences() {
    // Prefer bi-temporal typed nodes from KG
    if (this.kg?.getActivePreferences) {
      const activePrefs = this.kg.getActivePreferences();
      if (activePrefs.length > 0) {
        return activePrefs.map(p => ({
          topic: p.type,
          description: p.description,
          strength: p.strength ?? 0.7,
          evidence_count: 1
        }));
      }
    }

    // Fallback: infer from reaction history (legacy heuristic)
    const preferences = [];
    const history = this.kg?.user?.history || [];

    const topicCounts = {};
    const topicPositive = {};

    history.forEach(h => {
      h.topics?.forEach(topic => {
        topicCounts[topic] = (topicCounts[topic] || 0) + 1;
        if (h.reaction === 'up' || h.reaction === 'share') {
          topicPositive[topic] = (topicPositive[topic] || 0) + 1;
        }
      });
    });

    Object.entries(topicCounts).forEach(([topic, count]) => {
      if (count >= 2) {
        const positive = topicPositive[topic] || 0;
        const strength = positive / count;

        preferences.push({
          topic,
          description: `${topic} related content`,
          strength: strength > 0.5 ? strength : 0.3,
          evidence_count: count
        });
      }
    });

    return preferences;
  }

  /**
   * Extract user identity markers from KG
   */
  #extractUserIdentity() {
    // Prefer bi-temporal typed identity nodes from KG
    if (this.kg?.getActiveIdentities) {
      const activeIds = this.kg.getActiveIdentities();
      if (activeIds.length > 0) {
        // Convert typed nodes to the identity structure scorer expects
        const demographics = [];
        const social_groups = [];
        let profession = null;

        for (const id of activeIds) {
          const role = id.role.toLowerCase();
          if (['engineer', 'founder', 'developer', 'designer', 'scientist', 'analyst', 'manager'].includes(role)) {
            profession = {
              field: id.context || id.role,
              keywords: [id.role, ...(id.context ? id.context.split(/[\s,]+/) : [])],
              relevance: id.salience ?? 0.8
            };
          } else {
            social_groups.push({
              name: id.role,
              keywords: [id.role, ...(id.context ? id.context.split(/[\s,]+/) : [])],
              affinity: id.salience ?? 0.6
            });
          }
        }

        return {
          demographics,
          social_groups,
          profession: profession || { field: 'general', keywords: [], relevance: 0.3 }
        };
      }
    }

    // Fallback: static defaults
    return {
      demographics: [
        { key: 'age_group', value: 'millennials', relevance: 0.3 },
        { key: 'location', value: 'urban', relevance: 0.25 }
      ],
      social_groups: [
        {
          name: 'tech_workers',
          keywords: ['startup', 'engineering', 'software', 'tech'],
          affinity: 0.7
        },
        {
          name: 'early_adopters',
          keywords: ['beta', 'new', 'launch', 'innovation'],
          affinity: 0.6
        }
      ],
      profession: {
        field: 'technology',
        keywords: ['programming', 'development', 'ai', 'machine learning'],
        relevance: 0.8
      }
    };
  }

  /**
   * Extract institution trust levels from user data
   */
  #extractInstitutionTrust() {
    const sourceTrust = this.kg?.user?.source_trust || {};

    // Map source trust to institutional categories
    return {
      media: {
        trust_level: Math.max(0.5, Object.entries(sourceTrust)
          .filter(([source]) => ['techcrunch', 'hackernews', 'reuters'].includes(source))
          .reduce((avg, [, trust], _, arr) => avg + trust / arr.length, 0.5)),
        aliases: ['news', 'journalism', 'press'],
        last_updated: Date.now()
      },
      government: {
        trust_level: 0.4, // Default moderate skepticism
        aliases: ['federal', 'congress', 'administration', 'policy'],
        last_updated: Date.now()
      },
      corporations: {
        trust_level: 0.6,
        aliases: ['business', 'corporate', 'company', 'industry'],
        last_updated: Date.now()
      },
      academia: {
        trust_level: 0.8,
        aliases: ['university', 'research', 'study', 'scientific'],
        last_updated: Date.now()
      }
    };
  }

  /**
   * Calculate recency weight for trust data
   */
  #calculateRecencyWeight(lastUpdated) {
    const daysSince = (Date.now() - lastUpdated) / (1000 * 60 * 60 * 24);
    if (daysSince < 7) return 1.0;
    if (daysSince < 30) return 0.9;
    if (daysSince < 90) return 0.7;
    return 0.5;
  }
}
