# Marble Benchmark Findings — Pass 1 (Opus Deep Analysis)

**Date:** 2026-04-03
**Benchmark commit:** `14d3ce06fb30ed74a75166b0475620809963c897`
**Model:** gpt-4o-mini via OpenAI provider
**Analyst:** Claude Opus 4.6

---

## 1. Why Popularity Baseline (58.3%) Beats Marble Swarm (41.7%)

### The Numbers

| Method | MovieLens Static p@10 | MovieLens Online acc | GSS Static top1 |
|--------|----------------------|---------------------|----------------|
| popularity | **58.3%** | **79.2%** | — |
| majority | — | — | **55.6%** |
| swarm | 41.7% | 54.2% (frozen) | 33.3% |
| score | 28.3% | 58.3% (frozen) | 27.8% |
| random | 18.3% | 45.8% | 33.3% |

### Root Cause

Popularity is a **distributional prior** — it encodes "most people like this." MovieLens is a dataset where popular movies genuinely are liked by most users. The popularity baseline is not doing anything clever; it's exploiting the fact that the test set is drawn from the same distribution as the training set.

Marble's swarm committee, by contrast, operates **without any distributional signal**. The 5 agents reason about *why* a user might like something based on narrative/thematic fit, but they have zero information about *how many other people liked it*. This is equivalent to trying to predict election outcomes by reading policy platforms without looking at polls.

### Architectural Implication

This is not a "Marble is bad" finding. It's a **missing signal** finding. Marble's personalization reasoning is directionally correct (41.7% vs. 18.3% random), but it's competing with one hand tied behind its back. Any production recommender blends collaborative signals (popularity, nearest-neighbor) with content-based reasoning. Marble currently only does the content-based half.

The 16.6 percentage-point gap between swarm (41.7%) and popularity (58.3%) is the **price of ignoring the prior**. A hybrid approach would start from the popularity ranking and let the swarm re-rank within it, rather than scoring from scratch.

---

## 2. Why swarm_evolving Is Worse Than swarm_frozen

### The Numbers

| Method | MovieLens Online | GSS Online |
|--------|-----------------|------------|
| swarm_frozen | 54.2% | **53.1%** |
| swarm_evolving | **45.8%** | 46.9% |

Evolving is **8.4pp worse** on movies and **6.2pp worse** on opinions. This is a systematic degradation, not noise.

### Diagnosis: The Feedback Loop Is Poisoning Weights

The evolution engine (`core/evolution.js`) maintains a population of 20 CloneVariants and mutates weights based on fitness against observed outcomes. The problem is threefold:

**A. Catastrophically small sample size.** The benchmark runs 4 steps per user. With 6 users × 4 steps = 24 total feedback events, the evolutionary loop is trying to optimize ~15 weight parameters from fewer observations than parameters. This is classic overfitting — the mutations that survive are the ones that got lucky on the last 1-2 items, not the ones that generalize.

**B. Mutation rate too high for few samples.** The 10-20% mutation rate (`evolution.js` lines 30-49) is calibrated for hundreds of interactions. With 4 steps, a single bad mutation can flip a weight dramatically and persist because there aren't enough subsequent trials to kill it off. The population evolves *away from* the initial reasonable weights toward random noise.

**C. No regularization toward prior.** The mutation mechanism (`newWeight = oldWeight + (random - 0.5) × 2 × mutationRate`) has no pull-back toward the original weights. In a proper Bayesian update, the prior (frozen weights) would dominate when evidence is scarce. Here, the prior is discarded after the first generation.

### Why frozen works better

Frozen weights were presumably set by hand or calibrated on a larger dataset. They encode reasonable priors (Career 0.25, Timing 0.25, Serendipity 0.20, Growth 0.15, Contrarian 0.15). With only 4 feedback steps, the best strategy is to trust the prior — which is exactly what frozen does.

### Fix

The evolution engine needs a **minimum sample threshold** before activating (the auto-tuning code in `metric-agnostic-scorer.js` already has a 15-sample gate at line 202 — the swarm evolution path should respect the same gate). Additionally, add a regularization term that penalizes divergence from initial weights proportional to `1/sqrt(n_samples)`.

---

## 3. Why GSS Swarm == Random (33.3%)

### The Problem

