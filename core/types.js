/**
 * Marble type definitions
 */

/**
 * @typedef {Object} Story
 * @property {string} id - Unique story identifier
 * @property {string} title - Story headline
 * @property {string} summary - 1-2 sentence summary
 * @property {string} source - Source name (e.g., "hackernews", "techcrunch")
 * @property {string} url - Original URL
 * @property {string[]} topics - Multi-label topics
 * @property {Date} published_at - Publication timestamp
 * @property {number} [freshness] - Hours since published (computed)
 * @property {'inspiring'|'alarming'|'neutral'|'fun'} [valence] - Emotional valence
 * @property {number} [actionability] - 0-1, can user act on this?
 */

/**
 * @typedef {Object} ScoredStory
 * @property {Story} story - The original story
 * @property {number} relevance_score - Composite score (0-1)
 * @property {number} interest_match - Topic relevance (0-1)
 * @property {number} temporal_relevance - Today-relevance (0-1)
 * @property {number} novelty - Surprise factor (0-1)
 * @property {number} actionability - Can act on it (0-1)
 * @property {number} source_trust - Source credibility (0-1)
 * @property {number} arc_position - Position in narrative arc (1-10)
 * @property {string} why - Human-readable reason for selection
 */

/**
 * @typedef {Object} UserNode
 * @property {string} id - User identifier
 * @property {InterestEdge[]} interests - Weighted, decaying interests
 * @property {ContextSnapshot} context - Ephemeral daily context
 * @property {ReactionHistory[]} history - Past reactions
 * @property {BeliefNode[]} beliefs - Layer 1: Core beliefs about topics
 * @property {PreferenceNode[]} preferences - Layer 1: Explicit preferences
 * @property {IdentityNode[]} identities - Layer 1: Role/identity attributes
 * @property {Object<string, number>} confidence - Layer 1: Domain confidence scores
 */

/**
 * @typedef {Object} InterestEdge
 * @property {string} topic - Topic name
 * @property {number} weight - Current weight (0-1, decays over time)
 * @property {Date} last_boost - Last time this was reinforced
 * @property {'rising'|'stable'|'falling'} trend - Direction
 */

/**
 * @typedef {Object} ContextSnapshot
 * @property {string[]} calendar - Today's events
 * @property {string[]} active_projects - Current projects
 * @property {string[]} recent_conversations - Topics discussed recently
 * @property {string} [mood_signal] - Optional mood indicator
 */

/**
 * @typedef {Object} ReactionHistory
 * @property {string} item_id - Item that was reacted to (legacy: story_id)
 * @property {'up'|'down'|'skip'|'share'} reaction - User reaction
 * @property {Date} date - When reacted
 * @property {string[]} topics - Topics of the item
 * @property {string} source - Source of the item
 */

/**
 * @typedef {Object} BeliefNode
 * @property {string} topic - Topic or domain the belief is about
 * @property {string} claim - The belief statement
 * @property {number} strength - How strongly held (0-1)
 * @property {number} evidence_count - How many times reinforced
 */

/**
 * @typedef {Object} PreferenceNode
 * @property {string} type - Preference category (content_style, format, tone, etc.)
 * @property {string} description - What the preference is
 * @property {number} strength - Preference strength (-1 to 1, negative is dislike)
 */

/**
 * @typedef {Object} IdentityNode
 * @property {string} role - Identity role (engineer, founder, investor, etc.)
 * @property {string} context - Additional context for this identity
 * @property {number} salience - How central to self-concept (0-1)
 */

/**
 * @typedef {Object} ConfidenceMap
 * @property {string} domain - Domain name (AI, finance, biology, etc.)
 * @property {number} value - Confidence level (0-1)
 */

/**
 * @typedef {Object} ItemAttributeNode
 * @property {string} dimensionId - Dimension identifier (e.g., "director_style", "cuisine_type")
 * @property {string} value - Attribute value (e.g., "auteur_visual", "japanese")
 * @property {'belief'|'preference'|'identity'} kgType - How this maps to KG node types
 * @property {number} confidence - Confidence in this attribute (0-1)
 * @property {string} reasoning - Why this hypothesis was generated
 * @property {string} source - 'llm' | 'heuristic' | 'implicit'
 * @property {string} collectedAt - ISO timestamp
 */

/**
 * @typedef {Object} DimensionalPreference
 * @property {string} domain - Domain this preference applies to (movie, music, article, place)
 * @property {string} dimensionId - Dimension identifier (e.g., director_style, film_era)
 * @property {string} value - Preferred value within the dimension
 * @property {number} strength - Preference strength (-1 to 1)
 * @property {'explicit'|'implicit'} source - How this preference was collected
 * @property {number} confidence - How confident we are (0-1, based on evidence count)
 * @property {number} evidenceCount - Number of ratings supporting this preference
 * @property {string} collectedAt - ISO timestamp of collection
 */

