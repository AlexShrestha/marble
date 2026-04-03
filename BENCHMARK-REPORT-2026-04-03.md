# Marble Complete Clean Run Report

This file consolidates the fresh clean rerun, the metric definitions, the fallback explanation, and one traced sample case for each benchmark.

## Fresh Run Metadata

- GitHub repo: `https://github.com/AlexShrestha/marble`
- Fresh clone path: `/Users/skela/Documents/Playground/marble-github-cleanrun`
- Commit tested: `14d3ce06fb30ed74a75166b0475620809963c897`
- Benchmark wrapper path: `/Users/skela/Documents/Playground/marble-isolated-bench`
- Provider used in this clean run: `openai`
- Swarm model used: `gpt-4o-mini`

Raw outputs:
- [MovieLens static JSON](/Users/skela/Documents/Playground/benchmark-results-movielens-static-1775247631447.json)
- [MovieLens online JSON](/Users/skela/Documents/Playground/benchmark-results-movielens-online-1775248121963.json)
- [GSS static JSON](/Users/skela/Documents/Playground/benchmark-results-gss-static-1775248473572.json)
- [GSS online JSON](/Users/skela/Documents/Playground/benchmark-results-gss-online-1775249055932.json)
- [Short clean summary](/Users/skela/Documents/Playground/marble-clean-report-2026-04-03.md)

## Metric Definitions

The movie benchmarks are ranking tasks, so these are the important metrics:

- `precision@10`
  Meaning: of the top 10 items Marble returned, what fraction were actually correct.
  Example: `40%` means Marble got about `4` correct items in the top 10.

- `recall@10`
  Meaning: of all hidden relevant items in the candidate slate, how many Marble recovered in the top 10.
  Example: if there were `10` hidden positives and Marble surfaced `3`, recall@10 is `30%`.

- `hit@10`
  Meaning: whether Marble got at least one correct item into the top 10.
  This is probably what you meant by “heat at 10.”
  It is a weak metric when the task is easy enough that almost every method gets at least one hit.

- `nDCG@10`
  Meaning: ranking quality, where correct items closer to rank `1` count more than correct items at rank `10`.
  This is often the best single summary metric for recommendation quality because it rewards getting the right things near the top.

For the opinion tasks:

- `top1 accuracy`
  Meaning: did Marble’s first-ranked answer equal the real held-out answer.
  This is the clearest headline metric.

- `MRR`
  Meaning: reciprocal rank.
  If the true answer is ranked `1`, MRR contribution is `1.0`.
  If the true answer is ranked `2`, contribution is `0.5`.
  If ranked `3`, contribution is `0.333`.

### What To Look At First

- For movies:
  Look at `nDCG@10` first.
  Then look at `precision@10`.
  `hit@10` is the least informative once many methods are already near `100%`.

- For opinions:
  Look at `top1 accuracy` first.
  Then use `MRR` as the secondary signal.

## What Marble Used, And What Fell Back

This fresh commit behaves differently from earlier ones:

1. `swarm` no longer runs as a local-only heuristic path by default in the way we used before.
2. `swarm` now requires an actual LLM callback.
3. `score` mode also makes remote semantic/preference-alignment calls in this commit.
4. The old local ONNX embedding fallback is gone in this version.

So in this clean run:

- `swarm` used Marble’s own 5-agent committee with provider-backed LLM calls.
- The committee was fixed, not dynamically invented from scratch:
  - Career Agent
  - Growth Agent
  - Timing Agent
  - Contrarian Agent
  - Serendipity Agent
- Each agent got a prompt of the form:
  - “You are the X Agent in a story curation swarm.”
  - “Here is your mandate.”
  - “Here is the simulated user profile.”
  - “Here are the candidate stories.”
  - “Pick your top 5 stories and explain why.”

Internal fallback still exists in one important place:

- In `core/swarm.js`, if an agent’s LLM response cannot be parsed as the expected JSON, Marble falls back to heuristic scoring for that agent.

That mattered here because some raw agent outputs were messy:

- some contained fenced JSON
- some used odd indices like `0`
- some clearly mixed reasoning between nearby candidates