On the GSS opinion prediction task, Marble's swarm achieved exactly random-guess accuracy (33.3%). This is not "close to random" — it **is** random performance.

### Root Cause: The Committee Is Semantically Misaligned to the Task

The 5 agents are designed for **story curation**:
- Career Agent: "help with active projects, professional goals"
- Growth Agent: "expand thinking beyond current bubble"
- Timing Agent: "why this is relevant today"
- Contrarian Agent: "surface what others would miss"
- Serendipity Agent: "delight, inspiration, unexpectedly resonant"

When asked to predict whether an 80-year-old divorced Protestant woman favors or opposes gun permits, these lenses produce **eloquent nonsense**:

- The Timing Agent said the question is timely because the user is "in a public-opinion survey" — true but useless for prediction.
- The Career Agent framed both answer options as helpful for the user's "active project" of answering the survey — giving equal weight to both options.

The agents are not reasoning about **what the person believes**. They're reasoning about **why the content is interesting**, which is a completely different task. The committee mandates contain zero instruction to predict opinions, model belief systems, or leverage demographic correlations.

### Why Baselines Win

- `demographic_match` (58.3%) uses actual demographic features (age, race, education, religion, political leaning) to find similar respondents. This directly models the generating process.
- `majority` (55.6%) uses the modal answer from 1800 training respondents. Again, distributional prior.
- `nearest_neighbor` (52.8%) finds the most similar respondent by known answers.

All three baselines encode **who this person is like**. Marble's swarm encodes **why this content is interesting**. For opinion prediction, the former is the right question.

### Fix

For opinion/preference tasks, the swarm needs **belief-modeling agents** instead of curation agents. Something like:
- Demographic Prior Agent: "Given this person's demographics, what do similar people tend to believe?"
- Value Coherence Agent: "Given their known opinions, what position is logically consistent?"
- Identity Agent: "What does their self-identified political/religious identity predict?"

Or — more practically — bypass the swarm entirely for opinion tasks and use the collaborative filter + typed alignment scoring (`scorer.js` already has belief/preference/identity/institution alignment types).

---

## 4. Score Tie Problem (Both Options 0.35)

### The Evidence

From the GSS static sample case: the `score` method ranked `favor` above `oppose`, but **both received identical scores of 0.35**. The correct answer happened to land at rank 1 by insertion order, not by discriminative scoring.

### Structural Cause

The scoring formula in `scorer.js` (lines 151-320) computes:

```
raw = (alignment × weight + temporal × weight + novelty × weight + 
       actionability × weight + source_trust × weight) / normalizedBaseWeights
```

For binary opinion options like `favor` vs. `oppose`:
- **Temporal score**: identical (same timestamp)
- **Novelty score**: identical (both are new to the user)
- **Actionability**: identical (both are survey answers)
- **Source trust**: identical (same source)
- **Alignment**: the only differentiator, but for short opinion strings with minimal semantic content, the embedding similarity to the user profile is nearly identical

The result is that 4 of 5 scoring dimensions contribute zero discrimination, and the one that could discriminate (alignment) produces near-identical values for semantically thin options like single-word survey answers.

### Why This Matters

This isn't just a GSS problem. Any time Marble compares items that are similar on surface features but different in preference fit, the scorer will tie. For movies: two action films from the same year with similar casts will tie. The scorer has no mechanism to break ties using **collaborative or behavioral** signals.

### Fix

1. **Add explicit tie-breaking**: when scores are within epsilon (say 0.01), use a secondary signal (collaborative filter confidence, demographic prior, or even random with seed) to break ties.
2. **Increase alignment weight for low-content items**: when items have fewer tokens, the alignment dimension should be weighted higher since the other dimensions can't discriminate.
3. **Add a collaborative filter pass**: the CF module (`collaborative-filter.js`) already computes per-item scores from similar users. Blend this in as a 6th scoring dimension, or use it as the primary tie-breaker.

---

## 5. Parser Fragility — Fenced JSON Breaking Agent Output

### The Problem

From the benchmark traces: the Serendipity Agent "returned fenced JSON" which triggered per-agent fallback to heuristic scoring. The parser in `topic-insight-engine.js` (lines 124-125) does:

```javascript
const cleaned = response.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
const parsed = JSON.parse(cleaned);
```

### Failure Modes

