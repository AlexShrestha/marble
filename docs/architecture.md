# Architecture Guide

## System Overview

Marble follows a **modular, stateless architecture** with clear separation between user modeling, content scoring, and data persistence.

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Marble Architecture                            │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌───────────────┐   ┌──────────────────┐   ┌────────────────────┐ │
│  │   Raw Items   │──▶│   Enrichment     │──▶│  Scored Results    │ │
│  │   (any type)  │   │   Layer          │   │  (magic_score)     │ │
│  └───────────────┘   └──────┬───────────┘   └────────────────────┘ │
│                             │                        ▲              │
│                             ▼                        │              │
│                    ┌──────────────────┐    ┌──────────────────┐    │
│                    │ Knowledge Graph  │───▶│     Scorer       │    │
│                    │  (user model)    │    │  (multi-dim)     │    │
│                    └────────┬─────────┘    └──────────────────┘    │
│                             │                        ▲              │
│                             ▼                        │              │
│                    ┌──────────────────┐    ┌──────────────────┐    │
│                    │ Pattern Detector │───▶│ Calibration API  │    │
│                    │  (cross-item)    │    │  (auto-tune)     │    │
│                    └──────────────────┘    └──────────────────┘    │
│                             │                                      │
│                             ▼                                      │
│                    ┌──────────────────┐                            │
│                    │ Persistent Store │                            │
│                    │   (JSON files)   │                            │
│                    └──────────────────┘                            │
└──────────────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. Knowledge Graph (`kg.js`)
**Responsibility**: User modeling and state management

```javascript
class KnowledgeGraph {
  // User state management
  load()              // Load from disk
  save()              // Persist to disk

  // Interest modeling
  getInterestWeight() // Get current interest (with decay)
  boostInterest()     // Positive feedback
  decayInterest()     // Negative feedback

  // Context management
  setContext()        // Update daily context

  // History tracking
  recordReaction()    // Log user interaction
  hasSeen()          // Check if story shown before

  // Source trust
  getSourceTrust()    // Get source credibility
}
```

**Key Features**:
- Automatic interest decay (14-day half-life)
- Context-aware relevance
- Source trust learning
- Anti-staleness (no duplicate stories)

### 2. Scorer (`scorer.js`)
**Responsibility**: Multi-dimensional story ranking

```javascript
class Scorer {
  score(stories)      // Rank stories by magic_score

  // Private scoring methods
  #interestMatch()    // Topic similarity
  #temporalRelevance()// Context awareness
  #noveltyScore()     // Filter bubble prevention
  #actionability()    // Can user act on this?
  #sourceTrust()      // Source credibility
  #freshnessDecay()   // Recency bias
}
```

**Scoring Pipeline**:
1. **Interest Match**: Semantic similarity to user interests
2. **Temporal Relevance**: Relevance to today's context
3. **Novelty**: Exposure to new topics
4. **Actionability**: Practical utility
5. **Source Trust**: Historical source performance
6. **Freshness**: Recency multiplier

### 3. Types (`types.js`)
**Responsibility**: Type definitions and constants

- **Story/ScoredStory**: Data schemas
- **UserNode/InterestEdge**: User model structure
- **SCORE_WEIGHTS**: Dimension weightings
- **ARC_SLOTS**: Narrative positioning

### 4. Embeddings (`embeddings.js`)
**Responsibility**: Semantic similarity calculations

```javascript
class EmbeddingEngine {
  getSimilarity(text1, text2)  // Cosine similarity
  embed(text)                  // Generate embeddings
  enableCache(path)            // Persistent caching
}
```

**Features**:
- OpenAI embeddings (with local fallback)
- Persistent disk cache
- Cosine similarity calculations
- Graceful degradation to string matching

### 5. Item Enrichment Layer

The enrichment layer extracts deep, preference-predictive attributes from items — going far beyond basic metadata like genre or author. It operates through three cooperating components:

#### Entity Extractor (`entity-extractor.js`)
**Responsibility**: Synchronous, metadata-driven attribute extraction

