/**
 * Metric-Agnostic Configuration for Prism Scorer
 *
 * Allows startups to define their success metrics and auto-tune scoring weights.
 */

export const METRIC_TYPES = {
  ENGAGEMENT: 'engagement_time',
  CONVERSION: 'conversion_rate',
  REVENUE: 'revenue',
  RETENTION: 'retention_rate',
  SHARE: 'share_rate',
  CLICK_THROUGH: 'click_through_rate',
  REPLY_RATE: 'reply_rate',
  SENTIMENT: 'sentiment_shift',
  SCROLL_DEPTH: 'scroll_depth',
  RETURN_FREQUENCY: 'return_frequency'
};

export const USE_CASE_CONFIGS = {
  content_curation: {
    useCase: 'content_curation',
    targetMetrics: ['engagement_time', 'share_rate'],
    initialWeights: {
      interest_match: 0.25,
      temporal_relevance: 0.30,
      novelty: 0.20,
      actionability: 0.15,
      source_trust: 0.10
    },
    description: 'VIVO content curation (backward compatible)'
  },
  email_campaign: {
    useCase: 'email_campaign',
    targetMetrics: ['reply_rate', 'click_through_rate'],
    initialWeights: {
      interest_match: 0.35,
      temporal_relevance: 0.25,
      novelty: 0.15,
      actionability: 0.20,
      source_trust: 0.05
    },
    description: 'Email campaign optimization'
  },
  ecommerce: {
    useCase: 'ecommerce',
    targetMetrics: ['conversion_rate', 'revenue'],
    initialWeights: {
      interest_match: 0.40,
      temporal_relevance: 0.20,
      novelty: 0.15,
      actionability: 0.20,
      source_trust: 0.05
    },
    description: 'E-commerce conversion optimization'
  },
  retention: {
    useCase: 'retention',
    targetMetrics: ['retention_rate', 'return_frequency'],
    initialWeights: {
      interest_match: 0.30,
      temporal_relevance: 0.25,
      novelty: 0.25,
      actionability: 0.15,
      source_trust: 0.05
    },
    description: 'User retention optimization'
  }
};

export class MetricConfig {
  constructor(useCase = 'content_curation') {
    this.useCase = useCase;
    this.config = USE_CASE_CONFIGS[useCase] || USE_CASE_CONFIGS.content_curation;
    this.customMetrics = new Map();
  }

  getTargetMetrics() {
    return this.config.targetMetrics;
  }

  getInitialWeights() {
    return { ...this.config.initialWeights };
  }

  registerCustomMetric(metricDefinition) {
    const { name, type, normalize, validate } = metricDefinition;
    this.customMetrics.set(name, {
      type,
      normalize: normalize || ((value) => Math.max(0, Math.min(1, value))),
      validate: validate || ((value) => typeof value === 'number' && value >= 0)
    });
    return { success: true, metric: name };
  }

  validateMetricValue(metricName, value, context = {}) {
    const metric = this.customMetrics.get(metricName);
    if (metric && metric.validate) {
      try {
        const isValid = metric.validate(value, context);
        return { valid: isValid, error: isValid ? null : 'Validation failed' };
      } catch (error) {
        return { valid: false, error: error.message };
      }
    }

    // Default validation
    return {
      valid: typeof value === 'number' && value >= 0,
      error: typeof value !== 'number' || value < 0 ? 'Must be non-negative number' : null
    };
  }

  normalizeMetricValue(metricName, value, context = {}) {
    const metric = this.customMetrics.get(metricName);
    if (metric && metric.normalize) {
      return metric.normalize(value, context);
    }

    // Default normalization based on metric type
    if (metricName.includes('rate') || metricName.includes('ratio')) {
      return Math.max(0, Math.min(1, value));
    }
    if (metricName === 'revenue') {
      return Math.max(0, value / 10000); // Normalize to $10k scale
    }
    if (metricName.includes('time')) {
      return Math.max(0, Math.min(1, value / 300)); // Normalize to 5min scale
    }

    return Math.max(0, Math.min(1, value));
  }

  createCustomUseCase(definition) {
    const { name, targetMetrics, initialWeights, description } = definition;
    USE_CASE_CONFIGS[name] = {
      useCase: name,
      targetMetrics,
      initialWeights,
      description
    };
    return { success: true, useCase: name };
  }

  exportConfiguration() {
    return {
      useCase: this.useCase,
      config: this.config,
      customMetrics: Array.from(this.customMetrics.entries()),
      availableUseCases: Object.keys(USE_CASE_CONFIGS),
      exportedAt: new Date().toISOString()
    };
  }
}