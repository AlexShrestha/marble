/**
 * Synthetic Reasoner — Marble's Layer 2 inference engine
 *
 * Given 3+ real insights with confidence > threshold, generates hypotheses
 * about unobserved traits by cross-referencing insight patterns.
 *
 * Layer 1 (real): User goes to gym → "control-seeking behavior"
 * Layer 2 (synthetic): control-seeking + career change + kid →
 *   "will respond to content framed as protecting/providing,
 *    will avoid content about letting go"
 *
 * Synthetic insights carry lower confidence and testable predictions.
 * Confirmed predictions promote to real; contradictions demote/remove.
 */

// Reasoning rules: combinations of trait categories → synthetic hypotheses
// Each rule: { requires: [category patterns], emits: { hypothesis, category, predictions, avoidances } }
const REASONING_RULES = [
  {
    id: 'control_family',
    requires: ['control', 'family'],
    emits: {
      hypothesis: 'Responds to content framed as protecting/providing for loved ones',
      category: 'motivation-frame',
      predictions: ['protection', 'providing', 'security', 'family safety', 'legacy'],
      avoidances: ['letting go', 'surrender', 'acceptance of loss']
    }
  },
  {
    id: 'control_career',
    requires: ['control', 'career'],
    emits: {
      hypothesis: 'Prefers structured, predictable career advice over exploratory risk-taking',
      category: 'content-preference',
      predictions: ['roadmap', 'step-by-step', 'guaranteed', 'proven method', 'structured plan'],
      avoidances: ['leap of faith', 'go with the flow', 'embrace uncertainty']
    }
  },
  {
    id: 'ambition_insecurity',
    requires: ['ambition', 'insecurity'],
    emits: {
      hypothesis: 'Driven by fear of stagnation more than desire for success',
      category: 'motivation-driver',
      predictions: ['falling behind', 'competitive edge', 'stay ahead', 'dont miss out', 'level up'],
      avoidances: ['contentment', 'enough', 'slow down', 'be present']
    }
  },
  {
    id: 'health_control',
    requires: ['health', 'control'],
    emits: {
      hypothesis: 'Uses fitness/health as a control mechanism during uncertain times',
      category: 'coping-pattern',
      predictions: ['discipline', 'routine', 'optimization', 'tracking', 'measurable progress'],
      avoidances: ['intuitive', 'go easy', 'rest day', 'listen to your body']
    }
  },
  {
    id: 'social_insecurity',
    requires: ['social', 'insecurity'],
    emits: {
      hypothesis: 'Seeks social proof and validation before committing to decisions',
      category: 'decision-pattern',
      predictions: ['testimonial', 'reviews', 'community', 'others like you', 'proven'],
      avoidances: ['be the first', 'pioneer', 'trailblazer', 'uncharted']
    }
  },
  {
    id: 'ambition_family',
    requires: ['ambition', 'family'],
    emits: {
      hypothesis: 'Frames personal ambition through the lens of family duty',
      category: 'motivation-frame',
      predictions: ['for my family', 'better future', 'provide', 'role model', 'set an example'],
      avoidances: ['selfish goals', 'put yourself first', 'forget obligations']
    }
  },
  {
    id: 'creativity_insecurity',
    requires: ['creativity', 'insecurity'],
    emits: {
      hypothesis: 'Creative impulse suppressed by fear of judgment; responds to safe creative spaces',
      category: 'engagement-pattern',
      predictions: ['no wrong answer', 'creative freedom', 'experiment', 'private', 'judgment-free'],
      avoidances: ['share with everyone', 'public critique', 'competitive art']
    }
  },
  {
    id: 'financial_control',
    requires: ['financial', 'control'],
    emits: {
      hypothesis: 'Equates financial control with life control; budget disruption causes outsized stress',
      category: 'stress-trigger',
      predictions: ['budget', 'savings', 'financial plan', 'net worth', 'passive income'],
      avoidances: ['splurge', 'treat yourself', 'money is just money']
    }
  },
  {
    id: 'career_family',
    requires: ['career', 'family'],
    emits: {
      hypothesis: 'Experiences guilt about work-life balance; content addressing this resonates',
      category: 'emotional-hook',
      predictions: ['work-life balance', 'quality time', 'being present', 'guilt-free', 'integration'],
      avoidances: ['hustle culture', 'grind', 'sleep when youre dead']
    }
  },
  {
    id: 'health_ambition',
    requires: ['health', 'ambition'],
    emits: {
      hypothesis: 'Views health as performance optimization, not wellness',
      category: 'content-preference',
      predictions: ['peak performance', 'biohacking', 'optimize', 'edge', 'high performer'],
      avoidances: ['gentle', 'healing', 'self-care', 'recovery']
    }
  },
  {
    id: 'triple_control_career_family',
    requires: ['control', 'career', 'family'],
    emits: {
      hypothesis: 'Will respond strongly to content about building systems that run without them',
      category: 'deep-motivation',
      predictions: ['passive income', 'automation', 'delegation', 'systems', 'freedom'],
      avoidances: ['hands-on required', 'personal touch needed', 'irreplaceable']
    }
  },
  {
    id: 'triple_ambition_insecurity_social',
    requires: ['ambition', 'insecurity', 'social'],
    emits: {
      hypothesis: 'Compares self to peers obsessively; leaderboard/ranking content is catnip',
      category: 'engagement-pattern',
      predictions: ['ranking', 'top performers', 'percentile', 'benchmark', 'ahead of peers'],
      avoidances: ['everyone is on their own journey', 'comparison is the thief of joy']
    }
  }
];