Also, one earlier large movie-static attempt on this same fresh commit crashed in `score` mode because Marble’s remote preference-alignment fetch failed. I did not patch Marble. Instead, I reran the clean suite on bounded sample sizes so the clean run would complete while still exercising Marble itself.

## Committee Used In This Run

The committee was the same across all swarm experiments:

- `Career Agent`
  Mandate: help with active projects, professional goals, direct utility.

- `Growth Agent`
  Mandate: expand the user’s thinking beyond their current bubble.

- `Timing Agent`
  Mandate: why this is relevant today.

- `Contrarian Agent`
  Mandate: surface what others would miss.

- `Serendipity Agent`
  Mandate: surface delight, inspiration, or unexpectedly resonant picks.

## Aggregate Results

### 1. MovieLens Static

Raw report:
[benchmark-results-movielens-static-1775247631447.json](/Users/skela/Documents/Playground/benchmark-results-movielens-static-1775247631447.json)

Config:
- users: `6`
- candidates per user: `40`
- hidden positives per user: `10`
- topK: `10`

Results:
- `marblism_score_select`
  - precision@10 `28.3%`
  - recall@10 `28.3%`
  - hit@10 `100%`
  - nDCG@10 `32.7%`
- `marblism_swarm_select`
  - precision@10 `41.7%`
  - recall@10 `25.0%`
  - hit@10 `100%`
  - nDCG@10 `31.2%`
- `genre_overlap`
  - precision@10 `26.7%`
  - nDCG@10 `26.3%`
- `popularity`
  - precision@10 `58.3%`
  - nDCG@10 `60.9%`
- `random`
  - precision@10 `18.3%`
  - nDCG@10 `17.9%`

Reading:
- `popularity` was best.
- `swarm` beat `score` on precision but not on nDCG.
- Marble still underperformed the strongest simple baseline.

### 2. MovieLens Online / Evolving

Raw report:
[benchmark-results-movielens-online-1775248121963.json](/Users/skela/Documents/Playground/benchmark-results-movielens-online-1775248121963.json)

Config:
- users: `6`
- steps per user: `4`
- slate size: `12`
- positive threshold: target ranked in top `3`

Results:
- `marblism_score_frozen`
  - accuracy `58.3%`
- `marblism_score_evolving`
  - accuracy `54.2%`
- `marblism_swarm_frozen`
  - accuracy `54.2%`
- `marblism_swarm_evolving`
  - accuracy `45.8%`
- `genre_overlap`
  - accuracy `54.2%`
- `popularity`
  - accuracy `79.2%`
- `random`
  - accuracy `45.8%`

Reading:
- On this bounded evolving movie test, Marble did not show useful online improvement.
- `swarm_evolving` was worse than `swarm_frozen`.
- `popularity` remained clearly strongest.

### 3. GSS Static

Raw report:
[benchmark-results-gss-static-1775248473572.json](/Users/skela/Documents/Playground/benchmark-results-gss-static-1775248473572.json)

Config:
- train respondents: `1800`
- eval respondents: `12`
- max tasks per question: `3`

Results:
- `marblism_score_select`
  - top1 `27.8%`
  - MRR `0.561`
- `marblism_swarm_select`
  - top1 `33.3%`
  - MRR `0.584`
- `majority`
  - top1 `55.6%`
- `demographic_match`
  - top1 `58.3%`
- `nearest_neighbor`
  - top1 `52.8%`
- `random_guess`
  - top1 `33.3%`

Reading:
- Marble swarm barely edged random and remained far behind simple survey baselines.
- This is a much more sobering result than the movie setting.

### 4. GSS Online / Evolving

Raw report:
[benchmark-results-gss-online-1775249055932.json](/Users/skela/Documents/Playground/benchmark-results-gss-online-1775249055932.json)

Config:
- train respondents: `1800`
- eval respondents: `8`
- steps per respondent: `4`

Results:
- `marblism_score_frozen`
  - accuracy `46.9%`
- `marblism_score_evolving`
  - accuracy `46.9%`
- `marblism_swarm_frozen`
  - accuracy `53.1%`
- `marblism_swarm_evolving`
  - accuracy `46.9%`
- `majority`
  - accuracy `68.8%`
- `demographic_match`
  - accuracy `68.8%`
- `nearest_neighbor`
  - accuracy `68.8%`

