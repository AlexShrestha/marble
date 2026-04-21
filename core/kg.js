/**
 * Marble Knowledge Graph
 *
 * User-centric graph where the user is the root node.
 * Stories are scored by their distance to what matters to the user right now.
 *
 * Layer 1 - Typed Memory Nodes:
 * - belief: Core beliefs about topics/domains
 * - preference: Explicit preferences and patterns
 * - identity: Role/identity attributes about the user
 * - confidence: Confidence levels in knowledge areas
 * - episode: Source record every fact can point back to
 */

import { readFile, writeFile } from 'fs/promises';
import { createHash } from 'crypto';
import { extractEntityAttributes } from './entity-extractor.js';
import { embeddings as defaultEmbeddings } from './embeddings.js';

/**
 * On-disk schema version. Bump when the saved JSON shape changes in a way that
 * requires migration, and add a case to `#migrate()` below.
 */
export const KG_VERSION = 2;

/**
 * Default reconciliation rules — a conservative starter set that marks the
 * most common single-value slots as cardinality "one" so that ingesting
 * contradictory facts about them closes the older version automatically.
 *
 * Consumers can extend or fully replace this map via the `Marble` constructor
 * option `reconciliationRules`. Unlisted slots retain "many" (no forced
 * uniqueness) — a safe default that won't collapse distinct preferences.
 */
export const DEFAULT_RECONCILIATION_RULES = {
  beliefs: {
    current_city: 'one',
    current_employer: 'one',
    current_role: 'one',
  },
  preferences: {
    primary_diet: 'one',
    primary_language: 'one',
    time_zone: 'one',
  },
  identities: {
    current_city: 'one',
    current_employer: 'one',
    current_role: 'one',
    current_school: 'one',
  },
};

/**
 * Default decay configuration for `getActive*` views. Half-life controls how
 * fast `effective_strength = strength * 2^(-age_days / halfLifeDays)` shrinks
 * as facts age. Threshold 0 preserves the pre-decay behaviour — nothing is
 * filtered out unless consumers explicitly raise it. Historical queries
 * (`asOf` in the past) compute age relative to that point, not today, so
 * `getStateAt()` is unaffected.
 */
export const DEFAULT_DECAY_CONFIG = {
  halfLifeDays: 365,
  minEffectiveStrength: 0,
};

/**
 * Default entity-resolution config. Opt-in: unless `enabled: true`, none of
 * the resolution paths run and the KG behaves exactly as before. The threshold
 * applies to the embedding-similarity tier; acronym and exact-match tiers are
 * always deterministic.
 */
export const DEFAULT_ENTITY_RESOLUTION = {
  enabled: false,
  threshold: 0.85,
};

/**
 * Walk `src` and return a version with any unclosed `{`, `[`, or `"` closed
 * at the end. Designed to rescue LLM JSON that was truncated mid-structure
 * by a max_tokens ceiling. Skips escapes and string literals so braces inside
 * strings don't confuse the depth tracker. Strips a trailing comma if one
 * dangles before the synthetic closers.
 *
 * This is best-effort — if the input was already structurally invalid (not
 * just truncated), the result will still fail JSON.parse and the caller gets
 * null. No guarantees about semantic correctness: a rescued object is at
 * least parseable, not necessarily complete.
 *
 * @param {string} src
 * @returns {string}
 */
function _balanceBraces(src) {
  const stack = [];
  let inString = false;
  let escape = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let tail = '';
  if (inString) tail += '"';
  // Drop a dangling comma that would otherwise appear right before the synthetic closers.
  let trimmed = src.replace(/,\s*$/, '');
  // Drop a half-written key-value pair at the end (e.g. `"salience":` with no value).
  trimmed = trimmed.replace(/,?\s*"[^"]*"\s*:\s*$/, '');
  while (stack.length) {
    const open = stack.pop();
    tail += open === '{' ? '}' : ']';
  }
  return trimmed + tail;
}

/**
 * Tolerant JSON extraction from LLM text output.
 *
 * LLM completions can arrive empty, prose-wrapped, truncated mid-structure, or
 * otherwise malformed. This helper applies three recovery layers in order:
 *   1. Match the outermost JSON region and parse it directly.
 *   2. If parse fails, attempt brace-balance recovery on the matched region.
 *   3. If that fails, match the innermost opener and re-balance from there —
 *      rescues the common "prose + truncated JSON" shape.
 * Callers MUST still handle null.
 *
 * @param {string} text
 * @param {'object'|'array'} [shape='object']
 * @returns {any|null}
 */
function _extractJSON(text, shape = 'object') {
  if (!text || typeof text !== 'string') return null;
  const opener = shape === 'array' ? '[' : '{';
  const re = shape === 'array' ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/;
  const m = text.match(re);
  const candidate = m ? m[0] : null;
  if (candidate) {
    try { return JSON.parse(candidate); } catch { /* fall through to rescue */ }
    try { return JSON.parse(_balanceBraces(candidate)); } catch { /* fall through */ }
  }
  // Last resort: start from the first opener we find and balance to EOF. This
  // catches truncations where the closing bracket was never emitted, so the
  // greedy regex above didn't match at all.
  const start = text.indexOf(opener);
  if (start >= 0) {
    try { return JSON.parse(_balanceBraces(text.slice(start))); } catch { return null; }
  }
  return null;
}

/**
 * Coerce an LLM-produced belief/preference/identity entry into the object
 * shape the rest of the KG expects. LLMs frequently return string arrays
 * instead of the documented object arrays; silently dropping those is worse
 * than accepting them with sensible defaults.
 *
 * @param {any} entry
 * @param {'belief'|'preference'|'identity'} kind
 * @returns {Object|null}
 */
function _normalizeKgOverrideEntry(entry, kind) {
  if (entry == null) return null;
  if (typeof entry === 'string') {
    const s = entry.trim();
    if (!s) return null;
    if (kind === 'belief') return { topic: s, value: s, confidence: 0.5 };
    if (kind === 'preference') return { category: 'general', value: s, strength: 0.5 };
    if (kind === 'identity') return { role: 'general', value: s, salience: 0.5 };
  }
  if (typeof entry !== 'object') return null;
  // Object case: fill in any missing required fields rather than leaving
  // downstream code to read `undefined` off the structure.
  if (kind === 'belief') {
    const topic = entry.topic ?? entry.name ?? entry.key ?? entry.value ?? '';
    if (!topic) return null;
    return {
      ...entry,
      topic,
      value: entry.value ?? entry.claim ?? topic,
      confidence: typeof entry.confidence === 'number' ? entry.confidence : 0.5,
    };
  }
  if (kind === 'preference') {
    const value = entry.value ?? entry.preference ?? entry.name ?? '';
    if (!value && !entry.category) return null;
    return {
      ...entry,
      category: entry.category ?? 'general',
      value: value || entry.category,
      strength: typeof entry.strength === 'number' ? entry.strength : 0.5,
    };
  }
  if (kind === 'identity') {
    const value = entry.value ?? entry.identity ?? entry.name ?? '';
    if (!value && !entry.role) return null;
    return {
      ...entry,
      role: entry.role ?? 'general',
      value: value || entry.role,
      salience: typeof entry.salience === 'number' ? entry.salience : 0.5,
    };
  }
  return null;
}

/**
 * Normalize an entire `kgOverrides` block. Accepts missing keys, string-shaped
 * entries, and arrays-of-objects with partial fields. Always returns the
 * three-key structure so downstream code can index without existence checks.
 *
 * @param {any} raw
 * @returns {{ beliefs: Object[], preferences: Object[], identities: Object[] }}
 */
function _normalizeKgOverrides(raw) {
  const safe = (raw && typeof raw === 'object') ? raw : {};
  const map = (arr, kind) =>
    (Array.isArray(arr) ? arr : [])
      .map(e => _normalizeKgOverrideEntry(e, kind))
      .filter(Boolean);
  return {
    beliefs: map(safe.beliefs, 'belief'),
    preferences: map(safe.preferences, 'preference'),
    identities: map(safe.identities, 'identity'),
  };
}

// Minimal English stopword list for the no-LLM keyword fallback. Kept tiny to
// avoid pulling in a dependency; the goal is "better than empty", not
// production-grade NLP.
const _STOPWORDS = new Set([
  'a','an','the','and','or','but','if','then','than','so','of','to','for','in',
  'on','at','by','with','from','about','into','over','under','between','through',
  'is','are','was','were','be','been','being','have','has','had','do','does','did',
  'will','would','could','should','may','might','must','can','cannot','this','that',
  'these','those','i','you','he','she','it','we','they','them','their','our','your',
  'my','me','us','as','not','no','yes','also','just','very','really','its','it\'s',
  'up','down','out','off','too','any','some','all','more','most','much','many',
  'one','two','three','like','get','got','go','going','gone','see','seen','saw',
  'make','made','take','taken','took','find','found','come','came','come','gone',
  'new','old','now','then','here','there','where','when','what','why','how','who',
  'which','whose','been','being','being','not','don','doesn','isn','wasn','weren',
]);

