# API Reference

## Core: `Marble` class

The main entry point. Import from `marble` or `core/index.js`.

```javascript
import { Marble } from 'marble';
```

### Constructor

```javascript
const marble = new Marble({
  dataPath: './marble-kg.json',  // KG storage path (default: './marble-kg.json')
  count: 10,                      // Number of stories to return (default: 10)
  mode: 'score',                  // 'score' (v1), 'swarm' (v2), or 'local'
  llm: null                       // Optional LLM function for enhanced mode
});
```

### `marble.init()`

Initialize the engine. Loads KG from disk, applies interest decay, sets ready flag.

```javascript
await marble.init();
```

### `marble.select(stories, context) → ScoredStory[]`

Rank stories for a user. This is the main curation method — uses Scorer (v1) or Swarm (v2) depending on `mode`.

**Parameters:**
- `stories` — Array of Story objects
- `context` — User context object (optional)

```javascript
const results = await marble.select(stories, {
  interests: ['AI', 'startups', 'Shopify'],
  calendar: ['investor call 14:00', 'gym 18:00'],
  projects: ['AhaRoll', 'newsletter platform'],
  recent_conversations: ['knowledge graphs']
});
```

**Returns:** Array of scored stories:

```javascript
{
  story: { id, title, summary, source, url, topics, published_at },
  magic_score: 0.82,
  interest_match: 0.75,
  temporal_relevance: 0.9,
  novelty: 0.6,
  actionability: 0.8,
  source_trust: 0.85,
  arc_position: 1,
  why: "High interest match (AI, video) + timing (investor call today)"
}
```

### `marble.react(storyId, reaction, topics, source)`

Record explicit feedback. Updates KG interest weights and source trust.

```javascript
await marble.react('story-123', 'up', ['ai', 'productivity'], 'hackernews');
// reaction: 'up', 'down', 'share'
```

### `marble.signal(storyId, type, data)`

Record implicit signal.

```javascript
await marble.signal('story-456', 'dwell', { duration: 45000 });
await marble.signal('story-789', 'scroll', { depth: 0.9 });
await marble.signal('story-101', 'forward', { count: 1 });
```

### `marble.setContext(context)`

Update the user's daily context (calendar, projects, conversations).

```javascript
marble.setContext({
  calendar: ['standup 09:00', 'demo day 16:00'],
  active_projects: ['newsletter', 'marble'],
  recent_conversations: ['fundraising strategy'],
  mood_signal: 'focused'
});
```

### `marble.save()`

Persist KG state to disk.

```javascript
await marble.save();
```

### `marble.synthesize(opts) → Synthesis[]`

Run **L2 trait synthesis**. Derives structured psychological/behavioral traits from individual facts, then checks across the full KG whether each trait **replicates** across domains (confidence up), gets **contradicted** (surface as first-class gap), or only appears in a **K-way emergent fusion**. Persists results to `kg.user.syntheses[]` and returns the stored records.

Designed to run after `learn()` + `investigate()` so the full multi-layer KG is available as raw material.

**Options** (all optional — see `core/trait-synthesis.js` for full list):

| Option | Default | Purpose |
|---|---|---|
| `perNodeExtraction` | `true` | Phase 1 per-node trait extraction |
| `extractionChunkSize` | `10` | Nodes per LLM call in Phase 1 |
| `fusionSamples` | `5` | Number of K-way emergent-fusion samples |
| `k` | `10` | Nodes per fusion sample |
| `contradictionScan` | `true` | Phase 3 contradiction detection |
| `domainSpread` | `true` | Enforce domain diversity in fusion samples |
| `strengthRange` | `[0.4, 0.9]` | Skip obvious + near-dead nodes |
| `alpha` | `0.15` | Replication-bonus coefficient |
| `beta` | `1.3` | Cross-domain multiplier |
| `gamma` | `0.2` | Contradiction-penalty coefficient |
| `requireSurprising` | `false` | Drop syntheses not flagged surprising |
| `minConfidence` | `0.4` | Drop below threshold |
| `schemaStrict` | `true` | Drop on any required field missing |

```javascript
const syntheses = await marble.synthesize();
// [{ origin: 'trait_replication', trait: { dimension, value, weight }, confidence, ... }, ...]

// Filter by origin after the run
const contradictions = marble.kg.getSyntheses({ origin: 'contradiction' });
```

