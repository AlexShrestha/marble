/**
 * archetype-generator.js — Marble Archetype Generator
 *
 * Bootstraps user models from minimal data by generating behavioral templates
 * that fill gaps with statistically likely traits.
 *
 * When a person has very limited data (e.g., "Alex has a daughter"),
 * the archetype generator produces a full profile with confidence scores,
 * synthetic traits tagged as testable predictions, and KG-compatible insights.
 *
 * Archetypes start at low confidence and improve as signals confirm/deny traits.
 */

// ─── ARCHETYPE TEMPLATES ──────────────────────────────────────────────────────

const ARCHETYPE_TEMPLATES = {
  'parent-child-daughter': {
    label: 'Parent-Child (Daughter)',
    baseTraits: {
      relationship: 'parent-child',
      gender: 'female',
    },
    ageStages: [
      {
        range: [0, 2], label: 'infant',
        interests: ['sensory play', 'sleep routines', 'feeding'],
        needs: ['constant supervision', 'comfort objects', 'routine stability'],
        attentionSpan: 'minutes',
        communicationStyle: 'non-verbal',
      },
      {
        range: [3, 5], label: 'preschool',
        interests: ['pretend play', 'drawing', 'stories', 'animals', 'music'],
        needs: ['structured play', 'social skills development', 'emotional vocabulary'],
        attentionSpan: '10-15 minutes',
        communicationStyle: 'developing verbal',
      },
      {
        range: [6, 11], label: 'school-age',
        interests: ['reading', 'sports', 'crafts', 'friendships', 'games'],
        needs: ['homework support', 'peer acceptance', 'growing independence'],
        attentionSpan: '20-30 minutes',
        communicationStyle: 'conversational',
      },
      {
        range: [12, 17], label: 'teenager',
        interests: ['social media', 'music', 'friends', 'identity exploration', 'fashion'],
        needs: ['privacy', 'autonomy', 'emotional support without intrusion'],
        attentionSpan: 'variable, interest-dependent',
        communicationStyle: 'selective, peer-oriented',
      },
      {
        range: [18, 25], label: 'young-adult',
        interests: ['career exploration', 'relationships', 'self-discovery', 'travel'],
        needs: ['guidance without control', 'financial literacy', 'emotional support'],
        attentionSpan: 'self-directed',
        communicationStyle: 'adult peer',
      },
    ],
    parentImpact: {
      timeCommitment: 'high',
      emotionalLoad: 'high',
      decisionInfluence: 'major life decisions affected',
      contentRelevance: ['parenting', 'education', 'child development', 'family activities'],
    },
  },

  'parent-child-son': {
    label: 'Parent-Child (Son)',
    baseTraits: {
      relationship: 'parent-child',
      gender: 'male',
    },
    ageStages: [
      {
        range: [0, 2], label: 'infant',
        interests: ['sensory play', 'movement', 'feeding'],
        needs: ['constant supervision', 'comfort objects', 'routine stability'],
        attentionSpan: 'minutes',
        communicationStyle: 'non-verbal',
      },
      {
        range: [3, 5], label: 'preschool',
        interests: ['building', 'vehicles', 'outdoor play', 'stories', 'animals'],
        needs: ['structured play', 'physical activity', 'emotional vocabulary'],
        attentionSpan: '10-15 minutes',
        communicationStyle: 'developing verbal',
      },
      {
        range: [6, 11], label: 'school-age',
        interests: ['sports', 'gaming', 'science', 'building', 'friendships'],
        needs: ['homework support', 'physical outlets', 'growing independence'],
        attentionSpan: '20-30 minutes',
        communicationStyle: 'conversational',
      },
      {
        range: [12, 17], label: 'teenager',
        interests: ['gaming', 'sports', 'music', 'social media', 'identity exploration'],
        needs: ['privacy', 'autonomy', 'mentorship', 'emotional support'],
        attentionSpan: 'variable, interest-dependent',
        communicationStyle: 'selective, peer-oriented',
      },
      {
        range: [18, 25], label: 'young-adult',
        interests: ['career exploration', 'relationships', 'fitness', 'independence'],
        needs: ['guidance without control', 'financial literacy', 'purpose finding'],
        attentionSpan: 'self-directed',
        communicationStyle: 'adult peer',
      },
    ],
    parentImpact: {
      timeCommitment: 'high',
      emotionalLoad: 'high',
      decisionInfluence: 'major life decisions affected',
      contentRelevance: ['parenting', 'education', 'child development', 'family activities'],
    },
  },

  'partner': {
    label: 'Romantic Partner',
    baseTraits: {
      relationship: 'partner',
    },
    defaultTraits: {
      interests: ['shared experiences', 'communication', 'future planning'],
      needs: ['quality time', 'emotional support', 'mutual respect'],
      communicationStyle: 'intimate, daily',
      attentionPattern: 'consistent, priority',
    },
    subjectImpact: {
      timeCommitment: 'very high',
      emotionalLoad: 'very high',
      decisionInfluence: 'co-decision maker',
      contentRelevance: ['relationships', 'date ideas', 'communication', 'shared hobbies'],
    },
  },

  'colleague': {
    label: 'Work Colleague',
    baseTraits: {
      relationship: 'colleague',
    },
    defaultTraits: {
      interests: ['professional development', 'industry trends', 'team dynamics'],
      needs: ['clear communication', 'reliability', 'professional boundaries'],
      communicationStyle: 'professional, work-hours',
      attentionPattern: 'work-context only',
    },
    subjectImpact: {
      timeCommitment: 'medium',
      emotionalLoad: 'low-medium',
      decisionInfluence: 'work decisions',
      contentRelevance: ['industry news', 'productivity', 'team management'],
    },
  },

  'friend': {
    label: 'Close Friend',
    baseTraits: {
      relationship: 'friend',
    },
    defaultTraits: {
      interests: ['shared hobbies', 'social events', 'mutual support'],
      needs: ['reciprocity', 'trust', 'fun'],
      communicationStyle: 'casual, variable frequency',
      attentionPattern: 'intermittent but meaningful',
    },
    subjectImpact: {
      timeCommitment: 'medium',
      emotionalLoad: 'medium',
      decisionInfluence: 'social decisions',
      contentRelevance: ['social events', 'shared interests', 'gift ideas'],
    },
  },

  'parent': {
    label: 'Parent (of subject)',
    baseTraits: {
      relationship: 'parent-of-subject',
    },
    defaultTraits: {
      interests: ['health', 'family news', 'grandchildren', 'nostalgia'],
      needs: ['regular contact', 'feeling valued', 'health support'],
      communicationStyle: 'traditional, regular check-ins',
      attentionPattern: 'consistent, routine-based',
    },
    subjectImpact: {
      timeCommitment: 'medium',
      emotionalLoad: 'high',
      decisionInfluence: 'values and major decisions',
      contentRelevance: ['family', 'health', 'aging', 'holidays'],
    },
  },

  'sibling': {
    label: 'Sibling',
    baseTraits: {
      relationship: 'sibling',
    },
    defaultTraits: {
      interests: ['family events', 'shared history', 'mutual support'],
      needs: ['connection', 'acceptance', 'shared responsibility for parents'],
      communicationStyle: 'casual, event-driven',
      attentionPattern: 'periodic, deepens during events',
    },
    subjectImpact: {
      timeCommitment: 'low-medium',
      emotionalLoad: 'medium',
      decisionInfluence: 'family decisions',
      contentRelevance: ['family events', 'shared memories', 'parent care'],
    },
  },
};

