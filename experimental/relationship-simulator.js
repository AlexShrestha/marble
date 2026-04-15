/**
 * relationship-simulator.js — Marble Relationship Simulation Engine
 *
 * Models RELATIONSHIPS between people in the KG and uses them to predict needs.
 * Goes beyond individual profiles: cross-references person_a (real user) with
 * person_b (archetype or real) to find intersection opportunities.
 *
 * KEY INSIGHT: The recommendation isn't just "you like fitness" — it's
 * "your daughter has school holiday next week and you both enjoy outdoor
 * activities → hiking trail event nearby"
 *
 * RELATIONSHIP NODE:
 * { person_a, person_b, relationship_type, interaction_patterns,
 *   shared_interests, tension_points, recommendations }
 */

import { MarbleKG } from './kg.js';

// ─── TEMPORAL CONTEXTS ──────────────────────────────────────────────────────
// Seasonal/temporal patterns that affect relationship-based recommendations

const TEMPORAL_CONTEXTS = [
  { id: 'school_holiday', months: [6, 7, 8, 12], label: 'School Holiday', triggers: ['summer camps', 'family trips', 'kids activities'] },
  { id: 'weekend', recurring: 'weekly', label: 'Weekend', triggers: ['family outings', 'shared activities', 'quality time'] },
  { id: 'back_to_school', months: [8, 9], label: 'Back to School', triggers: ['school supplies', 'routine building', 'schedule planning'] },
  { id: 'winter_break', months: [12, 1], label: 'Winter Break', triggers: ['indoor activities', 'holiday planning', 'family traditions'] },
  { id: 'spring', months: [3, 4, 5], label: 'Spring', triggers: ['outdoor activities', 'sports signups', 'spring break trips'] },
  { id: 'summer', months: [6, 7, 8], label: 'Summer', triggers: ['camps', 'vacations', 'outdoor adventures', 'swimming'] },
];

// ─── RELATIONSHIP ACTIVITY TEMPLATES ────────────────────────────────────────
// Maps relationship_type → activity categories

const ACTIVITY_TEMPLATES = {
  'parent-child': {
    shared: ['outdoor adventures', 'cooking together', 'board games', 'reading', 'sports', 'creative projects'],
    parent_growth: ['parenting courses', 'child psychology', 'education resources', 'activity planning'],
    child_growth: ['classes', 'workshops', 'educational apps', 'social activities', 'skill building'],
  },
  'partner': {
    shared: ['date nights', 'travel', 'fitness together', 'cooking', 'shared hobbies'],
    individual_growth: ['communication skills', 'relationship books', 'gift ideas', 'surprise planning'],
  },
  'friend': {
    shared: ['events', 'group activities', 'shared hobbies', 'travel'],
    individual_growth: ['gift ideas', 'social planning'],
  },
  'colleague': {
    shared: ['networking events', 'industry conferences', 'team activities'],
    individual_growth: ['leadership skills', 'team dynamics', 'professional development'],
  },
  'sibling': {
    shared: ['family events', 'shared memories', 'joint activities'],
    individual_growth: ['family dynamics', 'communication'],
  },
};

// ─── MAIN CLASS ─────────────────────────────────────────────────────────────

export class RelationshipSimulator {
  /**
   * @param {MarbleKG} kg - loaded MarbleKG instance
   * @param {object} [opts]
   * @param {boolean} [opts.autoSave=false] - persist KG after mutations
   */
  constructor(kg, opts = {}) {
    this.kg = kg;
    this.autoSave = opts.autoSave || false;

    // Ensure relationships array exists in KG
    if (!this.kg.data.user.relationships) {
      this.kg.data.user.relationships = [];
    }
  }

  // ─── RELATIONSHIP CRUD ──────────────────────────────────────────────