```javascript
extractEntityAttributes(item)
// Returns: { domain: string, attributes: { [kgKey]: Array<{value, kgKey, kgType, attribute}> } }
```

- **Domain detection**: Infers item type (movie, music, book, article, restaurant) from metadata fields — no hardcoded type registry
- **Field-to-KG mapping**: Maps common metadata fields (director, genre, pacing, themes, cuisine, etc.) to KG node types via `FIELD_KG_MAP`
- **Text extraction**: Falls back to parsing title/summary for year→era, genre keywords, and theme keywords when structured metadata is absent
- Called **synchronously** from `kg.recordReaction()` on every user reaction

#### Topic Insight Engine (`topic-insight-engine.js`)
**Responsibility**: LLM-powered deep dimension discovery

```javascript
class TopicInsightEngine {
  analyse(item, reaction, kg)      // Main entry: extract → gap-check → simulate → write
  extractDimensions(item)          // LLM or heuristic dimension extraction
}
```

- **Self-questioning loop**: Asks the LLM "what dimensions predict preference for THIS item?" — no pre-defined schema
- Each dimension is typed: `{ id, label, value, kgType: 'belief'|'preference'|'identity' }`
- Checks KG for existing evidence before generating new hypotheses
- Writes surviving hypotheses as typed KG nodes (beliefs, preferences, identities)
- Called **asynchronously** (fire-and-forget) from `kg.recordReaction()` when attached

#### Gap Simulator (`topic-insight-engine.js`)
**Responsibility**: Hypothesis generation for unknown preference dimensions

```javascript
class GapSimulator {
  simulate(item, gaps, ratedHistory, reaction)
  // Returns: Array<{dimensionId, value, kgType, confidence, reasoning}>
}
```

- For dimensions with **no existing KG evidence**, generates plausible hypotheses about user preferences
- Cross-checks hypotheses against rated history to eliminate contradictions
- Confidence scores: 0.2–0.4 with little history, 0.5–0.8 with corroborating evidence
- Has both LLM-powered and heuristic fallback paths

#### Integration Flow

```
User reacts to item
    │
    ├──▶ extractEntityAttributes(item)          [sync, entity-extractor.js]
    │       └──▶ KG.#trackDimensionalPreferences()
    │
    └──▶ TopicInsightEngine.analyse(item, reaction, kg)  [async, fire-and-forget]
            ├──▶ extractDimensions(item)         [LLM or heuristic]
            ├──▶ Check KG for existing evidence
            ├──▶ GapSimulator.simulate()         [for unknown dimensions]
            ├──▶ Write hypotheses as KG nodes
            └──▶ Reinforce known dimensions
```

- **Sync path** (entity-extractor): fast, metadata-only, runs on every reaction
- **Async path** (TopicInsightEngine): deeper, LLM-powered, fire-and-forget
- Both paths converge in the KG — enrichment results feed into the `attribute_pattern_match` scoring dimension

### 6. Evolution (`evolution.js`)
**Responsibility**: User model adaptation over time

- Interest drift detection
- Long-term preference learning
- Model stability maintenance

### 7. Salience Engine (`salience.js`)
**Responsibility**: Top-K filtering and churn detection — the primitive that replaces unbounded "scan everything" passes

```javascript
// Public API, also exposed on KnowledgeGraph
import {
  computeSalience,           // score a single node
  computeVolatility,          // Map<slotKey, {score, invalidations, records}>
  getTopSalient,              // ranked list across types
  salienceDistribution,       // diagnostic: counts, percentiles, stale-active
  runChurnScan,               // deterministic → churn_pattern syntheses
} from 'marble/core/salience.js';
```

**Formula:**

```
salience = 0.6 × effective_strength + 0.2 × evidence_norm + 0.2 × slot_volatility
```

