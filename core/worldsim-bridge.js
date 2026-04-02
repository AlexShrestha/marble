/**
 * Marble-WorldSim Neutral Adapter
 *
 * Bridge module for syncing WorldSim synthetic user profiles with Marble KG.
 * Neither Marble nor WorldSim import from each other directly.
 * Bridge reads/writes to shared KG store only.
 *
 * Schema mapping:
 * WorldSim {demographics, psychographics, goals} -> Marble {beliefs, preferences, identities}
 *
 * World context cache: All world snapshots cached to KG via world-context-cache.js.
 * Marble reads from warm cache without on-demand cross-module calls.
 */

import { cacheWorldContext, getWorldContextOrFallback } from './world-context-cache.js';
// Standalone stub — in Jarvis this is provided by worldsim/system-a-who-where-how.js
function toWorldSimBridgeFormat(systemAOutput) {
  return {
    demographics: systemAOutput.demographics || {},
    psychographics: systemAOutput.psychographics || {},
    goals: systemAOutput.goals || [],
    system_a: systemAOutput,
  };
}




/**
 * Normalize WorldSim archetype data to Marble KG format
 *
 * @param {Object} worldSimData - Archetype from WorldSim with demographics, psychographics, goals
 * @returns {Object} Normalized Marble-compatible object with beliefs, preferences, identities
 */
export function readWorldContext(worldSimData) {
  if (!worldSimData) {
    return { beliefs: [], preferences: [], identities: [] };
  }

  const { demographics = {}, psychographics = {}, goals = [] } = worldSimData;

  // Extract Marble beliefs from demographics
  const beliefs = [];
  if (demographics.role) {
    beliefs.push({
      topic: 'role',
      claim: demographics.role,
      strength: 0.8,
      evidence_count: 1,
      valid_from: new Date().toISOString(),
      valid_to: null,
      source: 'worldsim'
    });
  }
  if (demographics.company_stage) {
    beliefs.push({
      topic: 'company_stage',
      claim: demographics.company_stage,
      strength: 0.8,
      evidence_count: 1,
      valid_from: new Date().toISOString(),
      valid_to: null,
      source: 'worldsim'
    });
  }
  if (demographics.industry) {
    beliefs.push({
      topic: 'industry',
      claim: demographics.industry,
      strength: 0.75,
      evidence_count: 1,
      valid_from: new Date().toISOString(),
      valid_to: null,
      source: 'worldsim'
    });
  }

  // Extract Marble preferences from psychographics
  const preferences = [];

  // Pain points as negative preferences
  if (psychographics.pain_points && Array.isArray(psychographics.pain_points)) {
    for (const painPoint of psychographics.pain_points) {
      preferences.push({
        type: 'pain_points',
        description: painPoint,
        strength: -0.7, // Negative = wants to avoid
        valid_from: new Date().toISOString(),
        valid_to: null,
        source: 'worldsim'
      });
    }
  }

  // Buying triggers as positive preferences
  if (psychographics.buying_triggers && Array.isArray(psychographics.buying_triggers)) {
    for (const trigger of psychographics.buying_triggers) {
      preferences.push({
        type: 'buying_triggers',
        description: trigger,
        strength: 0.8, // Positive = interested in
        valid_from: new Date().toISOString(),
        valid_to: null,
        source: 'worldsim'
      });
    }
  }

  // Platform preferences
  if (psychographics.platform_preferences && Array.isArray(psychographics.platform_preferences)) {
    for (const platform of psychographics.platform_preferences) {
      preferences.push({
        type: 'platform',
        description: platform,
        strength: 0.7,
        valid_from: new Date().toISOString(),
        valid_to: null,
        source: 'worldsim'
      });
    }
  }

  // Price sensitivity as preference
  if (psychographics.price_sensitivity) {
    const sensitivityStrength = {
      'low': 0.5,
      'medium': 0.2,
      'high': -0.5
    }[psychographics.price_sensitivity] || 0.2;

    preferences.push({
      type: 'price_sensitivity',
      description: psychographics.price_sensitivity,
      strength: sensitivityStrength,
      valid_from: new Date().toISOString(),
      valid_to: null,
      source: 'worldsim'
    });
  }

  // Adoption style as preference
  if (psychographics.adoption_style) {
    preferences.push({
      type: 'adoption_style',
      description: psychographics.adoption_style,
      strength: 0.7,
      valid_from: new Date().toISOString(),
      valid_to: null,
      source: 'worldsim'
    });
  }

  // Extract Marble identities from demographics
  const identities = [];
  if (demographics.country) {
    identities.push({
      type: 'geography',
      value: demographics.country,
      salience: 0.7,
      source: 'worldsim'
    });
  }
  if (demographics.timezone) {
    identities.push({
      type: 'timezone',
      value: demographics.timezone,
      salience: 0.6,
      source: 'worldsim'
    });
  }
  if (demographics.language) {
    identities.push({
      type: 'language',
      value: demographics.language,
      salience: 0.8,
      source: 'worldsim'
    });
  }

  // Goals can be stored as both beliefs and interests
  const goalBeliefs = [];
  if (goals && Array.isArray(goals)) {
    for (const goal of goals) {
      goalBeliefs.push({
        topic: 'goal',
        claim: goal,
        strength: 0.75,
        evidence_count: 1,
        valid_from: new Date().toISOString(),
        valid_to: null,
        source: 'worldsim'
      });
    }
  }

  return {
    beliefs: [...beliefs, ...goalBeliefs],
    preferences,
    identities,
    worldSimId: worldSimData.id || null,
    syncedAt: new Date().toISOString()
  };
}

