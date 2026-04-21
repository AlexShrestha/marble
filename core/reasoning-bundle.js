/**
 * reasoning-bundle.js — canonical intermediate format for Marble's
 * reasoning layers.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Pre-bundle, each layer spoke its own dialect: `runInsightSwarm()` returned
 * `Insight[]`, `InferenceEngine.run()` returned `Candidate[]`,
 * `InvestigativeCommittee.investigate()` returned `{ answered, gaps, ... }`.
 * Wiring them together in `learn()` required bespoke glue per layer, and
 * adding a fourth layer meant rewriting the glue.
 *
 * The MarbleReasoningBundle is a single object that every layer can read
 * from and every layer can write to. `learn()` maintains one per-run
 * bundle, populates it from each stage's output, and returns it to the
 * caller. A new layer plugs in by reading fields from the bundle and
 * adding its own — no orchestrator changes required.
 *
 * SHAPE
 * ─────
 *   {
 *     // L1 snapshot — the inputs every reasoning layer should start from.
 *     // These are immutable across a single `learn()` run.
 *     beliefs:       Object[],
 *     preferences:   Object[],
 *     identities:    Object[],
 *     interests:     Object[],
 *     episodes_sample: Object[],   // N most recent, for context
 *
 *     // Layer outputs — populated as each stage fires. Empty arrays if a
 *     // stage didn't run or returned nothing.
 *     insights:   Object[],        // L1.5 InsightSwarm
 *     hypotheses: Object[],        // L2 InferenceEngine candidates
 *     gaps:       Object[],        // L3/L4 InvestigativeCommittee gaps
 *     findings:   Object[],        // L3/L4 committee answered questions
 *
 *     // Provenance — which layers have contributed, in order. Consumers
 *     // that want to know "did the swarm fire?" check this rather than
 *     // inferring from empty arrays.
 *     layers_fired: string[],
 *     generated_at: string,        // ISO
 *
 *     // Custom-layer products — any extraStages can stash their output
 *     // here keyed by layer name so they don't collide with core fields.
 *     extensions: { [layerName: string]: any },
 *   }
 *
 * ADDING A LAYER
 * ──────────────
 *   marble.learn({
 *     extraStages: [
 *       async function myLayer(bundle, kg) {
 *         // read bundle.beliefs / bundle.insights / ...
 *         // stash your output:
 *         bundle.extensions.myLayer = { ... };
 *       }
 *     ]
 *   });
 *
 * The stage function's `name` is recorded in `layers_fired`. Use a named
 * function (or `Object.defineProperty(fn, 'name', ...)`) for a readable
 * provenance trail.
 */

const DEFAULT_EPISODES_SAMPLE = 25;

/**
 * Build a fresh bundle from the current KG state. L1 fields are filled
 * from `getActive*` views so each stage sees a consistent snapshot with
 * effective_strength + age_days already computed.
 *
 * @param {import('./kg.js').KnowledgeGraph} kg
 * @param {Object} [opts]
 * @param {number} [opts.episodesSample=25] - How many recent episodes to include.
 * @param {string} [opts.asOf] - Historical-mode: build the bundle as-of a timestamp.
 * @returns {Object} Empty-output bundle ready for stages to populate.
 */
export function createReasoningBundle(kg, opts = {}) {
  if (!kg?.user) {
    throw new Error('createReasoningBundle: kg must be loaded (kg.user is null)');
  }
  const episodesSample = opts.episodesSample ?? DEFAULT_EPISODES_SAMPLE;
  const asOf = opts.asOf;

  // Episode sample: most-recent first. Consumers can re-sort or filter
  // further — we just bound the context size so bundles stay printable.
  const episodes = kg.user.episodes || [];
  const episodes_sample = episodes
    .slice()
    .sort((a, b) => {
      const aT = a.source_date ? new Date(a.source_date).getTime() : 0;
      const bT = b.source_date ? new Date(b.source_date).getTime() : 0;
      return bT - aT;
    })
    .slice(0, episodesSample);

  return {
    beliefs: kg.getActiveBeliefs(asOf, { minEffectiveStrength: 0 }),
    preferences: kg.getActivePreferences(asOf, { minEffectiveStrength: 0 }),
    identities: kg.getActiveIdentities(asOf, { minEffectiveStrength: 0 }),
    interests: kg.user.interests || [],
    episodes_sample,

    insights: [],
    hypotheses: [],
    gaps: [],
    findings: [],

    layers_fired: [],
    generated_at: new Date().toISOString(),
    extensions: {},
  };
}

/**
 * Mark a layer as having contributed and (optionally) merge its output into
 * the bundle. The layer's name appears in `layers_fired` for provenance;
 * `contributions` is a partial bundle whose known keys are merged in.
 *
 * Unknown keys land under `extensions[layerName]` so custom layers don't
 * collide with the core field set.
 *
 * @param {Object} bundle
 * @param {string} layerName
 * @param {Object} [contributions]
 */
export function recordLayerContribution(bundle, layerName, contributions = {}) {
  if (!bundle || typeof bundle !== 'object') return;
  if (!Array.isArray(bundle.layers_fired)) bundle.layers_fired = [];
  bundle.layers_fired.push(layerName);

  const knownArrayKeys = ['insights', 'hypotheses', 'gaps', 'findings'];
  const customSlot = {};
  for (const [key, value] of Object.entries(contributions)) {
    if (knownArrayKeys.includes(key) && Array.isArray(value)) {
      bundle[key] = bundle[key].concat(value);
    } else {
      customSlot[key] = value;
    }
  }
  if (Object.keys(customSlot).length > 0) {
    if (!bundle.extensions) bundle.extensions = {};
    bundle.extensions[layerName] = customSlot;
  }
}

/**
 * Produce a compact summary of the bundle suitable for logging. Uses counts
 * rather than full arrays so learn() callers can log one line without
 * JSON.stringifying the whole thing.
 *
 * @param {Object} bundle
 * @returns {Object}
 */
export function summarizeBundle(bundle) {
  if (!bundle) return null;
  return {
    layers_fired: bundle.layers_fired || [],
    beliefs: (bundle.beliefs || []).length,
    preferences: (bundle.preferences || []).length,
    identities: (bundle.identities || []).length,
    insights: (bundle.insights || []).length,
    hypotheses: (bundle.hypotheses || []).length,
    gaps: (bundle.gaps || []).length,
    findings: (bundle.findings || []).length,
    extensions: Object.keys(bundle.extensions || {}),
  };
}