// Legacy weights for backward compatibility
export const SCORE_WEIGHTS = {
  interest_match: 0.25,
  temporal_relevance: 0.30,
  novelty: 0.20,
  actionability: 0.15,
  source_trust: 0.10,
  collaborative_filtering: 0.0 // Dynamic weight based on CF confidence
};

// Business metric types
export const METRIC_TYPES = {
  REPLY_RATE: 'reply_rate',
  CONVERSION: 'conversion',
  RETENTION: 'retention',
  REVENUE: 'revenue',
  CLICK_THROUGH: 'click_through',
  CLICK_THROUGH_RATE: 'click_through_rate',
  ENGAGEMENT_TIME: 'engagement_time',
  BEHAVIOR_CHANGE: 'behavior_change',
  CUSTOM: 'custom'
};

// Metric configuration class
export class MetricConfiguration {
  constructor(metricType, targetOutcome, useCase = 'default') {
    this.metricType = metricType;
    this.targetOutcome = targetOutcome;
    this.useCase = useCase;
    this.weights = this._getUseCaseWeights(useCase);
    this.correlationHistory = [];
    this.performanceThreshold = 0.15; // 15% improvement target
    this.learningRate = 0.08;
    this.created = Date.now();
  }

  _getUseCaseWeights(useCase) {
    const configs = {
      email_campaigns: {
        personalization_depth: 0.35,
        temporal_relevance: 0.25,
        psychological_resonance: 0.15,
        actionability: 0.20,
        trust_indicators: 0.05
      },
      content_curation: {
        interest_match: 0.25,
        temporal_relevance: 0.30,
        novelty: 0.20,
        actionability: 0.15,
        source_trust: 0.10
      },
      coaching_pipeline: {
        temporal_relevance: 0.35,
        actionability: 0.30,
        insight_density: 0.20,
        trust_indicators: 0.15
      },
      default: {
        interest_match: 0.25,
        temporal_relevance: 0.30,
        novelty: 0.20,
        actionability: 0.15,
        source_trust: 0.10
      }
    };
    configs.email_campaign = configs.email_campaigns; // Legacy alias
    return { ...configs[useCase] || configs.default };
  }

  updateWeights(newWeights) {
    this.weights = { ...this.weights, ...newWeights };
    this._normalizeWeights();
  }

  _normalizeWeights() {
    const sum = Object.values(this.weights).reduce((a, b) => a + b, 0);
    for (const key of Object.keys(this.weights)) {
      this.weights[key] /= sum;
    }
  }
}

// Outcome data structure
export const OutcomeDataSchema = {
  storyId: '',
  story: {},
  context: {},
  actualValue: 0,        // Actual business metric result
  baselineValue: 0,      // Baseline/control value
  metricType: '',
  timestamp: 0,
  dimensionScores: {},   // Scores for each dimension
  confidence: 0,
  metadata: {}
};

// New metric-driven scoring configurations
export const USE_CASE_CONFIGS = {
  email_campaigns: {
    targetMetrics: ['reply_rate', 'click_through_rate'],
    initialWeights: {
      personalization_depth: 0.35,
      temporal_relevance: 0.25,
      psychological_resonance: 0.15,
      actionability: 0.20,
      trust_indicators: 0.05
    }
  },
  content_curation: {
    targetMetrics: ['engagement_time', 'share_rate'],
    initialWeights: {
      interest_match: 0.25,
      temporal_relevance: 0.30,
      novelty: 0.20,
      actionability: 0.15,
      source_trust: 0.10
    }
  },
  sales_leads: {
    targetMetrics: ['conversion_rate', 'lead_quality'],
    initialWeights: {
      personalization_depth: 0.40,
      temporal_relevance: 0.20,
      psychological_resonance: 0.10,
      actionability: 0.25,
      trust_indicators: 0.05
    }
  },
  user_retention: {
    targetMetrics: ['retention_rate', 'churn_prevention'],
    initialWeights: {
      interest_match: 0.20,
      temporal_relevance: 0.35,
      novelty: 0.25,
      actionability: 0.15,
      source_trust: 0.05
    }
  },
  coaching_pipeline: {
    targetMetrics: ['behavior_change_rate', 'retention_rate'],
    initialWeights: {
      temporal_relevance: 0.35,
      actionability: 0.30,
      insight_density: 0.20,
      trust_indicators: 0.15
    }
  },
  survey_opinion: {
    targetMetrics: ['opinion_accuracy', 'prediction_correlation'],
    initialWeights: {
      interest_match: 0.10,
      belief_alignment: 0.40,
      preference_alignment: 0.20,
      identity_alignment: 0.20,
      temporal_relevance: 0.00,
      novelty: 0.00,
      actionability: 0.00,
      source_trust: 0.10
    }
  },
  preference_ranking: {
    targetMetrics: ['ranking_accuracy', 'recommendation_quality'],
    initialWeights: {
      preference_alignment: 0.60,
      interest_match: 0.25,
      temporal_relevance: 0.05,
      novelty: 0.05,
      actionability: 0.00,
      source_trust: 0.05
    }
  },
  deep_personalization: {
    targetMetrics: ['recommendation_quality', 'user_satisfaction'],
    initialWeights: {
      preference_alignment: 0.25,
      belief_alignment: 0.15,
      identity_alignment: 0.15,
      interest_match: 0.15,
      entity_affinity: 0.20,
      temporal_relevance: 0.00,
      novelty: 0.10,
      actionability: 0.00,
      source_trust: 0.00,
    }
  }
};
USE_CASE_CONFIGS.email_campaign = USE_CASE_CONFIGS.email_campaigns; // Legacy alias

