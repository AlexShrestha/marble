# Marble Fix Plan — Ranked Path to >65% Precision@10

**Date:** 2026-04-04
**Sources:** BENCHMARK-REPORT-2026-04-03.md, FINDINGS-PASS1.md, FINDINGS-PASS2.md
**Target:** >65% precision@10 on MovieLens U1 (current: 41.7% swarm, 58.3% popularity baseline)

---

## Synthesis: What the Three Passes Agree On

The benchmark report establishes the facts: popularity (58.3%) beats swarm (41.7%) on MovieLens static, and evolving (45.8%) is worse than frozen (54.2%) on MovieLens online. Pass 1 correctly identifies the root causes: missing distributional prior, wrong committee for the domain, poisoned feedback loop, parser fallbacks, and score ties. Pass 2 adds critical nuance: N=6 is statistically thin, the CF module may be dead (cold-start zeros), dynamic fleet features (`generateAgentFleet`, `computeDynamicWeights`) already exist but were never tested, and model quality (gpt-4o-mini) may be a binding constraint.

**The path to >65% requires both measurement fixes (valid benchmarks) and architectural fixes (popularity signal, dynamic committees, parser).** We implement them in parallel — the architectural fixes are clearly correct regardless of sample size, and the measurement fixes validate the delta.

---

## Fix 1: Integrate Popularity Signal into Swarm Scoring

**Priority:** CRITICAL — largest single lever

### Problem
Marble has zero distributional prior. The swarm reasons about *why* content fits a user but has no signal about *what most people like*. This is the 16.6pp gap between swarm and popularity.

### Implementation
**File:** `core/scorer.js`

Add a 6th scoring dimension `popularity_score` alongside alignment, temporal, novelty, actionability, source_trust:

```
popularity_score = item.rating_count / max_rating_count_in_slate
```

Use Bayesian blend in final score:
```
personalization_confidence = min(1.0, user_signal_count / 50)
final = popularity_score * (1 - personalization_confidence) + marble_score * personalization_confidence
```

This means: sparse profiles → lean on popularity; rich profiles → lean on Marble personalization.

**Also wire into swarm:** Add a "Social Proof Agent" to the committee (`core/swarm.js`) with mandate: "Rank candidates by how well-received they are among the broader population and similar users." This keeps the swarm architecture intact while injecting the popularity signal through a reasoning lens rather than raw numbers.

### Expected Impact
- **precision@10 delta:** +12–18pp (MovieLens static), bringing swarm to 54–60%
- **Risk:** LOW — this is standard hybrid recommender design; does not break personalization for rich profiles
- **Effort:** M — need popularity data pipeline into scorer + new agent definition + weight tuning

### Validation
Run `popularity + marble_rerank` vs `popularity` alone. If Marble doesn't improve over raw popularity, the swarm adds noise, not signal.

---

## Fix 2: Dynamic Committee Selection Per User

**Priority:** HIGH — 50% of voting weight currently comes from irrelevant agents

### Problem
The static 5-agent committee (Career, Growth, Timing, Contrarian, Serendipity) was designed for story curation. For movies: Career and Timing generate noise (50% of weight). For opinions: all 5 are misaligned. Pass 2 reveals that `generateAgentFleet()` (swarm.js:925–993) and `computeDynamicWeights()` (swarm.js:569–606) already exist but were never exercised in benchmarks.

### Implementation
**File:** `core/swarm.js`

**Step 1:** Test and fix the existing dynamic fleet system. Wire `generateAgentFleet()` into the benchmark path. If it generates domain-appropriate agents (genre fit, era/style for movies; belief modeling, value coherence for opinions), use it.

**Step 2:** If the dynamic system is insufficient, add per-user agent selection: given a user's taste profile (top genres, rating patterns, demographic signals), select 3–5 agents from a larger pool whose mandates match the user's interest dimensions. A drama-heavy user gets a Narrative Depth agent; an action-heavy user gets a Pacing/Spectacle agent.

**Step 3:** Implement per-query dynamic weight adjustment — a user actively job-hunting upweights Career; a user in exploration mode upweights Serendipity. Use KG profile signals to set weights per ranking call, not per evolution generation.

### Expected Impact
- **precision@10 delta:** +5–10pp (MovieLens), +5–10pp (GSS)
- **Risk:** MEDIUM — dynamic fleet generation costs 1 extra LLM call; bad agent generation could degrade results
- **Effort:** M — Step 1 is testing existing code; Steps 2–3 are new logic

---

## Fix 3: Fix Score Tie-Breaking

**Priority:** HIGH — silent failure mode that masks real signal