// ─── AGE ESTIMATION FROM CONTEXT ──────────────────────────────────────────────

const AGE_SIGNAL_PATTERNS = [
  { pattern: /(?:baby|infant|newborn)/i, ageRange: [0, 1] },
  { pattern: /(?:toddler|daycare)/i, ageRange: [1, 3] },
  { pattern: /(?:preschool|kindergarten|pre-k)/i, ageRange: [3, 5] },
  { pattern: /(?:elementary|grade school|first grade|second grade)/i, ageRange: [6, 10] },
  { pattern: /(?:middle school|tween)/i, ageRange: [11, 13] },
  { pattern: /(?:high school|teen|teenager|driving)/i, ageRange: [14, 17] },
  { pattern: /(?:college|university|dorm)/i, ageRange: [18, 22] },
  { pattern: /(?:soccer|ballet|gymnastics|piano lessons)/i, ageRange: [4, 12] },
  { pattern: /(?:prom|SAT|ACT|graduation)/i, ageRange: [16, 18] },
  { pattern: /(?:dating|boyfriend|girlfriend)/i, ageRange: [14, 25] },
];

function estimateAgeFromContext(contextSignals = []) {
  const ranges = [];

  for (const signal of contextSignals) {
    if (typeof signal !== 'string') continue;
    for (const { pattern, ageRange } of AGE_SIGNAL_PATTERNS) {
      if (pattern.test(signal)) {
        ranges.push(ageRange);
      }
    }
  }

  if (ranges.length === 0) return null;

  // Intersect ranges to narrow estimate
  let low = Math.max(...ranges.map(r => r[0]));
  let high = Math.min(...ranges.map(r => r[1]));

  // If ranges don't overlap, take the average bounds
  if (low > high) {
    low = Math.round(ranges.reduce((s, r) => s + r[0], 0) / ranges.length);
    high = Math.round(ranges.reduce((s, r) => s + r[1], 0) / ranges.length);
  }

  return { low, high, mid: Math.round((low + high) / 2), signalCount: ranges.length };
}