Reading:
- Marble did not improve under the opinion feedback loop.
- `swarm_frozen` was better than `swarm_evolving`.
- Baselines were materially stronger.

## Sample Case 1: MovieLens Static

Source:
[benchmark-results-movielens-static-1775247631447.json](/Users/skela/Documents/Playground/benchmark-results-movielens-static-1775247631447.json)

Sample user:
- user id `7`
- age `57`
- gender `M`
- occupation `administrator`

Inferred profile from visible training ratings:
- positive genres were led by:
  - `Drama (65)`
  - `Thriller (27)`
  - `Action (26)`
  - `Comedy (22)`
  - `Sci-Fi (21)`
  - `War (20)`
- strongest negative genres were:
  - `Horror (9)`
  - `Comedy (6)`
  - `Thriller (4)`

Hidden positive movies included:
- `Fatal Instinct (1993)`
- `Indiana Jones and the Last Crusade (1989)`
- `Die Hard: With a Vengeance (1995)`
- `Die Hard 2 (1990)`
- `Highlander (1986)`
- `Patton (1970)`
- `It's a Wonderful Life (1946)`
- `Manchurian Candidate, The (1962)`

What Marble had to do:
- rank `40` candidate movies
- recover the hidden liked ones near the top

`score` top 5:
- `Indiana Jones and the Last Crusade` `true`
- `Highlander` `true`
- `Waterworld` `false`
- `Color of Night` `false`
- `Touch` `false`

`swarm` top 5:
- `Patton` `true`
- `Chasing Amy` `false`
- `Indiana Jones and the Last Crusade` `true`
- `Pagemaster` `false`
- `Adventures of Robin Hood` `true`

What the swarm asked:
- `5` LLM calls, one per agent
- first two traced agents:
  - `Timing Agent`
  - `Contrarian Agent`

Example Timing Agent response:
- pushed `Indiana Jones`, `Pagemaster`, `Highlander`, `Patton`, `Black Beauty`
- framed them as “perfect for today” because they matched adventure/drama while avoiding unwanted horror/thriller overload

Example Contrarian Agent response:
- pushed `Pagemaster`, `Chasing Amy`, `Black Beauty`, `Patton`, `Eve’s Bayou`
- framed them as unusual but still resonant extensions of the user’s taste

Interpretation:
- `score` looked generic and heavily tied.
- `swarm` produced richer reasons and more differentiated picks.
- but even then, `popularity` still beat Marble overall.

## Sample Case 2: MovieLens Online / Evolving

Source:
[benchmark-results-movielens-online-1775248121963.json](/Users/skela/Documents/Playground/benchmark-results-movielens-online-1775248121963.json)

Sample user:
- user id `13`
- age `47`
- gender `M`
- occupation `educator`

Initial profile:
- strongest positive genres:
  - `Drama`
  - `Comedy`
  - `Action`
  - `Romance`
  - `Thriller`
- strongest negative genres:
  - `Horror`
  - `Comedy`
  - `Drama`
  - `Thriller`
  - `Action`

Loop count:
- `4` sequential hidden movies

### Step 1

Hidden target:
- `Pollyanna (1960)`
- real rating `2`
- ground truth: negative

Slate included:
- `Renaissance Man`
- `Willy Wonka`
- `Pollyanna`
- `Jaws 2`
- `Strawberry and Chocolate`
- `Night Falls on Manhattan`
- `Ballad of Narayama`
- `Blues Brothers`

Predictions:
- `score_frozen`
  - target rank `9`
  - predicted negative
- `score_evolving`
  - target rank `9`
  - predicted negative
- `swarm_frozen`
  - target rank `4`
  - predicted negative
- `genre_overlap`
  - target rank `8`
  - predicted negative
- `popularity`
  - target rank `10`
  - predicted negative

This step was basically handled correctly by everyone except random.

### Step 2

The report also captures the second hidden movie and the post-feedback state, but the main pattern did not improve in a meaningful way over the loop.

What the swarm asked:
- `20` LLM calls total for this traced user
- first traced agents:
  - `Contrarian Agent`
  - `Serendipity Agent`

Contrarian example:
- promoted `Strawberry and Chocolate`, `Night Falls on Manhattan`, `Renaissance Man`, `Ballad of Narayama`
- interpreted the user as an educator who might value discussion-worthy films more than pure genre fit