- **`effective_strength`** — `strength × 2^(-age_days / halfLife)`, halved when `valid_to=null` + `evidence_count=1` + age > 180d (stale-active guardrail prevents old one-off facts from dominating)
- **`evidence_norm`** — `log(1 + evidence_count) / log(10)` — 10× reinforcement normalizes to ~1.0
- **`slot_volatility`** — invalidations on this slot in trailing 180d, normalized to 0-1; high volatility is itself a signal (e.g. "serial project pivoter")

`getTopSalient({ types, limit, domains })` is the input source for any pairwise / quadratic inference pass. Working with this instead of raw `getMemoryNodesSummary()` keeps the pass bounded regardless of KG size — a 5000-node KG that previously OOM'd now runs in 62ms.

The churn scan (`runChurnScan`) emits **`origin: "churn_pattern"`** syntheses for slots reassigned ≥3 times in 180d. Deterministic, no LLM. Captures traits that live in the time series (e.g. "user serial-pivots projects") — invisible to snapshot-based inference.

### 8. Trait Synthesis (`trait-synthesis.js`)
**Responsibility**: LLM-directed cross-L1 pattern discovery — replaces the old O(N²) pairwise generators

```javascript
import { runTraitSynthesis } from 'marble/core/trait-synthesis.js';
const syntheses = await runTraitSynthesis(kg, { llmClient, ...opts });
```

Four phases, run in sequence:

```
Phase 1  Per-node trait extraction (LLM, chunks of ~10 nodes)
           each fact → 1-3 traits { dimension, value, weight, confidence, evidence_quote, domain }

Phase 2  Replication grouping (in-process, no LLM)
           group candidates by (dimension, value), compute replication_bonus
           cross-domain multiplier rewards traits that span multiple life areas

Phase 3  Contradiction detection (in-process, no LLM)
           same dimension + divergent values from DISJOINT node sets → "contradiction" origin
           first-class aspirational-vs-actual gap recording

Phase 4  K-way emergent fusion (LLM, small number of domain-spread samples)
           gestalt patterns that no single-node extraction would surface
           LLM returns {label: null} if facts don't cohere — no inventing
```

Output syntheses carry structured fields (`trait`, `mechanics`, `reinforcing_nodes`, `contradicting_nodes`, `domains_bridged`, `confidence_components`, `affinities`, `aversions`, `predictions`). Labels are human handles; the structured fields are what downstream tools match against.

### 9. Insight Swarm (`insight-swarm.js`)
**Responsibility**: L1.5 — 7 psychological-dimension agents probe the KG for questions worth asking

- Dimensions: desires, fears, motivations, frustrations, dreams, identity tensions, avoidance patterns
- Each agent generates 3-5 probing questions grounded in specific KG data
- Output persists to `kg.user.insights[]` and flows into `InferenceEngine.run()` as pre-built seeds (see `opts.seeds`) — avoids re-running the swarm

### Swarm systems — three parallel, purpose-built layers

Marble has **three distinct multi-agent systems** that all get called "swarm" in different contexts. They share a name but not wiring, agent shape, or evaluation paradigm. Pick the right one by matching your question:

| System | File | Purpose | Agent shape | Wiring |
|---|---|---|---|---|
| **`Swarm` class** | `core/swarm.js` | Narrative curation — "pick top N from 100 stories and explain why" | Static `{ name, mandate, weight }` lenses. Default: 6 agents (Career / Growth / Timing / Contrarian / Serendipity / Social Proof). Injectable via `new Swarm(kg, { lenses })`. | `marble.select()` when `mode: 'swarm'` or `'debate'` |
| **`generateAgentFleet()`** | `core/swarm.js` | Programmatic per-story scoring — "how relevant is THIS story to this user?" | Dynamic specs `{ name, exclusive_dimension, screening_question, positive_signals, negative_signals, weight, ... }` generated by LLM per domain + KG. Each spec becomes a `scoreFn` via `_buildSpecScorer()`. | `scorer.#scoreWithSwarm()` in the Decision Compression path |
| **`runInsightSwarm()`** | `core/insight-swarm.js` | L1.5 psychological probing — "what questions should we ask this user?" | Dynamic committee generated by `generateCommittee()` from the user's KG. Each agent targets one of 7 psychological dimensions (desires / fears / motivations / frustrations / dreams / identity tensions / avoidance patterns). | `marble.learn()` as the L1.5 pipeline stage |