/**
 * Categorize an insight's hypothesis text into trait categories
 * Uses keyword matching against the hypothesis and category fields
 */
function categorizeInsight(insight) {
  const text = `${insight.hypothesis || ''} ${insight.category || ''}`.toLowerCase();
  const categories = new Set();

  const categoryKeywords = {
    control: ['control', 'discipline', 'order', 'structure', 'routine', 'manage', 'plan'],
    family: ['family', 'child', 'kid', 'parent', 'spouse', 'partner', 'home'],
    career: ['career', 'job', 'work', 'professional', 'promotion', 'business', 'entrepreneur'],
    ambition: ['ambitio', 'goal', 'achieve', 'success', 'growth', 'advance', 'aspir'],
    insecurity: ['insecurity', 'fear', 'anxiety', 'worry', 'doubt', 'uncertain', 'imposter'],
    health: ['health', 'fitness', 'gym', 'exercise', 'diet', 'body', 'physical', 'workout'],
    social: ['social', 'community', 'peer', 'friend', 'network', 'belong', 'status'],
    creativity: ['creativ', 'art', 'design', 'invent', 'innovate', 'imagine', 'express'],
    financial: ['financ', 'money', 'invest', 'saving', 'wealth', 'income', 'budget']
  };

  for (const [category, keywords] of Object.entries(categoryKeywords)) {
    if (keywords.some(kw => text.includes(kw))) {
      categories.add(category);
    }
  }

  return [...categories];
}

export class SyntheticReasoner {
  /**
   * @param {Object} opts
   * @param {number} opts.confidenceThreshold - minimum confidence for input insights (default 0.4)
   * @param {number} opts.syntheticConfidenceBase - base confidence for generated synthetic insights (default 0.3)
   * @param {number} opts.promotionThreshold - confirmation count to promote synthetic → real (default 3)
   * @param {number} opts.demotionThreshold - contradiction count to remove (default 2)
   */
  constructor({
    confidenceThreshold = 0.4,
    syntheticConfidenceBase = 0.3,
    promotionThreshold = 3,
    demotionThreshold = 2
  } = {}) {
    this.confidenceThreshold = confidenceThreshold;
    this.syntheticConfidenceBase = syntheticConfidenceBase;
    this.promotionThreshold = promotionThreshold;
    this.demotionThreshold = demotionThreshold;
  }

