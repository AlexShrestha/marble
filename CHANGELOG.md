# Changelog

All notable changes to Marble will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — Provider generalization (OOTB integration pass 2)

- **New `openai-compatible` LLM provider.** Any OpenAI-compatible host
  (Moonshot/Kimi, Together, Fireworks, Groq, OpenRouter, Azure OpenAI,
  self-hosted vLLM, etc.) is now a first-class citizen. Set
  `LLM_PROVIDER=openai-compatible`, `LLM_BASE_URL`, `LLM_API_KEY`, and
  `MARBLE_LLM_MODEL`. No more hijacking the `deepseek` provider to route
  through third-party endpoints.
- **Explicit Ollama opt-in.** The old heuristic in `_buildDeepSeekClient`
  — "any non-DeepSeek base URL must be Ollama" — hijacked every
  OpenAI-compatible endpoint that users pointed `DEEPSEEK_BASE_URL` at.
  Ollama routing now requires either `DEEPSEEK_IS_OLLAMA=1` or a base URL
  whose path looks like Ollama's native shape (`/api`, no `/v1`). Non-matching
  URLs go through the standard OpenAI SDK path.
- **Retry with exponential backoff on transient failures.** Both
  `embeddings.embed()` and the OpenAI-compatible chat wrapper now retry
  429/408/409/425/5xx responses and network errors three times (250ms, 1s,
  4s), honoring `Retry-After` headers. 4xx client errors (400, 401, 403,
  404, 422) are not retried. Previously a single 429 downgraded scorer
  quality silently for the rest of the run.
- **Dedicated embeddings env vars for split-provider setups.**
  `OPENAI_EMBEDDINGS_API_KEY`, `OPENAI_EMBEDDINGS_BASE_URL`, and
  `OPENAI_EMBEDDINGS_MODEL` let callers point embeddings at real OpenAI
  while chat goes through an OpenAI-compatible proxy (or vice versa).
  When unset, `OPENAI_API_KEY` / `OPENAI_EMBEDDING_MODEL` are used as
  fallback so existing configs keep working unchanged.

### Fixed — Install-time blockers (OOTB integration pass 1)

- **`.env.example` no longer misrepresents the default embeddings provider.**
  The old default `EMBEDDINGS_PROVIDER=local` claimed "no API key needed"
  but was falling through to `NullEmbeddings` with a single easy-to-miss warning
  (local ONNX embeddings were removed). Default is now `openai` with an explicit
  `OPENAI_API_KEY` requirement, and `EMBEDDINGS_PROVIDER=none` is documented as
  the explicit keyword-only opt-in.
- **Louder failure when embeddings fail to initialize.** The module-level
  singleton now emits a prominent one-time boxed warning that names the problem
  and the fix. Integrators who request `EMBEDDINGS_PROVIDER=none` or pass their
  own `{ embeddings: ... }` to the constructor see no warning.
- **`KnowledgeGraph#seedClones` and `#breedStrongClones` no longer crash on
  malformed LLM output.** Both sites used `text.match(/.../)[0]` which threw
  `Cannot read properties of null` on empty/prose/truncated completions.
  Replaced with a tolerant `_extractJSON(text, shape)` helper; failures now log
  a clear warning and skip the bad response rather than aborting `learn()`.
- **`max_tokens` raised on both clone prompts.** `seedClones` 1200 → 4096 and
  `breedStrongClones` 600 → 4096 — the old limits routinely truncated nested
  JSON responses. Both are now overridable via an `{ maxTokens }` option for
  providers with lower ceilings.
- **`embeddings` option on `new Marble()` now threads through to the Scorer.**
  Previously the constructor accepted `embeddings` but the Scorer imported the
  module singleton unconditionally — custom providers (for caching, retries,
  alternative hosts) were silently ignored. Scorer constructor accepts
  `{ embeddings }` as an option; `new Marble({ embeddings })` wires it through.
- **Construction-time warnings de-duplicated across instances.** "No LLM
  provider configured" and "No embeddings configured" warnings now fire at most
  once per process, not once per `new Marble()`. Batch workloads that spin up
  one instance per user/request/session no longer flood stderr.
- **New `silent: true` constructor option** suppresses the above warnings
  entirely for callers that know what they're doing.

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
