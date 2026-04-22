# How Marble Works

The data synthesis process in plain English.

## The Core Idea

Marblism takes a tiny amount of real data about a user (a name, an email, a few interests), generates dozens of "what-if" versions of that person, tests content against all of them, then uses real feedback to figure out which version is closest to the truth.

Think of it like casting marbles in a jar — shake to see which versions rise to the top.

## The 8-Step Process

### Step 1: Partial Input Arrives

A user signs up or a profile is created. You might have:
- A name and email
- A few stated interests
- A job title
- Maybe nothing beyond an ID

That's fine. Marblism is designed to work with incomplete data.

### Step 2: Gap Identification

The system identifies what's missing. A complete user model needs:
- **Demographics** — age range, location, income tier
- **Psychographics** — pain points, goals, values, buying triggers
- **Behavior patterns** — price sensitivity, decision speed, adoption style
- **Interests** — weighted topics with trend direction

For a new user, most of this is unknown. That's where clones come in.

### Step 3: Clone Generation

Marblism generates **50 complete personas** (clones), each filling in the gaps differently:

```
Real data:     "Alex, founder, interested in AI"
Clone #1:      Alex + early adopter + price insensitive + moves fast + values novelty
Clone #2:      Alex + mainstream + budget-conscious + methodical + values reliability
Clone #3:      Alex + technical + data-driven + cautious + values evidence
...
Clone #50:     Alex + creative + impulsive + trend-sensitive + values aesthetics
```

Each clone is a complete hypothesis about who this person might be. The real traits are locked; the unknown traits are generated with diversity.

### Step 4: Knowledge Graph Storage

Two files maintain state:

1. **User KG** (`marblism-kg.json`) — ground truth. Real interests with weights, reaction history, source trust scores, daily context (calendar, projects, mood).

2. **Clone Population** (`population.json`) — 50 hypothetical variants. Each has demographics, psychographics, behavior patterns, 8 scoring weights, fitness scores, and prediction history.

Interests decay exponentially (14-day half-life). If you don't reinforce an interest, it fades. This keeps the model fresh.

### Step 5: Probability Assignment

Three layers of probability determine which clones matter:

**Layer 1 — Initial Weights:** New clones start with randomized scoring weights across 8 dimensions (interest match, temporal relevance, novelty, actionability, source trust, career fit, growth potential, serendipity). Each weight is 0-1.

**Layer 2 — Fitness-Based Selection:** After each feedback cycle, clones are scored on prediction accuracy. Did the clone predict the user would engage with Story X? Did they actually engage? Correct predictions increase fitness; wrong ones decrease it.