  /**
   * Generate synthetic insights from a set of real insights.
   * Requires at least 3 qualifying insights (confidence > threshold).
   *
   * @param {Array} insights - real insights array from Clone
   * @returns {{ synthetic: Array, reasoning: Array }} - new synthetic insights + reasoning trace
   */
  reason(insights) {
    if (!Array.isArray(insights)) return { synthetic: [], reasoning: [] };

    // Filter to qualifying insights
    const qualifying = insights.filter(i =>
      !i.synthetic && i.confidence >= this.confidenceThreshold
    );

    if (qualifying.length < 3) {
      return {
        synthetic: [],
        reasoning: [{ note: `Need 3+ qualifying insights, have ${qualifying.length}` }]
      };
    }

    // Categorize each insight
    const insightCategories = qualifying.map(i => ({
      insight: i,
      categories: categorizeInsight(i)
    }));

    // Build a set of all present categories
    const presentCategories = new Set();
    for (const { categories } of insightCategories) {
      for (const c of categories) presentCategories.add(c);
    }

    // Match rules
    const results = [];
    const reasoning = [];

    for (const rule of REASONING_RULES) {
      const allRequired = rule.requires.every(req => presentCategories.has(req));
      if (!allRequired) continue;

      // Find source insights that contributed to this rule
      const sources = [];
      for (const req of rule.requires) {
        const matching = insightCategories
          .filter(ic => ic.categories.includes(req))
          .map(ic => ic.insight);
        sources.push(...matching);
      }

      // Deduplicate sources
      const uniqueSources = [...new Map(sources.map(s => [s.hypothesis, s])).values()];

      // Synthetic confidence = base * average confidence of sources
      const avgSourceConfidence = uniqueSources.reduce((sum, s) => sum + s.confidence, 0) / uniqueSources.length;
      const confidence = Math.min(0.7, this.syntheticConfidenceBase + (avgSourceConfidence * 0.3));

      const syntheticInsight = {
        hypothesis: rule.emits.hypothesis,
        confidence: Math.round(confidence * 100) / 100,
        category: rule.emits.category,
        predictions: rule.emits.predictions,
        avoidances: rule.emits.avoidances || [],
        synthetic: true,
        ruleId: rule.id,
        sourceInsights: uniqueSources.map(s => s.hypothesis),
        confirmations: 0,
        contradictions: 0,
        testable: rule.emits.predictions.map(p => ({
          prediction: `User engages more with content containing "${p}"`,
          tested: false,
          result: null
        }))
      };

      results.push(syntheticInsight);
      reasoning.push({
        rule: rule.id,
        matched: rule.requires,
        sources: uniqueSources.map(s => ({ hypothesis: s.hypothesis, confidence: s.confidence })),
        generated: rule.emits.hypothesis,
        assignedConfidence: syntheticInsight.confidence
      });
    }

    return { synthetic: results, reasoning };
  }

  /**
   * Process feedback on a synthetic insight.
   * Returns updated insight with potentially changed status.
   *
   * @param {Object} syntheticInsight - a synthetic insight to update
   * @param {boolean} confirmed - true if content test confirmed the prediction
   * @returns {{ insight: Object, action: 'keep'|'promote'|'demote' }}
   */
  processFeedback(syntheticInsight, confirmed) {
    const updated = { ...syntheticInsight };

    if (confirmed) {
      updated.confirmations = (updated.confirmations || 0) + 1;
      // Boost confidence slightly on confirmation
      updated.confidence = Math.min(0.95, updated.confidence + 0.05);

      if (updated.confirmations >= this.promotionThreshold) {
        // Promote to real insight
        updated.synthetic = false;
        updated.promotedAt = new Date().toISOString();
        updated.promotedFrom = 'synthetic';
        return { insight: updated, action: 'promote' };
      }
    } else {
      updated.contradictions = (updated.contradictions || 0) + 1;
      // Drop confidence on contradiction
      updated.confidence = Math.max(0.05, updated.confidence - 0.1);

      if (updated.contradictions >= this.demotionThreshold) {
        return { insight: updated, action: 'demote' };
      }
    }

    return { insight: updated, action: 'keep' };
  }

  /**
   * Merge synthetic insights into an existing insight array.
   * Avoids duplicates by ruleId. Returns combined array.
   *
   * @param {Array} existingInsights - current insights (real + synthetic)
   * @param {Array} newSynthetics - newly generated synthetic insights
   * @returns {Array} merged insights
   */
  merge(existingInsights, newSynthetics) {
    const existing = [...(existingInsights || [])];
    const existingRuleIds = new Set(
      existing.filter(i => i.ruleId).map(i => i.ruleId)
    );

    for (const synth of newSynthetics) {
      if (!existingRuleIds.has(synth.ruleId)) {
        existing.push(synth);
        existingRuleIds.add(synth.ruleId);
      }
    }

    return existing;
  }

  /**
   * Run a full reasoning cycle on a clone's insights:
   * 1. Filter real insights
   * 2. Generate synthetics
   * 3. Merge into clone's insight array
   *
   * @param {Object} clone - a Clone instance (or plain object with .insights)
   * @returns {{ clone: Object, added: number, reasoning: Array }}
   */
  augment(clone) {
    const insights = clone.insights || [];
    const { synthetic, reasoning } = this.reason(insights);

    if (synthetic.length === 0) {
      return { clone, added: 0, reasoning };
    }

    const merged = this.merge(insights, synthetic);
    clone.insights = merged;

    return {
      clone,
      added: synthetic.length,
      reasoning
    };
  }
}

export { categorizeInsight, REASONING_RULES };
