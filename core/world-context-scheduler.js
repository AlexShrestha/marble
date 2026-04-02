/**
 * World Context Cache Scheduler
 *
 * Triggers scheduled cache writes of world-context snapshots to KG.
 * Integrates with:
 * 1. Nightly cron schedule (24h TTL cache refresh)
 * 2. User data ingest events (cache invalidation + immediate refresh)
 *
 * No polling — events driven via pub/sub or task queue callbacks.
 */

import { cacheWorldContext, invalidateWorldContextCache } from './world-context-cache.js';
import { toWorldSimContext } from './worldsim-bridge.js';

/**
 * Schedule nightly cache refresh
 *
 * Call this during app startup to register the nightly job.
 * Integrates with existing cron/scheduler (e.g. node-cron, APScheduler, N8N).
 *
 * @param {Object} kg - KnowledgeGraph instance
 * @param {Function} scheduler - Scheduler function (e.g. cron library)
 * @param {string} cronExpression - Cron pattern (default: '0 0 * * *' = daily at midnight)
 * @returns {Function} Unsubscribe function to cancel the scheduled job
 */
export function scheduleNightlyCacheRefresh(kg, scheduler, cronExpression = '0 0 * * *') {
  if (!scheduler || typeof scheduler !== 'function') {
    console.warn('[WorldContextScheduler] No scheduler provided, skipping nightly cache refresh');
    return () => {};
  }

  console.log(`[WorldContextScheduler] Scheduling nightly cache refresh at: ${cronExpression}`);

  const job = scheduler(cronExpression, async () => {
    try {
      const worldContext = toWorldSimContext(kg);
      await cacheWorldContext(kg, worldContext, 24);
      console.log('[WorldContextScheduler] Nightly cache refresh complete');
    } catch (err) {
      console.error('[WorldContextScheduler] Nightly cache refresh failed:', err.message);
    }
  });

  // Return unsubscribe function
  return () => {
    if (job && typeof job.stop === 'function') {
      job.stop();
    }
  };
}

/**
 * Handle cache invalidation on new user data ingestion
 *
 * Call this when user data is ingested (e.g. from data monitor or event queue).
 * Invalidates cache immediately, optionally refreshes with new world context.
 *
 * @param {Object} kg - KnowledgeGraph instance
 * @param {Object} opts - Options
 * @param {boolean} opts.refreshImmediately - If true, refresh cache immediately (default: true)
 * @param {number} opts.cacheTTLHours - Cache TTL for refresh (default: 24)
 * @returns {Promise<Object>} Result of cache invalidation/refresh
 */
export async function handleUserDataIngest(kg, opts = {}) {
  const { refreshImmediately = true, cacheTTLHours = 24 } = opts;

  try {
    // Invalidate stale cache
    await invalidateWorldContextCache(kg);
    console.log('[WorldContextScheduler] User data ingested, cache invalidated');

    let refreshResult = null;

    // Optionally refresh immediately
    if (refreshImmediately) {
      const worldContext = toWorldSimContext(kg);
      refreshResult = await cacheWorldContext(kg, worldContext, cacheTTLHours);
      console.log('[WorldContextScheduler] Cache refreshed immediately after data ingest');
    }

    return {
      invalidated: true,
      refreshed: refreshImmediately,
      refreshResult
    };
  } catch (err) {
    console.error('[WorldContextScheduler] Failed to handle user data ingest:', err.message);
    throw err;
  }
}

/**
 * Get cache refresh status for monitoring
 *
 * @param {Object} kg - KnowledgeGraph instance
 * @returns {Object} Status info
 */
export function getCacheRefreshStatus(kg) {
  if (!kg || !kg.user) {
    return { status: 'no_kg' };
  }

  const cache = kg.user.cached_world_context;

  if (!cache) {
    return { status: 'no_cache', generated_at: null, valid_until: null };
  }

  const now = new Date();
  const validUntil = new Date(cache.valid_until);
  const isValid = now <= validUntil;

  return {
    status: isValid ? 'fresh' : 'stale',
    generated_at: cache.generated_at,
    valid_until: cache.valid_until,
    age_minutes: Math.round((now - new Date(cache.generated_at)) / 60000),
    ttl_hours: cache.ttl_hours
  };
}