Serendipity example:
- returned fenced JSON
- included `Pollyanna` itself as uplifting
- this is exactly the kind of output shape that can stress Marble’s parser and trigger per-agent fallback behavior

Interpretation:
- this trace helps explain why evolving swarm did not beat frozen swarm here
- the agent reasoning was rich, but not consistently calibrated to the target label

## Sample Case 3: GSS Static

Source:
[benchmark-results-gss-static-1775248473572.json](/Users/skela/Documents/Playground/benchmark-results-gss-static-1775248473572.json)

Hidden question:
- `gunlaw`
- question: “Should a police permit be required before someone can buy a gun?”
- real answer: `favor`

Respondent profile:
- female
- age `80`
- white
- high school
- divorced
- protestant
- news every day
- independent, close to democrat
- liberal

Known opinions Marble could see:
- `cappun = oppose`
- `helppoor = agree with both`
- `confed = a great deal`
- `conjudge = only some`
- `conlegis = only some`

Candidate answers:
- `favor`
- `oppose`

`score` result:
- rank 1 `favor`
- rank 2 `oppose`
- but both got the same score `0.35`

So `score` was technically correct but not sharply discriminative.

`swarm` result:
- rank 1 `favor`
- rank 2 `oppose`
- the `favor` option got stronger aggregate backing

First two traced agents:
- `Timing Agent`
- `Career Agent`

Timing Agent response:
- essentially said:
  - this is relevant now because the user is literally in a public-opinion survey
  - hearing the `favor` and `oppose` frames today helps them answer better

Career Agent response:
- framed both candidate answers as useful because they directly help the user’s “active project” of answering the survey

Interpretation:
- swarm added coherent survey-context reasoning
- but note the structure: it often gave useful reasons for both options, then only weakly separated them
- that helps explain why static opinion accuracy remained poor overall

## Sample Case 4: GSS Online / Evolving

Source:
[benchmark-results-gss-online-1775249055932.json](/Users/skela/Documents/Playground/benchmark-results-gss-online-1775249055932.json)

Sample respondent:
- same respondent family as above
- female
- age `80`
- white
- high school
- divorced
- protestant
- independent, close to democrat
- liberal

Initially known opinions:
- `conjudge = only some`
- `conlegis = only some`

Hidden question order:
- `gunlaw`
- `cappun`
- `helppoor`
- `confed`

Loop count:
- `4`

### Step 1

Hidden question:
- `gunlaw`
- real answer: `favor`

Predictions:
- `score_frozen`
  - rank 1 `favor`
- `score_evolving`
  - rank 1 `favor`
- `swarm_frozen`
  - rank 1 `favor`
- `swarm_evolving`
  - rank 1 `favor`
- `majority`
  - rank 1 `favor`
- `demographic_match`
  - rank 1 `favor`
- `nearest_neighbor`
  - rank 1 `oppose`

So step 1 went fine for Marble.

### Step 2

The trace then moves to `cappun`.

What matters is that the evolving variants did not improve over time:
- `score_evolving` ended equal to `score_frozen`
- `swarm_evolving` ended worse than `swarm_frozen`

First two traced agents:
- `Timing Agent`
- `Growth Agent`

Timing Agent example:
- said this is timely because the user is actively filling out a public-opinion survey on politics and public policy

Growth Agent example:
- framed the question as a way to think about civil liberties, safety, and public policy complexity

Interpretation:
- the LLM reasoning was articulate
- but the sequential feedback loop still did not improve held-out answer prediction in aggregate

## Bottom Line

On this fresh clean rerun:

- Marble was tested through a real fresh GitHub clone.
- Swarm used Marble’s actual provider-backed committee path.
- The committee was always the same 5 Marble agents.
- The reports include real prompts and real model responses.
- The strongest simple baselines still beat Marble on both the movie and opinion tasks.
- The evolving loop did not show reliable improvement in these bounded runs.

## If You Want The Next Step

Two natural next passes:

- run the exact same clean suite again with `deepseek` instead of `openai`
- extract the four `sample_trace` objects into a separate “casebook” file with less benchmark summary and more raw committee/response detail