### Problem
From GSS static: `score` gave both `favor` and `oppose` identical scores of 0.35. 4 of 5 scoring dimensions (temporal, novelty, actionability, source_trust) produce zero discrimination for items with similar surface features. The one differentiator (alignment) produces near-identical values for semantically thin items.

### Implementation
**File:** `core/scorer.js`

1. **Diversity penalty:** When items have near-identical scores (within epsilon=0.01), apply a diversity bonus that rewards items dissimilar to higher-ranked items already selected. Use embedding distance as the diversity measure.

2. **Entropy bonus:** For items in a tie, prefer the item whose selection increases the entropy of the final ranked list (in terms of genre, topic, or attribute distribution).

3. **CF tie-breaker:** Wire `collaborative-filter.js` scores as secondary sort key. But first (per Pass 2): verify CF is actually returning non-zero scores. If CF returns cold-start zeros in benchmark context, implement a fallback to item-level popularity count.

4. **Increase alignment weight for low-content items:** When items have fewer tokens (e.g., single-word survey answers), dynamically upweight the alignment dimension since other dimensions can't discriminate.

### Expected Impact
- **precision@10 delta:** +2–4pp (GSS), +1–3pp (MovieLens)
- **Risk:** LOW — tie-breaking only activates when scores are within epsilon; no effect on clearly differentiated items
- **Effort:** S — ~30 lines in scorer.js consensus builder

---

## Fix 4: Fix Parser — Eliminate Fenced JSON Failures

**Priority:** HIGH — every parse failure throws away a paid LLM call

### Problem
Agents return fenced JSON (`\`\`\`json ... \`\`\``), trailing text, or multiple blocks. The current parser strips fences then tries `JSON.parse`, which fails on trailing text. Fallback to heuristic scoring is **silent** — no metrics track how often it triggers.

### Implementation
**File:** `core/swarm.js` (deep mode parser), `core/topic-insight-engine.js` (lines 124–125)

1. **Replace fence-stripping with fence-extraction:**
   ```javascript
   const fenceMatch = response.match(/```json?\s*\n?([\s\S]*?)\n?\s*```/);
   const jsonStr = fenceMatch ? fenceMatch[1].trim() : response.trim();
   ```

2. **Cascading extraction:** Try in order: raw parse → fence extraction → first `{` to last `}` → first `[` to last `]`

3. **Prompt constraint:** Add to all agent system prompts: `Respond with ONLY a JSON object. No markdown fences, no explanation text.`

4. **Log fallback rate:** Add a counter that tracks parse failures per agent per run. Emit as a first-class metric in benchmark output.

### Expected Impact
- **precision@10 delta:** +2–5pp (eliminates silent degradation to heuristics)
- **Risk:** LOW — strictly more robust than current parser
- **Effort:** S — ~40 lines across two files + prompt update

---

## Fix 5: Fix Evolving Feedback Loop

**Priority:** MEDIUM — evolving is 0-for-4 across all benchmarks

### Problem
`swarm_evolving` is worse than `swarm_frozen` across all four benchmarks. Pass 1 diagnoses: catastrophically small sample size (24 events for 15+ parameters), mutation rate too high, no regularization toward prior. Pass 2 adds: no one has dumped the evolved weights, and the evolution may be converging toward "always pick popular" (filter bubble).

### Implementation
**File:** `core/evolution.js`

1. **Gate on minimum samples:** Add `if (feedbackCount < 15) return frozenWeights;` before the evolution loop. This matches the existing 15-sample gate in `metric-agnostic-scorer.js` (line 202).

2. **Add regularization toward prior:** Modify the mutation function:
   ```javascript
   const regularization = initialWeight * (1 / Math.sqrt(Math.max(1, sampleCount)));
   newWeight = oldWeight + mutation + (initialWeight - oldWeight) * regularization;
   ```
   This pulls weights back toward their initial values, with pull strength inversely proportional to evidence.

3. **Reduce mutation rate for small samples:**
   ```javascript
   const effectiveMutationRate = baseMutationRate * Math.min(1, sampleCount / 50);
   ```

4. **Add diversity constraint:** Penalize weight vectors that converge all weight to a single agent (prevents filter bubble convergence).

5. **Diagnostic: dump evolved weights** after benchmark runs to verify the mechanism is learning signal, not noise.

### Expected Impact
- **precision@10 delta:** +5–8pp on online/evolving tasks (stops poisoning); 0pp on static
- **Risk:** LOW — gating on minimum samples is strictly safe; regularization preserves frozen behavior when evidence is scarce
- **Effort:** M — mutation function changes + diagnostic tooling + testing

---

## Fix 6: Add User KG Awareness to Agents