### `marble.rebuild() → { churnSyntheses, distribution }`

Cheap deterministic pass — no LLM calls. Runs the **churn scan** (slots reassigned ≥3 times in 180d emit `origin: "churn_pattern"` syntheses) and returns the **salience distribution** (counts, percentiles, stale-active counts, top-10 examples) for triage.

Safe to run on every `learn()` or on a cron. The churn scan captures "serial pivoter"-style traits that live in the time series of belief invalidations, not the current snapshot.

```javascript
const { churnSyntheses, distribution } = await marble.rebuild();

console.log(distribution);
// {
//   total: 4509,
//   staleActive: 2837,     // one-off facts older than 180d — likely ingestion noise
//   percentiles: { p10, p50, p90, p99, max },
//   byType: { belief: {...}, preference: {...}, identity: {...} },
//   topExamples: [{ ref: 'belief:running', salience: 0.82, ... }, ...]
// }
```

Use `distribution.staleActive / distribution.total` as a quick "is this KG mostly signal or mostly ingestion noise?" check. A high ratio (>50%) suggests an ingest-dedup follow-up is warranted.

---

## Profile Creation

Marble creates user profiles automatically from signals and context. There are no manual "create profile" steps — the profile emerges from the Knowledge Graph.

### Clone: `Clone` class

Import from `core/clone.js`. A Clone is a digital twin snapshot of the user.

### `clone.takeSnapshot() → Snapshot`

Capture the user's current state from KG data.

```javascript
const snapshot = clone.takeSnapshot();
// {
//   interests: [{ topic: 'AI', weight: 0.85, trend: 'rising' }, ...],
//   patterns: { preferred_sources: [...], active_hours: [...] },
//   context: { calendar: [...], projects: [...] },
//   source_trust: { hackernews: 0.9, reddit: 0.7 },
//   created_at: '2026-03-25T...'
// }
```

### `clone.toPrompt() → string`

Generate a natural language profile for LLM-based agents. Outputs top interests, context, reaction patterns, and source trust as a readable prompt.

```javascript
const prompt = clone.toPrompt();
// "This user is deeply interested in AI (0.85, rising), startups (0.7, stable)..."
```

### `clone.wouldEngage(story) → number`

Quick heuristic: probability this user would engage (0-1). No LLM needed.

```javascript
const probability = clone.wouldEngage(story);
// 0.78
```

### `clone.calculateEngagement(description, context) → number`

Insight-driven engagement scoring (v2) with fallback to flat weights (v1).

---

## Prediction

### Scorer: `Scorer` class

Import from `core/scorer.js`. Scores stories against the user's KG using 5 weighted dimensions.

### `scorer.score(stories) → ScoredStory[]`

Score a batch of stories. Returns sorted by `magic_score`.

**Score weights (how magic_score is computed):**

| Dimension | Weight | What it measures |
|-----------|--------|-----------------|
| `temporal_relevance` | **0.30** | Does this matter TODAY? Calendar, projects, deadlines |
| `interest_match` | 0.25 | Topic relevance via semantic embeddings + interest weights |
| `novelty` | 0.20 | Surprise factor; penalizes over-saturated topics |
| `actionability` | 0.15 | Can the user act on this? (launch, deadline, opportunity) |
| `source_trust` | 0.10 | Source credibility from KG history |

**Freshness decay curve:**

| Story age | Freshness score |
|-----------|----------------|
| 2 hours | 1.0 |
| 6 hours | 0.95 |
| 24 hours | 0.7 |
| 48 hours | 0.5 |

### Swarm: `Swarm` class

Import from `core/swarm.js`. Multi-agent scoring — 5 specialized agents reach consensus.

### `swarm.score(story, context) → SwarmScore`

Score a single story through all 5 agents.

```javascript
const result = swarm.score(story, context);
// {
//   score: 0.78,
//   agents: {
//     career: 0.9,      // Direct project/business impact
//     timing: 0.7,      // Calendar/deadline relevance
//     serendipity: 0.6, // Unexpected connections
//     growth: 0.8,      // Adjacent interests, emerging fields
//     contrarian: 0.5   // Challenges assumptions, under-covered
//   }
// }
```

**Default lens set (6 agents):**