// ─── ARCHETYPE GENERATOR ──────────────────────────────────────────────────────

/**
 * Generate a full archetype profile from minimal facts.
 *
 * @param {object} facts - Minimal known facts
 * @param {string} facts.relationshipType - e.g. 'daughter', 'son', 'partner', 'colleague', 'friend', 'parent', 'sibling'
 * @param {number[]} [facts.ageRange] - [low, high] estimated age, e.g. [6, 10]
 * @param {string[]} [facts.mentionedInterests] - Any interests explicitly mentioned
 * @param {string[]} [facts.contextSignals] - Raw context strings for age estimation
 * @param {string} [facts.name] - Name if known
 * @param {object} [facts.extraFacts] - Any additional known facts
 * @returns {object} Full archetype profile with confidence scores
 */
export function generateArchetype(facts) {
  const {
    relationshipType,
    ageRange: explicitAgeRange,
    mentionedInterests = [],
    contextSignals = [],
    name,
    extraFacts = {},
  } = facts;

  // Resolve template
  const templateKey = resolveTemplateKey(relationshipType);
  const template = ARCHETYPE_TEMPLATES[templateKey];

  if (!template) {
    return {
      error: `Unknown relationship type: ${relationshipType}`,
      availableTypes: Object.keys(ARCHETYPE_TEMPLATES),
    };
  }

  // Estimate age
  const contextAge = estimateAgeFromContext(contextSignals);
  const ageEstimate = explicitAgeRange
    ? { low: explicitAgeRange[0], high: explicitAgeRange[1], mid: Math.round((explicitAgeRange[0] + explicitAgeRange[1]) / 2), signalCount: 0 }
    : contextAge;

  // Get developmental stage for parent-child archetypes
  let stage = null;
  if (template.ageStages && ageEstimate) {
    stage = template.ageStages.find(s =>
      ageEstimate.mid >= s.range[0] && ageEstimate.mid <= s.range[1]
    );
  }

  // If no age estimate but has age stages, default to school-age (most common query)
  if (template.ageStages && !stage) {
    stage = template.ageStages.find(s => s.label === 'school-age') || template.ageStages[2];
  }

  // Build trait profile
  const traits = buildTraitProfile(template, stage, mentionedInterests, extraFacts);

  // Calculate confidence scores
  const confidenceScores = calculateConfidence(facts, stage);

  // Generate KG-compatible insights
  const insights = generateInsights(template, traits, confidenceScores, facts);

  // Build the archetype
  const archetype = {
    id: `archetype_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    templateKey,
    label: template.label,
    name: name || null,

    // Core profile
    relationship: template.baseTraits.relationship,
    ageEstimate: ageEstimate || { low: null, high: null, mid: null, signalCount: 0 },
    developmentalStage: stage ? stage.label : null,

    // Trait profile with per-trait confidence
    traits,

    // Overall confidence
    overallConfidence: confidenceScores.overall,
    confidenceBreakdown: confidenceScores,

    // KG-compatible insights (ready for MarbleKG.addInsight())
    insights,

    // Impact on the subject (the primary user)
    subjectImpact: template.parentImpact || template.subjectImpact || {},

    // Metadata
    source: 'archetype-generator',
    synthetic: true,
    createdAt: new Date().toISOString(),
    factCount: countFacts(facts),
  };

  return archetype;
}

/**
 * Resolve a human-friendly relationship type to a template key.
 */
function resolveTemplateKey(type) {
  const normalized = (type || '').toLowerCase().trim();

  const mapping = {
    'daughter': 'parent-child-daughter',
    'son': 'parent-child-son',
    'child': 'parent-child-son', // default to son, user can specify
    'partner': 'partner',
    'wife': 'partner',
    'husband': 'partner',
    'spouse': 'partner',
    'girlfriend': 'partner',
    'boyfriend': 'partner',
    'colleague': 'colleague',
    'coworker': 'colleague',
    'co-worker': 'colleague',
    'friend': 'friend',
    'best friend': 'friend',
    'parent': 'parent',
    'mother': 'parent',
    'mom': 'parent',
    'father': 'parent',
    'dad': 'parent',
    'sibling': 'sibling',
    'brother': 'sibling',
    'sister': 'sibling',
  };

  return mapping[normalized] || normalized;
}

function buildTraitProfile(template, stage, mentionedInterests, extraFacts) {
  const traits = [];

  // Source for traits: stage (parent-child) or defaultTraits (other)
  const source = stage || template.defaultTraits || {};

  // Interests
  const baseInterests = source.interests || [];
  for (const interest of baseInterests) {
    const isConfirmed = mentionedInterests.some(m =>
      m.toLowerCase().includes(interest.toLowerCase()) ||
      interest.toLowerCase().includes(m.toLowerCase())
    );

    traits.push({
      category: 'interest',
      value: interest,
      confidence: isConfirmed ? 0.8 : 0.3,
      synthetic: !isConfirmed,
      source: isConfirmed ? 'confirmed' : 'archetype-template',
    });
  }

  // Add mentioned interests not in template
  for (const mi of mentionedInterests) {
    const alreadyAdded = traits.some(t =>
      t.category === 'interest' &&
      (t.value.toLowerCase().includes(mi.toLowerCase()) ||
       mi.toLowerCase().includes(t.value.toLowerCase()))
    );
    if (!alreadyAdded) {
      traits.push({
        category: 'interest',
        value: mi,
        confidence: 0.9,
        synthetic: false,
        source: 'mentioned',
      });
    }
  }

  // Needs
  const baseNeeds = source.needs || [];
  for (const need of baseNeeds) {
    traits.push({
      category: 'need',
      value: need,
      confidence: 0.25,
      synthetic: true,
      source: 'archetype-template',
    });
  }

  // Communication style
  if (source.communicationStyle) {
    traits.push({
      category: 'communication',
      value: source.communicationStyle,
      confidence: 0.2,
      synthetic: true,
      source: 'archetype-template',
    });
  }

  // Attention span/pattern
  if (source.attentionSpan || source.attentionPattern) {
    traits.push({
      category: 'attention',
      value: source.attentionSpan || source.attentionPattern,
      confidence: 0.2,
      synthetic: true,
      source: 'archetype-template',
    });
  }

  // Extra facts as high-confidence traits
  for (const [key, value] of Object.entries(extraFacts)) {
    traits.push({
      category: key,
      value,
      confidence: 0.9,
      synthetic: false,
      source: 'provided',
    });
  }

  return traits;
}

function calculateConfidence(facts, stage) {
  let overall = 0.15; // baseline for any archetype

  // Relationship type known
  if (facts.relationshipType) overall += 0.1;

  // Age known or estimated
  if (facts.ageRange) overall += 0.15;
  else if (facts.contextSignals && facts.contextSignals.length > 0) overall += 0.08;

  // Stage resolved
  if (stage) overall += 0.05;

  // Mentioned interests add signal
  if (facts.mentionedInterests && facts.mentionedInterests.length > 0) {
    overall += Math.min(0.15, facts.mentionedInterests.length * 0.05);
  }

  // Name known
  if (facts.name) overall += 0.05;

  // Extra facts
  if (facts.extraFacts) {
    overall += Math.min(0.15, Object.keys(facts.extraFacts).length * 0.05);
  }

  return {
    overall: Math.min(0.8, Math.round(overall * 100) / 100),
    ageConfidence: facts.ageRange ? 0.7 : (facts.contextSignals?.length > 0 ? 0.3 : 0.1),
    traitConfidence: 0.25,
    relationshipConfidence: facts.relationshipType ? 0.8 : 0.1,
  };
}

function generateInsights(template, traits, confidenceScores, facts) {
  const insights = [];
  const now = new Date().toISOString();

  // Generate insight per synthetic trait category
  const syntheticByCategory = {};
  for (const trait of traits) {
    if (!trait.synthetic) continue;
    if (!syntheticByCategory[trait.category]) syntheticByCategory[trait.category] = [];
    syntheticByCategory[trait.category].push(trait.value);
  }

  for (const [category, values] of Object.entries(syntheticByCategory)) {
    insights.push({
      id: `archetype_${category}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      observation: `${template.label}: ${facts.relationshipType} relationship detected with minimal data`,
      hypothesis: `Based on ${template.label} archetype, likely ${category}: ${values.join(', ')}`,
      supporting_signals: facts.contextSignals || [],
      contradicting_signals: [],
      confidence: confidenceScores.traitConfidence,
      derived_predictions: values.map(v =>
        `Person shows ${category} pattern: "${v}" — testable via direct observation or mention`
      ),
      source_layer: 'synthetic',
      created_at: now,
      updated_at: now,
      test_results: [],
    });
  }

  // Impact insight for the primary user
  const impact = template.parentImpact || template.subjectImpact;
  if (impact && impact.contentRelevance) {
    insights.push({
      id: `archetype_impact_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      observation: `User has a ${facts.relationshipType} — affects content preferences`,
      hypothesis: `User likely interested in: ${impact.contentRelevance.join(', ')} due to ${facts.relationshipType} relationship`,
      supporting_signals: [`relationship: ${facts.relationshipType}`],
      contradicting_signals: [],
      confidence: confidenceScores.overall,
      derived_predictions: impact.contentRelevance.map(topic =>
        `User engages with ${topic} content at higher-than-baseline rate`
      ),
      source_layer: 'synthetic',
      created_at: now,
      updated_at: now,
      test_results: [],
    });
  }

  return insights;
}

function countFacts(facts) {
  let count = 0;
  if (facts.relationshipType) count++;
  if (facts.ageRange) count++;
  if (facts.name) count++;
  if (facts.mentionedInterests) count += facts.mentionedInterests.length;
  if (facts.contextSignals) count += facts.contextSignals.length;
  if (facts.extraFacts) count += Object.keys(facts.extraFacts).length;
  return count;
}

// ─── ARCHETYPE UPDATE (SIGNAL CONFIRMATION) ───────────────────────────────────

/**
 * Update an archetype's confidence based on new signal.
 * Confirms or denies synthetic traits.
 *
 * @param {object} archetype - Previously generated archetype
 * @param {object} signal - { traitCategory, traitValue, outcome: 'confirmed'|'denied'|'partial' }
 * @returns {object} Updated archetype
 */
export function updateArchetype(archetype, signal) {
  const { traitCategory, traitValue, outcome } = signal;

  for (const trait of archetype.traits) {
    if (trait.category !== traitCategory) continue;

    const matches = trait.value.toLowerCase().includes(traitValue.toLowerCase()) ||
                    traitValue.toLowerCase().includes(trait.value.toLowerCase());

    if (!matches) continue;

    switch (outcome) {
      case 'confirmed':
        trait.confidence = Math.min(0.95, trait.confidence + 0.25);
        trait.synthetic = false;
        trait.source = 'confirmed';
        break;
      case 'denied':
        trait.confidence = Math.max(0.0, trait.confidence - 0.3);
        break;
      case 'partial':
        trait.confidence = Math.min(0.7, trait.confidence + 0.1);
        break;
    }
  }

  // Recalculate overall confidence
  const confirmedCount = archetype.traits.filter(t => t.source === 'confirmed' || t.source === 'mentioned' || t.source === 'provided').length;
  const totalCount = archetype.traits.length;
  if (totalCount > 0) {
    archetype.overallConfidence = Math.min(0.95,
      archetype.overallConfidence + (confirmedCount / totalCount) * 0.1
    );
  }

  archetype.updatedAt = new Date().toISOString();
  return archetype;
}

/**
 * Convert archetype insights to MarbleKG-compatible format for direct injection.
 */
export function toKGInsights(archetype) {
  return archetype.insights;
}

/**
 * List available archetype templates.
 */
export function listTemplates() {
  return Object.entries(ARCHETYPE_TEMPLATES).map(([key, t]) => ({
    key,
    label: t.label,
    relationship: t.baseTraits.relationship,
    hasAgeStages: !!t.ageStages,
  }));
}

// Export for testing
export { ARCHETYPE_TEMPLATES, estimateAgeFromContext, AGE_SIGNAL_PATTERNS };