1. **Trailing text after fence**: LLM returns `Here are my picks:\n\`\`\`json\n{...}\n\`\`\`\nHope this helps!` — after stripping fences, the trailing text makes `JSON.parse` fail.
2. **Multiple fenced blocks**: LLM returns reasoning in one block, data in another — the regex merges them into unparsable text.
3. **Nested backticks**: LLM uses backticks within the JSON string values — regex strips them, corrupting the JSON.

### Impact

When parsing fails, `swarm.js` (line 313) falls back to heuristic scoring for that agent. This means:
- The LLM reasoning (which cost tokens and latency) is **completely discarded**
- The agent falls back to keyword/temporal heuristics that were designed as a fast path, not a replacement for LLM judgment
- **The fallback is silent** — there's no metric tracking how often it triggers, so degradation is invisible

In the benchmark traces, "some contained fenced JSON" and "some used odd indices like 0" — suggesting the fallback triggered on a non-trivial fraction of agent calls.

### Fix

1. **Extract JSON from fenced blocks** instead of stripping fences:
   ```javascript
   const fenceMatch = response.match(/```json?\s*\n?([\s\S]*?)\n?```/);
   const jsonStr = fenceMatch ? fenceMatch[1] : response;
   ```
2. **Try multiple extraction strategies** in order: raw parse → fence extraction → find first `{` to last `}` → regex for array `[...]`
3. **Log fallback rate** as a first-class metric so degradation is visible
4. **Constrain the prompt**: add `Respond with ONLY a JSON object. No markdown, no explanation, no fenced blocks.` to agent prompts

---

## 6. Static 5-Agent Committee — Why It Fails for Movie Recs

### The Mismatch

The committee was designed for **story curation** (news/articles for a knowledge worker). The agent mandates reveal this clearly:

| Agent | Mandate | Movie Relevance |
|-------|---------|----------------|
| Career | "active projects, professional goals" | Movies don't have professional utility |
| Timing | "why this is relevant today" | A 1989 movie isn't "timely" |
| Growth | "expand thinking beyond bubble" | Loosely applicable |
| Contrarian | "what others would miss" | Loosely applicable |
| Serendipity | "delight, inspiration" | Applicable |

Only 2-3 of 5 agents have mandates that map to movie recommendation. The Career and Timing agents are essentially generating noise for this domain. With weights of 0.25 each, **50% of the voting weight comes from irrelevant agents**.

### Evidence from Traces

- The Timing Agent promoted Indiana Jones as "perfect for today" — a movie from 1989. The reasoning is post-hoc rationalization, not genuine temporal relevance.
- The Career Agent in GSS framed survey answers as helping the user's "active project" of taking the survey — circular reasoning that provides no signal.

### Why This Doesn't Invalidate the Architecture

The swarm *architecture* (multiple reasoning perspectives, weighted consensus) is sound. The problem is that the *specific agents* are hardcoded for a different domain. A movie recommendation committee should have:

- **Genre Fit Agent**: "Does this match the user's demonstrated genre preferences?"
- **Era/Style Agent**: "Does this match the user's preferred time period and filmmaking style?"
- **Social Proof Agent**: "How popular is this among users with similar taste?"
- **Discovery Agent**: "Is this outside the user's usual picks but highly rated by similar users?"
- **Emotional Arc Agent**: "Does this serve the user's current mood/viewing context?"

### Fix

Two approaches:
1. **Dynamic committee generation**: Given the task domain (movies, opinions, articles), generate appropriate agent mandates at runtime. Cost: one extra LLM call.
2. **Domain-specific committee configs**: Ship pre-built committee definitions per domain. Less flexible but zero additional latency.

---

## 7. Missing Popularity Signal — How to Integrate

### Current State

Marble has **no explicit popularity signal**. The closest proxy is:
- Collaborative filtering (`collaborative-filter.js`): encodes "users like you engaged with this" but is capped at 15% weight and requires sufficient similar-user data
- Source trust (`scorer.js`): hardcoded trusted sources — not the same as item-level popularity
- Signal inference (`signals.js`): dwell time and engagement signals — requires runtime behavioral data that benchmarks don't provide

### Why It's Missing

Marble was designed as a **personalization** engine, not a recommendation engine. Its philosophical stance is "what's right for *you*" not "what's popular." This is a valid product position for story curation, but it's a handicap in benchmarks where the popularity distribution of the test set matches the training set.