| Agent | Weight | Lens |
|-------|--------|------|
| Career | 0.25 | Direct project impact, business relevance |
| Timing | 0.25 | Calendar events, project deadlines, NOW relevance |
| Serendipity | 0.20 | Delightful, inspiring, unexpected connections |
| Growth | 0.15 | Adjacent interests, emerging fields |
| Contrarian | 0.15 | Under-covered, challenges assumptions |
| Social Proof | 0.10 | Community validation, popularity among similar users |

**Injecting a custom lens set:**

```javascript
const swarm = new Swarm(kg, {
  mode: 'deep',
  llm: yourLLM,
  lenses: [
    { name: 'Domain Expert', mandate: '...', weight: 0.4 },
    { name: 'Skeptic',       mandate: '...', weight: 0.3 },
    { name: 'Novice',        mandate: '...', weight: 0.3 },
  ],
});
const ranked = await swarm.curate(stories);
```

Each lens must be `{ name, mandate, weight }`. When `lenses` is omitted, the default 6-agent fleet above is used. For programmatic per-story scoring with dynamic agents (a different paradigm), see `generateAgentFleet()` / `swarmScore()` — those produce scoring functions, not narrative picks.

### `swarm.rank(stories, options) → RankedStory[]`

Rank multiple stories with swarm consensus.

```javascript
const ranked = swarm.rank(stories, { limit: 10 });
```

### Evolution: `EvolutionEngine` class

Import from `core/evolution.js`. Genetic algorithm that evolves clone variants to improve prediction accuracy.

### `engine.rankStories(stories) → Rankings`

Get story rankings from all clone variants.

### `engine.updateFitness(userFeedback)`

Update clone fitness based on actual user behavior.

### `engine.evolve()`

Run one evolution cycle: kill bottom 20%, mutate survivors, spawn new variants.

### `engine.getBestClone() → Clone`

Return the fittest clone for actual ranking.

### `engine.getMetrics() → Metrics`

```javascript
const m = engine.getMetrics();
// { generation: 14, populationSize: 10, avgFitness: 0.82, predictionAccuracy: 0.71 }
```

---

## Feedback & Signals

### Explicit Feedback

Use `marble.react()` to record direct user actions:

```javascript
await marble.react('story-123', 'up', ['ai', 'productivity'], 'hackernews');
await marble.react('story-456', 'down', ['crypto'], 'reddit');
await marble.react('story-789', 'share', ['startups', 'saas'], 'newsletter');
```

**What happens on feedback:**
- `up` / `share` → `boostInterest(topic, 0.1)` for each topic, source trust +0.02
- `down` → `decayInterest(topic, 0.05)` for each topic, source trust -0.03

### Implicit Signals

Use `marble.signal()` to record behavioral data. Marble auto-infers reactions from signals.

### Signal Processor: `SignalProcessor` class

Import from `core/signals.js`.

### `signals.recordSignal(storyId, type, value)`

Record a behavioral signal.

```javascript
signals.recordSignal('story-123', 'dwell', 25000);            // 25s reading
signals.recordSignal('story-123', 'scroll', { depth: 0.9 });  // 90% scroll
signals.recordSignal('story-456', 'forward', 1);               // forwarded
signals.recordSignal('story-789', 'reply', 1);                 // replied
```

### `signals.inferReactions() → Reaction[]`

Convert accumulated signals into KG reactions with confidence scores.

```javascript
const reactions = signals.inferReactions();
// [{ storyId: 'story-123', reaction: 'up', confidence: 0.75 }]
```

**Signal → reaction mapping:**

| Signal | Condition | Reaction | Confidence |
|--------|-----------|----------|------------|
| `reply` | any | up | 0.9 |
| `forward` | any | share | 0.8 |
| `click` | any | up | 0.7 |
| `dwell` | > 30s | up | 0.7 |
| `dwell` | < 5s | down | 0.6 |
| `scroll` | depth > 80% | up | 0.4 × depth |
| `silence` | 7+ stories present, 70%+ session engaged | down | 0.6 |

**Silence detection:** If a user engaged with 70%+ of stories in a session but ignored specific ones, those get an inferred `down` reaction. This is the most powerful implicit signal — it captures what the user actively chose to skip.

---

## Confidence Scores