**Layer 3 — Population Confidence:** The overall confidence score reflects how well the population as a whole is predicting behavior. High variance = low confidence (we're still guessing). Low variance = high confidence (the surviving clones agree).

### Step 6: Testing Content Against Clones

When new content arrives (stories, products, notifications), each clone evaluates it independently:

```
Story: "Shopify launches AI-powered product descriptions"

Clone #1 (early adopter):     Score: 0.92  — "Directly relevant to their stack"
Clone #2 (mainstream):        Score: 0.41  — "Interesting but not urgent"
Clone #3 (technical):         Score: 0.78  — "Good technical implications"
Clone #14 (budget-conscious): Score: 0.85  — "Could save them money"
...

Weighted consensus: 0.74 — Include in top 10
```

The consensus is weighted by clone fitness — clones that have been right before get more vote weight.

### Step 7: Feedback Updates the Model

When the user interacts (or doesn't), the system learns:

| Signal | What it means | KG update |
|--------|--------------|-----------|
| Read for 30+ seconds | Engaged | Boost topic interest +0.1 |
| Shared/forwarded | Loved it | Boost +0.15, strong share signal |
| Read < 5 seconds | Bounced | Decay topic -0.05 |
| No interaction (silence) | Implicit skip | Slight decay if pattern detected |
| Thumbs up/down | Explicit | Direct boost/decay |

Each clone's prediction is compared against the actual behavior. Clones that predicted correctly gain fitness; wrong ones lose it.

### Step 8: Evolution

Every cycle (daily by default):

1. **Evaluate**: Score every clone's prediction accuracy
2. **Kill**: Bottom 20% of clones are removed
3. **Mutate**: Surviving clones produce offspring with 15% weight mutation
4. **Spawn**: New random clones fill empty slots (maintains diversity)
5. **Repeat**: Population converges on the user's true preferences

After ~2 weeks, surviving clones have converged on the user's actual preferences — including latent interests they never explicitly stated.

### Step 9: Trait Synthesis (Optional, LLM-heavy)

`marble.synthesize()` derives **structured traits** from the KG — not just "what topics does the user like" but "what psychological/behavioral dimensions replicate across their life." It runs in four phases:

**Phase 1 — Per-node trait extraction.** Each L1 fact ("runs 6×/week on Higdon program") gets 1-3 traits extracted: `{ dimension: "time_orientation", value: "compound", weight: 0.75, evidence_quote: "long runs" }`. Uses the LLM in small batches (~10 nodes per call).

**Phase 2 — Replication grouping.** The same trait showing up independently from several nodes is much stronger evidence than one node. Cross-domain replication (running + prayer + long stock holds → `time_orientation: compound` across health + spirituality + finance) gets a multiplier.

**Phase 3 — Contradiction detection.** Same dimension with divergent values from **disjoint** node sets surfaces as a first-class `origin: "contradiction"` record — the aspirational-vs-actual gap. Example: "follow_through" implies `sustained` from daily practices but `inconsistent` from job-hop history. Both sides get recorded with full provenance.

**Phase 4 — K-way emergent fusion.** A small number of domain-spread samples asking the LLM "find a gestalt pattern across these K facts, or return null if they don't cohere." Captures patterns no single-node extraction would surface ("endurance-engineered founder practice").

Every synthesis decomposes into structured fields downstream tools consume as predicates — not prose labels:

- `trait: { dimension, value, weight }` — the matchable unit
- `mechanics` — why this pattern coheres (shown to users as "why we recommended this")
- `reinforcing_nodes` / `contradicting_nodes` — full provenance, both sides
- `confidence_components` — `base_from_llm` / `replication_bonus` / `contradiction_penalty` / `cross_domain`
- `affinities` / `aversions` — specific enough to match real content titles
- `predictions` — falsifiable (observable dwell / share / skip)

### Step 10: Rebuild (Optional, Deterministic)

`marble.rebuild()` runs two cheap deterministic passes — no LLM:

1. **Churn scan.** Slots (e.g. `belief:current_project`) reassigned ≥3 times in 180d emit `origin: "churn_pattern"` syntheses. This is what captures "serial pivoter" traits — patterns that live in the TIME SERIES of invalidations, not the current snapshot. Event-driven inference never sees this; `rebuild()` does.

2. **Salience distribution diagnostic.** Returns percentiles, stale-active counts, and top-10 examples so you can quickly answer "is this KG mostly signal or mostly ingestion noise?" Use `distribution.staleActive / distribution.total` as the triage ratio.

## Synthesis Origins (the 5 kinds of pattern)

Every synthesis has one of five `origin` values — downstream can filter by origin to, e.g., surface aspirational-vs-actual gaps separately from coherent traits:

| Origin | Where it comes from | What it means |
|---|---|---|
| `single_node` | One fact implies a trait (Phase 1 only) | Low-confidence isolated signal — moderate weight, flagged `isolated: true` |
| `trait_replication` | Same trait from ≥2 nodes, optionally cross-domain | High confidence. The "endurance discipline across health + work + finance" case |
| `contradiction` | Same dimension, divergent values from disjoint nodes | The aspirational-vs-actual gap. Highest-leverage signal for content systems |
| `emergent_fusion` | K-way LLM gestalt pattern | The "no single fact reveals this" case. Carries a full `mechanics` explanation |
| `churn_pattern` | Slot reassigned ≥3 times in 180d | "Serial pivoter" trait. Lives in the time series, not the snapshot. Emitted by `rebuild()` |

## The Pipeline (Visual)

```
┌─────────────────────────────────────────────────────────┐
│  1. GATHER                                               │
│  Sources: RSS, HN, NewsAPI, custom feeds                │
│  + World Signals: trends, search volume, social velocity │
│                      ~100 stories                        │
├─────────────────────────────────────────────────────────┤
│  2. SCORE                                                │
│                                                          │
│  Score mode (v1):                                        │
│    magic_score = interest(0.25) + temporal(0.30)         │
│               + novelty(0.20) + actionability(0.15)      │
│               + source_trust(0.10) × freshness_decay     │
│                                                          │
│  Swarm mode (v2):                                        │
│    Clone → 6 agents evaluate in parallel                 │
│    Career(25%) | Timing(25%) | Serendipity(20%)          │
│    Growth(15%) | Contrarian(15%) | Social Proof(10%)     │
│    → Weighted consensus → top candidates                 │
│    Lenses injectable via new Swarm(kg, { lenses })       │
├─────────────────────────────────────────────────────────┤
│  3. ARC REORDER                                          │
│  Sequence into narrative flow:                           │
│  Opener → Bridge → Deep dives → Pivot → Practical        │
│  → Horizon → Personal → Closer                           │
├─────────────────────────────────────────────────────────┤
│  4. DELIVER                                              │
│  Telegram | Email | JSON API | Webhook | Video           │
├─────────────────────────────────────────────────────────┤
│  5. LEARN                                                │
│  L1.5 InsightSwarm (7 psychological lenses, persistent)  │
│  → L2 InferenceEngine (L1.5 passthrough + temporal)      │
│  → L3 Clone evolution (kill bottom 20%, mutate survivors)│
├─────────────────────────────────────────────────────────┤
│  6. SYNTHESIZE (optional, LLM-heavy)                     │
│  Phase 1: Per-node trait extraction                      │
│  Phase 2: Replication grouping (cross-domain bonus)      │
│  Phase 3: Contradiction detection (disjoint node sets)   │
│  Phase 4: K-way emergent fusion                          │
│  → kg.user.syntheses[] (4 origins: single_node,          │
│    trait_replication, contradiction, emergent_fusion)    │
├─────────────────────────────────────────────────────────┤
│  7. REBUILD (optional, deterministic)                    │
│  Churn scan: slot reassigned ≥3× in 180d                 │
│  → churn_pattern origin (5th origin)                     │
│  + salienceDistribution() diagnostic                     │
└─────────────────────────────────────────────────────────┘
```

## Key Numbers

| Metric | Value |
|--------|-------|
| Clones per user | 50 (configurable) |
| Scoring weights per clone | 8 |
| Mutation rate | 15% per evolution cycle |
| Kill rate | Bottom 20% per cycle |
| Interest half-life | 14 days |
| Target prediction accuracy | >70% after convergence |
| Convergence time | ~2 weeks |
| Cost per simulation (with LLM) | $0.12-$0.20 |
| Cost without LLM | $0 (local embeddings) |
| Salience formula | `0.6 × effective_strength + 0.2 × evidence_norm + 0.2 × slot_volatility` |
| Stale-active guardrail | `valid_to=null` + `evidence_count=1` + age > 180d → effective strength × 0.5 |
| Volatility window | 180 days (slot invalidations) |
| Churn threshold | ≥3 invalidations in window → `churn_pattern` synthesis |
| Synthesis fusion samples | 5 K-way samples per `synthesize()` run (K ≈ 10 nodes) |
| L1.5 → L2 seed reuse | `learn()` passes insights into `InferenceEngine` as `opts.seeds` — no duplicate LLM call |
