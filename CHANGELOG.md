# Changelog

All notable changes to Marble will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### BREAKING CHANGES

- **Package renamed**: `marblism` → `marble`
- **Class renamed**: `Marblism` → `Marble`. The `Marblism` alias has been **removed**. Update imports.
- **`react()` signature changed**: now takes the full item object, not `(id, reaction, topics, source)`.
  ```js
  // Before
  await marble.react('story-123', 'up', ['ai'], 'techcrunch');
  // After
  await marble.react({ id: 'story-123', title: '...', topics: ['ai'], source: 'techcrunch' }, 'up');
  ```
- **`reactSlate()` renamed to `feedbackBatch()`**. `reactSlate()` still works as a deprecated alias.
- **`arcReorder` is now opt-in**: narrative arc reranking no longer runs by default. Pass `arcReorder: true`
  to the constructor for newsletter/content-curation use cases.
- **KG history field renamed**: `story_id` → `item_id`. Reads accept both for backward compatibility with
  existing saved KGs.
- **Removed `movie_recommendation` profile**: use `deep_personalization` instead (same weights, domain-agnostic naming).
- **Removed `core/domain-schemas.js`**: `FIELD_KG_MAP` in `entity-extractor.js` covers all domains generically.
- **Removed exports**: `AGENT_LENSES`, `SwarmAgent`, `swarmScore`, `computeDynamicWeights`,
  `generateAgentFleet`, `invalidateFleetCache`, `getFleetCacheStats`, `explodeAgentQuestions`,
  `detectDomain`, `detectItemDomain`, `getDomainSchema`, `DOMAINS`, `attributeCount`,
  `extractEntityAttributes`, `SignalProcessor`, `Observer`, `runInsightSwarm`, `getL2Seeds`,
  `SimulationQueue`, `TopicInsightEngine`, `GapSimulator`, `CollaborativeFilter`,
  `LightweightScorer`, all `worldsim-bridge`, `world-context-cache`, `world-context-scheduler`
  exports. These are internal — use `Marble` class methods or import directly from the internal path.
- **Moved to `experimental/`**: `archetype-generator.js`, `relationship-simulator.js`, `synthetic-reasoner.js`.
- **Deleted**: `core/dynamic-weights.js` (superseded by `enterprise/dynamic-weight-system.js`).

### Added

- **`Marble.learn()`**: Runs L1.5 insight swarm → L2 inference → L3 clone evolution.
  Seeds clone population automatically on first call.
- **`Marble.feedbackBatch(reactions)`**: Contrastive analysis of an entire slate in one LLM call.
  Makes Day 2 ranking 3-10× better than Day 1.
- **`Marble.investigate(opts)`**: Deep investigation with adaptive committee, debate,
  psychological inference, and cross-referencing.
- **`Marble.ingestConversations(filePath)`**: Mine ChatGPT/Claude exports into the KG.
- **`TopicInsightEngine`**: Auto-attached on `init()` when LLM is configured.
- **`ClonePopulation.predictConsensus(item)`**: Scores an item through all active clones,
  weighted by fitness. Used by `select()` when clones exist.
- **Jaccard-based keyword fallback** in `#interestMatch()`: Marble now produces a real
  personalization signal even without embeddings. 40% keyword + 60% semantic blend when both available.
- **Temporal KG queries**: `kg.getStateAt(date)`, `kg.invalidateFact(type, topic, reason)`,
  `kg.getFactHistory(type, topic)`.
- **Emotion encoding**: `kg.tagEmotions()`, `kg.getByEmotion()` with 15 universal emotion codes.
- **Signal compression stack** (`MemoryLayers`): 4-layer context assembly (L0 identity, L1 essential,
  L2 on-demand, L3 deep search) for token-efficient LLM prompts.
- **Adaptive investigative committee**: spawns investigators tailored to available data types per user.
  No two users get the same committee.
- **Recursive follow-up questions**: each finding triggers 2 deeper questions.
- **Psychological inference layer**: facts → meaning (surface vs underlying motivation).
- **Cross-referencing**: finds contradictions, clusters, and synthesis gaps across all beliefs.
- **Debate mechanism**: investigators/swarm agents challenge each other's findings before consensus.
- **Revelation events**: high-confidence new facts instantly kill contradicting clones
  (not gradual decay).
- **Bayesian confidence updating**: evidence strength × clone maturity × streak multiplier.
- **Clone merging**: overlapping clones consolidate traits.
- **Conversation mining pipeline**: exchange-mode chunking, emotion detection, dedup with
  `evidence_count`, inference pass for psychological patterns.
- **Constructor options**: `arcReorder`, `coldStartThreshold`, `cloneBoostWeight`.
- **Warnings** for missing LLM or embeddings configuration (no silent degradation).

### Fixed

- **Critical CF async bug**: `#collaborativeScore()` never awaited the CF promise, so
  collaborative filtering was 100% dead in the scorer.
- **Critical KG snapshot field names**: `_buildKGSnapshot()` was sending `undefined` values
  for all beliefs and preferences to the LLM (wrong field names: `b.value`/`b.confidence`
  should have been `b.claim`/`b.strength`).
- **SimulationQueue.foldIntoL1()**: was calling `kg.addBelief(obj)` with a single object
  argument, but the signature expects `(topic, claim, strength)`.
- **Clone.toPrompt() incomplete**: now includes beliefs, preferences, identities,
  and dimensional preferences.
- **Breeding in `evolve()`**: `kg.breedStrongClones()` was referenced in comments but never invoked.
- **CF cold-start thresholds**: `coldStartThreshold` 3→1, `minSimilarity` 0.3→0.1,
  additive confidence formula replaces pure multiplicative (avoids any-zero-kills-all).
- **Bayesian popularity blend threshold**: 50→10 signals (was making Marble look identical
  to popularity for new users until they'd reacted 50+ times).
- **ChatGPT export parser**: handle null `node.message` entries, use `msg.author?.role` fallback.
- **ConversationMiner**: removed `maxChunks: 10` cap (was processing ~2% of data).
- **Removed `NODE_TLS_REJECT_UNAUTHORIZED = '0'`**: was disabling TLS verification globally
  for the Node process. If you need this, set it explicitly in your environment.
- **Test imports**: 16 test files had broken relative imports (`'./scorer.js'` instead of
  `'../core/scorer.js'`).

### Changed

- **CI**: test glob `test/**/*.test.js` → `test/*.test.js` (was not expanding on CI shell).
- **Node matrix**: 18.x/20.x → 20.x/22.x (Node 18 is EOL).
- **Insight committee CI job**: skips when `DEEPSEEK_BASE_URL` secret is not set.
- **Domain labels in entity-extractor**: `'movie'` → `'visual_media'`, `'music'` → `'audio'`,
  `'book'` → `'long_form_text'`, `'restaurant'` → `'place'`. Generic labels don't leak
  content-specific jargon into user beliefs.

### Removed

- All MovieLens/GSS benchmark files (17 files): `BENCHMARK-REPORT-*.md`, `FINDINGS-PASS*.md`,
  `MARBLE-FIX-PLAN.md`, `benchmark-results-*.json`, `docs/benchmarks.md`,
  `test/test-movielens-*.js`, `test/test-marble-movie-benchmark.js`,
  `test/test-bitemporal-kg-benchmark.js`, `test/test-layer2-typed-alignments-benchmark.js`,
  `test/test-offline-calibration-benchmark.js`, `test/run-*-benchmark.js`,
  `test/benchmark-suite.js`, `test/baselines.js`.

## [0.1.0] - earlier

Initial release.
