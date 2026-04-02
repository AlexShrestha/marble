/**
 * World Context Warm Cache
 *
 * Manages scheduled cache writes of world-context snapshots to KG.
 * Marble reads from this cache without on-demand cross-module calls.
 *
 * Cache Schema:
 * {
 *   world_context: {...},
 *   generated_at: ISO8601,
 *   valid_until: ISO8601,
 *   source: 'worldsim',
 *   cache_version: 1
 * }
 *
 * Cache invalidation triggers:
 * 1. New user data ingested (via trigger from user-data-monitor)
 * 2. Nightly schedule (via cron)
 */

/**
 * Write world context snapshot to KG cache
 *
 * @param {Object} kg - KnowledgeGraph instance
 * @param {Object} worldContext - World context snapshot from WorldSim
 * @param {number} ttlHours - Cache TTL in hours (default: 24)
 * @returns {Promise<Object>} Cache metadata
 */
export async function cacheWorldContext(kg, worldContext, ttlHours = 24) {
  if (!kg || !kg.user) {
    throw new Error('Invalid KG instance');
  }

  const now = new Date();
  const validUntil = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);

  const cacheEntry = {
    world_context: worldContext,
    generated_at: now.toISOString(),
    valid_until: validUntil.toISOString(),
    source: 'worldsim',
    cache_version: 1,
    ttl_hours: ttlHours
  };

  // Store in KG user object
  if (!kg.user.cached_world_context) {
    kg.user.cached_world_context = {};
  }

  kg.user.cached_world_context = cacheEntry;

  // Persist to disk
  await kg.save();

  return {
    cached: true,
    generated_at: cacheEntry.generated_at,
    valid_until: cacheEntry.valid_until,
    ttl_hours: ttlHours
  };
}

/**
 * Read cached world context from KG
 *
 * @param {Object} kg - KnowledgeGraph instance
 * @returns {Object|null} Cached world context or null if missing/stale
 */
export function getWorldContextCache(kg) {
  if (!kg || !kg.user) {
    return null;
  }

  const cache = kg.user.cached_world_context;

  if (!cache) {
    return null;
  }

  return cache.world_context || null;
}

/**
 * Check if cached world context is still valid
 *
 * @param {Object} kg - KnowledgeGraph instance
 * @returns {Object} Cache status with staleness info
 */
export function checkCacheValidity(kg) {
  if (!kg || !kg.user) {
    return {
      valid: false,
      reason: 'no_kg',
      cache_exists: false,
      age_minutes: null,
      remaining_minutes: null
    };
  }

  const cache = kg.user.cached_world_context;

  if (!cache) {
    return {
      valid: false,
      reason: 'no_cache',
      cache_exists: false,
      age_minutes: null,
      remaining_minutes: null
    };
  }

  const now = new Date();
  const validUntil = new Date(cache.valid_until);

  if (now > validUntil) {
    const ageMs = now - new Date(cache.generated_at);
    const ageMinutes = Math.round(ageMs / 60000);

    return {
      valid: false,
      reason: 'stale',
      cache_exists: true,
      age_minutes: ageMinutes,
      remaining_minutes: 0,
      generated_at: cache.generated_at,
      expired_at: cache.valid_until
    };
  }

  const ageMs = now - new Date(cache.generated_at);
  const ageMinutes = Math.round(ageMs / 60000);
  const remainingMs = validUntil - now;
  const remainingMinutes = Math.round(remainingMs / 60000);

  return {
    valid: true,
    reason: 'fresh',
    cache_exists: true,
    age_minutes: ageMinutes,
    remaining_minutes: remainingMinutes,
    generated_at: cache.generated_at,
    valid_until: cache.valid_until
  };
}

/**
 * Get cached world context if valid, else return fallback
 *
 * @param {Object} kg - KnowledgeGraph instance
 * @param {Object} fallback - Fallback context if cache is missing/stale (default: empty)
 * @returns {Object} World context (cached or fallback)
 */
export function getWorldContextOrFallback(kg, fallback = { demographics: {}, psychographics: {}, goals: [] }) {
  const cache = getWorldContextCache(kg);
  const status = checkCacheValidity(kg);

  if (status.valid && cache) {
    return cache;
  }

  // Log staleness for debugging
  if (status.cache_exists && !status.valid) {
    console.warn(`[WorldContextCache] Cache stale (${status.age_minutes} min old), using fallback`);
  }

  return fallback;
}

/**
 * Invalidate cached world context (triggers cache refresh)
 *
 * @param {Object} kg - KnowledgeGraph instance
 * @returns {Promise<void>}
 */
export async function invalidateWorldContextCache(kg) {
  if (!kg || !kg.user) {
    return;
  }

  kg.user.cached_world_context = null;
  await kg.save();
}

/**
 * Get cache statistics for monitoring
 *
 * @param {Object} kg - KnowledgeGraph instance
 * @returns {Object} Cache statistics
 */
export function getCacheStats(kg) {
  const validity = checkCacheValidity(kg);
  const cache = kg.user?.cached_world_context;

  return {
    has_cache: validity.cache_exists,
    is_valid: validity.valid,
    reason: validity.reason,
    age_minutes: validity.age_minutes,
    remaining_minutes: validity.remaining_minutes,
    generated_at: cache?.generated_at || null,
    valid_until: cache?.valid_until || null,
    ttl_hours: cache?.ttl_hours || null,
    cache_version: cache?.cache_version || null
  };
}