export const ARC_SLOTS = {
  OPENER: 1,       // High energy, attention-grabbing
  BRIDGE: 2,       // Transition to substance
  DEEP_1: 3,       // First deep-dive
  DEEP_2: 4,       // Second deep-dive
  PIVOT: 5,        // Change of pace / surprise
  DEEP_3: 6,       // Third deep-dive
  PRACTICAL: 7,    // Actionable / how-to
  HORIZON: 8,      // Future-looking
  PERSONAL: 9,     // Close to home (local, relationships)
  CLOSER: 10       // Warm, human, memorable
};

// ─── METRIC-AGNOSTIC SCORING TYPES ─────────────────────────────────

/**
 * @typedef {Object} MetricConfigData
 * @property {string} startupId - Unique startup identifier
 * @property {string} useCase - Use case type (email_campaigns, content_curation, coaching_pipeline)
 * @property {string[]} primaryMetrics - Primary business metrics to optimize for
 * @property {string[]} secondaryMetrics - Secondary metrics to track
 * @property {Object} customMetrics - Custom metric definitions
 * @property {Object} weights - Initial dimension weights
 * @property {Object} thresholds - Performance thresholds
 * @property {number} learningRate - Rate of weight updates during calibration
 */

/**
 * @typedef {Object} OutcomeValidationData
 * @property {string} content_id - Content that was scored
 * @property {Object} dimension_scores - Original dimension scores
 * @property {Object} actual_metrics - Actual business results
 * @property {Object} baseline_metrics - Baseline/control metrics
 * @property {Object} metadata - Additional context
 * @property {number} timestamp - When outcome occurred
 */

/**
 * @typedef {Object} MetricPrediction
 * @property {number} expected_delta - Expected change in metric (0-1)
 * @property {number} confidence - Confidence in prediction (0-1)
 * @property {Array} contributing_dimensions - Top dimensions driving prediction
 */

/**
 * @typedef {Object} ScoredContentResult
 * @property {number} relevance_score - Composite score (0-1)
 * @property {Object} dimension_scores - All dimension scores
 * @property {Object} metric_predictions - Predictions for each target metric
 * @property {string} startup_id - Startup identifier
 * @property {string[]} target_metrics - Target metrics for this scoring
 * @property {number} calibration_confidence - Confidence in current calibration
 * @property {string} reasoning - Human-readable explanation
 */

// Extended metric types for the agnostic system
export const EXTENDED_METRIC_TYPES = {
  ...METRIC_TYPES,
  DWELL_TIME: 'dwell_time',
  SCROLL_DEPTH: 'scroll_depth',
  SHARE_RATE: 'share_rate',
  RETURN_FREQUENCY: 'return_frequency',
  SENTIMENT_SHIFT: 'sentiment_shift',
  VIDEO_COMPLETION_RATE: 'video_completion_rate',
  EMAIL_REPLY_RATE: 'email_reply_rate',
  SOCIAL_ENGAGEMENT: 'social_engagement',
  LEAD_QUALITY: 'lead_quality'
};

// Calibration status types
export const CALIBRATION_STATUS = {
  NOT_STARTED: 'not_started',
  LEARNING: 'learning',
  CALIBRATED: 'calibrated',
  NEEDS_MORE_DATA: 'needs_more_data',
  DEGRADED: 'degraded'
};