**None of these share wiring.** They're parallel, purpose-built systems. The naming collision is a historical accretion — the design intent is clearer if you read each as its own thing.

**Which to use when:**
- Need a narrative summary of *why* a batch of items was picked? → `Swarm.curate()`
- Need a numeric score for a single item, cheaply, at scale? → `swarmScore(story, kg, { fleet })`
- Need probing questions that surface psychological dimensions the KG doesn't yet know? → `runInsightSwarm(kg)`

**Injection points** for tailored-per-user behavior:
- `new Swarm(kg, { lenses: [...] })` — custom lens set for narrative curation
- `generateAgentFleet(domain, contentSample, kgSummary, llm)` — dynamic fleet for programmatic scoring
- `runInsightSwarm(kg, { llmClient })` — always dynamic (no static fallback)

No unified "one fleet to rule them all." This is intentional — narrative curation and programmatic scoring produce genuinely different agent shapes, and merging them adds glue code without adding capability.

### 10. Inference Engine (`inference-engine.js`)
**Responsibility**: L2 — gates L1.5 passthrough candidates and runs temporal pattern detection

Post-refactor (April 2026) this is a thin layer. The old `_inferFromBelief` / `_inferFromPreferenceIdentity` / `_inferFromConfidenceGaps` methods were deleted — they emitted O(N²) template-string noise that OOM'd on real-sized KGs. Cross-L1 pattern discovery lives entirely in `trait-synthesis.js` now.

```javascript
async run() {
  // L1.5 passthrough — use caller-supplied seeds when available
  // Temporal patterns — input capped via kg.getTopSalient({ limit: 100 })
  // Inline gate — sub-threshold candidates never allocated
}

async runTraitSynthesis(opts)  // thin delegation into trait-synthesis.js
```

## Data Flow

### 0. Reasoning Pipeline (learn → synthesize → rebuild)

```
marble.learn()
    │
    ├──▶ L1.5 InsightSwarm          (7 psychological lenses, committee of agents)
    │       └──▶ kg.user.insights[]        (persistent; reused as L2 seeds)
    │
    ├──▶ L2 InferenceEngine.run()
    │       ├──▶ L1.5 passthrough candidates (inline gate; no alloc below threshold)
    │       └──▶ _inferFromTemporalPatterns (input = kg.getTopSalient({limit:100}))
    │
    └──▶ L3 Clone evolution          (kill bottom 20%, mutate survivors)

marble.synthesize()          [LLM-heavy; daily/weekly]
    │
    └──▶ runTraitSynthesis()         (4 phases)
          ├──▶ Phase 1: per-node trait extraction
          ├──▶ Phase 2: replication grouping → trait_replication / single_node
          ├──▶ Phase 3: contradiction detection → contradiction
          └──▶ Phase 4: K-way fusion → emergent_fusion
               │
               └──▶ kg.user.syntheses[] via kg.addSynthesis() (upsert)

marble.rebuild()             [deterministic; safe to run per-learn or on cron]
    │
    ├──▶ runChurnScan()               → churn_pattern origin → kg.addSynthesis()
    └──▶ salienceDistribution()       → diagnostic { total, staleActive, percentiles, ... }
```

**5 synthesis origins** — downstream tools can filter on any of them:

| Origin | Source | Example |
|---|---|---|
| `single_node` | trait implied by exactly one node | "Isolated signal — risk profile: high volatility tolerant" |
| `trait_replication` | same trait implied by multiple nodes across domains | "Replicated across 3 domains — time orientation: compound" |
| `contradiction` | same dimension, divergent values from disjoint node sets | "Conflicting signals on follow_through: sustained ↔ inconsistent" |
| `emergent_fusion` | gestalt pattern from K-way sample | "Endurance-engineered founder practice" |
| `churn_pattern` | slot reassigned ≥3 times in 180d | "Churn on belief current_project" — "serial_pivoter" |