Marble uses multiple confidence layers. Here's where each one lives and what it means.

### Story-Level Scores (from Scorer)

Returned by `marble.select()` on every story:

| Score | Range | Meaning |
|-------|-------|---------|
| `magic_score` | 0–1 | Final composite rank (weighted sum of all dimensions) |
| `interest_match` | 0–1 | How well story topics match user interests |
| `temporal_relevance` | 0–1 | How relevant to the user's day (calendar, projects) |
| `novelty` | 0–1 | How surprising/new (penalizes saturation) |
| `actionability` | 0–1 | Can the user act on this? |
| `source_trust` | 0–1 | How reliable is this source for this user? |

### Signal Confidence (from SignalProcessor)

Every inferred reaction includes a `confidence` (0–1) indicating how certain the inference is:

```javascript
{ storyId: 'story-123', reaction: 'up', confidence: 0.75 }
```

Higher confidence signals (reply: 0.9, forward: 0.8) carry more weight than ambiguous ones (scroll: 0.4).

### Interest Confidence (from KG)

Each topic in the KG has a weight and trend:

```javascript
{
  topic: 'AI',
  weight: 0.85,        // 0–1, decays over 14 days without reinforcement
  trend: 'rising',     // 'rising' | 'stable' | 'falling'
  last_boost: '2026-03-25T...'
}
```

### Clone Fitness (from Evolution)

Each clone variant tracks how well it predicted actual user behavior:

```javascript
{
  fitness: 0.82,              // 0–1, how accurate this clone's predictions are
  predictionAccuracy: 0.71,   // % of predictions confirmed by user behavior
  generation: 14              // How many evolution cycles this clone survived
}
```

### Insight Confidence (from KG Insights)

Hypotheses about user behavior carry their own confidence:

```javascript
{
  observation: 'User reads AI articles every morning',
  hypothesis: 'User is evaluating AI tools for their team',
  confidence: 0.6,  // Updated by recordTestResult()
  supporting_signals: ['dwell_ai_morning_1', 'dwell_ai_morning_2']
}
```

Confidence increases when predictions are confirmed, decreases when wrong.

---

## Knowledge Graph: `MarbleKG` class

Import from `core/kg.js`.

### `kg.ingestSignal(signal)`

Process a new signal and generate hypotheses.

```javascript
await kg.ingestSignal({
  type: 'engagement',
  topic: 'AI code review',
  value: 0.8,
  context: { source: 'hackernews', time: 'morning' },
  timestamp: Date.now()
});
```

### `kg.addInsight(insight)`

Manually add an insight with hypothesis.

```javascript
kg.addInsight({
  observation: 'User reads AI articles every morning',
  hypothesis: 'User is evaluating AI tools for their team',
  supporting_signals: ['dwell_ai_morning_1', 'dwell_ai_morning_2'],
  confidence: 0.6
});
```

### `kg.recordTestResult(insightId, prediction, outcome)`

Record whether a hypothesis prediction was confirmed. Updates confidence.

```javascript
kg.recordTestResult('insight-abc', 'would_click_ai_hiring', true);
// Confirmed → confidence increases
kg.recordTestResult('insight-def', 'would_share_crypto', false);
// Rejected → confidence decreases
```

### `kg.getInsights(filter) → Insight[]`

Retrieve insights with optional filtering.

```javascript
const insights = kg.getInsights({
  minConfidence: 0.5,
  sourceLayer: 'observed',
  topic: 'AI'
});
```

### `kg.getPredictions() → Prediction[]`

Get testable predictions sorted by confidence.

### `kg.crossReferenceSignals() → Pattern[]`

Find latent patterns by clustering time-proximate signals.

### `kg.getInterestWeight(topic) → number`

Get decayed interest weight for a topic (v1 compatibility).

### `kg.boostInterest(topic, amount)`

Increase interest weight (called on positive feedback).

### `kg.decayInterest(topic, amount)`

Decrease interest weight (called on negative feedback).

### `kg.getSourceTrust(source) → number`

Returns source credibility score (0–1). Defaults to 0.5 for unknown sources.

### `kg.hasSeen(storyId) → boolean`

Check if user has already seen a story.

### `kg.getTopSalient(opts) → Annotated[]`