/**
 * Write WorldSim data to KG and cache world context snapshot
 *
 * @param {Object} kg - KnowledgeGraph instance
 * @param {Object} worldSimData - WorldSim archetype to sync
 * @param {number} cacheTTLHours - Cache TTL in hours (default: 24)
 * @returns {Promise<Object>} Sync result with cache metadata
 */
export async function writeWorldContext(kg, worldSimData, cacheTTLHours = 24) {
  if (!kg || !kg.user) {
    throw new Error('Invalid KG instance provided to writeWorldContext');
  }

  const normalized = readWorldContext(worldSimData);

  // Write beliefs to KG
  for (const belief of normalized.beliefs) {
    kg.addBelief(belief.topic, belief.claim, belief.strength);
  }

  // Write preferences to KG
  for (const pref of normalized.preferences) {
    kg.addPreference(pref.type, pref.description, pref.strength);
  }

  // Write identities to KG (role, context, salience)
  for (const identity of normalized.identities) {
    kg.addIdentity(identity.type, identity.value, identity.salience);
  }

  // Track sync metadata
  if (!kg.user.worldsim_syncs) {
    kg.user.worldsim_syncs = [];
  }

  kg.user.worldsim_syncs.push({
    worldsim_id: normalized.worldSimId,
    synced_at: normalized.syncedAt,
    num_beliefs: normalized.beliefs.length,
    num_preferences: normalized.preferences.length,
    num_identities: normalized.identities.length
  });

  // Keep last 10 syncs
  if (kg.user.worldsim_syncs.length > 10) {
    kg.user.worldsim_syncs = kg.user.worldsim_syncs.slice(-10);
  }

  // Build world context snapshot (normalized format)
  const worldContextSnapshot = {
    demographics: {},
    psychographics: {},
    goals: []
  };

  // Extract demographics from beliefs
  for (const belief of normalized.beliefs) {
    if (belief.topic === 'role') worldContextSnapshot.demographics.role = belief.claim;
    if (belief.topic === 'company_stage') worldContextSnapshot.demographics.company_stage = belief.claim;
    if (belief.topic === 'industry') worldContextSnapshot.demographics.industry = belief.claim;
  }

  // Extract psychographics from preferences
  for (const pref of normalized.preferences) {
    if (pref.type === 'pain_points') {
      if (!worldContextSnapshot.psychographics.pain_points) worldContextSnapshot.psychographics.pain_points = [];
      worldContextSnapshot.psychographics.pain_points.push(pref.description);
    }
    if (pref.type === 'buying_triggers') {
      if (!worldContextSnapshot.psychographics.buying_triggers) worldContextSnapshot.psychographics.buying_triggers = [];
      worldContextSnapshot.psychographics.buying_triggers.push(pref.description);
    }
    if (pref.type === 'platform') {
      if (!worldContextSnapshot.psychographics.platform_preferences) worldContextSnapshot.psychographics.platform_preferences = [];
      worldContextSnapshot.psychographics.platform_preferences.push(pref.description);
    }
    if (pref.type === 'price_sensitivity') worldContextSnapshot.psychographics.price_sensitivity = pref.description;
    if (pref.type === 'adoption_style') worldContextSnapshot.psychographics.adoption_style = pref.description;
  }

  // Extract goals from beliefs
  for (const belief of normalized.beliefs) {
    if (belief.topic === 'goal') worldContextSnapshot.goals.push(belief.claim);
  }

  // Cache world context snapshot for warm reads
  const cacheResult = await cacheWorldContext(kg, worldContextSnapshot, cacheTTLHours);

  // Persist to disk
  await kg.save();

  return {
    synced: true,
    num_beliefs: normalized.beliefs.length,
    num_preferences: normalized.preferences.length,
    num_identities: normalized.identities.length,
    cache_result: cacheResult
  };
}

