/**
 * Pre-configured metric profiles for common use cases
 * Makes it easy to set up Marble for different business scenarios
 */

import { MetricConfiguration, METRIC_TYPES } from './types.js';
import { Scorer } from './scorer.js';

export const USE_CASE_PROFILES = {
  content_curation: {
    targetMetric: METRIC_TYPES.ENGAGEMENT_TIME,
    weights: {
      interest_match: 0.25,
      temporal_relevance: 0.30,
      novelty: 0.20,
      actionability: 0.15,
      source_trust: 0.10
    },
    description: 'Optimize for user engagement and retention',
    performanceThreshold: 0.25, // 25% improvement target
    learningRate: 0.08
  },

  email_campaigns: {
    targetMetric: METRIC_TYPES.REPLY_RATE,
    weights: {
      personalization_depth: 0.35,
      temporal_relevance: 0.25,
      psychological_resonance: 0.15,
      actionability: 0.20,
      trust_indicators: 0.05
    },
    description: 'Optimize for email response rates',
    performanceThreshold: 0.15, // 15% improvement target
    learningRate: 0.10
  },

  sales_leads: {
    targetMetric: METRIC_TYPES.CONVERSION,
    weights: {
      personalization_depth: 0.40,
      temporal_relevance: 0.20,
      psychological_resonance: 0.10,
      actionability: 0.25,
      trust_indicators: 0.05
    },
    description: 'Optimize for lead conversion',
    performanceThreshold: 0.20, // 20% improvement target
    learningRate: 0.12
  },

  user_retention: {
    targetMetric: METRIC_TYPES.RETENTION,
    weights: {
      interest_match: 0.20,
      temporal_relevance: 0.35,
      novelty: 0.25,
      actionability: 0.15,
      source_trust: 0.05
    },
    description: 'Optimize for user retention and churn prevention',
    performanceThreshold: 0.30, // 30% improvement target
    learningRate: 0.06
  },

  coaching_pipeline: {
    targetMetric: METRIC_TYPES.BEHAVIOR_CHANGE,
    weights: {
      temporal_relevance: 0.35,
      actionability: 0.30,
      insight_density: 0.20,
      trust_indicators: 0.15
    },
    description: 'Optimize for behavior change and coaching outcomes',
    performanceThreshold: 0.25,
    learningRate: 0.08
  },

  survey_opinion: {
    targetMetric: METRIC_TYPES.CUSTOM,
    weights: {
      interest_match: 0.10,
      belief_alignment: 0.40,
      preference_alignment: 0.20,
      identity_alignment: 0.20,
      temporal_relevance: 0.00,
      novelty: 0.00,
      actionability: 0.00,
      source_trust: 0.10
    },
    description: 'Optimize for opinion prediction using typed alignment components',
    performanceThreshold: 0.30,
    learningRate: 0.08
  },

  preference_ranking: {
    targetMetric: METRIC_TYPES.CUSTOM,
    weights: {
      preference_alignment: 0.60,
      interest_match: 0.25,
      temporal_relevance: 0.05,
      novelty: 0.05,
      actionability: 0.00,
      source_trust: 0.05
    },
    description: 'Optimize for MovieLens-style preference ranking',
    performanceThreshold: 0.25,
    learningRate: 0.10
  },

  movie_recommendation: {
    targetMetric: METRIC_TYPES.CUSTOM,
    weights: {
      preference_alignment: 0.25,
      belief_alignment: 0.15,
      identity_alignment: 0.10,
      interest_match: 0.10,
      entity_affinity: 0.25,
      temporal_relevance: 0.00,
      novelty: 0.10,
      actionability: 0.00,
      source_trust: 0.05
    },
    description: 'Optimize for movie recommendations using entity-attribute matching from secondary context',
    performanceThreshold: 0.15,
    learningRate: 0.10
  }
};

/**
 * Create a MetricConfiguration from a use case profile
 */
export function createProfileConfig(useCase) {
  const profile = USE_CASE_PROFILES[useCase];
  if (!profile) {
    throw new Error(`Unknown use case: ${useCase}. Available: ${Object.keys(USE_CASE_PROFILES).join(', ')}`);
  }

  const config = new MetricConfiguration(profile.targetMetric, useCase);
  config.updateWeights(profile.weights);
  config.performanceThreshold = profile.performanceThreshold;
  config.learningRate = profile.learningRate;

  return config;
}

/**
 * Factory for creating preconfigured scorers
 */
export function createScorerForUseCase(kg, useCase) {
  const config = createProfileConfig(useCase);
  return new Scorer(kg, config);
}

// Backward-compatibility alias (singular form)
export const USE_CASE_PROFILES_LEGACY = {
  ...USE_CASE_PROFILES,
  email_campaign: USE_CASE_PROFILES.email_campaigns  // Alias for backward compat
};

// Export for external integrations
export default USE_CASE_PROFILES;