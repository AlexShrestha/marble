/**
 * Pluggable Metric Configuration System
 *
 * Allows startups to define custom success metrics and automatically tune
 * scoring weights against those metrics through calibration.
 */

import { USE_CASE_CONFIGS, METRIC_TYPES } from '../types.js';

export class PluggableMetricConfig {
  constructor() {
    this.registeredMetrics = new Map();
    this.customUseCases = new Map();
    this.metricValidators = new Map();
    this.normalizationFunctions = new Map();

    // Initialize standard metrics
    this.initializeStandardMetrics();
  }

  /**
   * Initialize standard business metrics
   */
  initializeStandardMetrics() {
    const standardMetrics = [
      {
        name: 'reply_rate',
        displayName: 'Reply Rate',
        description: 'Email reply rate metric',
        type: METRIC_TYPES.REPLY_RATE,
        unit: 'percentage',
        min_value: 0,
        max_value: 1,
        dimension_correlations: {
          personalization_depth: 0.35,
          temporal_relevance: 0.25,
          psychological_resonance: 0.15,
          actionability: 0.20,
          trust_indicators: 0.15
        }
      },
      {
        name: 'click_through_rate',
        displayName: 'Click Through Rate',
        description: 'Click through rate metric',
        type: METRIC_TYPES.CLICK_THROUGH_RATE,
        unit: 'percentage',
        min_value: 0,
        max_value: 1,
        dimension_correlations: {
          personalization_depth: 0.30,
          temporal_relevance: 0.20,
          psychological_resonance: 0.25,
          actionability: 0.35,
          trust_indicators: 0.10
        }
      },
      {
        name: 'conversion_rate',
        displayName: 'Conversion Rate',
        description: 'Conversion rate metric',
        type: METRIC_TYPES.CONVERSION,
        unit: 'percentage',
        min_value: 0,
        max_value: 1,
        dimension_correlations: {
          personalization_depth: 0.40,
          temporal_relevance: 0.20,
          psychological_resonance: 0.20,
          actionability: 0.30,
          trust_indicators: 0.25
        }
      },
      {
        name: 'revenue',
        displayName: 'Revenue',
        description: 'Revenue metric',
        type: METRIC_TYPES.REVENUE,
        unit: 'currency',
        min_value: 0,
        max_value: null,
        dimension_correlations: {
          personalization_depth: 0.35,
          temporal_relevance: 0.25,
          psychological_resonance: 0.20,
          actionability: 0.25,
          trust_indicators: 0.30
        }
      }
    ];

    standardMetrics.forEach(metric => {
      this.registeredMetrics.set(metric.name, {
        ...metric,
        registered_at: Date.now()
      });
    });
  }

  /**
   * Register a custom business metric
   */
  registerCustomMetric(metricDefinition) {
    const {
      name,
      displayName,
      description,
      type = METRIC_TYPES.CUSTOM,
      unit = 'percentage',
      higher_is_better = true,
      baseline_calculation = 'average',
      min_value = 0,
      max_value = null,
      validation_function = null,
      normalization_function = null,
      dimension_correlations = {},
      metadata = {}
    } = metricDefinition;

    if (!name || typeof name !== 'string') {
      throw new Error('Metric name is required and must be a string');
    }

    const metric = {
      name,
      displayName: displayName || name,
      description,
      type,
      unit,
      higher_is_better,
      baseline_calculation,
      min_value,
      max_value,
      dimension_correlations,
      metadata,
      registered_at: Date.now()
    };

    // Store validation function if provided
    if (validation_function && typeof validation_function === 'function') {
      this.metricValidators.set(name, validation_function);
    }

    // Store normalization function if provided
    if (normalization_function && typeof normalization_function === 'function') {
      this.normalizationFunctions.set(name, normalization_function);
    }

    this.registeredMetrics.set(name, metric);

    return {
      success: true,
      metric_id: name,
      message: `Custom metric '${displayName}' registered successfully`
    };
  }

  /**
   * Create a custom use case configuration
   */
  createCustomUseCase(useCaseDefinition) {
    const {
      name,
      displayName,
      description,
      primaryMetrics = [],
      secondaryMetrics = [],
      dimensionWeights = {},
      contentRequirements = [],
      validationRules = [],
      metadata = {}
    } = useCaseDefinition;

    if (!name || !primaryMetrics.length) {
      throw new Error('Use case name and at least one primary metric are required');
    }

    // Validate that all metrics are registered
    const allMetrics = [...primaryMetrics, ...secondaryMetrics];
    for (const metric of allMetrics) {
      if (!this.registeredMetrics.has(metric) && !Object.values(METRIC_TYPES).includes(metric)) {
        throw new Error(`Metric '${metric}' is not registered. Register it first with registerCustomMetric()`);
      }
    }

    // Generate initial weights based on dimension correlations
    const computedWeights = this.computeInitialWeights(primaryMetrics, secondaryMetrics, dimensionWeights);

    const useCase = {
      name,
      displayName: displayName || name,
      description,
      primaryMetrics,
      secondaryMetrics,
      targetMetrics: [...primaryMetrics, ...secondaryMetrics], // For compatibility
      initialWeights: computedWeights,
      contentRequirements,
      validationRules,
      metadata,
      created_at: Date.now()
    };

    this.customUseCases.set(name, useCase);

    return {
      success: true,
      useCase: name,
      primaryMetrics,
      secondaryMetrics,
      initialWeights: computedWeights,
      message: `Custom use case '${displayName}' created successfully`
    };
  }