Return the top-K most salient nodes across the requested L1 types. **Use this instead of unbounded accessors as the input to any pairwise or quadratic inference pass** — guarantees the pass runs in bounded memory regardless of KG size.

Salience folds `effective_strength` (strength × recency decay) with `evidence_norm` and `slot_volatility`, applies the stale-active guardrail, and returns a ranked list.

**Formula:**

```
salience = 0.6 × effective_strength + 0.2 × evidence_norm + 0.2 × slot_volatility
```

- `effective_strength` — `strength × 2^(-age_days / halfLife)`, halved when `valid_to=null` + `evidence_count=1` + age > 180d (stale-active guardrail)
- `evidence_norm` — `log(1 + evidence_count) / log(10)`, so 10× reinforcement ≈ 1.0
- `slot_volatility` — invalidations on this slot in the last 180d, normalized to 0-1

**Options:**

| Option | Default | Purpose |
|---|---|---|
| `types` | `['belief', 'preference', 'identity']` | Which L1 types to rank |
| `limit` | `100` | Top-K cutoff |
| `domains` | — | Keep only nodes whose stored `domain` matches |
| `asOf` | — | ISO date for as-of queries |

```javascript
const top = kg.getTopSalient({ types: ['belief'], limit: 50 });
// [
//   {
//     node: { topic: 'running', claim: '...', strength: 0.85, ... },
//     type: 'belief',
//     ref: 'belief:running',
//     salience: 0.82,
//     effective_strength: 0.75,
//     slot_volatility: 0.0,
//     stale_active: false
//   },
//   ...
// ]
```

### `kg.salienceDistribution(opts) → Distribution`

Diagnostic. Returns counts, percentiles, stale-active counts, byType breakdown, and the top-10 most salient nodes. Pure function, no side effects.

```javascript
const d = kg.salienceDistribution();
// {
//   total: 4509,
//   staleActive: 2837,
//   percentiles: { p10, p50, p90, p99, max },
//   byType: { belief: { count, staleActive }, preference: {...}, identity: {...} },
//   topExamples: [{ ref, salience, effective_strength, slot_volatility, stale_active }, ...]
// }
```

### `kg.addSynthesis(synthesis) → Synthesis`

Persist a synthesis record. Generates an `id` + `generated_at` if missing. **Upserts on `(origin, trait.dimension, trait.value)`** — a re-run of `synthesize()` doesn't duplicate the same pattern; the higher-confidence record wins while keeping the original id.

### `kg.getSyntheses(opts) → Synthesis[]`

Filter syntheses with any combination of these:

| Option | Type | Purpose |
|---|---|---|
| `minConfidence` | number | Drop below threshold |
| `origin` | string | `'single_node'` / `'trait_replication'` / `'contradiction'` / `'emergent_fusion'` / `'churn_pattern'` |
| `surprising` | boolean | Only records flagged surprising |
| `trait` | `{ dimension, value }` | Both optional — match on whichever provided |
| `domainsIncludes` | string[] | Keep records whose `domains_bridged` covers ALL given domains |

```javascript
// Aspirational-vs-actual gaps — the most valuable signal for content systems
const gaps = kg.getSyntheses({ origin: 'contradiction' });

// High-confidence cross-domain traits
const strong = kg.getSyntheses({ minConfidence: 0.7, origin: 'trait_replication' });

// Serial-pivoter patterns
const churn = kg.getSyntheses({ origin: 'churn_pattern' });
```

### `kg.getSynthesesForNode(nodeRef) → Synthesis[]`

Return records where the node appears in **either** `reinforcing_nodes` or `contradicting_nodes`. Useful for "what patterns does this fact support or undermine?" queries.

```javascript
// What does "user runs 6x/week" imply across the KG?
const patterns = kg.getSynthesesForNode('belief:running');
```

---

## HTTP Endpoints

### Signal Tracker (`web/tracker.js`)

| Method | Endpoint | Body/Query | Response |
|--------|----------|-----------|----------|
| POST | `/track` | `{ storyId, type, value, timestamp }` | `{ success, signal }` |
| GET | `/signals/:storyId` | — | `{ storyId, signals[], summary }` |
| GET | `/health` | — | `{ status, signals_stored, active_sessions, uptime }` |
| GET | `/debug/signals` | — | `{ totalStories, activeSessions, signals }` (dev only) |