**Priority:** MEDIUM — agents currently reason from impoverished inputs

### Problem
Pass 2 identifies that agents aren't wrong — they're **information-starved**. The Timing Agent has no actual temporal context. The Career Agent has no career data. Agents receive a simulated user profile but not the user's full preference history from the KG. This forces post-hoc rationalization instead of genuine taste inference.

### Implementation
**File:** `core/swarm.js` (agent prompt construction), `core/kg.js` (KG query)

1. **Inject KG preference history into agent prompts:** Before each swarm run, query the user's KG for:
   - Top 10 liked items with reasons (if available)
   - Top 5 disliked items with reasons
   - Explicit preference statements ("I love noir thrillers", "I hate slapstick")
   - Temporal patterns (watches action on weekends, drama on weeknights)

2. **Inject contextual signals:** Pass current date, time of day, and any available context (recent browsing, calendar events) into the Timing Agent prompt.

3. **Structured user profile block:** Standardize a `<user-context>` XML block that all agents receive, containing KG-derived preferences, demographics, and behavioral patterns.

4. **Per-agent KG slicing:** Each agent gets the KG slice relevant to its mandate. Genre Fit agent gets genre distribution; Social Proof agent gets collaborative filtering neighbors; Discovery agent gets the anti-preferences (what to avoid).

### Expected Impact
- **precision@10 delta:** +3–5pp (MovieLens), +5–8pp (GSS where demographic/belief signals matter most)
- **Risk:** MEDIUM — larger prompts increase cost and latency; KG data quality varies
- **Effort:** L — KG query pipeline + prompt restructuring + per-agent slicing logic

---

## Implementation Order & Projected Trajectory

| Phase | Fixes | Cumulative p@10 (projected) | Timeline |
|-------|-------|----------------------------|----------|
| **Phase 0** | Run benchmark at n≥50 users (Pass 2's #1 priority) | Baseline recalibration | Before any code changes |
| **Phase 1** | Fix 4 (parser) + Fix 5 gate (evolution min-samples) | ~45–48% | Low-effort, clearly correct |
| **Phase 2** | Fix 1 (popularity blend) + Fix 3 (tie-breaking) | ~58–63% | Closes the popularity gap |
| **Phase 3** | Fix 2 (dynamic committees) + Fix 6 (KG awareness) | ~63–68% | Unlocks personalization signal |

### Key Ablations to Run Alongside

Per Pass 2's critique, these measurements should run in parallel with code fixes:

1. **Model ablation:** Same benchmark with gpt-4o and Claude Sonnet — if p@10 jumps 15pp, model quality is the binding constraint
2. **Swarm overhead ablation:** Single LLM call with full prompt vs. 5-agent committee — quantify the value of multi-agent reasoning
3. **CF diagnostic:** Verify `collaborative-filter.js` returns non-zero scores during benchmarks (may be returning cold-start zeros)
4. **Loss analysis:** Identify specific users/items where Marble beats popularity — this reveals the swarm's actual signal
5. **Dynamic fleet test:** Exercise `generateAgentFleet()` and `computeDynamicWeights()` in benchmark path

---

## Risk Summary

| Fix | Risk | Mitigation |
|-----|------|-----------|
| 1. Popularity blend | Marble becomes "popularity + noise" | Validate with rerank test: popularity+marble > popularity alone |
| 2. Dynamic committees | Bad auto-generated agents degrade results | A/B test dynamic vs. static; keep static as fallback |
| 3. Tie-breaking | Diversity penalty could push relevant items down | Only activate within epsilon; no effect on clear winners |
| 4. Parser | Cascading extraction could grab wrong JSON block | Unit test each extraction strategy against real agent outputs |
| 5. Evolution | Regularization could prevent real learning | Reduce regularization strength as sample count grows |
| 6. KG awareness | Larger prompts increase cost 2–3x per agent | Cache KG summaries; truncate to top signals |

---

## Success Criteria

- **Primary:** >65% precision@10 on MovieLens U1 with n≥50 users
- **Secondary:** `popularity + marble_rerank` beats `popularity` alone (proves Marble adds value)
- **Tertiary:** `swarm_evolving` ≥ `swarm_frozen` on online tasks (proves feedback loop works)
- **Cost:** <10 LLM calls per slate (down from current 5 per committee × potential retries)

---

## The Philosophical Question

Pass 2 asks the right question: is Marble a **personalization engine** or a **recommendation engine**? The answer for benchmarks: it must be both. Popularity is the prior; personalization is the update. The goal is not to beat popularity — it's to prove that `popularity + Marble > popularity`. That's the value proposition. These six fixes build toward that proof.