### 1. Story Ingestion
```
External APIs ───┐
RSS Feeds    ───┼──▶ Raw Stories Array
Web Scrapers ───┘
```

### 2. Scoring Process
```
Raw Stories ──▶ Scorer.score() ──┐
                      │          │
                      ▼          ▼
            KnowledgeGraph ─▶ ScoredStories
                      │
                      ▼
            Interest Matching
            Temporal Analysis
            Novelty Injection
            Trust Weighting
```

### 3. User Feedback Loop
```
User Reaction ──▶ KG.recordReaction() ──▶ Interest Updates
      │                                        │
      ▼                                        ▼
Story Metadata                         Source Trust Updates
(topics, source)                            │
                                           ▼
                                    Persistent Storage
```

## Storage Architecture

### File Structure
```
data/marble/
├── alex.json           # User knowledge graph
├── beta-user.json      # Another user
└── ...

data/cache/
├── embeddings/         # Semantic similarity cache
│   ├── topic-pairs.json
│   └── embeddings.json
└── ...
```

### User Model Schema
```javascript
{
  "id": "alex",
  "interests": [
    {
      "topic": "artificial-intelligence",
      "weight": 0.85,
      "last_boost": "2026-03-24T10:30:00Z",
      "trend": "rising"
    }
  ],
  "context": {
    "calendar": ["investor pitch at 2pm"],
    "active_projects": ["marble-launch"],
    "recent_conversations": ["ai-funding", "product-market-fit"]
  },
  "history": [
    {
      "story_id": "story-123",
      "reaction": "up",
      "date": "2026-03-24T09:15:00Z",
      "topics": ["ai", "startups"],
      "source": "techcrunch"
    }
  ],
  "source_trust": {
    "techcrunch": 0.78,
    "hackernews": 0.65
  }
}
```

## Scalability Considerations

### Single User Performance
- **Stories/sec**: ~5000 stories scored per second
- **Memory footprint**: ~50MB per user (10K interactions)
- **Disk usage**: ~10KB per user profile

### Multi-User Scaling
```
Load Balancer ──┐
                ├──▶ Scorer Instance 1 ──▶ User KG Cache
                ├──▶ Scorer Instance 2 ──▶ User KG Cache
                └──▶ Scorer Instance N ──▶ User KG Cache
                            │
                            ▼
                    Shared Embeddings Cache
                            │
                            ▼
                    Persistent Storage Layer
```

### Caching Strategy
- **User models**: In-memory LRU cache (1000 users)
- **Embeddings**: Persistent disk cache
- **Story metadata**: Redis cache for frequently accessed stories

## Security & Privacy

### Data Minimization
- Only store necessary user interaction data
- Automatic history trimming (500 most recent reactions)
- No storage of story content (only metadata)

### Isolation
- Each user model is independently stored
- No cross-user data leakage
- Stateless scoring (no shared state between users)

## Integration Patterns

### API Integration
```javascript
// RESTful scoring endpoint
POST /api/score
{
  "user_id": "alex",
  "stories": [...],
  "context": {...}
}

// Response
{
  "ranked_stories": [...],
  "user_insights": {...}
}
```

### Event-Driven Integration
```javascript
// Reaction webhook
POST /api/react
{
  "user_id": "alex",
  "story_id": "story-123",
  "reaction": "up"
}
```

### Batch Processing
```javascript
// Bulk user update
POST /api/bulk-score
{
  "users": ["alex", "beta-user"],
  "stories": [...],
  "async": true
}
```

## Monitoring & Observability

### Key Metrics
- **Scoring latency**: p95, p99 response times
- **User engagement**: Reaction rates, session length
- **Model accuracy**: Predicted vs actual reactions
- **Cache hit rates**: Embeddings, user models

### Health Checks
- User model loading/saving success rates
- Embedding service availability
- Disk space for user data
- Memory usage per user model

This architecture provides a solid foundation for building personalized content experiences at scale while maintaining simplicity and explainability.