### User Dashboard (`web/dashboard.js`)

| Method | Endpoint | Response |
|--------|----------|----------|
| GET | `/profile` | HTML dashboard with interests, clone fitness, signals |
| GET | `/profile/data` | `{ user, interests, clone, recentSignals, sourceStats, weeklyStats }` |

### API Adapter (`adapters/delivery/api.js`)

For programmatic integration:

```javascript
import { APIAdapter } from './adapters/delivery/api.js';
const api = new APIAdapter({ baseUrl: 'https://your-app.com' });
```

| Method | Parameters | Description |
|--------|-----------|-------------|
| `getStoriesForUser(userId, options)` | `{ limit, format, includePersonalization }` | Fetch personalized stories |
| `recordUserSignal(userId, storyId, type, data)` | Signal type + data | Record behavior signal |
| `trackStoryClick(storyId, userId, metadata)` | — | Track click event |
| `trackStoryView(storyId, userId, metadata)` | — | Track impression |
| `trackStoryShare(storyId, userId, platform, metadata)` | Platform string | Track share |
| `getUserAnalytics(userId, timeframe)` | `'7d'`, `'30d'`, etc. | Engagement analytics |
| `batchProcessStories(operations)` | Array of operations | Batch API calls |
| `getHealthStatus()` | — | Health check |

---

## Source Adapters

### RSS

```javascript
import { RSSAdapter } from './adapters/sources/rss.js';
const rss = new RSSAdapter({ feeds: ['https://feed-url.xml'] });
const stories = await rss.fetchStories({ limit: 20 });
```

### HackerNews

```javascript
import { HackerNewsAdapter } from './adapters/sources/hackernews.js';
const hn = new HackerNewsAdapter();
const stories = await hn.fetchStories({ type: 'top', limit: 50 });
```

### NewsAPI

```javascript
import { NewsAPIAdapter } from './adapters/sources/newsapi.js';
const newsapi = new NewsAPIAdapter({ apiKey: process.env.NEWSAPI_KEY });
const stories = await newsapi.fetchStories({ endpoint: 'top-headlines', country: 'us' });
```

---

## Delivery Adapters

### Telegram

```javascript
import { TelegramAdapter } from './adapters/delivery/telegram.js';
const telegram = new TelegramAdapter('BOT_TOKEN', 'https://your-app.com');
await telegram.sendStories(stories, 'CHAT_ID', { format: 'compact', includeReactions: true });
```

### Email

```javascript
import { EmailAdapter } from './adapters/delivery/email.js';
const email = new EmailAdapter({ fromEmail: 'stories@your-app.com' });
await email.sendNewsletterEmail(stories, 'user@example.com');
```

### API (JSON)

```javascript
import { APIAdapter } from './adapters/delivery/api.js';
const api = new APIAdapter({ baseUrl: 'https://your-app.com' });
const result = await api.getStoriesForUser(userId, { limit: 10 });
```

### Webhook

```javascript
import { WebhookAdapter } from './adapters/delivery/webhook.js';
const webhook = new WebhookAdapter();
await webhook.deliverToWebhooks(stories, webhookConfigs);
```

---

## World Signals

```javascript
import { WorldSignalAggregator } from './adapters/signals/world.js';
const agg = new WorldSignalAggregator({ sources: ['hackernews', 'reddit', 'trends'] });
const signals = await agg.aggregate({ subreddits: ['technology', 'startups'] });
```

Each signal includes a `world_attention_score` (0-1) combining velocity (40%), engagement (30%), source credibility (20%), and recency (10%).

---

## WorldSim: `WorldSim` class

Import from `worldsim/index.js`. Product-market fit simulation engine.

### `worldsim.simulate(product) → PMFResult`

Run full PMF simulation.

```javascript
const results = await worldsim.simulate({
  name: 'DevFlow',
  description: 'AI-powered code review platform',
  categories: ['technology', 'productivity']
});
```

### `worldsim.quickCheck(product) → PMFResult`

Fast check with 20 archetypes.

### `worldsim.deepSimulation(product) → PMFResult`

Thorough analysis with 100 archetypes.

### `worldsim.compareProducts(products) → Comparison`

Compare multiple product variations against the same population.

### PMFResult structure