/**
 * Lightweight keyword extractor for the no-LLM mode. Splits on non-word chars,
 * drops short tokens and stopwords, returns up to `limit` most-frequent tokens.
 *
 * This is a deliberately simple fallback — when no TopicInsightEngine is wired
 * and the caller hands `react()` an item with no `topics`, we at least derive
 * something the scorer can use rather than leaving the KG completely topic-thin.
 *
 * @param {string} text
 * @param {number} [limit=5]
 * @returns {string[]}
 */
function _extractKeywordsFromText(text, limit = 5) {
  if (!text || typeof text !== 'string') return [];
  const freq = new Map();
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const t of tokens) {
    if (t.length < 3) continue;
    if (_STOPWORDS.has(t)) continue;
    if (/^\d+$/.test(t)) continue;
    freq.set(t, (freq.get(t) || 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k]) => k);
}

export class KnowledgeGraph {
  constructor(dataPath, opts = {}) {
    this.dataPath = dataPath;
    this.user = null;
    this.items = new Map();
    this._topicInsightEngine = null;     // TopicInsightEngine for LLM-powered enrichment
    this._dimensionalPreferences = [];   // DimensionalPreference[] tracking
    this._lastInsightResult = null;      // Last enrichment result for debugging
    // Native vector index: node_id → Float32Array embedding
    this._vectorIndex = new Map();
    this._vectorIndexMeta = new Map();   // node_id → { type, node, text }
    // Decay config — overridable per-instance so consumers with long-lived
    // facts (preferences that rarely change) can use a longer half-life.
    this.decayConfig = { ...DEFAULT_DECAY_CONFIG, ...(opts.decayConfig || {}) };
    // Entity resolution is opt-in. When disabled (default), resolveEntity()
    // and the entity-aware codepaths below are no-ops so existing consumers
    // see no behaviour change.
    this.entityResolution = { ...DEFAULT_ENTITY_RESOLUTION, ...(opts.entityResolution || {}) };
  }

  /**
   * Attach a TopicInsightEngine to enable LLM-powered preference enrichment on every reaction.
   * @param {import('./topic-insight-engine.js').TopicInsightEngine} engine
   */
  setTopicInsightEngine(engine) {
    this._topicInsightEngine = engine;
  }

  async load() {
    try {
      const raw = await readFile(this.dataPath, 'utf-8');
      const data = JSON.parse(raw);
      this.user = data.user || this.#defaultUser();
      this._dimensionalPreferences = data._dimensionalPreferences || [];
      this.version = data.version ?? 0;
      if (this.version < KG_VERSION) this.#migrate();
      return this;
    } catch {
      this.user = this.#defaultUser();
      this._dimensionalPreferences = [];
      this.version = KG_VERSION;
      return this;
    }
  }