// Metric-agnostic use case configurations (extended)
/**
 * @typedef {Object} KGOverrides
 * @property {Array<{topic:string, value:string, confidence:number}>} beliefs
 * @property {Array<{category:string, value:string, strength:number}>} preferences
 * @property {Array<{role:string, value:string, salience:number}>} identities
 */

/**
 * @typedef {Object} UserClone
 * @property {string} id
 * @property {string} gap            - The knowledge gap this clone fills (question text)
 * @property {string} hypothesis     - Concrete hypothesis filling that gap (e.g. "Alex trains for ultra endurance")
 * @property {KGOverrides} kgOverrides - This clone's belief/preference/identity extensions to the base KG
 * @property {number} confidence     - 0–1, updated via Bayesian feedback
 * @property {Array<{signal:string, predicted:boolean, actual:boolean, correct:boolean}>} evaluations
 * @property {string|null} spawnedFrom - parent clone id if bred from a strong clone
 * @property {number} generation
 * @property {number} createdAt
 * @property {number} lastScoredAt
 * @property {'active'|'killed'} status
 */

/**
 * @typedef {Object} SynthesisTrait
 * @property {string} dimension  - e.g. "time_orientation", "effort_profile"
 * @property {string} value      - e.g. "compound", "peak_driven"
 * @property {number} weight     - 0-1, how strongly this trait applies
 */

/**
 * @typedef {Object} ConfidenceComponents
 * @property {number}  base_from_llm        - LLM-stated confidence for the trait
 * @property {number}  replication_bonus    - Bonus from cross-node reinforcement
 * @property {number}  contradiction_penalty - Penalty from contradicting evidence
 * @property {boolean} cross_domain         - Reinforcing nodes span >1 domain
 */

/**
 * @typedef {'single_node'|'trait_replication'|'contradiction'|'emergent_fusion'|'churn_pattern'} SynthesisOrigin
 *   - single_node: trait implied by exactly one node — low confidence by design
 *   - trait_replication: same trait implied by multiple nodes, optionally across domains
 *   - contradiction: same dimension, divergent values from disjoint node sets
 *   - emergent_fusion: gestalt pattern from K-way cross-domain sample; no single-node derivation
 *   - churn_pattern: the pattern IS the rate of slot reassignment — "serial pivoter"
 *     traits that live in the time series of invalidations, not the current snapshot
 */

/**
 * @typedef {Object} Synthesis
 * @property {string}   id                    - Stable record id
 * @property {string}   label                 - Short human handle (not the payload)
 * @property {SynthesisOrigin} origin
 * @property {SynthesisTrait}  trait
 * @property {string}   mechanics             - 2-4 sentences explaining WHY this pattern coheres
 * @property {string[]} reinforcing_nodes     - Node refs that support the trait (e.g. "belief:running")
 * @property {string[]} contradicting_nodes   - Node refs that undermine it (contradiction case only)
 * @property {string[]} domains_bridged       - Unique domains across reinforcing nodes
 * @property {boolean}  isolated              - True when only one node supports the trait
 * @property {number}   confidence            - Final composite confidence 0-1
 * @property {ConfidenceComponents} confidence_components
 * @property {string[]} affinities            - Content types that should match this pattern
 * @property {string[]} aversions             - Content types that should be deprioritized
 * @property {string[]} predictions           - Falsifiable observable behaviors
 * @property {boolean}  surprising            - Flagged as non-obvious (useful for ranking)
 * @property {string}   generated_at          - ISO timestamp
 * @property {string}   [model]               - LLM model id used
 * @property {string}   mode                  - Which engine mode emitted this ("trait_synthesis" | "fusion")
 */

export const EXTENDED_USE_CASE_CONFIGS = {
  ...USE_CASE_CONFIGS,
  ecommerce: {
    targetMetrics: ['revenue', 'conversion_rate', 'return_frequency'],
    initialWeights: {
      actionability: 0.40,
      trust_indicators: 0.25,
      personalization_depth: 0.20,
      temporal_relevance: 0.15
    }
  },
  media_platform: {
    targetMetrics: ['dwell_time', 'share_rate', 'return_frequency'],
    initialWeights: {
      insight_density: 0.35,
      interest_match: 0.25,
      social_proof: 0.20,
      novelty: 0.20
    }
  },
  saas_onboarding: {
    targetMetrics: ['behavior_change_rate', 'retention_rate'],
    initialWeights: {
      actionability: 0.45,
      temporal_relevance: 0.25,
      trust_indicators: 0.20,
      insight_density: 0.10
    }
  }
};