```javascript
{
  pmf_score: 0.73,
  segments: [{ name, size, avgScore, viability, characteristics, painPoints, opportunities }],
  markets: [{ segment, score, viability, opportunity, entry_strategy }],
  messaging: { [segment]: { positioning, value_props, channels, tone, call_to_action } },
  recommendations: { overall, product, go_to_market, next_steps }
}
```

---

## Observer: `Observer` class

Import from `core/observer.js`. KPI tracking and health monitoring.

### `observer.trackKPI(name, value)`

```javascript
await observer.trackKPI('clone_fitness', 0.82);
await observer.trackKPI('signal_capture_rate', 0.75);
```

### `observer.getReport(timeframe) → Report`

```javascript
const report = await observer.getReport('week');
// { kpis: { clone_fitness: { count, average, trend, status } } }
```

### `observer.checkThresholds() → Alert[]`

Check all KPIs against targets, return any violations.

---

## Types Reference

### Story (input)

```javascript
{
  id: 'story-123',
  title: 'OpenAI releases GPT-5',
  summary: 'New model with 10x context window...',
  source: 'hackernews',
  url: 'https://...',
  topics: ['AI', 'LLMs', 'OpenAI'],
  published_at: '2026-03-25T10:00:00Z',
  valence: 0.8,        // optional: positive/negative sentiment
  actionability: 0.7   // optional: pre-computed actionability
}
```

### Synthesis (from `marble.synthesize()` / `kg.user.syntheses[]`)

Output of L2 trait synthesis — structured enough that downstream tools can reason over `trait` / `affinities` / `aversions` as predicates, not free-form prose.

```javascript
{
  id: 'synth_1729..._abc123',
  label: 'Replicated across 3 domains — time orientation: compound',  // HUMAN handle, not the payload
  origin: 'trait_replication',  // 'single_node' | 'trait_replication' | 'contradiction' | 'emergent_fusion' | 'churn_pattern'

  // The trait itself — matchable unit for downstream predicate matching
  trait: {
    dimension: 'time_orientation',
    value: 'compound',
    weight: 0.85
  },

  // Why this pattern coheres — shown to users as the "why we recommended this"
  mechanics: 'Marathon training, a 3-yr daily prayer practice, 5-yr company horizons, and 5+ yr stock positions all independently imply comfort with long feedback cycles and unglamorous repetition.',

  // Full provenance — every synthesis traces back to its source facts
  reinforcing_nodes:    ['belief:running', 'identity:daily_prayer', 'context:5yr_ventures', 'preference:long_holds'],
  contradicting_nodes: [],  // contradiction case only — facts that undermine the trait
  domains_bridged:     ['health', 'spirituality', 'work', 'finance'],
  isolated:             false,

  // Confidence decomposed so downstream can requery at different thresholds
  confidence: 0.88,
  confidence_components: {
    base_from_llm:         0.65,
    replication_bonus:     0.25,
    contradiction_penalty: 0.0,
    cross_domain:          true
  },

  // What downstream SHOULD surface + MUST deprioritize
  affinities:  ['long-form essays on compound practice', 'marathon psychology × stoicism crossovers', ...],
  aversions:   ['hustle porn / 4am grind content', 'viral-in-90-days narratives', ...],
  predictions: ['Will dwell >2× average on content framing work as endurance sport', ...],  // falsifiable, feedback-loop input

  surprising:  false,   // LLM-flagged; useful for ranking
  generated_at: '2026-04-22T...',
  model:        'claude-opus-4-6',
  mode:         'trait_synthesis'   // or 'fusion' | 'churn_scan'
}
```

### Arc Slots (narrative positioning)

Stories are arranged in a narrative arc for optimal reading flow:

| Position | Slot | Purpose |
|----------|------|---------|
| 1 | OPENER | Hook — highest engagement story |
| 2 | BRIDGE | Transition from hook to depth |
| 3-4 | DEEP_1, DEEP_2 | Core interest deep dives |
| 5 | PIVOT | Topic shift to prevent fatigue |
| 6 | DEEP_3 | Third deep dive |
| 7 | PRACTICAL | Actionable/tactical content |
| 8 | HORIZON | Forward-looking, emerging trends |
| 9 | PERSONAL | Growth/serendipity pick |
| 10 | CLOSER | End on a high note |