  /**
   * Compute initial weights based on metric correlations
   */
  computeInitialWeights(primaryMetrics, secondaryMetrics, manualWeights = {}) {
    const dimensions = [
      'personalization_depth', 'temporal_relevance', 'psychological_resonance',
      'actionability', 'trust_indicators', 'insight_density', 'social_proof',
      'interest_match', 'novelty', 'source_trust'
    ];

    const weights = {};

    // Initialize with equal weights
    for (const dimension of dimensions) {
      weights[dimension] = 1 / dimensions.length;
    }

    // Apply correlations from registered metrics
    const allMetrics = [...primaryMetrics, ...secondaryMetrics];
    const correlationSum = {};
    const correlationCount = {};

    for (const metricName of allMetrics) {
      const metric = this.registeredMetrics.get(metricName);
      if (metric?.dimension_correlations) {
        for (const [dimension, correlation] of Object.entries(metric.dimension_correlations)) {
          if (dimensions.includes(dimension)) {
            correlationSum[dimension] = (correlationSum[dimension] || 0) + correlation;
            correlationCount[dimension] = (correlationCount[dimension] || 0) + 1;
          }
        }
      }
    }

    // Compute correlation-based weights
    for (const dimension of dimensions) {
      if (correlationCount[dimension] > 0) {
        const avgCorrelation = correlationSum[dimension] / correlationCount[dimension];
        // Scale correlation to positive weight (0.05 to 0.5)
        weights[dimension] = Math.max(0.05, Math.min(0.5, 0.2 + avgCorrelation * 0.3));
      }
    }

    // Apply manual overrides
    for (const [dimension, weight] of Object.entries(manualWeights)) {
      if (dimensions.includes(dimension) && typeof weight === 'number' && weight >= 0) {
        weights[dimension] = weight;
      }
    }

    // Normalize weights to sum to 1
    const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
    for (const dimension of dimensions) {
      weights[dimension] = weights[dimension] / totalWeight;
    }

    return weights;
  }

  /**
   * Validate metric value using custom validator
   */
  validateMetricValue(metricName, value, context = {}) {
    const metric = this.registeredMetrics.get(metricName);
    if (!metric) {
      return { valid: false, error: `Unknown metric: ${metricName}` };
    }

    // Basic range validation
    if (typeof value !== 'number' || isNaN(value)) {
      return { valid: false, error: 'Metric value must be a number' };
    }

    if (value < metric.min_value) {
      return { valid: false, error: `Value ${value} below minimum ${metric.min_value}` };
    }

    if (metric.max_value !== null && value > metric.max_value) {
      return { valid: false, error: `Value ${value} exceeds maximum ${metric.max_value}` };
    }

    // Custom validation
    const validator = this.metricValidators.get(metricName);
    if (validator) {
      try {
        const customResult = validator(value, context);
        if (customResult !== true && customResult?.valid !== true) {
          return { valid: false, error: customResult?.error || 'Custom validation failed' };
        }
      } catch (error) {
        return { valid: false, error: `Validation error: ${error.message}` };
      }
    }

    return { valid: true };
  }

  /**
   * Normalize metric value using custom normalizer
   */
  normalizeMetricValue(metricName, value, context = {}) {
    const normalizer = this.normalizationFunctions.get(metricName);
    if (normalizer) {
      try {
        return normalizer(value, context);
      } catch (error) {
        console.warn(`Normalization failed for ${metricName}: ${error.message}`);
        return value;
      }
    }
    return value;
  }

  /**
   * Get configuration for use case (including custom ones)
   */
  getUseCaseConfig(useCaseName) {
    // Check custom use cases first
    if (this.customUseCases.has(useCaseName)) {
      return this.customUseCases.get(useCaseName);
    }

    // Fallback to standard configurations
    return USE_CASE_CONFIGS[useCaseName] || null;
  }

  /**
   * List all available metrics (standard + custom)
   */
  getAvailableMetrics() {
    const standardMetrics = Object.values(METRIC_TYPES).map(type => ({
      name: type,
      type: 'standard',
      description: `Standard ${type.replace('_', ' ')} metric`
    }));

    const customMetrics = Array.from(this.registeredMetrics.values()).map(metric => ({
      name: metric.name,
      displayName: metric.displayName,
      type: 'custom',
      description: metric.description,
      unit: metric.unit,
      registered_at: new Date(metric.registered_at).toISOString()
    }));

    return {
      standard: standardMetrics,
      custom: customMetrics,
      total: standardMetrics.length + customMetrics.length
    };
  }