  /**
   * Forward-migrate the in-memory KG from whatever `this.version` was loaded
   * to `KG_VERSION`. Runs on every load when the on-disk file predates the
   * current schema — migrations must be idempotent and safe to run repeatedly.
   *
   * Migration map:
   *   0 → 1: add `episodes: []` to user
   *   1 → 2: add `entities: []` to user
   */
  #migrate() {
    if (this.version < 1) {
      if (!Array.isArray(this.user.episodes)) this.user.episodes = [];
    }
    if (this.version < 2) {
      if (!Array.isArray(this.user.entities)) this.user.entities = [];
    }
    this.version = KG_VERSION;
  }

  async save() {
    const data = {
      version: KG_VERSION,
      user: this.user,
      _dimensionalPreferences: this._dimensionalPreferences,
      updated_at: new Date().toISOString()
    };
    await writeFile(this.dataPath, JSON.stringify(data, null, 2));
  }

  /**
   * Get interest weight for a topic. Returns 0 if no interest registered.
   */
  getInterestWeight(topic) {
    const interest = this.user.interests.find(i =>
      i.topic.toLowerCase() === topic.toLowerCase()
    );
    if (!interest) return 0;
    return this.#applyDecay(interest);
  }

  /**
   * Boost interest weight based on positive reaction
   */
  boostInterest(topic, amount = 0.1) {
    let interest = this.user.interests.find(i =>
      i.topic.toLowerCase() === topic.toLowerCase()
    );
    if (!interest) {
      interest = { topic, weight: 0, last_boost: new Date().toISOString(), trend: 'rising' };
      this.user.interests.push(interest);
    }
    interest.weight = Math.min(1, interest.weight + amount);
    interest.last_boost = new Date().toISOString();
    interest.trend = 'rising';
  }

  /**
   * Decay interest weight based on negative reaction
   */
  decayInterest(topic, amount = 0.05) {
    const interest = this.user.interests.find(i =>
      i.topic.toLowerCase() === topic.toLowerCase()
    );
    if (!interest) return;
    interest.weight = Math.max(0, interest.weight - amount);
    interest.trend = 'falling';
  }

  /**
   * Record a reaction and update interest weights
   * @param {string} itemId - ID of the item being rated
   * @param {string} reaction - Reaction type: 'up', 'down', 'skip', 'share'
   * @param {string[]} topics - Topic tags for the item
   * @param {string} source - Source of the item
   * @param {Object} [item=null] - Optional item metadata for secondary context extraction
   */
  recordReaction(itemId, reaction, topics, source, item = null) {
    // No-LLM keyword fallback: when no TopicInsightEngine is wired and the
    // caller provided no topics, derive a small keyword set from the item's
    // title/summary so the interest graph gets a signal (otherwise every
    // reaction in no-LLM mode contributes zero to the scorer's interest match).
    // Marked derivedTopics on the history entry so downstream code can weight
    // them lower if desired — they are a heuristic fallback, not user-curated.
    let effectiveTopics = topics;
    let derivedTopics = false;
    if (
      (!effectiveTopics || effectiveTopics.length === 0) &&
      !this._topicInsightEngine &&
      item
    ) {
      const text = `${item.title || ''} ${item.summary || item.description || ''}`.trim();
      const kws = _extractKeywordsFromText(text);
      if (kws.length) {
        effectiveTopics = kws;
        derivedTopics = true;
      }
    }

    const historyEntry = {
      item_id: itemId,
      reaction,
      date: new Date().toISOString(),
      topics: effectiveTopics,
      source,
      ...(derivedTopics && { topics_derived: true }),
    };

    // Extract and store secondary context if item metadata provided
    if (item) {
      const { domain, attributes } = extractEntityAttributes(item);
      if (domain && Object.keys(attributes).length > 0) {
        this.#extractSecondaryContext(attributes, reaction);
        historyEntry.entity_attributes = attributes;
        historyEntry.context_collected = true;

        // Track dimensional preferences from extracted attributes
        this.#trackDimensionalPreferences(domain, attributes, reaction);
      }

      // Run TopicInsightEngine for LLM-powered enrichment (async, fire-and-forget)
      if (this._topicInsightEngine) {
        this._topicInsightEngine.analyse(item, reaction, this)
          .then(result => { this._lastInsightResult = result; })
          .catch(() => {}); // Silently ignore enrichment failures
      }
    }

    this.user.history.push(historyEntry);

    // Update interest weights based on reaction. Derived-keyword topics get a
    // dampened boost (half the normal rate) since they are heuristic, not
    // user-declared.
    const boostMultiplier = derivedTopics ? 0.5 : 1.0;
    for (const topic of effectiveTopics || []) {
      if (reaction === 'up' || reaction === 'share') {
        this.boostInterest(topic, (reaction === 'share' ? 0.15 : 0.1) * boostMultiplier);
      } else if (reaction === 'down') {
        this.decayInterest(topic, 0.05 * boostMultiplier);
      }
    }

    // Update source trust
    this.#updateSourceTrust(source, reaction);

    // Note: CF integration should be handled at application layer
    // to avoid circular dependencies and keep KG focused on core knowledge

    // Trim history to last 500 entries
    if (this.user.history.length > 500) {
      this.user.history = this.user.history.slice(-500);
    }

    // Persist to disk (fire-and-forget — prevents _dimensionalPreferences loss on restart)
    this.save();
  }

  /**
   * Extract and store secondary context from rated item attributes
   * Writes typed KG nodes (beliefs, preferences, identities) based on extracted attributes
   * @private
   * @param {Object} attributes - Extracted entity attributes from entity-extractor
   * @param {string} reaction - User's reaction to the item
   */
  #extractSecondaryContext(attributes, reaction) {
    const isPositive = reaction === 'up' || reaction === 'share';

    // Determine strength modifiers based on reaction
    const strengthDelta = isPositive ? 0.15 : -0.10;
    const beliefStrength = isPositive ? 0.6 : 0.3;
    const identityStrength = isPositive ? 0.6 : 0.3;

    for (const [kgKey, attrList] of Object.entries(attributes)) {
      for (const attr of attrList) {
        if (attr.kgType === 'belief') {
          // Store as belief with confidence based on reaction
          this.addBelief(kgKey, attr.value, beliefStrength);
        } else if (attr.kgType === 'preference') {
          // Get existing preference strength or start at 0.5 (neutral)
          const existing = this.getPreferences(kgKey)
            .find(p => p.description.toLowerCase() === attr.value.toLowerCase());
          const currentStrength = existing?.strength || 0.5;
          const newStrength = Math.max(-1, Math.min(1, currentStrength + strengthDelta));
          this.addPreference(kgKey, attr.value, newStrength);
        } else if (attr.kgType === 'identity') {
          // Store as identity attribute with salience based on reaction
          this.addIdentity(kgKey, attr.value, identityStrength);
        }
      }
    }
  }

  /**
   * Set today's ephemeral context
   */
  setContext(context) {
    this.user.context = { ...this.user.context, ...context };
  }

  /**
   * Get source trust score (0-1)
   */
  getSourceTrust(source) {
    return this.user.source_trust[source] ?? 0.5; // neutral default
  }

  /**
   * Check if user has seen an item recently.
   * Reads both item_id (new) and story_id (legacy) for backward compatibility.
   */
  hasSeen(itemId) {
    return this.user.history.some(h => (h.item_id || h.story_id) === itemId);
  }

  // ── Layer 1: Typed Memory Node Methods ─────────────

  /**
   * Add a belief with bi-temporal validity.
   * If an active belief on the same topic exists with a different claim,
   * it is closed (contradiction detection) and a new fact is created.
   * @param {string} topic - Topic or domain
   * @param {string} claim - The belief statement
   * @param {number} strength - Belief strength (0-1)
   * @param {Object} [opts]
   * @param {string} [opts.validFrom] - ISO date when this belief became true in
   *   the real world (source date). Defaults to now. Pass the source timestamp
   *   here so temporal queries work against the source timeline, not the
   *   ingest timeline.
   * @param {string} [opts.episodeId] - Provenance pointer. Appended to the
   *   fact's `evidence: [episode_id]` array so `getFactProvenance()` can trace
   *   back to the source.
   */
  addBelief(topic, claim, strength = 0.7, opts = {}) {
    const now = new Date().toISOString();
    const validFrom = opts.validFrom || now;
    // When an entity id is attached, treat two facts with matching
    // (topic, entity_id) as the same fact even if the raw claim string
    // differs. This is how "school=BSB" + "school=British School Barcelona"
    // collapse to a single active belief.
    const matchesSame = (b) => {
      if (b.topic.toLowerCase() !== topic.toLowerCase() || b.valid_to) return false;
      if (opts.entityId && b.entity_id) return b.entity_id === opts.entityId;
      return b.claim === claim;
    };
    const matchesSlot = (b) =>
      b.topic.toLowerCase() === topic.toLowerCase() && !b.valid_to;
    const active = this.user.beliefs.find(matchesSlot);

    if (active) {
      if (matchesSame(active)) {
        // Reinforce existing belief
        active.strength = Math.min(1, strength);
        active.evidence_count = (active.evidence_count || 0) + 1;
        active.recorded_at = now;
        if (opts.episodeId) this.#linkEvidence(active, opts.episodeId);
        return;
      }
      // Contradiction: close old fact. Use the incoming validFrom (source
      // date) so the closure lines up on the source timeline, not wall-clock.
      active.valid_to = validFrom;
    }

    const fact = {
      topic, claim,
      strength: Math.min(1, strength),
      evidence_count: 1,
      valid_from: validFrom,
      valid_to: null,
      recorded_at: now,
      evidence: [],
      ...(opts.entityId ? { entity_id: opts.entityId } : {}),
    };
    if (opts.episodeId) this.#linkEvidence(fact, opts.episodeId);
    this.user.beliefs.push(fact);
  }

  /**
   * Get the currently active belief about a topic (or as-of a point in time).
   * @param {string} topic - Topic to search for
   * @param {string} [asOf] - ISO date; defaults to now
   * @returns {Object|null} Belief object or null
   */
  getBelief(topic, asOf) {
    return this.getActiveBeliefs(asOf).find(
      b => b.topic.toLowerCase() === topic.toLowerCase()
    ) || null;
  }

  /**
   * Return a trimmed, caller-friendly view of the active belief on `topic`.
   *
   * The full fact object (with every internal field) is available via
   * `getBelief()`; this method is for consumers who just want to render or
   * filter the belief without reaching into internals. Freshness uses the
   * temporal-decay `age_days`; `confidence` uses the decayed
   * `effective_strength`. `top_sources` resolves evidence episode ids to
   * short refs (`{ id, source, source_date }`) so provenance can be
   * displayed without a second lookup.
   *
   * @param {string} topic
   * @param {Object} [opts]
   * @param {string} [opts.asOf]
   * @param {number} [opts.minConfidence] - Reject if effective_strength is below this
   * @param {number} [opts.maxFreshnessDays] - Reject if older than this
   * @param {number} [opts.topSources=3] - How many episode refs to include
   * @returns {{ value: string, confidence: number, freshness_days: number, evidence_count: number, top_sources: Array<{ id, source, source_date }> }|null}
   */
  getActiveBelief(topic, opts = {}) {
    const fact = this.getActiveBeliefs(opts.asOf, opts).find(
      b => b.topic.toLowerCase() === topic.toLowerCase()
    );
    return this.#viewFact(fact, 'belief', opts);
  }

  /**
   * Singular rich-view accessor for preferences. When multiple preferences
   * exist on the same `type` (e.g. many "favorite_music" entries), returns
   * the one with the highest effective_strength — "give me the canonical
   * answer for this slot". Pass `description` to target a specific one.
   *
   * @param {string} type
   * @param {Object} [opts]
   * @param {string} [opts.description] - Disambiguate when type has many entries
   * @param {string} [opts.asOf]
   * @param {number} [opts.minConfidence]
   * @param {number} [opts.maxFreshnessDays]
   * @param {number} [opts.topSources=3]
   * @returns {{ value: string, confidence: number, freshness_days: number, evidence_count?: number, top_sources: Array }|null}
   */
  getActivePreference(type, opts = {}) {
    const candidates = this.getActivePreferences(opts.asOf, opts)
      .filter(p => p.type.toLowerCase() === type.toLowerCase());
    if (candidates.length === 0) return null;
    let fact;
    if (opts.description) {
      fact = candidates.find(p => p.description.toLowerCase() === opts.description.toLowerCase());
    } else {
      // Multi-entry slots (e.g. "favorite_music") — pick the strongest active
      // entry so there's a single canonical answer to "what's their X?".
      fact = candidates.reduce((best, p) =>
        (p.effective_strength ?? p.strength ?? 0) > (best.effective_strength ?? best.strength ?? 0) ? p : best
      );
    }
    return this.#viewFact(fact, 'preference', opts);
  }

  /**
   * Singular rich-view accessor for identities.
   *
   * @param {string} role
   * @param {Object} [opts]
   * @param {string} [opts.asOf]
   * @param {number} [opts.minConfidence]
   * @param {number} [opts.maxFreshnessDays]
   * @param {number} [opts.topSources=3]
   * @returns {{ value: string, confidence: number, freshness_days: number, top_sources: Array }|null}
   */
  getActiveIdentity(role, opts = {}) {
    const fact = this.getActiveIdentities(opts.asOf, opts).find(
      i => i.role.toLowerCase() === role.toLowerCase()
    );
    return this.#viewFact(fact, 'identity', opts);
  }

  /**
   * Shared "rich view" projection. Extracted so all three singular
   * accessors produce the same shape and honour the same filter options.
   * @private
   */
  #viewFact(fact, kind, opts = {}) {
    if (!fact) return null;

    // `effective_strength` / `age_days` are attached by `#filterActive`.
    // If a caller bypassed the public accessors (addX → user.beliefs) the
    // fact may not have them yet — fall back to the raw strength/salience
    // and skip freshness rather than emitting garbage numbers.
    const confidence = typeof fact.effective_strength === 'number'
      ? fact.effective_strength
      : (typeof fact.strength === 'number' ? fact.strength
        : (typeof fact.salience === 'number' ? fact.salience : 0));
    const freshness_days = typeof fact.age_days === 'number' ? fact.age_days : null;

    const minConfidence = typeof opts.minConfidence === 'number' ? opts.minConfidence : null;
    if (minConfidence !== null && confidence < minConfidence) return null;
    if (
      typeof opts.maxFreshnessDays === 'number'
      && freshness_days !== null
      && freshness_days > opts.maxFreshnessDays
    ) return null;

    const topN = opts.topSources ?? 3;
    const top_sources = Array.isArray(fact.evidence)
      ? fact.evidence.slice(0, topN)
        .map(id => this.getEpisode(id))
        .filter(Boolean)
        .map(e => ({ id: e.id, source: e.source, source_date: e.source_date }))
      : [];

    // Use the right "value" field per kind.
    const value = kind === 'belief' ? fact.claim
      : kind === 'preference' ? fact.description
      : fact.context;

    const view = {
      value,
      confidence,
      freshness_days,
      top_sources,
    };
    if (typeof fact.evidence_count === 'number') view.evidence_count = fact.evidence_count;
    return view;
  }

  /**
   * Return all beliefs that are active (valid_to is null or > asOf).
   *
   * Each returned belief is a shallow copy with two extra fields computed at
   * read time:
   *   - `effective_strength = strength * 2^(-age_days / halfLifeDays)`
   *   - `age_days` (relative to `asOf`)
   *
   * Stored facts are not mutated. When `decayConfig.minEffectiveStrength > 0`,
   * facts whose effective strength falls below the threshold are filtered
   * out — this is how consumers ask "ignore stale facts" without changing
   * the underlying data. Threshold defaults to 0 so back-compat is preserved.
   *
   * @param {string} [asOf] - ISO date; defaults to now
   * @param {Object} [opts]
   * @param {number} [opts.halfLifeDays] - Override instance half-life
   * @param {number} [opts.minEffectiveStrength] - Override instance threshold
   * @returns {Array} Active beliefs with `effective_strength` + `age_days`
   */
  getActiveBeliefs(asOf, opts = {}) {
    return this.#filterActive(this.user.beliefs, asOf, opts);
  }

  /**
   * Add a preference with bi-temporal validity.
   * Contradictions on same type+description close the old fact.
   * @param {string} type - Preference type (e.g., "content_style", "format", "tone")
   * @param {string} description - What the preference is
   * @param {number} strength - Preference strength (-1 to 1)
   * @param {Object} [opts]
   * @param {string} [opts.validFrom] - ISO date when this preference became
   *   true (source date). Defaults to now.
   * @param {string} [opts.episodeId] - Provenance pointer.
   */
  addPreference(type, description, strength = 0.7, opts = {}) {
    const now = new Date().toISOString();
    const validFrom = opts.validFrom || now;
    // Entity-aware matching: two preferences with the same type that resolve
    // to the same entity are "the same" even if their description strings
    // differ. Without an entity id, fall back to the exact desc match that
    // has always been here.
    const active = this.user.preferences.find(p => {
      if (p.type.toLowerCase() !== type.toLowerCase() || p.valid_to) return false;
      if (opts.entityId && p.entity_id) return p.entity_id === opts.entityId;
      return p.description.toLowerCase() === description.toLowerCase();
    });

    if (active) {
      // Reinforce — update strength in place
      active.strength = Math.max(-1, Math.min(1, strength));
      active.recorded_at = now;
      if (opts.episodeId) this.#linkEvidence(active, opts.episodeId);
      return;
    }

    const fact = {
      type, description,
      strength: Math.max(-1, Math.min(1, strength)),
      valid_from: validFrom,
      valid_to: null,
      recorded_at: now,
      evidence: [],
      ...(opts.entityId ? { entity_id: opts.entityId } : {}),
    };
    if (opts.episodeId) this.#linkEvidence(fact, opts.episodeId);
    this.user.preferences.push(fact);
  }

  /**
   * Get active preferences, optionally filtered by type.
   * @param {string} [type] - Preference type to filter by
   * @param {string} [asOf] - ISO date; defaults to now
   * @returns {Array} Active preferences
   */
  getPreferences(type = null, asOf) {
    const active = this.getActivePreferences(asOf);
    if (!type) return active;
    return active.filter(p => p.type.toLowerCase() === type.toLowerCase());
  }

  /**
   * Return all preferences that are currently active.
   * Adds `effective_strength` + `age_days` the same way `getActiveBeliefs()`
   * does; see that method for the decay semantics.
   *
   * @param {string} [asOf] - ISO date; defaults to now
   * @param {Object} [opts]
   * @returns {Array} Active preferences with computed freshness fields
   */
  getActivePreferences(asOf, opts = {}) {
    return this.#filterActive(this.user.preferences, asOf, opts);
  }

  /**
   * Add an identity attribute with bi-temporal validity.
   * If an active identity with the same role exists but different context, close old.
   * @param {string} role - Identity role (e.g., "engineer", "founder", "investor")
   * @param {string} context - Context for this identity
   * @param {number} salience - How central this identity is (0-1)
   * @param {Object} [opts]
   * @param {string} [opts.validFrom] - ISO date when this identity became
   *   true (source date). Defaults to now.
   * @param {string} [opts.episodeId] - Provenance pointer.
   */
  addIdentity(role, context = '', salience = 0.8, opts = {}) {
    const now = new Date().toISOString();
    const validFrom = opts.validFrom || now;
    const active = this.user.identities.find(i =>
      i.role.toLowerCase() === role.toLowerCase() && !i.valid_to
    );

    const contextMatchesEntity = active && opts.entityId && active.entity_id === opts.entityId;
    if (active) {
      if (active.context === context || contextMatchesEntity) {
        // Reinforce — either exact context match, or the entity id matches
        // so different phrasings of the same thing count as the same fact.
        active.salience = Math.min(1, salience);
        active.recorded_at = now;
        if (opts.episodeId) this.#linkEvidence(active, opts.episodeId);
        return;
      }
      // Role context changed — close old, align to source timeline.
      active.valid_to = validFrom;
    }

    const fact = {
      role, context,
      salience: Math.min(1, salience),
      valid_from: validFrom,
      valid_to: null,
      recorded_at: now,
      evidence: [],
      ...(opts.entityId ? { entity_id: opts.entityId } : {}),
    };
    if (opts.episodeId) this.#linkEvidence(fact, opts.episodeId);
    this.user.identities.push(fact);
  }

  // ── Episodes (first-class source records) ──────────────

  /**
   * Record (or look up) a source episode. An episode is one concrete piece of
   * input material — a chat conversation, a journal entry, an email thread —
   * that facts can point back to via their `evidence: [episode_id]` array.
   *
   * Idempotent: if an episode with a matching `id` OR matching `content_hash`
   * already exists, the existing one is returned. This lets the miner safely
   * re-ingest the same file without creating duplicate episodes, and lets two
   * different consumers converge on the same record when they happen to
   * produce the same content.
   *
   * @param {Object} ep
   * @param {string} [ep.id] - Consumer-supplied ID; auto-generated if omitted.
   * @param {string} [ep.source='unknown'] - Free-form label (e.g. "chatgpt",
   *   "gmail", "notes"). Consumers own the namespace.
   * @param {string} [ep.source_date] - ISO date when the episode happened in
   *   the real world. Null if unknown — fall back explicitly rather than
   *   silently stamping "now".
   * @param {string} [ep.content] - Raw text; hashed and summarised, not stored
   *   verbatim (KGs are not blob stores).
   * @param {string} [ep.content_summary] - Optional pre-computed summary.
   * @param {Object} [ep.metadata] - Opaque consumer-side extras.
   * @returns {Object} The canonical episode record.
   */
  addEpisode(ep = {}) {
    if (!Array.isArray(this.user.episodes)) this.user.episodes = [];
    const content = ep.content ?? '';
    const content_hash = ep.content_hash || (content
      ? createHash('sha256').update(content).digest('hex').slice(0, 16)
      : null);
    const now = new Date().toISOString();

    // Dedup: prefer explicit id, fall back to hash. Returning the existing
    // record (not a new one) lets callers repeatedly call addEpisode() during
    // re-ingests without bloating the KG.
    const existing = this.user.episodes.find(e =>
      (ep.id && e.id === ep.id) ||
      (content_hash && e.content_hash === content_hash)
    );
    if (existing) return existing;

    const id = ep.id || `ep_${Date.now()}_${this.user.episodes.length}`;
    const record = {
      id,
      source: ep.source || 'unknown',
      source_date: ep.source_date || null,
      ingested_at: now,
      content_hash,
      content_summary: ep.content_summary || (content ? content.slice(0, 200) : null),
      ...(ep.metadata ? { metadata: ep.metadata } : {}),
    };
    this.user.episodes.push(record);
    return record;
  }

  /**
   * Look up an episode by id.
   * @param {string} id
   * @returns {Object|null}
   */
  getEpisode(id) {
    return (this.user.episodes || []).find(e => e.id === id) || null;
  }

  /**
   * Return the episode records that back a given fact — the provenance trail.
   * Accepts either a fact object directly or a `{ type, topic }` selector.
   *
   * @param {Object} ref - `{ evidence: [...] }` or `{ type, topic }` or `{ type, role }`
   * @returns {Array<Object>} Episode records in the order they were linked.
   */
  getFactProvenance(ref) {
    if (!ref) return [];
    let fact = ref;
    if (!Array.isArray(ref.evidence) && (ref.type || ref.kind)) {
      const type = ref.type || ref.kind;
      const key = (ref.topic || ref.role || ref.type || '').toLowerCase();
      const collection = type === 'belief' ? this.user.beliefs
        : type === 'preference' ? this.user.preferences
        : type === 'identity' ? this.user.identities
        : [];
      fact = collection.find(f => {
        const k = (f.topic || f.type || f.role || '').toLowerCase();
        return k === key && !f.valid_to;
      });
    }
    if (!fact || !Array.isArray(fact.evidence)) return [];
    return fact.evidence
      .map(id => this.getEpisode(id))
      .filter(Boolean);
  }

  #linkEvidence(fact, episodeId) {
    if (!Array.isArray(fact.evidence)) fact.evidence = [];
    if (!fact.evidence.includes(episodeId)) fact.evidence.push(episodeId);
  }

  /**
   * Shared active-fact filter with temporal decay applied at read time.
   * Used by `getActiveBeliefs/Preferences/Identities`.
   *
   * Decays `strength` (or `salience` for identities) with a half-life on
   * `valid_from → asOf`. Returns shallow copies with `effective_strength`
   * and `age_days` appended; the stored facts are never mutated. Callers
   * who set `minEffectiveStrength > 0` get stale facts filtered out; the
   * default threshold of 0 preserves pre-decay behaviour.
   *
   * @private
   */
  #filterActive(collection, asOf, opts = {}) {
    const ts = asOf ? new Date(asOf).getTime() : Date.now();
    const halfLife = opts.halfLifeDays ?? this.decayConfig.halfLifeDays;
    const threshold = opts.minEffectiveStrength ?? this.decayConfig.minEffectiveStrength;
    const halfLifeMs = halfLife * 86_400_000;
    const results = [];

    for (const fact of collection) {
      const from = fact.valid_from ? new Date(fact.valid_from).getTime() : 0;
      const to = fact.valid_to ? new Date(fact.valid_to).getTime() : Infinity;
      if (!(from <= ts && ts < to)) continue;

      // Base score: `strength` for beliefs/preferences, `salience` for
      // identities. Fall back to 0.5 if neither is present (defensive).
      const baseStrength = typeof fact.strength === 'number'
        ? fact.strength
        : (typeof fact.salience === 'number' ? fact.salience : 0.5);

      // Age measured from the fact's source date, not ingest date — so
      // imported-old facts age correctly. Negative ages (future-dated) are
      // clamped to 0 so the decay term never exceeds 1.
      const ageMs = Math.max(0, ts - from);
      const effectiveStrength = halfLifeMs > 0
        ? baseStrength * Math.pow(0.5, ageMs / halfLifeMs)
        : baseStrength;

      if (effectiveStrength < threshold) continue;

      results.push({
        ...fact,
        effective_strength: effectiveStrength,
        age_days: ageMs / 86_400_000,
      });
    }
    return results;
  }

  // ── Reconciliation ─────────────────────────────────────

  /**
   * Sweep active facts and enforce cardinality on slots listed as "one" in
   * the rules. For each such slot, keep only the newest active fact; every
   * older one gets `valid_to` set to the newer fact's `valid_from` so the
   * timeline reads as a clean handoff, not an overlap.
   *
   * Idempotent — re-running changes nothing when the graph is already
   * reconciled. Safe to call after every ingest.
   *
   * Rule shape:
   *   {
   *     beliefs:     { [topic]: 'one' | 'many' },
   *     preferences: { [type]:  'one' | 'many' },
   *     identities:  { [role]:  'one' | 'many' }
   *   }
   *
   * Only 'one' slots are acted on. Unlisted or 'many' slots keep their
   * existing (possibly multiple) active facts untouched.
   *
   * @param {Object} [rules] - Rule map; defaults to `DEFAULT_RECONCILIATION_RULES`
   * @returns {{ beliefs_invalidated: number, preferences_invalidated: number, identities_invalidated: number }}
   */
  reconcile(rules = DEFAULT_RECONCILIATION_RULES) {
    const merged = {
      beliefs: { ...(rules?.beliefs || {}) },
      preferences: { ...(rules?.preferences || {}) },
      identities: { ...(rules?.identities || {}) },
    };

    const sweep = (collection, ruleMap, keyFn) => {
      // Bucket active facts by lowercase slot key. Only enforce on slots the
      // consumer explicitly marked 'one'. Entity ids affect equivalence at
      // `addBelief/Preference/Identity` time (in-place reinforcement when
      // two calls share an entity_id under the same slot); `reconcile()`
      // stays slot-based because a 'one' slot means "exactly one active
      // fact" regardless of which entity it refers to.
      const buckets = new Map();
      for (const fact of collection) {
        if (fact.valid_to) continue;
        const key = (keyFn(fact) || '').toLowerCase();
        if (!key) continue;
        const rule = ruleMap[key] || ruleMap[keyFn(fact)]; // exact-case fallback
        if (rule !== 'one') continue;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(fact);
      }

      let invalidated = 0;
      for (const group of buckets.values()) {
        if (group.length < 2) continue;
        // Sort by valid_from ascending, keep newest, close the rest at the
        // newest's valid_from (so the timeline is a clean handoff).
        group.sort((a, b) => {
          const aT = a.valid_from ? new Date(a.valid_from).getTime() : 0;
          const bT = b.valid_from ? new Date(b.valid_from).getTime() : 0;
          return aT - bT;
        });
        const newest = group[group.length - 1];
        for (const older of group.slice(0, -1)) {
          older.valid_to = newest.valid_from || new Date().toISOString();
          older.invalidation_reason = older.invalidation_reason || 'reconciled';
          invalidated += 1;
        }
      }
      return invalidated;
    };

    return {
      beliefs_invalidated: sweep(this.user.beliefs, merged.beliefs, f => f.topic),
      preferences_invalidated: sweep(this.user.preferences, merged.preferences, f => f.type),
      identities_invalidated: sweep(this.user.identities, merged.identities, f => f.role),
    };
  }

  // ── Entity resolution (alias clustering) ───────────────

  /**
   * Resolve a label to a canonical entity id, creating one if no match
   * exists. Matching tiers, in order:
   *
   *   1. Exact match (case-insensitive, whitespace-normalised) on canonical
   *      or any alias.
   *   2. Acronym match: "BSB" matches "British School Barcelona" when every
   *      letter of the shorter form is the first letter of a significant
   *      word in the longer form (in order).
   *   3. Embedding similarity ≥ `threshold` — only when an embeddings
   *      provider is available and the shorter label is non-trivial
   *      (>=3 chars). Skipped silently otherwise.
   *
   * The aliases list on the matched entity grows with every novel phrasing
   * seen, so "her school" alongside existing "British School Barcelona" +
   * "BSB" converges to a single entity with three aliases after three
   * resolutions.
   *
   * Works regardless of `entityResolution.enabled` — that flag only gates
   * whether the ingest pipeline calls this method automatically. Consumers
   * can always call it by hand.
   *
   * @param {string} label
   * @param {Object} [opts]
   * @param {Float32Array} [opts.embedding] - Pre-computed embedding for `label`.
   *   Reuse across many calls by passing it explicitly — skips one API call.
   * @param {Object} [opts.embeddings] - Provider override; defaults to the
   *   module-level singleton.
   * @param {number} [opts.threshold] - Overrides `entityResolution.threshold`.
   * @returns {Promise<{ id: string, canonical: string, matched_via: 'exact'|'acronym'|'embedding'|'created' }>}
   */
  async resolveEntity(label, opts = {}) {
    const text = String(label || '').trim();
    if (!text) throw new Error('resolveEntity: empty label');
    if (!Array.isArray(this.user.entities)) this.user.entities = [];

    const norm = this.#normalizeLabel(text);

    // Tier 1: exact (canonical or alias, case-insensitive)
    for (const ent of this.user.entities) {
      if (this.#normalizeLabel(ent.canonical) === norm) {
        return { id: ent.id, canonical: ent.canonical, matched_via: 'exact' };
      }
      if ((ent.aliases || []).some(a => this.#normalizeLabel(a) === norm)) {
        return { id: ent.id, canonical: ent.canonical, matched_via: 'exact' };
      }
    }

    // Tier 2: acronym (handles "BSB" ↔ "British School Barcelona")
    for (const ent of this.user.entities) {
      const candidates = [ent.canonical, ...(ent.aliases || [])];
      for (const cand of candidates) {
        if (this.#isAcronymMatch(text, cand) || this.#isAcronymMatch(cand, text)) {
          // Record the novel phrasing so future exact-match calls hit.
          if (!ent.aliases?.some(a => this.#normalizeLabel(a) === norm)) {
            ent.aliases = [...(ent.aliases || []), text];
          }
          return { id: ent.id, canonical: ent.canonical, matched_via: 'acronym' };
        }
      }
    }

    // Tier 3: embedding similarity. Skip gracefully when no provider.
    const threshold = opts.threshold ?? this.entityResolution.threshold;
    const provider = opts.embeddings || defaultEmbeddings;
    let embedding = opts.embedding;
    if (!embedding && text.length >= 3 && provider && typeof provider.embed === 'function') {
      try { embedding = await provider.embed(text); } catch { embedding = null; }
    }
    if (embedding && embedding.length > 0) {
      let best = null;
      let bestScore = -Infinity;
      for (const ent of this.user.entities) {
        if (!ent.embedding || ent.embedding.length === 0) continue;
        const entVec = ent.embedding instanceof Float32Array
          ? ent.embedding
          : Float32Array.from(ent.embedding);
        if (entVec.length !== embedding.length) continue;
        const sim = this.#cosineSimilarity(embedding, entVec);
        if (sim > bestScore) { best = ent; bestScore = sim; }
      }
      if (best && bestScore >= threshold) {
        if (!best.aliases?.some(a => this.#normalizeLabel(a) === norm)) {
          best.aliases = [...(best.aliases || []), text];
        }
        return { id: best.id, canonical: best.canonical, matched_via: 'embedding' };
      }
    }

    // No match — create a new canonical entity. Persist embedding as a plain
    // array so it survives JSON.stringify; rehydrated to Float32Array on use.
    const id = `ent_${Date.now()}_${this.user.entities.length}`;
    const record = {
      id,
      canonical: text,
      aliases: [],
      ...(embedding && embedding.length > 0 ? { embedding: Array.from(embedding) } : {}),
    };
    this.user.entities.push(record);
    return { id, canonical: text, matched_via: 'created' };
  }

  /**
   * Manually register that `alias` refers to the same entity as `canonical`.
   * Creates the canonical entity on the fly if it doesn't yet exist. Useful
   * when the consumer has prior knowledge that the automatic tiers would miss
   * (e.g. project code-names, personal nicknames).
   *
   * @param {string} canonical
   * @param {string} alias
   * @returns {string} the entity id
   */
  registerEntityAlias(canonical, alias) {
    if (!Array.isArray(this.user.entities)) this.user.entities = [];
    const normCanonical = this.#normalizeLabel(canonical);
    let ent = this.user.entities.find(e => this.#normalizeLabel(e.canonical) === normCanonical);
    if (!ent) {
      ent = { id: `ent_${Date.now()}_${this.user.entities.length}`, canonical, aliases: [] };
      this.user.entities.push(ent);
    }
    const normAlias = this.#normalizeLabel(alias);
    if (!ent.aliases.some(a => this.#normalizeLabel(a) === normAlias)) {
      ent.aliases.push(alias);
    }
    return ent.id;
  }

  /**
   * Look up an entity by id.
   * @param {string} id
   * @returns {Object|null}
   */
  getEntity(id) {
    return (this.user.entities || []).find(e => e.id === id) || null;
  }

  #normalizeLabel(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /**
   * True if `short` is a plausible acronym of `long`. Matches the uppercase
   * letters of `short` against the first letter of each significant word in
   * `long` (skipping short stopwords like 'of', 'the', 'and'). Case-sensitive
   * on `short` to avoid matching lowercase coincidences like "bsb" against
   * "blue sandy beach".
   */
  #isAcronymMatch(short, long) {
    if (!short || !long) return false;
    const clean = short.replace(/[^A-Za-z]/g, '');
    if (clean.length < 2 || clean.length > 6) return false;
    if (clean !== clean.toUpperCase()) return false; // must be all-caps to count as acronym
    const words = long.split(/\s+/).filter(w => w.length > 0 && !_STOPWORDS.has(w.toLowerCase()));
    if (words.length < clean.length) return false;
    const firstLetters = words.slice(0, clean.length).map(w => w[0].toUpperCase()).join('');
    return firstLetters === clean;
  }

  /**
   * Get active identity attributes
   * @param {string} [asOf] - ISO date; defaults to now
   * @returns {Array} Active identity attributes
   */
  getIdentities(asOf) {
    return this.getActiveIdentities(asOf);
  }

  /**
   * Return all identities that are currently active.
   * Adds `effective_strength` (derived from `salience`) and `age_days`.
   *
   * @param {string} [asOf] - ISO date; defaults to now
   * @param {Object} [opts]
   * @returns {Array} Active identities with computed freshness fields
   */
  getActiveIdentities(asOf, opts = {}) {
    return this.#filterActive(this.user.identities, asOf, opts);
  }

  /**
   * Set confidence in a domain (how sure user is about their knowledge)
   * @param {string} domain - Domain (e.g., "AI", "finance", "biology")
   * @param {number} confidence - Confidence level (0-1)
   */
  setDomainConfidence(domain, confidence) {
    this.user.confidence[domain] = Math.max(0, Math.min(1, confidence));
  }

  /**
   * Get confidence in a domain
   * @param {string} domain - Domain to query
   * @returns {number} Confidence level (0-1, defaults to 0.5)
   */
  getDomainConfidence(domain) {
    return this.user.confidence[domain] ?? 0.5;
  }

  /**
   * Get all typed memory nodes as a summary
   * @returns {Object} Summary of beliefs, preferences, identities, confidence
   */
  getMemoryNodesSummary() {
    const activeBeliefs = this.getActiveBeliefs();
    const activePreferences = this.getActivePreferences();
    const activeIdentities = this.getActiveIdentities();
    return {
      beliefs: activeBeliefs,
      preferences: activePreferences,
      identities: activeIdentities,
      confidence: this.user.confidence,
      total_beliefs: activeBeliefs.length,
      total_beliefs_all: this.user.beliefs.length,
      total_preferences: activePreferences.length,
      total_preferences_all: this.user.preferences.length,
      total_identities: activeIdentities.length,
      total_identities_all: this.user.identities.length,
      domains_with_confidence: Object.keys(this.user.confidence).length
    };
  }

  /**
   * Get the last insight enrichment result (for debugging/monitoring).
   * @returns {Object|null} Last TopicInsightEngine result
   */
  getLastInsightResult() {
    return this._lastInsightResult;
  }

  // ── Temporal Query Helpers ─────────────────────────────

  /**
   * Get a full snapshot of the user's state at a specific point in time.
   * Returns beliefs, preferences, and identities that were active at `asOf`.
   *
   * @param {string} asOf - ISO date string
   * @returns {Object} { beliefs, preferences, identities, timestamp }
   */
  getStateAt(asOf) {
    return {
      beliefs: this.getActiveBeliefs(asOf),
      preferences: this.getActivePreferences(asOf),
      identities: this.getActiveIdentities(asOf),
      timestamp: asOf,
    };
  }

  /**
   * Invalidate a fact by setting its valid_to date.
   * Works on beliefs, preferences, and identities.
   *
   * @param {string} type - 'belief' | 'preference' | 'identity'
   * @param {string} topic - The topic/type/role to invalidate
   * @param {string} [reason] - Why this fact was invalidated
   * @returns {boolean} Whether a fact was invalidated
   */
  invalidateFact(type, topic, reason) {
    const now = new Date().toISOString();
    const topicLower = topic.toLowerCase();
    let collection;

    if (type === 'belief') collection = this.user.beliefs;
    else if (type === 'preference') collection = this.user.preferences;
    else if (type === 'identity') collection = this.user.identities;
    else return false;

    let invalidated = false;
    for (const item of collection) {
      const key = item.topic || item.type || item.role || '';
      if (key.toLowerCase() === topicLower && !item.valid_to) {
        item.valid_to = now;
        item.invalidation_reason = reason || null;
        invalidated = true;
      }
    }
    return invalidated;
  }

  /**
   * Get the history of a specific fact over time (all versions, including superseded).
   *
   * @param {string} type - 'belief' | 'preference' | 'identity'
   * @param {string} topic - The topic/type/role
   * @returns {Array} All versions sorted by valid_from ascending
   */
  getFactHistory(type, topic) {
    const topicLower = topic.toLowerCase();
    let collection;

    if (type === 'belief') collection = this.user.beliefs;
    else if (type === 'preference') collection = this.user.preferences;
    else if (type === 'identity') collection = this.user.identities;
    else return [];

    return collection
      .filter(item => {
        const key = item.topic || item.type || item.role || '';
        return key.toLowerCase() === topicLower;
      })
      .sort((a, b) => {
        const aTime = a.valid_from ? new Date(a.valid_from).getTime() : 0;
        const bTime = b.valid_from ? new Date(b.valid_from).getTime() : 0;
        return aTime - bTime;
      });
  }

  // ── Emotion Encoding ──────────────────────────────────

  /**
   * Add emotion tags to a KG node (belief, preference, or identity).
   * Emotions use a universal vocabulary: joy, fear, trust, frustration,
   * hope, anxiety, pride, shame, curiosity, boredom, anger, love,
   * grief, wonder, peace.
   *
   * @param {string} type - 'belief' | 'preference' | 'identity'
   * @param {string} topic - The topic/type/role to tag
   * @param {string[]} emotions - Array of emotion codes
   */
  tagEmotions(type, topic, emotions) {
    const topicLower = topic.toLowerCase();
    let collection;

    if (type === 'belief') collection = this.user.beliefs;
    else if (type === 'preference') collection = this.user.preferences;
    else if (type === 'identity') collection = this.user.identities;
    else return;

    for (const item of collection) {
      const key = item.topic || item.type || item.role || '';
      if (key.toLowerCase() === topicLower && !item.valid_to) {
        item.emotions = [...new Set([...(item.emotions || []), ...emotions])];
      }
    }
  }

  /**
   * Get all nodes tagged with a specific emotion.
   *
   * @param {string} emotion - Emotion code to search for
   * @returns {Array<{ type: string, item: Object }>}
   */
  getByEmotion(emotion) {
    const emotionLower = emotion.toLowerCase();
    const results = [];

    for (const b of this.getActiveBeliefs()) {
      if (b.emotions?.some(e => e.toLowerCase() === emotionLower)) {
        results.push({ type: 'belief', item: b });
      }
    }
    for (const p of this.getActivePreferences()) {
      if (p.emotions?.some(e => e.toLowerCase() === emotionLower)) {
        results.push({ type: 'preference', item: p });
      }
    }
    for (const i of this.getActiveIdentities()) {
      if (i.emotions?.some(e => e.toLowerCase() === emotionLower)) {
        results.push({ type: 'identity', item: i });
      }
    }

    return results;
  }

  // ── Native Vector Index ───────────────────────────────

  /**
   * Add a single node to the in-process vector index.
   * @param {string} nodeId - Unique node identifier
   * @param {Float32Array} embedding - Pre-computed embedding vector
   * @param {Object} meta - Node metadata { type, node, text }
   */
  indexNode(nodeId, embedding, meta) {
    this._vectorIndex.set(nodeId, embedding);
    this._vectorIndexMeta.set(nodeId, meta);
  }

  /**
   * Build the vector index from all current KG nodes (interests, beliefs, preferences, identities).
   * Embeds each node's text representation and stores it in the in-memory index.
   * @param {Object} [provider] - Embeddings provider (defaults to module-level singleton)
   * @returns {Promise<number>} Number of nodes indexed
   */
  async buildVectorIndex(provider = null) {
    const emb = provider || defaultEmbeddings;
    this._vectorIndex.clear();
    this._vectorIndexMeta.clear();

    const entries = [];  // { nodeId, text, type, node }

    for (const [i, interest] of (this.user.interests || []).entries()) {
      entries.push({
        nodeId: `interest:${i}`,
        text: `interest in ${interest.topic}`,
        type: 'interest',
        node: interest,
      });
    }

    for (const [i, belief] of (this.user.beliefs || []).entries()) {
      const text = belief.claim
        ? `belief: ${belief.topic} - ${belief.claim}`
        : `belief: ${belief.topic}`;
      entries.push({ nodeId: `belief:${i}`, text, type: 'belief', node: belief });
    }

    for (const [i, pref] of (this.user.preferences || []).entries()) {
      entries.push({
        nodeId: `preference:${i}`,
        text: `preference: ${pref.type} ${pref.description}`,
        type: 'preference',
        node: pref,
      });
    }

    for (const [i, identity] of (this.user.identities || []).entries()) {
      const text = identity.context
        ? `identity: ${identity.role} ${identity.context}`
        : `identity: ${identity.role}`;
      entries.push({ nodeId: `identity:${i}`, text, type: 'identity', node: identity });
    }

    if (entries.length === 0) return 0;

    const texts = entries.map(e => e.text);
    const vecs = await emb.embedBatch(texts);

    for (let i = 0; i < entries.length; i++) {
      const { nodeId, text, type, node } = entries[i];
      if (vecs[i] && vecs[i].length > 0) {
        this.indexNode(nodeId, vecs[i], { type, node, text });
      }
    }

    return this._vectorIndex.size;
  }

  /**
   * Semantic search over indexed KG nodes using cosine similarity.
   * Returns the top-K nodes most similar to the query.
   * @param {string} query - Free-text query
   * @param {number} [topK=5] - Number of results to return
   * @param {Object} [provider] - Embeddings provider (defaults to module-level singleton)
   * @returns {Promise<Array<{nodeId, similarity, type, node, text}>>}
   */
  async semanticSearch(query, topK = 5, provider = null) {
    if (this._vectorIndex.size === 0) return [];

    const emb = provider || defaultEmbeddings;
    const queryVec = await emb.embed(query);

    if (!queryVec || queryVec.length === 0) return [];

    const results = [];
    for (const [nodeId, nodeVec] of this._vectorIndex) {
      if (nodeVec.length !== queryVec.length) continue;
      const similarity = this.#cosineSimilarity(queryVec, nodeVec);
      const meta = this._vectorIndexMeta.get(nodeId);
      results.push({ nodeId, similarity, ...meta });
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK);
  }

  /**
   * Get tracked dimensional preferences
   * @param {string} [domain] - Optional domain filter
   * @returns {Array} DimensionalPreference objects
   */
  getDimensionalPreferences(domain) {
    if (!domain) return this._dimensionalPreferences;
    return this._dimensionalPreferences.filter(p => p.domain === domain);
  }

  // ── Private ──────────────────────────────────────────

  #cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);
    return normA === 0 || normB === 0 ? 0 : dot / (normA * normB);
  }

  #applyDecay(interest) {
    const daysSinceBoost = (Date.now() - new Date(interest.last_boost).getTime()) / 86400000;
    const halfLife = 14; // 2 weeks half-life
    const decayFactor = Math.pow(0.5, daysSinceBoost / halfLife);
    return interest.weight * decayFactor;
  }

  /**
   * Track dimensional preferences from entity attributes (DimensionalPreference type)
   * @private
   */
  #trackDimensionalPreferences(domain, attributes, reaction) {
    const isPositive = reaction === 'up' || reaction === 'share';
    const strengthDelta = isPositive ? 0.15 : -0.10;

    for (const [kgKey, attrList] of Object.entries(attributes)) {
      for (const attr of attrList) {
        const existing = this._dimensionalPreferences.find(
          p => p.domain === domain && p.dimensionId === kgKey && p.value === attr.value
        );
        if (existing) {
          existing.strength = Math.max(-1, Math.min(1, existing.strength + strengthDelta));
          existing.evidenceCount++;
          existing.confidence = Math.min(1, existing.evidenceCount * 0.2);
        } else {
          this._dimensionalPreferences.push({
            domain,
            dimensionId: kgKey,
            value: attr.value,
            strength: isPositive ? 0.6 : -0.3,
            source: 'implicit',
            confidence: 0.2,
            evidenceCount: 1,
            collectedAt: new Date().toISOString()
          });
        }
      }
    }
  }

  #updateSourceTrust(source, reaction) {
    const current = this.user.source_trust[source] ?? 0.5;
    if (reaction === 'up' || reaction === 'share') {
      this.user.source_trust[source] = Math.min(1, current + 0.02);
    } else if (reaction === 'down') {
      this.user.source_trust[source] = Math.max(0, current - 0.03);
    }
  }

  #defaultUser() {
    return {
      id: 'default',
      interests: [],
      context: {
        calendar: [],
        active_projects: [],
        recent_conversations: [],
        mood_signal: null
      },
      history: [],
      source_trust: {},
      // Layer 1: Typed Memory Nodes
      beliefs: [],        // Core beliefs: { topic, claim, strength (0-1), evidence_count, evidence: [episode_id] }
      preferences: [],    // Explicit preferences: { type, description, strength (0-1), evidence: [episode_id] }
      identities: [],     // Identity attributes: { role, context, salience (0-1), evidence: [episode_id] }
      confidence: {},     // Confidence by domain: { domain: confidence_score (0-1) }
      clones: [],         // UserClone hypothesis array
      episodes: [],       // Source records: { id, source, source_date, ingested_at, content_hash, content_summary?, metadata? }
      entities: []        // Canonical entities: { id, canonical, aliases: [], embedding? } — collapses "BSB" ↔ "British School Barcelona"
    };
  }

  // ── UserClone: competing hypothesis layer ────────────────────────────────

  /** @returns {import('./types.js').UserClone[]} */
  getActiveClones() {
    return this.user.clones?.filter(c => c.status === 'active') || [];
  }

  /** @param {import('./types.js').UserClone} clone */
  saveClone(clone) {
    if (!this.user.clones) this.user.clones = [];
    const idx = this.user.clones.findIndex(c => c.id === clone.id);
    if (idx !== -1) {
      this.user.clones[idx] = clone;
    } else {
      this.user.clones.push(clone);
    }
  }

  killClone(cloneId) {
    const clone = this.user.clones?.find(c => c.id === cloneId);
    if (clone) clone.status = 'killed';
  }

  /**
   * Seed UserClone archetypes from knowledge gaps.
   * Each gap becomes one or more clones with concrete kgOverrides representing
   * a specific hypothesis about how that gap resolves.
   *
   * Two prompt paths:
   *   - Cold start (no gaps yet): asks for a small number of short archetypes
   *     derived from known interests/preferences, with a tight token budget.
   *     This is the very first `learn()` call on a user — trying to reason
   *     about "unknown gaps" from near-empty data makes LLMs ramble or emit
   *     prose; the short-form prompt keeps them on-task.
   *   - Warm path (gaps present): full archetype prompt, generous budget.
   *
   * @param {Object} llm - LLM client from llm-provider.js
   * @param {string} model
   * @param {Object} [opts]
   * @param {number} [opts.maxTokens=8192] - LLM max_tokens. Default is 8192
   *   because the prompt asks for nested JSON (arrays of beliefs/preferences/
   *   identities) and any meaningful archetype easily exceeds 4096 tokens
   *   mid-structure on typical providers. Lower only if your provider caps
   *   below 8192.
   * @param {number} [opts.coldStartMaxTokens=1500] - Tighter budget for the
   *   cold-start branch where the prompt explicitly requests brevity.
   * @returns {Promise<import('./types.js').UserClone[]>}
   */
  async seedClones(llm, model, opts = {}) {
    const maxTokens = opts.maxTokens ?? 8192;
    const coldStartMaxTokens = opts.coldStartMaxTokens ?? 1500;

    // Read gaps stored by CuriosityLoop (beliefs with key starting with gap:)
    const gapBeliefs = (this.user.beliefs || []).filter(b => b.topic?.startsWith('gap:'));
    const gaps = gapBeliefs.map(b => b.claim ?? b.value ?? b.topic.replace('gap:', ''));

    const known = {
      beliefs: this.user.beliefs?.filter(b => !b.topic?.startsWith('gap:')).slice(0, 5),
      preferences: this.user.preferences?.slice(0, 5),
      identities: this.user.identities?.slice(0, 3),
      interests: this.user.interests?.slice(0, 5),
    };

    const isColdStart = gaps.length === 0;
    const prompt = isColdStart
      ? `You are building an archetype model of a user from sparse initial data.

Known facts about the user:
${JSON.stringify(known, null, 2)}

Produce exactly 2 short archetype hypotheses that represent meaningfully different plausible versions of this user based on the known data. Keep it compact — no more than 3 beliefs, 3 preferences, and 2 identities per archetype. Keep the total response under ${Math.floor(coldStartMaxTokens * 0.6)} tokens.

Return a JSON array. Each element:
{
  "gap": "<one-line open question about this user>",
  "hypothesis": "<short description of this user variant>",
  "kgOverrides": {
    "beliefs": [{ "topic": "...", "value": "...", "confidence": 0.7 }],
    "preferences": [{ "category": "...", "value": "...", "strength": 0.7 }],
    "identities": [{ "role": "...", "value": "...", "salience": 0.7 }]
  },
  "confidence": 0.5
}

Return ONLY the JSON array. No prose, no explanation.`
      : `You are building an archetype model of a user.

Known facts about the user:
${JSON.stringify(known, null, 2)}

Unresolved knowledge gaps:
${gaps.map((g, i) => `${i + 1}. ${g}`).join('\n')}

For each gap, create 1–2 concrete archetype hypotheses that represent meaningfully different versions of this user. Each hypothesis must include specific kgOverrides — concrete beliefs, preferences, and identities this version of the user would hold.

Return a JSON array. Each element:
{
  "gap": "<the gap question>",
  "hypothesis": "<concrete description of this user variant>",
  "kgOverrides": {
    "beliefs": [{ "topic": "...", "value": "...", "confidence": 0.7 }],
    "preferences": [{ "category": "...", "value": "...", "strength": 0.7 }],
    "identities": [{ "role": "...", "value": "...", "salience": 0.7 }]
  },
  "confidence": 0.5
}

Return ONLY the JSON array. No explanation.`;

    const resp = await llm.messages.create({
      model,
      max_tokens: isColdStart ? coldStartMaxTokens : maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = resp?.content?.[0]?.text;
    const raw = _extractJSON(text, 'array');
    if (!raw || !Array.isArray(raw)) {
      const err = new Error(
        '[kg.seedClones] LLM response did not contain a parseable JSON array. ' +
        'Check LLM output length/truncation or provider health.'
      );
      err.stage = 'seedClones';
      err.code = 'LLM_UNPARSEABLE';
      console.warn(err.message + ' — skipping seed.');
      // Attach the failure to the KG so `learn()` can surface it without
      // changing the array-return contract of this method.
      this._lastSeedCloneError = err;
      return [];
    }
    this._lastSeedCloneError = null;
    const now = Date.now();
    return raw.map((h, i) => ({
      id: `clone_seed_${now}_${i}`,
      gap: h.gap || '',
      hypothesis: h.hypothesis,
      kgOverrides: _normalizeKgOverrides(h.kgOverrides),
      confidence: h.confidence ?? 0.5,
      evaluations: [],
      spawnedFrom: null,
      generation: 0,
      createdAt: now,
      lastScoredAt: now,
      status: 'active',
    }));
  }

  updateCloneConfidence(cloneId, predictionCorrect) {
    const clone = this.user.clones?.find(c => c.id === cloneId);
    if (!clone) return;
    const lr = 0.1;
    clone.confidence = predictionCorrect
      ? Math.min(1, clone.confidence + lr * (1 - clone.confidence))
      : Math.max(0, clone.confidence - lr * clone.confidence);
    clone.lastScoredAt = Date.now();
  }

  killWeakClones() {
    for (const clone of this.user.clones || []) {
      if (clone.status === 'active' && clone.evaluations.length >= 10 && clone.confidence < 0.15) {
        clone.status = 'killed';
      }
    }
  }

  /**
   * Breed a neighbouring archetype from every strong clone (confidence > 0.75).
   *
   * @param {Object} llm - LLM client from llm-provider.js
   * @param {string} model
   * @param {Object} [opts]
   * @param {number} [opts.maxTokens=8192] - LLM max_tokens per breed call.
   *   Tighter limits truncate the nested kgOverrides JSON.
   * @returns {Promise<{ bred: number, failures: Error[] }>} Per-call diagnostics —
   *   callers that want to surface degraded runs (e.g. `learn()`) can inspect
   *   `failures` instead of relying on stderr warnings.
   */
  async breedStrongClones(llm, model, opts = {}) {
    const maxTokens = opts.maxTokens ?? 8192;
    const failures = [];
    let bred = 0;

    const strong = this.getActiveClones().filter(c => c.confidence > 0.75);
    for (const parent of strong) {
      const resp = await llm.messages.create({
        model,
        max_tokens: maxTokens,
        messages: [{
          role: 'user',
          content: `A user archetype hypothesis has proven strong (confidence > 0.75):

Gap: "${parent.gap}"
Hypothesis: "${parent.hypothesis}"
Current kgOverrides: ${JSON.stringify(parent.kgOverrides, null, 2)}

Generate 1 neighbouring archetype variant — a plausible evolution or refinement of this hypothesis. It must differ meaningfully in at least one kgOverride dimension.

Return JSON:
{
  "gap": "${parent.gap}",
  "hypothesis": "<refined description>",
  "kgOverrides": {
    "beliefs": [{ "topic": "...", "value": "...", "confidence": 0.7 }],
    "preferences": [{ "category": "...", "value": "...", "strength": 0.7 }],
    "identities": [{ "role": "...", "value": "...", "salience": 0.7 }]
  },
  "confidence": 0.5
}

Return ONLY the JSON object.`,
        }],
      });
      const raw = _extractJSON(resp?.content?.[0]?.text, 'object');
      if (!raw || typeof raw !== 'object') {
        const err = new Error(
          `[kg.breedStrongClones] LLM response for parent "${parent.id}" did not contain ` +
          'parseable JSON object — skipping this parent. Check for truncation or prose wrapping.'
        );
        err.stage = 'breedStrongClones';
        err.code = 'LLM_UNPARSEABLE';
        err.parentId = parent.id;
        console.warn(err.message);
        failures.push(err);
        continue;
      }
      this.saveClone({
        id: `clone_bred_${Date.now()}`,
        gap: raw.gap || parent.gap || '',
        hypothesis: raw.hypothesis,
        kgOverrides: _normalizeKgOverrides(raw.kgOverrides),
        confidence: raw.confidence ?? 0.5,
        evaluations: [],
        spawnedFrom: parent.id,
        generation: (parent.generation || 0) + 1,
        createdAt: Date.now(),
        lastScoredAt: Date.now(),
        status: 'active',
      });
      bred += 1;
    }
    return { bred, failures };
  }
}