/**
 * Batch sync multiple WorldSim archetypes to KG
 *
 * @param {Object} kg - KnowledgeGraph instance
 * @param {Array} archetypes - Array of WorldSim archetypes
 * @returns {Promise<Object>} Summary of sync results
 */
export async function syncBatch(kg, archetypes) {
  if (!Array.isArray(archetypes)) {
    throw new Error('archetypes must be an array');
  }

  let synced = 0;
  let errors = 0;

  for (const archetype of archetypes) {
    try {
      await writeWorldContext(kg, archetype);
      synced++;
    } catch (err) {
      errors++;
      console.error(`Failed to sync archetype ${archetype.id}:`, err.message);
    }
  }

  return {
    total: archetypes.length,
    synced,
    errors,
    timestamp: new Date().toISOString()
  };
}

/**
 * Write System A WHO/WHERE/HOW pipeline output to KG and warm cache.
 * This is the primary entry point for L1 world grounding from WorldSim System A.
 *
 * @param {Object} kg - KnowledgeGraph instance
 * @param {Object} systemAOutput - Result of runSystemA() from system-a-who-where-how.js
 * @param {number} cacheTTLHours - Cache TTL in hours (default: 24)
 * @returns {Promise<Object>} Sync result with cache metadata and L1 grounding stats
 */
export async function writeSystemAOutput(kg, systemAOutput, cacheTTLHours = 24) {
  if (!kg || !kg.user) {
    throw new Error('Invalid KG instance provided to writeSystemAOutput');
  }
  if (!systemAOutput || systemAOutput.system !== 'A') {
    throw new Error('writeSystemAOutput requires System A pipeline output from runSystemA()');
  }

  // Convert to WorldSim bridge format (standard demographics/psychographics/goals + system_a payload)
  const bridgeData = toWorldSimBridgeFormat(systemAOutput);

  // Write standard fields to KG via existing writeWorldContext
  const syncResult = await writeWorldContext(kg, bridgeData, cacheTTLHours);

  // Also write L1 grounding facts as high-confidence beliefs
  const { l1_grounding_facts = [] } = systemAOutput;
  let l1Written = 0;

  for (const fact of l1_grounding_facts) {
    // Use probability * pipeline_confidence as belief strength
    const strength = Math.round(fact.probability * (fact.pipeline_confidence || 1) * 1000) / 1000;

    if (fact.dimension.startsWith('who.') || fact.dimension.startsWith('how.')) {
      kg.addBelief(fact.dimension, fact.answer, strength);
      l1Written++;
    } else if (fact.dimension.startsWith('where.')) {
      kg.addIdentity(fact.dimension, fact.answer, strength);
      l1Written++;
    }
  }

  // Cache extended System A payload separately under system_a key
  if (!kg.user.system_a_cache) {
    kg.user.system_a_cache = {};
  }
  const now = new Date();
  kg.user.system_a_cache = {
    output: systemAOutput,
    cached_at: now.toISOString(),
    valid_until: new Date(now.getTime() + cacheTTLHours * 60 * 60 * 1000).toISOString(),
    pipeline_confidence: systemAOutput.pipeline_confidence
  };

  await kg.save();

  return {
    ...syncResult,
    l1_grounding_facts_written: l1Written,
    pipeline_confidence: systemAOutput.pipeline_confidence,
    population_size: systemAOutput.population_size,
    clusters_found: (systemAOutput.clusters || []).length
  };
}