  /**
   * List all available use cases (standard + custom)
   */
  getAvailableUseCases() {
    const standardUseCases = Object.keys(USE_CASE_CONFIGS).map(name => ({
      name,
      type: 'standard',
      targetMetrics: USE_CASE_CONFIGS[name].targetMetrics || []
    }));

    const customUseCases = Array.from(this.customUseCases.values()).map(useCase => ({
      name: useCase.name,
      displayName: useCase.displayName,
      type: 'custom',
      primaryMetrics: useCase.primaryMetrics,
      secondaryMetrics: useCase.secondaryMetrics,
      created_at: new Date(useCase.created_at).toISOString()
    }));

    return {
      standard: standardUseCases,
      custom: customUseCases,
      total: standardUseCases.length + customUseCases.length
    };
  }

  /**
   * Export configuration for persistence
   */
  exportConfiguration() {
    return {
      registeredMetrics: Array.from(this.registeredMetrics.entries()),
      customUseCases: Array.from(this.customUseCases.entries()),
      exportedAt: Date.now(),
      version: '1.0'
    };
  }

  /**
   * Import configuration from persistence
   */
  importConfiguration(config) {
    if (config.registeredMetrics) {
      this.registeredMetrics = new Map(config.registeredMetrics);
    }

    if (config.customUseCases) {
      this.customUseCases = new Map(config.customUseCases);
    }

    return {
      success: true,
      metricsImported: this.registeredMetrics.size,
      useCasesImported: this.customUseCases.size,
      importedAt: Date.now()
    };
  }

  /**
   * Create quick-start configuration for common business models
   */
  createQuickStartConfig(businessModel) {
    const quickStartConfigs = {
      saas_b2b: {
        metrics: [
          { name: 'trial_conversion_rate', displayName: 'Trial Conversion Rate', type: METRIC_TYPES.CONVERSION },
          { name: 'feature_adoption_rate', displayName: 'Feature Adoption Rate', type: METRIC_TYPES.BEHAVIOR_CHANGE },
          { name: 'monthly_retention_rate', displayName: 'Monthly Retention', type: METRIC_TYPES.RETENTION }
        ],
        useCase: {
          name: 'saas_b2b_growth',
          displayName: 'SaaS B2B Growth',
          description: 'Optimize content for B2B SaaS user engagement and conversion',
          primaryMetrics: ['trial_conversion_rate'],
          secondaryMetrics: ['feature_adoption_rate', 'monthly_retention_rate']
        }
      },
      ecommerce: {
        metrics: [
          { name: 'purchase_conversion_rate', displayName: 'Purchase Conversion', type: METRIC_TYPES.CONVERSION },
          { name: 'average_order_value', displayName: 'Average Order Value', type: METRIC_TYPES.REVENUE },
          { name: 'cart_abandonment_rate', displayName: 'Cart Abandonment', type: METRIC_TYPES.BEHAVIOR_CHANGE }
        ],
        useCase: {
          name: 'ecommerce_optimization',
          displayName: 'E-commerce Optimization',
          description: 'Optimize content for e-commerce conversion and revenue',
          primaryMetrics: ['purchase_conversion_rate', 'average_order_value'],
          secondaryMetrics: ['cart_abandonment_rate']
        }
      },
      content_platform: {
        metrics: [
          { name: 'daily_active_users', displayName: 'Daily Active Users', type: METRIC_TYPES.ENGAGEMENT_TIME },
          { name: 'content_sharing_rate', displayName: 'Content Sharing Rate', type: METRIC_TYPES.BEHAVIOR_CHANGE },
          { name: 'session_duration', displayName: 'Session Duration', type: METRIC_TYPES.ENGAGEMENT_TIME }
        ],
        useCase: {
          name: 'content_engagement',
          displayName: 'Content Platform Engagement',
          description: 'Optimize content for user engagement and platform growth',
          primaryMetrics: ['daily_active_users'],
          secondaryMetrics: ['content_sharing_rate', 'session_duration']
        }
      }
    };

    const config = quickStartConfigs[businessModel];
    if (!config) {
      throw new Error(`Unknown business model: ${businessModel}`);
    }

    // Register metrics
    const registeredMetrics = [];
    for (const metric of config.metrics) {
      const result = this.registerCustomMetric(metric);
      registeredMetrics.push(result);
    }

    // Create use case
    const useCaseResult = this.createCustomUseCase(config.useCase);

    return {
      success: true,
      businessModel,
      metricsRegistered: registeredMetrics.length,
      useCase: useCaseResult,
      message: `Quick-start configuration for '${businessModel}' created successfully`
    };
  }
}