### Integration Strategy

**Option A: Popularity as a Prior (Bayesian Blend)**
```
final_score = popularity_prior × (1 - personalization_confidence) + marble_score × personalization_confidence
```
When Marble has low confidence (few user signals, sparse profile), fall back toward popularity. As personalization confidence grows, let Marble's score dominate. This is the standard "explore/exploit" pattern in recommendation systems.

**Option B: Popularity as a 6th Scoring Dimension**
Add `popularity_weight` to the scorer alongside alignment, temporal, novelty, actionability, and source_trust. For MovieLens, this could be `rating_count / max_rating_count` or `avg_rating / 5.0`. Weight it at 0.20 initially.

**Option C: Popularity as a Swarm Agent**
Add a "Social Proof Agent" to the committee with mandate: "Rank candidates by how well-received they are among the broader population and among users similar to this one." This keeps the swarm architecture intact.

**Recommendation**: Option A is the most principled. It preserves Marble's personalization identity while acknowledging that with sparse user data, the best prediction is the population average.

---

## 8. Ranked Fix List with Expected Impact

| Priority | Fix | Expected p@10 Impact | Effort |
|----------|-----|---------------------|--------|
| **1** | **Add popularity/collaborative prior blend** (Option A from section 7) | +12-18pp on MovieLens (closing most of the gap to 58.3%) | Medium — need popularity data pipeline + blending logic in scorer |
| **2** | **Fix parser: extract JSON from fences** instead of stripping | +3-5pp (eliminates silent fallback to heuristics; hard to quantify precisely but removes a floor on performance) | Low — ~20 lines of code |
| **3** | **Gate evolution on minimum samples** (≥15 before activating, matching metric-agnostic-scorer threshold) | +5-8pp on online/evolving tasks (stops the poisoning effect) | Low — add sample count check before evolution loop |
| **4** | **Domain-aware committee selection** (movie agents for movies, belief agents for opinions) | +5-10pp on GSS, +3-5pp on MovieLens | Medium — define 2-3 committee presets, add domain routing |
| **5** | **Add tie-breaking with CF score** | +2-4pp on GSS, +1-2pp on MovieLens | Low — add secondary sort key in consensus builder |
| **6** | **Reduce Career/Timing weight or replace** for non-article domains | +2-3pp on MovieLens (reduces noise from irrelevant agents) | Low — config change |
| **7** | **Add evolution regularization** (penalize divergence from initial weights) | +2-3pp on online tasks (prevents overfitting on sparse feedback) | Medium — modify mutation function |
| **8** | **Log fallback rate as metric** | 0pp direct, but enables diagnosing future degradation | Low — add counter + log line |

### Projected Combined Impact

If fixes 1-5 are implemented:
- **MovieLens Static p@10**: 41.7% → ~58-65% (competitive with or beating popularity)
- **MovieLens Online accuracy**: 45.8% (evolving) → ~60-65%
- **GSS Static top1**: 33.3% → ~45-50% (still below demographic_match but meaningfully above random)
- **GSS Online accuracy**: 46.9% → ~55-60%

The popularity prior blend (fix 1) is the single highest-leverage change. It's also the most philosophically significant — it means accepting that Marble should be a **hybrid** system, not a pure personalization engine, at least until it has enough user signal to outperform the prior.

---

## Summary

Marble's core architecture (multi-agent swarm with weighted consensus) is sound, but it's being benchmarked with three critical handicaps:

1. **No distributional prior** — it ignores the single strongest signal (popularity/majority) that every baseline exploits
2. **Wrong agents for the task** — the story-curation committee generates noise on movie and opinion tasks
3. **Self-sabotaging feedback loop** — the evolution engine overfits on tiny samples, making evolving worse than frozen

The parser fragility and score tie problems are secondary but contribute meaningful noise. The fixes are well-scoped and can be implemented incrementally, with the popularity prior blend delivering the largest single improvement.

The philosophical question for Marble is: **should it compete on recommendation benchmarks at all, or is its value proposition specifically the personalization layer that sits on top of a conventional recommender?** If the latter, the right benchmark isn't "Marble vs. popularity" — it's "popularity + Marble vs. popularity alone."