/**
 * Get System A WHO/WHERE/HOW output from warm cache.
 * Returns null if cache is missing or expired.
 *
 * @param {Object} kg - KnowledgeGraph instance
 * @returns {Object|null} Cached System A output or null
 */
export function getSystemAFromCache(kg) {
  if (!kg || !kg.user || !kg.user.system_a_cache) return null;
  const cache = kg.user.system_a_cache;
  if (!cache.valid_until || new Date() > new Date(cache.valid_until)) return null;
  return cache.output;
}

/**
 * Get world context from warm cache (preferred, no on-demand calls)
 * Falls back to last known context or empty grounding if cache stale/missing
 *
 * @param {Object} kg - KnowledgeGraph instance
 * @returns {Object} World context from cache or fallback
 */
export function getWorldContextFromCache(kg) {
  return getWorldContextOrFallback(kg, {
    demographics: {},
    psychographics: {},
    goals: []
  });
}

/**
 * Query KG to build WorldSim-compatible context snapshot
 * Used by WorldSim to understand current KG state
 *
 * @param {Object} kg - KnowledgeGraph instance
 * @returns {Object} Current KG state in WorldSim-readable format
 */
export function toWorldSimContext(kg) {
  if (!kg || !kg.user) {
    return { demographics: {}, psychographics: {}, goals: [] };
  }

  const user = kg.user;

  // Build demographics from identities (identities stored as {role, context})
  const demographics = {};
  if (user.identities) {
    const activeIdentities = kg.getActiveIdentities();
    for (const identity of activeIdentities) {
      // In KG: role is the type (geography, timezone, language), context is the value
      if (identity.role === 'geography') demographics.country = identity.context;
      if (identity.role === 'timezone') demographics.timezone = identity.context;
      if (identity.role === 'language') demographics.language = identity.context;
    }
  }

  // Extract from beliefs
  const activeBeliefs = kg.getActiveBeliefs();
  for (const belief of activeBeliefs) {
    if (belief.topic === 'role') demographics.role = belief.claim;
    if (belief.topic === 'company_stage') demographics.company_stage = belief.claim;
    if (belief.topic === 'industry') demographics.industry = belief.claim;
  }

  // Build psychographics from preferences
  const psychographics = {
    pain_points: [],
    buying_triggers: [],
    platform_preferences: [],
    goals: []
  };

  const activePreferences = kg.getActivePreferences();
  if (activePreferences) {
    for (const pref of activePreferences) {
      if (pref.type === 'pain_points' && pref.strength < 0) {
        psychographics.pain_points.push(pref.description);
      }
      if (pref.type === 'buying_triggers' && pref.strength > 0) {
        psychographics.buying_triggers.push(pref.description);
      }
      if (pref.type === 'platform') {
        psychographics.platform_preferences.push(pref.description);
      }
      if (pref.type === 'price_sensitivity') {
        psychographics.price_sensitivity = pref.description;
      }
      if (pref.type === 'adoption_style') {
        psychographics.adoption_style = pref.description;
      }
    }
  }

  // Extract goals from beliefs
  const goals = activeBeliefs
    .filter(b => b.topic === 'goal')
    .map(b => b.claim);

  return {
    demographics,
    psychographics,
    goals,
    lastUpdated: new Date().toISOString(),
    source: 'marble_kg'
  };
}