  /**
   * Add a relationship to the KG.
   * @param {object} rel
   * @param {string} rel.person_a - subject (usually the user)
   * @param {string} rel.person_b - the other person (real name or archetype label)
   * @param {string} rel.relationship_type - 'parent-child' | 'partner' | 'friend' | 'colleague' | 'sibling'
   * @param {object} [rel.person_b_profile] - archetype profile for person_b (interests, age, etc.)
   * @returns {object} the stored relationship node
   */
  addRelationship(rel) {
    const id = `rel_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();

    const node = {
      id,
      person_a: rel.person_a,
      person_b: rel.person_b,
      relationship_type: rel.relationship_type,
      person_b_profile: rel.person_b_profile || {},
      interaction_patterns: rel.interaction_patterns || [],
      shared_interests: [],
      tension_points: [],
      recommendations: [],
      created_at: now,
      updated_at: now,
    };

    // Auto-compute shared interests from profiles
    node.shared_interests = this._computeSharedInterests(node);

    this.kg.data.user.relationships.push(node);
    this._maybeSave();
    return node;
  }

  /**
   * Get a relationship by ID.
   */
  getRelationship(relId) {
    return this.kg.data.user.relationships.find(r => r.id === relId) || null;
  }

  /**
   * Get all relationships, optionally filtered.
   */
  getRelationships(filter = {}) {
    let rels = this.kg.data.user.relationships || [];
    if (filter.type) rels = rels.filter(r => r.relationship_type === filter.type);
    if (filter.person_b) rels = rels.filter(r => r.person_b === filter.person_b);
    return rels;
  }

  /**
   * Update a relationship node.
   */
  updateRelationship(relId, updates) {
    const rel = this.getRelationship(relId);
    if (!rel) return null;

    if (updates.person_b_profile) rel.person_b_profile = { ...rel.person_b_profile, ...updates.person_b_profile };
    if (updates.interaction_patterns) rel.interaction_patterns = updates.interaction_patterns;
    if (updates.tension_points) rel.tension_points = updates.tension_points;
    rel.updated_at = new Date().toISOString();

    // Recompute shared interests
    rel.shared_interests = this._computeSharedInterests(rel);

    this._maybeSave();
    return rel;
  }

  // ─── SIMULATION ENGINE ──────────────────────────────────────────────

  /**
   * Simulate relationship dynamics and generate recommendations.
   * Cross-references person_a's KG insights with person_b's profile
   * to find intersection opportunities.
   *
   * @param {string} relId - relationship ID
   * @param {object} [opts]
   * @param {Date} [opts.date] - reference date for temporal context
   * @returns {object} simulation result with recommendations
   */
  simulate(relId, opts = {}) {
    const rel = this.getRelationship(relId);
    if (!rel) return null;

    const date = opts.date || new Date();
    const userInsights = this.kg.getInsights({ minConfidence: 0.3 });
    const userInterests = (this.kg.getInterests() || []).map(i => i.topic.toLowerCase());

    // 1. Compute shared interests from both profiles
    const sharedInterests = rel.shared_interests;

    // 2. Get temporal context
    const activeContexts = this._getActiveTemporalContexts(date);

    // 3. Generate relationship-aware recommendations
    const recommendations = this._generateRecommendations(rel, userInsights, userInterests, activeContexts);

    // 4. Identify tension points (conflicts in preferences)
    const tensions = this._identifyTensions(rel, userInsights);

    // Store results on the relationship node
    rel.recommendations = recommendations;
    rel.tension_points = tensions;
    rel.last_simulation = date.toISOString();
    rel.updated_at = date.toISOString();

    this._maybeSave();

    return {
      relationship: rel,
      shared_interests: sharedInterests,
      active_contexts: activeContexts,
      recommendations,
      tension_points: tensions,
      simulation_date: date.toISOString(),
    };
  }

  /**
   * Simulate all relationships and return aggregated recommendations.
   * @param {object} [opts]
   * @param {Date} [opts.date]
   * @returns {object[]} all simulation results
   */
  simulateAll(opts = {}) {
    const rels = this.kg.data.user.relationships || [];
    return rels.map(r => this.simulate(r.id, opts)).filter(Boolean);
  }

  /**
   * Get VIVO-ready recommendations: formatted for story/product selection.
   * Returns recommendations tagged with relationship context for the
   * editorial pipeline.
   *
   * @param {object} [opts]
   * @param {Date} [opts.date]
   * @param {number} [opts.limit=10]
   * @returns {object[]} { topic, reason, confidence, relationship, temporal_context }
   */
  getVivoRecommendations(opts = {}) {
    const limit = opts.limit || 10;
    const results = this.simulateAll(opts);

    const allRecs = [];
    for (const result of results) {
      for (const rec of (result.recommendations || [])) {
        allRecs.push({
          topic: rec.topic,
          reason: rec.reason,
          confidence: rec.confidence,
          relationship: `${result.relationship.person_a} → ${result.relationship.person_b}`,
          relationship_type: result.relationship.relationship_type,
          temporal_context: rec.temporal_context || null,
        });
      }
    }

    return allRecs
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, limit);
  }

  // ─── INTERNAL ──────────────────────────────────────────────────────────

  /**
   * Compute shared interests between person_a (from KG) and person_b (from profile).
   */
  _computeSharedInterests(rel) {
    const userInterests = (this.kg.getInterests() || []).map(i => i.topic.toLowerCase());
    const personBInterests = (rel.person_b_profile.interests || []).map(i => i.toLowerCase());

    // Direct overlap
    const direct = userInterests.filter(i => personBInterests.includes(i));

    // Semantic proximity — check if categories overlap
    const categories = this._categorizeInterests([...userInterests, ...personBInterests]);
    const categoryOverlap = [];
    for (const [cat, items] of Object.entries(categories)) {
      const fromA = items.filter(i => userInterests.includes(i));
      const fromB = items.filter(i => personBInterests.includes(i));
      if (fromA.length > 0 && fromB.length > 0) {
        categoryOverlap.push({ category: cat, person_a: fromA, person_b: fromB });
      }
    }

    return { direct, category_overlap: categoryOverlap };
  }

  /**
   * Categorize interests into broad groups for overlap detection.
   */
  _categorizeInterests(interests) {
    const categories = {
      outdoor: ['hiking', 'cycling', 'running', 'swimming', 'camping', 'nature', 'outdoor activities', 'sports', 'outdoor play', 'outdoor adventures'],
      creative: ['drawing', 'music', 'crafts', 'creative projects', 'writing', 'photography', 'art'],
      fitness: ['gym', 'fitness', 'running', 'exercise', 'yoga', 'sports', 'swimming', 'fitness together'],
      learning: ['reading', 'science', 'education', 'courses', 'books', 'stories', 'educational apps'],
      social: ['events', 'friends', 'networking', 'social media', 'social events', 'group activities'],
      technology: ['gaming', 'coding', 'ai', 'tech', 'startup', 'programming'],
      family: ['family activities', 'parenting', 'cooking together', 'board games', 'family trips'],
    };

    const result = {};
    for (const [cat, keywords] of Object.entries(categories)) {
      const matched = interests.filter(i => keywords.some(k => i.includes(k) || k.includes(i)));
      if (matched.length > 0) result[cat] = [...new Set(matched)];
    }
    return result;
  }

  /**
   * Get active temporal contexts for a given date.
   */
  _getActiveTemporalContexts(date) {
    const month = date.getMonth() + 1; // 1-indexed
    const dayOfWeek = date.getDay(); // 0=Sunday
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

    const active = [];
    for (const ctx of TEMPORAL_CONTEXTS) {
      if (ctx.months && ctx.months.includes(month)) {
        active.push(ctx);
      }
      if (ctx.recurring === 'weekly' && isWeekend) {
        active.push(ctx);
      }
    }
    return active;
  }

  /**
   * Generate relationship-aware recommendations.
   */
  _generateRecommendations(rel, userInsights, userInterests, activeContexts) {
    const recs = [];
    const type = rel.relationship_type;
    const template = ACTIVITY_TEMPLATES[type] || ACTIVITY_TEMPLATES['friend'];
    const personBProfile = rel.person_b_profile || {};
    const personBInterests = (personBProfile.interests || []).map(i => i.toLowerCase());

    // 1. Shared activity recommendations
    for (const activity of (template.shared || [])) {
      // Boost if it matches user's actual interests
      const userMatch = userInterests.some(ui => activity.toLowerCase().includes(ui) || ui.includes(activity.toLowerCase()));
      const personBMatch = personBInterests.some(pi => activity.toLowerCase().includes(pi) || pi.includes(activity.toLowerCase()));

      let confidence = 0.4;
      if (userMatch) confidence += 0.2;
      if (personBMatch) confidence += 0.2;

      recs.push({
        topic: activity,
        reason: `Shared activity for ${rel.person_a} and ${rel.person_b} (${type})`,
        confidence: Math.min(0.95, confidence),
        type: 'shared_activity',
      });
    }

    // 2. Person_a growth recommendations (what does user need in this role?)
    const growthKey = type === 'parent-child' ? 'parent_growth' : 'individual_growth';
    for (const topic of (template[growthKey] || [])) {
      recs.push({
        topic,
        reason: `${rel.person_a} may benefit from this as ${type === 'parent-child' ? 'a parent' : 'part of'} relationship with ${rel.person_b}`,
        confidence: 0.5,
        type: 'role_growth',
      });
    }

    // 3. Person_b benefit recommendations
    if (template.child_growth && type === 'parent-child') {
      for (const topic of template.child_growth) {
        const personBMatch = personBInterests.some(pi => topic.toLowerCase().includes(pi) || pi.includes(topic.toLowerCase()));
        recs.push({
          topic,
          reason: `${rel.person_b} would benefit from ${topic}`,
          confidence: personBMatch ? 0.7 : 0.4,
          type: 'person_b_benefit',
        });
      }
    }

    // 4. Temporal boosting — add context-specific recommendations
    for (const ctx of activeContexts) {
      for (const trigger of ctx.triggers) {
        // Check if trigger aligns with relationship type
        const existing = recs.find(r => r.topic.toLowerCase().includes(trigger) || trigger.includes(r.topic.toLowerCase()));
        if (existing) {
          existing.confidence = Math.min(0.95, existing.confidence + 0.15);
          existing.temporal_context = ctx.label;
        } else {
          recs.push({
            topic: trigger,
            reason: `${ctx.label}: relevant for ${rel.person_a} + ${rel.person_b}`,
            confidence: 0.45,
            type: 'temporal',
            temporal_context: ctx.label,
          });
        }
      }
    }

    // 5. Insight-driven cross-reference
    for (const insight of userInsights.slice(0, 10)) {
      const obs = insight.observation.toLowerCase();
      // Check if any person_b interest relates to this insight
      for (const pi of personBInterests) {
        if (obs.includes(pi) || insight.supporting_signals?.some(s => s.toLowerCase().includes(pi))) {
          recs.push({
            topic: `${pi} (shared with ${rel.person_b})`,
            reason: `KG insight "${insight.observation}" intersects with ${rel.person_b}'s interest in ${pi}`,
            confidence: Math.min(0.9, insight.confidence * 0.8),
            type: 'insight_crossref',
            source_insight: insight.id,
          });
        }
      }
    }

    // Sort and deduplicate
    const seen = new Set();
    return recs
      .filter(r => {
        const key = r.topic.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Identify tension points between user preferences and relationship needs.
   */
  _identifyTensions(rel, userInsights) {
    const tensions = [];
    const type = rel.relationship_type;
    const personBProfile = rel.person_b_profile || {};

    // Check for time-competition tensions
    const timeIntensiveInsights = userInsights.filter(i => {
      const obs = i.observation.toLowerCase();
      return obs.includes('career') || obs.includes('startup') || obs.includes('work') || obs.includes('builder');
    });

    if (timeIntensiveInsights.length > 0 && (type === 'parent-child' || type === 'partner')) {
      tensions.push({
        type: 'time_competition',
        description: `${rel.person_a}'s work/career focus may compete with ${rel.person_b} relationship time`,
        severity: 'medium',
        suggestion: `Schedule dedicated time for ${rel.person_b} — protect it like a meeting`,
      });
    }

    // Check for interest misalignment
    const personBNeeds = personBProfile.needs || [];
    for (const need of personBNeeds) {
      const needLower = need.toLowerCase();
      const userSupports = userInsights.some(i =>
        i.observation.toLowerCase().includes(needLower) ||
        i.supporting_signals?.some(s => s.toLowerCase().includes(needLower))
      );
      if (!userSupports && (needLower.includes('emotional') || needLower.includes('support') || needLower.includes('attention'))) {
        tensions.push({
          type: 'unmet_need',
          description: `${rel.person_b} needs "${need}" which isn't reflected in ${rel.person_a}'s current focus`,
          severity: 'low',
          suggestion: `Consider content about: ${need}`,
        });
      }
    }

    return tensions;
  }

  _maybeSave() {
    if (this.autoSave) this.kg.save();
  }
}

export default RelationshipSimulator;
