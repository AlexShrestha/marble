/**
 * Prism Swarm — Multi-Agent Story Curation
 *
 * Each agent evaluates stories through a different lens,
 * all grounded in the user's Clone (digital twin).
 *
 * The agents don't just score — they argue, advocate, and reach consensus.
 * This is how 100 stories become 10 magical ones.
 *
 * v2: Dynamic agent fleet — domain-aware agents generated per context.
 * Use generateAgentFleet(domain, contentSample, kgSummary) to spawn agents
 * tailored to the content type. Use explodeAgentQuestions() for N-question
 * per-agent scoring. Use computeDynamicWeights() to derive weights from
 * discriminability rather than hardcoded values.
 */

import { Clone } from './clone.js';
import { createLLMClient, defaultModel } from './llm-provider.js';

// ── Agent Definitions ──────────────────────────────────────────

const AGENT_LENSES = {
  career: {
    name: 'Career Agent',
    mandate: 'Find stories that directly impact the user\'s active projects, business, and professional goals. Ask: "Will this help them make money, avoid a mistake, or seize an opportunity in their current work?"',
    weight: 0.25
  },
  growth: {
    name: 'Growth Agent',
    mandate: 'Find stories that expand the user\'s thinking beyond their current bubble. Not random — adjacent interests, emerging fields they should know about, ideas that connect to what they already care about in non-obvious ways.',
    weight: 0.15
  },
  timing: {
    name: 'Timing Agent',
    mandate: 'Find stories where TODAY is the perfect day to hear them. Calendar events, project deadlines, meetings, seasonal relevance, breaking news that affects decisions they\'re making right now.',
    weight: 0.25
  },
  contrarian: {
    name: 'Contrarian Agent',
    mandate: 'Find stories everyone else would miss. Challenge the user\'s assumptions. Surface signal from noise. The story nobody is talking about that will matter in 2 weeks. The take that goes against the grain but is backed by evidence.',
    weight: 0.15
  },
  serendipity: {
    name: 'Serendipity Agent',
    mandate: 'Find stories that would genuinely delight, surprise, or inspire the user. Not clickbait — real moments of "I didn\'t know I needed to hear this today." Human stories, unexpected connections, the kind of thing you\'d screenshot and send to a friend.',
    weight: 0.20
  }
};

// ── Swarm Agent ──────────────────────────────────────────

class SwarmAgent {
  constructor(lens, clone) {
    this.lens = lens;
    this.clone = clone;
    this.picks = [];
  }

  /**
   * Evaluate all stories through this agent's lens.
   * Returns scored picks with reasoning.
   */
  evaluate(stories) {
    this.picks = stories.map(story => ({
      story,
      score: this.#score(story),
      reason: null // filled by LLM in deep mode
    }));

    this.picks.sort((a, b) => b.score - a.score);
    return this.picks;
  }

  /**
   * Get this agent's top N advocacy picks
   */
  advocate(n = 5) {
    return this.picks.slice(0, n);
  }

  /**
   * Generate prompt for LLM-based deep evaluation
   */
  toPrompt(stories) {
    return [
      `You are the ${this.lens.name} in a story curation swarm.`,
      '',
      `YOUR MANDATE: ${this.lens.mandate}`,
      '',
      this.clone.toPrompt(),
      '',
      '## Stories to evaluate',
      '',
      ...stories.map((s, i) =>
        `${i + 1}. [${s.source}] ${s.title}\n   ${s.summary}\n   Topics: ${(s.topics || []).join(', ')}`
      ),
      '',
      'Pick your top 5 stories. For each, explain WHY this user needs to hear this TODAY.',
      'Format: { "picks": [{ "index": N, "score": 0-1, "reason": "..." }] }'
    ].join('\n');
  }

  // ── Heuristic scoring (fast mode, no LLM) ──────────

  #score(story) {
    const engagement = this.clone.wouldEngage(story);

    switch (this.lens.name) {
      case 'Career Agent':
        return this.#careerScore(story, engagement);
      case 'Growth Agent':
        return this.#growthScore(story, engagement);
      case 'Timing Agent':
        return this.#timingScore(story, engagement);
      case 'Contrarian Agent':
        return this.#contrarianScore(story, engagement);
      case 'Serendipity Agent':
        return this.#serendipityScore(story, engagement);
      default:
        return engagement;
    }
  }

  #careerScore(story, base) {
    let score = base;
    const text = `${story.title} ${story.summary}`.toLowerCase();
    const ctx = this.clone._snapshot?.context || {};

    // Direct project mention = strong signal
    for (const project of ctx.projects || []) {
      if (text.includes(project.toLowerCase())) {
        score += 0.4;
        break;
      }
    }

    // Business-relevant keywords
    const bizWords = ['revenue', 'funding', 'launch', 'acquisition', 'api', 'pricing',
      'competitor', 'market', 'growth', 'customer', 'saas', 'shopify', 'stripe'];
    const bizHits = bizWords.filter(w => text.includes(w)).length;
    score += Math.min(0.2, bizHits * 0.05);

    return Math.min(1, score);
  }

  #growthScore(story, base) {
    let score = base * 0.5; // de-weight pure interest match
    const interests = this.clone._snapshot?.interests || {};

    // Adjacent topics score higher than direct matches
    const directMatch = (story.topics || []).some(t => interests[t]?.weight > 0.5);
    const adjacentMatch = (story.topics || []).some(t => {
      const w = interests[t]?.weight;
      return w && w > 0.1 && w < 0.5; // known but not saturated
    });

    if (adjacentMatch && !directMatch) score += 0.3; // adjacent = growth
    if (!directMatch && !adjacentMatch) score += 0.15; // unknown = potential stretch

    return Math.min(1, score);
  }

  #timingScore(story, base) {
    let score = 0.1;
    const text = `${story.title} ${story.summary}`.toLowerCase();
    const ctx = this.clone._snapshot?.context || {};

    // Calendar match = highest signal
    for (const event of ctx.calendar || []) {
      const words = event.toLowerCase().split(/\s+/);
      if (words.some(w => w.length > 3 && text.includes(w))) {
        score += 0.4;
        break;
      }
    }

    // Recent conversation match
    for (const convo of ctx.conversations || []) {
      if (text.includes(convo.toLowerCase())) {
        score += 0.25;
        break;
      }
    }

    // Freshness matters more for timing
    const hoursOld = story.freshness || 24;
    if (hoursOld < 3) score += 0.2;
    else if (hoursOld < 6) score += 0.1;

    return Math.min(1, score);
  }

  #contrarianScore(story, base) {
    let score = 0.2;
    const patterns = this.clone._snapshot?.patterns || {};

    // Stories on topics the user usually avoids but from trusted sources
    const isAvoided = (story.topics || []).some(t =>
      (patterns.avoids || []).includes(t)
    );
    const isTrusted = (this.clone._snapshot?.source_trust?.[story.source] ?? 0.5) > 0.6;

    if (isAvoided && isTrusted) score += 0.4; // contrarian gold
    if (story.valence === 'alarming') score += 0.1;

    // Low saturation = less covered = contrarian
    const interests = this.clone._snapshot?.interests || {};
    const isMainstream = (story.topics || []).some(t => interests[t]?.weight > 0.7);
    if (!isMainstream) score += 0.15;

    return Math.min(1, score);
  }

  #serendipityScore(story, base) {
    let score = 0.15;

    if (story.valence === 'fun') score += 0.25;
    if (story.valence === 'inspiring') score += 0.2;

    // Moderate interest match = sweet spot (not boring, not irrelevant)
    const interests = this.clone._snapshot?.interests || {};
    const matchStrength = Math.max(
      ...(story.topics || []).map(t => interests[t]?.weight || 0),
      0
    );
    if (matchStrength > 0.2 && matchStrength < 0.6) score += 0.2;

    // Shareable stories score high
    const shareWords = ['beautiful', 'amazing', 'unexpected', 'first ever',
      'discovered', 'breakthrough', 'heartwarming', 'incredible'];
    const text = `${story.title} ${story.summary}`.toLowerCase();
    const shareHits = shareWords.filter(w => text.includes(w)).length;
    score += Math.min(0.2, shareHits * 0.1);

    return Math.min(1, score);
  }
}

// ── Swarm Orchestrator ──────────────────────────────────────

export class Swarm {
  constructor(kg, options = {}) {
    this.clone = new Clone(kg);
    this.agents = [];
    this.options = {
      mode: options.mode || 'fast', // 'fast' (heuristic) or 'deep' (LLM)
      llm: options.llm || null,     // LLM function for deep mode
      topN: options.topN || 10
    };
  }

  /**
   * Run the swarm curation process.
   * Each agent evaluates independently, then consensus is reached.
   *
   * @param {Story[]} stories - All candidate stories (~100)
   * @returns {ScoredStory[]} - Final curated selection
   */
  async curate(stories) {
    // Step 1: Create digital twin snapshot
    this.clone.takeSnapshot();

    // Step 2: Spawn agents with different lenses
    this.agents = Object.entries(AGENT_LENSES).map(([key, lens]) =>
      new SwarmAgent(lens, this.clone)
    );

    // Step 3: Each agent evaluates independently
    if (this.options.mode === 'deep' && this.options.llm) {
      await this.#deepEvaluation(stories);
    } else {
      this.#fastEvaluation(stories);
    }

    // Step 4: Consensus — weighted vote across all agents
    const consensus = this.#buildConsensus(stories);

    // Step 5: Return top N with arc positions
    return consensus.slice(0, this.options.topN);
  }

  /**
   * Fast mode: heuristic scoring, no LLM calls
   */
  #fastEvaluation(stories) {
    for (const agent of this.agents) {
      agent.evaluate(stories);
    }
  }

  /**
   * Deep mode: LLM-powered evaluation per agent
   */
  async #deepEvaluation(stories) {
    const promises = this.agents.map(async (agent) => {
      const prompt = agent.toPrompt(stories);
      const response = await this.options.llm(prompt);

      try {
        const parsed = JSON.parse(response);
        for (const pick of parsed.picks || []) {
          const story = stories[pick.index - 1];
          if (story) {
            agent.picks.push({
              story,
              score: pick.score,
              reason: pick.reason
            });
          }
        }
      } catch {
        // Fallback to heuristic if LLM parsing fails
        agent.evaluate(stories);
      }
    });

    await Promise.all(promises);
  }

  /**
   * Consensus: combine agent picks with weighted voting
   */
  #buildConsensus(stories) {
    const storyScores = new Map();
    const lensKeys = Object.keys(AGENT_LENSES);

    for (let i = 0; i < this.agents.length; i++) {
      const agent = this.agents[i];
      const lens = AGENT_LENSES[lensKeys[i]];
      const topPicks = agent.advocate(15); // each agent's top 15

      for (const pick of topPicks) {
        const id = pick.story.id;
        if (!storyScores.has(id)) {
          storyScores.set(id, {
            story: pick.story,
            total_score: 0,
            agent_scores: {},
            reasons: []
          });
        }

        const entry = storyScores.get(id);
        entry.total_score += pick.score * lens.weight;
        entry.agent_scores[lens.name] = pick.score;
        if (pick.reason) entry.reasons.push(`${lens.name}: ${pick.reason}`);
      }
    }

    // Sort by consensus score
    const ranked = [...storyScores.values()]
      .sort((a, b) => b.total_score - a.total_score);

    // Format as ScoredStory
    return ranked.map((entry, i) => ({
      story: entry.story,
      magic_score: entry.total_score,
      agent_scores: entry.agent_scores,
      why: entry.reasons.length ? entry.reasons.join(' | ') : this.#generateWhy(entry),
      arc_position: i + 1
    }));
  }

  #generateWhy(entry) {
    const top = Object.entries(entry.agent_scores)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 2)
      .map(([agent, score]) => `${agent.replace(' Agent', '')}: ${(score * 100).toFixed(0)}%`);
    return top.join(', ');
  }
}

export { Clone, SwarmAgent, AGENT_LENSES };

// ── Genre Overlap Helpers ─────────────────────────────────────────────────────

/**
 * Extract normalized genre array from a story regardless of field name.
 * Handles: story.genres (array), story.genre (string/array), story.topics (array).
 */
function _normalizeGenres(story) {
  const raw = story.genres || story.genre || [];
  const arr = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split('|').map(s => s.trim()) : []);
  // Also fold in topics that look like genres (no spaces, capitalized)
  const topics = (story.topics || []).filter(t => /^[A-Z][a-z]+$/.test(t));
  return [...new Set([...arr, ...topics])].map(g => g.toLowerCase()).filter(Boolean);
}

/**
 * Build a genre → affinity weight map from user history and declared interests.
 * Liked items contribute +0.3 per genre, disliked -0.1; interests add a base of 0.2.
 * Returns weights normalized to [0, 1].
 */
function _buildGenreWeights(history, interests) {
  const weights = {};

  // Seed from declared interests
  for (const [topic, data] of Object.entries(interests || {})) {
    const w = typeof data === 'object' ? (data.weight || 0.5) : Number(data);
    weights[topic.toLowerCase()] = (weights[topic.toLowerCase()] || 0) + w * 0.3;
  }

  // Learn from history
  for (const item of (history || [])) {
    const liked = item.reaction === 'liked' || item.score > 0.6;
    const disliked = item.reaction === 'disliked' || item.score < 0.3;
    if (!liked && !disliked) continue;
    const genres = _normalizeGenres(item);
    for (const g of genres) {
      weights[g] = (weights[g] || 0) + (liked ? 0.3 : -0.1);
    }
  }

  // Clamp to [0.05, 1.0]
  for (const k of Object.keys(weights)) {
    weights[k] = Math.max(0.05, Math.min(1.0, weights[k]));
  }
  return weights;
}

/**
 * Compute genre overlap score: average genre affinity across a story's genres.
 * Returns 0 if story has no genre data.
 */
export function genreOverlapScore(story, kg) {
  const storyGenres = _normalizeGenres(story);
  if (storyGenres.length === 0) return 0;

  const clone = new Clone(kg);
  clone.takeSnapshot();
  const userInterests = clone._snapshot?.interests || {};
  const history = kg.history || kg.reactions || [];

  const weights = _buildGenreWeights(history, userInterests);
  const scores = storyGenres.map(g => weights[g] || 0.05);
  return scores.reduce((s, v) => s + v, 0) / scores.length;
}

/**
 * Hybrid swarm score: genre overlap (60%) + motivation-grounded fallback agents (40%).
 * Beats a pure genre baseline by layering user motivation signals on top of genre fit.
 *
 * For content without structured genres (news, articles), reverts to pure motivation agents.
 *
 * @param {Object} story
 * @param {Object} kg - Knowledge graph / user clone
 * @returns {{ score: number, agentScores: Object, genreScore: number, motivationScore: number }}
 */
/**
 * @param {Object} story
 * @param {Object} kg - Knowledge graph / user clone
 * @param {Object} [opts]
 * @param {number|null} [opts.collaborativeScore] - Pre-computed CF score (0–1) from
 *   globalCollaborativeFilter or similar. When provided, blended as a third signal.
 *   CF and swarm are COMPLEMENTARY: CF captures population patterns ("users like you"),
 *   swarm captures individual motivation ("this specific user"). Neither competes —
 *   both are included when available. See AlexShrestha/marble#25 for rationale.
 */
export function swarmScore(story, kg, opts = {}) {
  const clone = new Clone(kg);
  clone.takeSnapshot();

  // ── Motivation agents ────────────────────────────────────────────────
  // If a dynamic fleet was pre-built via generateAgentFleet(), use it.
  // Otherwise fall back to domain-agnostic static frames.
  let motivationScore;
  let agentScores = {};

  if (opts.fleet && typeof opts.fleet.scoreStory === 'function') {
    // Dynamic committee: agents were generated by LLM for this domain/user
    const fleetResult = opts.fleet.scoreStory(story, {});
    motivationScore = fleetResult.score;
    agentScores = fleetResult.agentScores || {};
  } else {
    // Static fallback frames (domain-agnostic)
    const agents = _FALLBACK_AGENT_FRAMES.map(frame => ({ frame, clone }));
    let weighted = 0;
    let totalWeight = 0;

    for (const { frame } of agents) {
      const baseEngagement = clone.wouldEngage ? clone.wouldEngage(story) : 0.3;

      const storyGenres = _normalizeGenres(story);
      const interests = clone._snapshot?.interests || {};
      const interestTopics = Object.keys(interests).map(t => t.toLowerCase());
      const genreMatch = storyGenres.some(g => interestTopics.includes(g)) ? 0.2 : 0;

      const avoidPatterns = (clone._snapshot?.avoid_patterns || clone._snapshot?.avoidPatterns || [])
        .map(p => p.toLowerCase());
      const titleText = `${story.title || ''} ${story.summary || ''}`.toLowerCase();
      const avoided = avoidPatterns.some(p => titleText.includes(p)) ? -0.15 : 0;

      let depthBonus = 0;
      if (frame.name === 'depth_preference') {
        const wordCount = (story.summary || story.description || '').split(/\s+/).length;
        const prefersDeep = (clone._snapshot?.preferences?.depth || 'medium') === 'deep';
        depthBonus = prefersDeep ? (wordCount > 150 ? 0.15 : -0.05) : (wordCount < 80 ? 0.1 : 0);
      }

      const s = Math.max(0, Math.min(1, baseEngagement + genreMatch + avoided + depthBonus));
      agentScores[frame.name] = s;
      weighted += s * frame.weight;
      totalWeight += frame.weight;
    }

    motivationScore = totalWeight > 0 ? weighted / totalWeight : 0;
  }

  // ── Genre overlap signal ─────────────────────────────────────────────
  const storyGenres = _normalizeGenres(story);
  const hasStructuredGenres = storyGenres.length > 0;
  let genreScore = 0;

  if (hasStructuredGenres) {
    const userInterests = clone._snapshot?.interests || {};
    const history = kg.history || kg.reactions || [];
    const weights = _buildGenreWeights(history, userInterests);
    const scores = storyGenres.map(g => weights[g] || 0.05);
    genreScore = scores.reduce((s, v) => s + v, 0) / scores.length;
  }

  // ── Sparse-content detection ─────────────────────────────────────────
  // When content has < 40 words (e.g. MovieLens: title + genres only), the
  // motivation agents cannot differentiate items — they have nothing to read.
  // Empirically, on MovieLens u1.base the 60/40 blend hurt precision vs pure
  // genre overlap because the 0.4 motivation weight diluted a clean genre signal
  // with near-random engagement scores. Fix: weight genre much higher on sparse
  // content so motivation noise does not drag down well-calibrated genre affinity.
  const contentWords = `${story.title || ''} ${story.summary || ''} ${story.description || ''}`
    .split(/\s+/).filter(Boolean).length;
  const isSparse = contentWords < 40;

  // ── Hybrid blend: CF + genre + motivation ────────────────────────────
  // Architecture decision (marble#25): swarm COMPLEMENTS collaborative filtering.
  //   CF = population signal ("users like you liked X")
  //   genre = structural match signal
  //   motivation = individual signal ("why THIS user consumes this content")
  // When all three are available, blend them. When CF is absent, rely on genre+motivation.
  const collabScore = opts.collaborativeScore ?? null;
  const hasCollab = collabScore !== null && !Number.isNaN(collabScore);

  let score;
  if (hasCollab && hasStructuredGenres) {
    // Three-signal blend
    score = isSparse
      ? collabScore * 0.40 + genreScore * 0.40 + motivationScore * 0.20
      : collabScore * 0.30 + genreScore * 0.40 + motivationScore * 0.30;
  } else if (hasCollab) {
    // No genre structure (news, articles): CF + motivation
    score = collabScore * 0.50 + motivationScore * 0.50;
  } else if (hasStructuredGenres) {
    // No CF: weight genre higher on sparse content to avoid motivation noise
    score = isSparse
      ? genreScore * 0.80 + motivationScore * 0.20
      : genreScore * 0.60 + motivationScore * 0.40;
  } else {
    score = motivationScore;
  }

  const activeClones = _getActiveClones(kg);
  const clone_predictions = activeClones.length > 0 ? _clonePredictions(activeClones, story) : null;

  return {
    score: Math.round(score * 1000) / 1000,
    agentScores,
    genreScore: Math.round(genreScore * 1000) / 1000,
    motivationScore: Math.round(motivationScore * 1000) / 1000,
    collaborativeScore: hasCollab ? Math.round(collabScore * 1000) / 1000 : null,
    isSparse,
    ...(clone_predictions ? { clone_predictions } : {}),
  };
}

// ── Dynamic Weights ──────────────────────────────────────────────────────────

/**
 * Derive agent weights from discriminability (variance) across a scored batch.
 *
 * Weight = variance(agent.scores) × weightHint, normalized to sum=1.
 * Agents that score all candidates identically contribute no signal → weight ≈ 0.
 *
 * @param {Array<Object>} agentScoreMatrix - Per-item agent score objects,
 *   e.g. [{ career: 0.8, timing: 0.3, serendipity: 0.5, growth: 0.4, contrarian: 0.6 }, ...]
 * @param {Object} [weightHints] - Base weight hints (defaults to AGENT_LENSES weights)
 * @param {number} [varianceThreshold=0.001] - Agents below this variance are excluded
 * @returns {Object} Normalized weights, e.g. { career: 0.31, timing: 0.28, ... }
 */
export function computeDynamicWeights(agentScoreMatrix, weightHints = null, varianceThreshold = 0.001) {
  const defaultHints = Object.fromEntries(
    Object.entries(AGENT_LENSES).map(([k, v]) => [k, v.weight])
  );
  const hints = weightHints || defaultHints;

  if (!agentScoreMatrix || agentScoreMatrix.length < 2) {
    return { ...hints };
  }

  const agentNames = Object.keys(hints);
  const n = agentScoreMatrix.length;

  // Compute variance per agent
  const variances = {};
  for (const name of agentNames) {
    const scores = agentScoreMatrix.map(row => row[name] ?? 0);
    const mean = scores.reduce((s, v) => s + v, 0) / n;
    variances[name] = scores.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  }

  // Raw weight = variance × hint; near-zero variance → excluded
  const rawWeights = {};
  for (const name of agentNames) {
    const hint = hints[name] ?? (1 / agentNames.length);
    rawWeights[name] = variances[name] < varianceThreshold ? 0 : variances[name] * hint;
  }

  // Normalize; fall back to hints if all excluded
  const total = Object.values(rawWeights).reduce((s, w) => s + w, 0);
  if (total === 0) return { ...hints };

  const normalized = {};
  for (const name of agentNames) {
    normalized[name] = Math.round((rawWeights[name] / total) * 1000) / 1000;
  }
  return normalized;
}

// ── Domain Detection ─────────────────────────────────────────────────────────

const _DOMAIN_KEYWORDS = {
  'HackerNews': ['news.ycombinator.com', 'hn.algolia.com', 'hacker news', 'hn discussion'],
  'Twitter': ['twitter.com', 'x.com', '@', 'tweet'],
  'Reddit': ['reddit.com', 'r/', '/u/', 'subreddit'],
  'Medium': ['medium.com', 'medium story', 'medium article'],
  'Dev.to': ['dev.to', 'devto'],
  'YouTube': ['youtube.com', 'youtu.be', 'youtube video'],
  'GitHub': ['github.com', 'github.io', 'gist.github'],
  'LinkedIn': ['linkedin.com', 'linkedin'],
  'Blog': ['.substack.com', '.newsletter', 'substack'],
  'News': ['bbc.com', 'cnn.com', 'ny times', 'nytimes.com', 'theverge.com', 'techcrunch.com'],
  'Academic': ['arxiv.org', 'paper', 'research'],
};

const _URL_PATTERN = /https?:\/\/([^\s\/]+)/gi;

/**
 * Detect content domain from a text sample. Heuristic-first, LLM fallback.
 *
 * @param {string} contentSample - Title + summary + url, etc.
 * @param {boolean} [useLLM=false] - Force LLM if heuristics are inconclusive
 * @returns {Promise<{domain: string, availableSignals: string[], contextHint: string}>}
 */
export async function detectDomain(contentSample, useLLM = false) {
  if (!contentSample || typeof contentSample !== 'string') {
    return { domain: 'unknown', availableSignals: [], contextHint: 'No content to analyze' };
  }

  const text = contentSample.toLowerCase();
  const signals = [];
  let detectedDomain = null;

  const urls = (contentSample.match(_URL_PATTERN) || []).map(u => u.toLowerCase());
  if (urls.length > 0) {
    signals.push(`url_found:${urls[0]}`);
    for (const [domain, keywords] of Object.entries(_DOMAIN_KEYWORDS)) {
      for (const kw of keywords) {
        if (urls.some(u => u.includes(kw))) { detectedDomain = domain; signals.push(`url_match:${kw}`); break; }
      }
      if (detectedDomain) break;
    }
  }

  if (!detectedDomain) {
    for (const [domain, keywords] of Object.entries(_DOMAIN_KEYWORDS)) {
      for (const kw of keywords) {
        if (text.includes(kw)) { detectedDomain = domain; signals.push(`keyword_match:${kw}`); break; }
      }
      if (detectedDomain) break;
    }
  }

  if (!detectedDomain && (useLLM || signals.length === 0)) {
    try {
      const client = createLLMClient();
      const response = await client.messages.create({
        model: process.env.MARBLE_LLM_MODEL || defaultModel('fast'),
        max_tokens: 150,
        messages: [{
          role: 'user',
          content: `Identify the content domain from this text. Return ONLY the domain name (e.g. "HackerNews", "Medium", "Twitter", "Blog", "YouTube", "News", "Academic", "GitHub" or "unknown"):\n\n${contentSample.slice(0, 500)}`
        }]
      });
      const llmDomain = (response.content[0]?.type === 'text' ? response.content[0].text : '').trim();
      if (llmDomain && llmDomain !== 'unknown') { detectedDomain = llmDomain; signals.push(`llm_detected:${llmDomain}`); }
    } catch (err) {
      signals.push(`llm_error:${err.message}`);
    }
  }

  const domain = detectedDomain || 'unknown';
  return {
    domain,
    availableSignals: signals,
    contextHint: domain === 'unknown'
      ? 'Unable to determine domain; using general context'
      : `Content from ${domain}; apply domain-specific scoring adjustments`
  };
}

// ── Dynamic Agent Fleet ──────────────────────────────────────────────────────

const _fleetCache = new Map();

function _hashKgSummary(kgSummary) {
  const str = JSON.stringify(kgSummary || '').slice(0, 600);
  let h = 0;
  for (let i = 0; i < str.length; i++) h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Build a synchronous scorer from a generated agent spec.
 * Spec fields: name, boost_keywords, penalty_keywords, domain_signals, insight_keywords,
 *              interest_anchors, interest_topics, positive_signals, negative_signals
 *
 * Checks BOTH text content AND structured fields (story.genres, story.year, story.director)
 * so the scorer works on sparse content like MovieLens items (title + genres only).
 */
function _buildSpecScorer(spec) {
  return function specScorer(story, ctx) {
    let score = 0;
    const reasons = [];
    const text = `${story.title || ''} ${story.summary || ''} ${story.description || ''}`.toLowerCase();

    // ── Structured field matching (critical for sparse content like movies) ──
    const storyGenres = _normalizeGenres(story);

    // Interest anchors: check against genres AND full text (LLM specs use phrases, not just genre labels)
    const anchors = [
      ...(spec.interest_anchors || []),
      ...(spec.interest_topics || []),
    ].map(a => a.toLowerCase());

    for (const anchor of anchors) {
      if (storyGenres.includes(anchor) || text.includes(anchor)) {
        score += 0.25;
        reasons.push(`[${spec.name}] anchor match: "${anchor}"`);
        break;
      }
    }

    // Positive signals: LLM generates full sentences — extract meaningful keywords (>3 chars)
    // and check if any appear in text. This bridges LLM spec format to keyword scoring.
    const posSignalKeywords = (spec.positive_signals || [])
      .flatMap(s => s.toLowerCase().split(/[\s,.()/]+/).filter(w => w.length > 3));
    let posHits = 0;
    for (const kw of posSignalKeywords) {
      if (text.includes(kw)) posHits++;
    }
    if (posSignalKeywords.length > 0 && posHits > 0) {
      const posScore = Math.min(0.35, 0.1 * posHits);
      score += posScore;
      reasons.push(`[${spec.name}] signal keywords matched: ${posHits}/${posSignalKeywords.length}`);
    }

    // Story year / recency signal
    const storyYear = story.year || (story.title ? (story.title.match(/\((\d{4})\)/) || [])[1] : null);
    if (storyYear && spec.year_preference) {
      const diff = Math.abs(Number(storyYear) - Number(spec.year_preference));
      if (diff <= 5) { score += 0.15; reasons.push(`[${spec.name}] year match: ${storyYear}`); }
    }

    // ── Text keyword matching ─────────────────────────────────────────────
    for (const kw of (spec.boost_keywords || [])) {
      if (text.includes(kw.toLowerCase())) { score += 0.2; reasons.push(`[${spec.name}] boost: "${kw}"`); break; }
    }
    for (const kw of (spec.penalty_keywords || [])) {
      if (text.includes(kw.toLowerCase())) { score -= 0.1; reasons.push(`[${spec.name}] penalty: "${kw}"`); break; }
    }

    // Negative signals vs genres
    const negativeSignals = (spec.negative_signals || spec.penalty_keywords || []).map(s => s.toLowerCase());
    for (const neg of negativeSignals) {
      if (storyGenres.includes(neg)) {
        score -= 0.15;
        reasons.push(`[${spec.name}] genre penalty: "${neg}"`);
        break;
      }
    }

    const domainSignals = (spec.domain_signals || {})[ctx._domain] || [];
    for (const sig of domainSignals) {
      if (text.includes(sig.toLowerCase())) { score += 0.15; reasons.push(`[${spec.name}] domain signal: "${sig}"`); break; }
    }
    for (const kw of (spec.insight_keywords || [])) {
      if (text.includes(kw.toLowerCase())) { score += 0.15; reasons.push(`[${spec.name}] kg insight: "${kw}"`); break; }
    }

    return { score: Math.max(0, Math.min(1, score)), reasons, agent: spec.name };
  };
}

async function _generateFleetFromLLM(domain, contentSample, kgSummary, llm) {
  const client = llm || createLLMClient();

  // Compact KG representation: pull what matters for motivation inference
  const kg = kgSummary || {};
  const interests = (kg.interests || []).slice(0, 15).map(i =>
    typeof i === 'string' ? i : `${i.topic || i.name}${i.trend ? ` (${i.trend})` : ''}`
  );
  const avoidPatterns = (kg.avoidPatterns || kg.avoid_patterns || []).slice(0, 8);
  const role = kg.role || kg.identity?.role || '';
  const recentEngagement = (kg.recentEngagement || kg.recent_engagement || []).slice(0, 8);
  const history = (kg.history || []).slice(-10).map(h => h.title || h.topic || h);

  const kgStr = JSON.stringify({ role, interests, avoidPatterns, recentEngagement, history }, null, 0).slice(0, 900);

  const prompt = `You are designing a personalized scoring agent fleet for Marble.

STEP 1 — Infer consumption motivation.
Look at this user's profile and domain. Why does this user consume "${domain}" content?
Consider: leisure/escape, nostalgia, career relevance, education, social/shared experience, creative inspiration, etc.
The answer should be specific to THIS user's actual pattern, not a generic assumption.

STEP 2 — Design 5 agents, each probing one dimension of that motivation.
Each agent asks: "Does this content satisfy THIS specific aspect of why this user consumes this type of content?"
Agents must be grounded in the user's actual history and interests — not generic professional lenses.

User profile:
${kgStr}

Content domain: ${domain}
Content sample: ${(contentSample || '').slice(0, 300)}

Return ONLY a JSON object:
{
  "inferred_motivation": "one sentence — why this user consumes this content type",
  "motivation_signals": ["evidence from KG that supports this", ...],
  "agents": [
    {
      "name": "snake_case_agent_name",
      "exclusive_dimension": "ONE of: subject_matter | format_style | emotional_register | novelty_familiarity | social_context | depth_complexity | practical_utility | aesthetic_fit",
      "motivation_frame": "one sentence — what satisfaction dimension this agent probes for this user",
      "screening_question": "the single most predictive yes/no question this agent asks",
      "weight": 0.0-1.0,
      "positive_signals": ["what yes looks like in content for this specific user", ...],
      "negative_signals": ["what would fail this agent's test for this user", ...],
      "interest_anchors": ["specific user interests/topics this agent is sensitive to", ...]
    },
    ...
  ]
}

Rules:
- All agent weights must sum to 1.0
- Agent names must NOT be: career, growth, timing, contrarian, serendipity (those are generic professional lenses)
- ORTHOGONALITY: each agent MUST have a DIFFERENT exclusive_dimension. No two agents may share the same exclusive_dimension value. This is a hard constraint — questions from two agents with the same dimension would be redundant duplicates.
- Each agent's screening_question must be answerable ONLY from its exclusive_dimension — never bleed into another agent's territory
- screening_question must be specific enough that two similar items could get different answers`;

  const response = await client.messages.create({
    model: process.env.MARBLE_LLM_MODEL || defaultModel('heavy'),
    max_tokens: 1600,
    messages: [{ role: 'user', content: prompt }]
  });

  const raw = response.content[0]?.type === 'text' ? response.content[0].text : '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON object found in LLM response');
  const parsed = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(parsed.agents) || parsed.agents.length === 0) throw new Error('Invalid agents array');

  // Attach inferred motivation metadata to each agent spec for use by explodeAgentQuestions
  const motivation = parsed.inferred_motivation || '';
  return parsed.agents.map(a => ({ ...a, inferred_motivation: motivation }));
}

// Generic fallback agents — used only when LLM fleet generation fails.
// These are intentionally domain-agnostic: the LLM path is responsible for
// producing domain/motivation-specific agents. This is just a safety net.
const _FALLBACK_AGENT_FRAMES = [
  { name: 'interest_fit',      motivation_frame: 'Does this directly match what this user has shown interest in?',            weight: 0.30 },
  { name: 'pattern_match',     motivation_frame: 'Does this fit the consumption pattern visible in this user\'s history?',    weight: 0.30 },
  { name: 'avoidance_check',   motivation_frame: 'Does this avoid topics or styles this user consistently disengages from?',  weight: 0.25 },
  { name: 'depth_preference',  motivation_frame: 'Does this match the depth and complexity this user tends to prefer?',       weight: 0.15 },
];

function _buildStaticFleet(domain) {
  const specs = _FALLBACK_AGENT_FRAMES.map(frame => ({
    name: frame.name,
    weight: frame.weight,
    motivation_frame: frame.motivation_frame,
    screening_question: frame.motivation_frame,
    scoreFn: _buildSpecScorer({
      name: frame.name,
      boost_keywords: [],
      penalty_keywords: [],
      domain_signals: {},
      insight_keywords: [],
    }),
    isStatic: true,
  }));

  return { agents: specs, weights: Object.fromEntries(specs.map(s => [s.name, s.weight])), source: 'static_fallback', domain };
}

/**
 * Return active UserClone hypotheses from a KG instance (max 3 by default).
 * @param {Object} kg - KG instance with getActiveClones()
 * @param {number} [max=3]
 * @returns {import('./types.js').UserClone[]}
 */
function _getActiveClones(kg, max = 3) {
  if (typeof kg?.getActiveClones === 'function') {
    return kg.getActiveClones().slice(0, max);
  }
  return (kg?.user?.clones || []).filter(c => c.status === 'active').slice(0, max);
}

/**
 * Generate per-clone predictions for a story (used in feedback loop).
 * @param {import('./types.js').UserClone[]} clones
 * @param {Object} story
 * @returns {Object} { cloneId: predictedScore }
 */
function _clonePredictions(clones, story) {
  const out = {};
  for (const clone of clones) {
    // Simple heuristic: base on clone confidence × title relevance keyword match
    const text = `${story.title || ''} ${story.summary || ''}`.toLowerCase();
    const kw = clone.hypothesis.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    const hits = kw.filter(w => text.includes(w)).length;
    out[clone.id] = Math.min(1, clone.confidence * 0.6 + (hits / Math.max(1, kw.length)) * 0.4);
  }
  return out;
}

/**
 * Spawn a dynamic agent fleet from domain + KG context.
 *
 * Uses the configured LLM provider to generate 5 domain/KG-aware agents.
 * Caches per (domain, kgHash) unless active clones are present or
 * MARBLE_FLEET_CACHE=0 (default). Set MARBLE_FLEET_CACHE=1 to force caching.
 *
 * @param {string} domain - Content domain (e.g. "HackerNews", "movies", "Twitter")
 * @param {string} contentSample - Sample content for context
 * @param {Object} kgSummary - Compact KG summary { interests, insights, ... }
 * @param {Object} [llm] - Optional pre-constructed LLM client
 * @param {import('./types.js').UserClone[]} [clones] - Active UserClone hypotheses; bypasses cache
 * @returns {Promise<{ agents, weights, scoreStory, source, domain, cacheKey }>}
 */
export async function generateAgentFleet(domain, contentSample, kgSummary, llm = null, clones = null) {
  const kgHash = _hashKgSummary(kgSummary);
  const cacheKey = `${domain || 'unknown'}:${kgHash}`;
  const useCache = process.env.MARBLE_FLEET_CACHE === '1' && !clones?.length;

  if (useCache && _fleetCache.has(cacheKey)) {
    return { ..._fleetCache.get(cacheKey), cacheKey, fromCache: true };
  }

  let fleet = null;

  try {
    const specs = await _generateFleetFromLLM(domain, contentSample, kgSummary, llm);

    const totalWeight = specs.reduce((s, sp) => s + (sp.weight || 0), 0);
    const normalized = specs.map(sp => ({
      ...sp,
      weight: totalWeight > 0 ? sp.weight / totalWeight : 1 / specs.length,
    }));

    const agentEntries = normalized.map(spec => ({
      name: spec.name,
      weight: spec.weight,
      scoreFn: _buildSpecScorer(spec),
      spec,
      isStatic: false,
    }));

    const weights = {};
    for (const a of agentEntries) weights[a.name] = a.weight;

    fleet = {
      agents: agentEntries,
      weights,
      source: 'llm_generated',
      domain,
      scoreStory(story, ctx) {
        const domainCtx = { ...ctx, _domain: domain };
        let composite = 0;
        const agentScores = {};
        const allReasons = [];
        for (const agent of this.agents) {
          const result = agent.scoreFn(story, domainCtx);
          agentScores[agent.name] = result.score;
          composite += result.score * agent.weight;
          for (const r of result.reasons) allReasons.push({ agent: agent.name, reason: r });
        }
        return {
          score: Math.round(composite * 1000) / 1000,
          agentScores,
          reasons: allReasons,
          story: { title: story.title, topics: story.topics },
          fleetSource: this.source,
        };
      }
    };
  } catch (err) {
    console.warn('[generateAgentFleet] LLM generation failed, using static fallback:', err.message);
    fleet = { ..._buildStaticFleet(domain) };
  }

  fleet.cacheKey = cacheKey;
  _fleetCache.set(cacheKey, fleet);
  return fleet;
}

/** Invalidate a specific fleet cache entry (e.g., after KG update). */
export function invalidateFleetCache(domain, kgSummary) {
  const kgHash = _hashKgSummary(kgSummary);
  return _fleetCache.delete(`${domain || 'unknown'}:${kgHash}`);
}

/** Get fleet cache stats for debugging. */
export function getFleetCacheStats() {
  return { size: _fleetCache.size, keys: Array.from(_fleetCache.keys()) };
}

// ── Question Explosion ────────────────────────────────────────────────────────

/**
 * Generate N evaluation questions for an agent and score them against content.
 *
 * Each question: { question, fired, confidence }
 * Agent score = sum(fired * confidence) / questionsWithData
 *
 * Questions that can't be answered (no signal in content) score 0 — no penalty.
 * This keeps agents honest: they can only claim credit where data exists.
 *
 * @param {Object|string} agent - Agent spec or plain name string
 * @param {string} contentSample - Content to evaluate
 * @param {Object} kgSummary - Compact KG summary
 * @param {Object} [llm] - Optional pre-constructed Anthropic client
 * @param {Object} [opts] - { n: number of questions (default 5) }
 * @returns {Promise<{ agent, questions, score, questionsWithData, source }>}
 */
export async function explodeAgentQuestions(agent, contentSample, kgSummary, llm = null, opts = {}) {
  // Minimum viable question set: 3 questions per agent.
  // 5 questions produce noise — questions 4–5 tend to restate questions 1–2,
  // diluting signal. 3 focused questions with evidence citations outperform
  // 5 shallow questions empirically (see marble#25 architecture decision).
  const n = opts.n || 3;

  const client = llm || createLLMClient();

  const agentSpec = typeof agent === 'string' ? { name: agent, motivation_frame: `${agent} lens` } : agent;
  const agentName = agentSpec.name || 'unknown';

  // Content sparsity gate: when content has fewer than 40 words (e.g. MovieLens:
  // title + genres only), LLM question explosion cannot generate meaningful
  // questions — there is nothing to read. Fall through to direct structural
  // scoring instead.
  const contentWords = (contentSample || '').split(/\s+/).filter(Boolean).length;
  if (contentWords < 40 && !opts.forceLLM) {
    return _sparseContentScore(agentSpec, contentSample, kgSummary);
  }
  const motivationFrame = agentSpec.motivation_frame || agentSpec.description || agentSpec.name || '';
  const screeningQuestion = agentSpec.screening_question || motivationFrame;
  const positiveSignals = (agentSpec.positive_signals || agentSpec.boost_keywords || []).slice(0, 6).join(', ');
  const negativeSignals = (agentSpec.negative_signals || agentSpec.penalty_keywords || []).slice(0, 4).join(', ');
  const interestAnchors = (agentSpec.interest_anchors || agentSpec.interest_topics || []).slice(0, 8).join(', ');
  const inferredMotivation = agentSpec.inferred_motivation || '';
  const exclusiveDimension = agentSpec.exclusive_dimension || '';
  const siblingQuestions = (opts.siblingQuestions || []).slice(0, 12).join('\n  - ');

  // Compact user profile for question generation
  const kg = kgSummary || {};
  const topInterests = (kg.interests || []).slice(0, 10).map(i =>
    typeof i === 'string' ? i : `${i.topic || i.name}${i.trend ? ` (${i.trend})` : ''}`
  ).join(', ');
  const avoidPatterns = (kg.avoidPatterns || kg.avoid_patterns || []).slice(0, 6).join(', ');
  const likedHistory = (kg.history || []).filter(h => h.reaction === 'liked' || h.score > 0.7).slice(-5).map(h => h.title || h.topic || h).join(', ');
  const dislikedHistory = (kg.history || []).filter(h => h.reaction === 'disliked' || h.score < 0.3).slice(-5).map(h => h.title || h.topic || h).join(', ');

  const prompt = `You are the "${agentName}" evaluation agent in Marble, a personalized content ranking system.

Your motivation frame: ${motivationFrame}
Your core screening question: ${screeningQuestion}
${exclusiveDimension ? `Your EXCLUSIVE dimension: ${exclusiveDimension}. You ONLY ask questions that probe this dimension. Questions about other dimensions belong to sibling agents and must NOT appear in your output.` : ''}
${inferredMotivation ? `Why this user consumes this content type: ${inferredMotivation}` : ''}
${siblingQuestions ? `FORBIDDEN — these questions are already covered by sibling agents (do NOT ask anything semantically similar):\n  - ${siblingQuestions}` : ''}

This user's taste profile:
${topInterests ? `- Strong interests: ${topInterests}` : ''}
${interestAnchors ? `- Topics most relevant to your lens: ${interestAnchors}` : ''}
${likedHistory ? `- Examples of content they've enjoyed: ${likedHistory}` : ''}
${dislikedHistory ? `- Examples of content they've disliked: ${dislikedHistory}` : ''}
${avoidPatterns ? `- Patterns they avoid: ${avoidPatterns}` : ''}
${positiveSignals ? `- Signals that indicate a strong match for your lens: ${positiveSignals}` : ''}
${negativeSignals ? `- Signals that indicate a poor match for your lens: ${negativeSignals}` : ''}

Content being evaluated:
${(contentSample || '').slice(0, 700)}

Generate exactly ${n} yes/no questions that probe whether this content satisfies your lens for THIS specific user.

Requirements:
- Each question must be answerable from the content text alone
- Questions must be deep enough to distinguish between superficially similar items
- A "yes" must meaningfully predict that THIS user would be satisfied — not just that the content is generically good
- Questions must be grounded in the user's actual taste (their specific interests, history, avoidances)
- Do NOT ask generic questions like "Is this relevant?", "Does this expand thinking?", or "Is this well-made?"
- Each question should be specific enough that two similar items could get different answers
- DIVERSITY CONSTRAINT: each question must probe a DIFFERENT observable dimension. Do NOT write variations of the same question. Cover distinct aspects (e.g. topic match, tone/style, format, specificity level, user-history alignment). If two questions feel similar, replace one with something orthogonal.

For each question, evaluate it against the content and provide:
- fired: true if the content satisfies this question, false if not
- confidence: 0.0–1.0 certainty about the fired value (based on evidence in the content)
- evidence: a short quote or specific observation from the content justifying fired. Required — if you cannot cite evidence, set confidence to 0.3 or below.

Return ONLY a JSON array, no commentary:
[
  { "question": "...", "fired": true/false, "confidence": 0.0-1.0, "evidence": "..." },
  ...
]`;

  let questions = [];
  let source = 'llm';

  try {
    const response = await client.messages.create({
      model: process.env.MARBLE_LLM_MODEL || defaultModel('heavy'),
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }]
    });

    const raw = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array in LLM response');

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) throw new Error('LLM response is not an array');

    questions = parsed.slice(0, n).map(q => {
      const rawConf = Math.max(0, Math.min(1, Number(q.confidence) || 0));
      // Evidence quality gate: if fired=true but no evidence provided, cap confidence at 0.4
      // to prevent hallucinated positives from inflating the agent score.
      const hasEvidence = Boolean(q.evidence && q.evidence.trim().length > 5);
      const confidence = (q.fired && !hasEvidence) ? Math.min(rawConf, 0.4) : rawConf;
      return {
        question: q.question || '',
        fired: Boolean(q.fired),
        confidence,
        evidence: q.evidence || '',
      };
    });
  } catch (err) {
    source = 'fallback';
    const text = (contentSample || '').toLowerCase();
    const keywords = [
      ...(agentSpec.boost_keywords || []),
      ...(agentSpec.insight_keywords || []),
    ].slice(0, n);

    questions = keywords.map(kw => ({
      question: `Does the content relate to "${kw}"?`,
      fired: text.includes(kw.toLowerCase()),
      confidence: text.includes(kw.toLowerCase()) ? 0.7 : 0.2,
    }));

    while (questions.length < n) {
      questions.push({ question: `Is this content relevant to the ${agentName} agent?`, fired: false, confidence: 0.1 });
    }
  }

  const questionsWithData = questions.length;
  const scoreSum = questions.reduce((s, q) => s + (q.fired ? q.confidence : 0), 0);
  const score = questionsWithData > 0 ? Math.round((scoreSum / questionsWithData) * 1000) / 1000 : 0;

  return { agent: agentName, questions, score, questionsWithData, source };
}

// ── Sparse Content Scoring ────────────────────────────────────────────────────

/**
 * Generate 2 dimension-specific structural questions for sparse content.
 *
 * Each exclusive_dimension maps to a different observable signal so that sibling
 * agents do NOT produce the same question for the same item. This is the fix for
 * the original bug where all agents asked identical genre/history questions,
 * causing massive cross-agent redundancy on MovieLens (sparse) content.
 */
function _sparseQuestionsForDimension(dim, contentGenres, allAnchors, negatives, history, kg) {
  const genreHit = contentGenres.some(g => allAnchors.includes(g));
  const matchedGenres = contentGenres.filter(g => allAnchors.includes(g)).join(', ');

  const historyLiked = history.filter(h => h.reaction === 'liked' || h.score > 0.6);
  const historyHit = historyLiked.some(h => {
    const hGenres = _normalizeGenres(h);
    return hGenres.some(g => contentGenres.includes(g));
  });

  const historyDisliked = history.filter(h => h.reaction === 'disliked' || h.score < 0.3);
  const dislikeHit = historyDisliked.some(h => {
    const hGenres = _normalizeGenres(h);
    return hGenres.some(g => contentGenres.includes(g));
  });

  // Infer novelty: content genre not found in user's liked history = novel territory
  const likedGenres = new Set(historyLiked.flatMap(h => _normalizeGenres(h)));
  const isNovel = contentGenres.length > 0 && contentGenres.every(g => !likedGenres.has(g));
  const isFamiliar = contentGenres.some(g => likedGenres.has(g));

  // Infer popularity proxy: if genre appears in many liked items = socially mainstream for user
  const genreFreq = {};
  for (const h of history) for (const g of _normalizeGenres(h)) genreFreq[g] = (genreFreq[g] || 0) + 1;
  const maxFreq = Math.max(1, ...Object.values(genreFreq));
  const isPopularForUser = contentGenres.some(g => (genreFreq[g] || 0) / maxFreq > 0.3);

  // Depth proxy: drama/documentary/biography → deeper; action/comedy → lighter
  const deepGenres = ['drama', 'documentary', 'biography', 'mystery', 'thriller', 'war', 'history'];
  const lightGenres = ['comedy', 'animation', 'family', 'musical', 'sport'];
  const isDeep = contentGenres.some(g => deepGenres.includes(g));
  const isLight = contentGenres.some(g => lightGenres.includes(g));
  const prefersDeep = (kg.preferences?.depth || 'medium') === 'deep';

  const map = {
    subject_matter: [
      { question: `Does this content's primary genre/subject match one of this user's known preferences?`, fired: genreHit, confidence: genreHit ? 0.85 : 0.15, evidence: genreHit ? `genre overlap: ${matchedGenres}` : 'no genre overlap' },
      { question: `Has this user positively engaged with this genre in their history?`, fired: historyHit, confidence: historyHit ? 0.80 : 0.45, evidence: historyHit ? 'genre in liked history' : 'not found in liked history' },
    ],
    emotional_register: [
      { question: `Does the emotional tone of this content (drama/comedy/thriller) match what this user gravitates toward?`, fired: isFamiliar, confidence: isFamiliar ? 0.75 : 0.40, evidence: isFamiliar ? 'tone genre in liked history' : 'tone genre not in liked history' },
      { question: `Does this content avoid the emotional registers this user has historically disengaged from?`, fired: !dislikeHit, confidence: dislikeHit ? 0.80 : 0.65, evidence: dislikeHit ? 'genre in disliked history' : 'not in disliked history' },
    ],
    novelty_familiarity: [
      { question: `Is this content in territory the user hasn't extensively explored (novel genre)?`, fired: isNovel, confidence: isNovel ? 0.70 : 0.50, evidence: isNovel ? 'genre not in liked history' : 'genre already in liked history' },
      { question: `Is this content familiar enough that the user is likely to engage rather than bounce?`, fired: isFamiliar, confidence: isFamiliar ? 0.75 : 0.45, evidence: isFamiliar ? 'genre in liked history' : 'unfamiliar genre' },
    ],
    depth_complexity: [
      { question: `Does the complexity/depth of this content match this user's stated or inferred preference?`, fired: prefersDeep ? isDeep : !isDeep, confidence: (prefersDeep ? isDeep : isLight) ? 0.80 : 0.50, evidence: isDeep ? 'deep-genre detected' : isLight ? 'light-genre detected' : 'depth unknown' },
      { question: `Does this content avoid the depth level this user consistently skips?`, fired: !(prefersDeep ? isLight : isDeep), confidence: 0.65, evidence: 'inferred from genre depth category' },
    ],
    social_context: [
      { question: `Is this content in a genre that is mainstream/popular for users with this profile?`, fired: isPopularForUser, confidence: isPopularForUser ? 0.70 : 0.45, evidence: isPopularForUser ? 'genre appears frequently in user history' : 'genre underrepresented in user history' },
      { question: `Does this content belong to genres with strong community/social appeal for this user type?`, fired: isFamiliar, confidence: 0.60, evidence: 'inferred from genre-history overlap' },
    ],
    practical_utility: [
      { question: `Does this content serve a clear practical purpose for this user (learning, reference, skill)?`, fired: genreHit, confidence: genreHit ? 0.70 : 0.30, evidence: genreHit ? `anchored genre: ${matchedGenres}` : 'no practical anchor genres found' },
      { question: `Is this content's utility-to-entertainment ratio consistent with this user's consumption pattern?`, fired: historyHit, confidence: historyHit ? 0.65 : 0.45, evidence: historyHit ? 'genre in liked history' : 'not in liked history' },
    ],
    aesthetic_fit: [
      { question: `Does the genre/style of this content match this user's aesthetic sensibility (e.g. art-house vs. mainstream)?`, fired: isFamiliar, confidence: isFamiliar ? 0.70 : 0.45, evidence: isFamiliar ? 'stylistic genre overlap in history' : 'no style match' },
      { question: `Does this content avoid genres this user finds aesthetically off-putting?`, fired: !dislikeHit, confidence: dislikeHit ? 0.80 : 0.60, evidence: dislikeHit ? 'genre in disliked history' : 'no aesthetic conflict' },
    ],
    format_style: [
      { question: `Does the format/presentation genre (e.g. documentary, animation) match user preferences?`, fired: isFamiliar, confidence: isFamiliar ? 0.70 : 0.40, evidence: isFamiliar ? 'format genre in history' : 'format genre not in history' },
      { question: `Is the content format one this user has historically engaged with?`, fired: historyHit, confidence: historyHit ? 0.75 : 0.40, evidence: historyHit ? 'format genre liked' : 'format not in liked history' },
    ],
  };

  return map[dim] || map['subject_matter'];
}

/**
 * Direct structural scoring for sparse content (< 40 words, e.g. MovieLens items).
 *
 * When content is title + genres only, LLM question explosion is meaningless:
 * there is nothing to read, so the LLM hallucinates answers. Instead, score
 * deterministically from genre/keyword overlap against the agent's interest anchors.
 *
 * Returns an explodeAgentQuestions-compatible result so callers can use it uniformly.
 */
function _sparseContentScore(agentSpec, contentSample, kgSummary) {
  const agentName = agentSpec.name || 'unknown';
  const storyGenres = _normalizeGenres({ title: contentSample || '', genres: [] });

  // Pull any genres from the content sample (format: "Title (Year) | Genre1|Genre2")
  const genreMatch = (contentSample || '').match(/\|\s*([^|]+(?:\|[^|]+)*)$/);
  const contentGenres = genreMatch
    ? genreMatch[1].split('|').map(g => g.trim().toLowerCase()).filter(Boolean)
    : storyGenres;

  // Anchors: agent's interest topics + user interests from KG
  const anchors = [
    ...(agentSpec.interest_anchors || []),
    ...(agentSpec.interest_topics || []),
    ...(agentSpec.positive_signals || []),
  ].map(a => a.toLowerCase());

  const negatives = [
    ...(agentSpec.negative_signals || []),
    ...(agentSpec.penalty_keywords || []),
  ].map(a => a.toLowerCase());

  // KG genre affinity from history
  const kg = kgSummary || {};
  const history = kg.history || [];
  const interests = kg.interests || [];
  const interestTopics = (Array.isArray(interests)
    ? interests.map(i => typeof i === 'string' ? i : (i.topic || i.name || ''))
    : Object.keys(interests)
  ).map(t => t.toLowerCase());

  const allAnchors = [...new Set([...anchors, ...interestTopics])];

  const genreHit = contentGenres.some(g => allAnchors.includes(g));
  const genrePenalty = contentGenres.some(g => negatives.includes(g));
  const historyHit = history.some(h => {
    const hGenres = _normalizeGenres(h);
    return (h.reaction === 'liked' || h.score > 0.6) && hGenres.some(g => contentGenres.includes(g));
  });

  // Dimension-specific question sets for sparse content.
  // Each exclusive_dimension gets a distinct structural question to prevent
  // all agents from asking the same 3 genre questions (the original redundancy bug).
  const dim = (agentSpec.exclusive_dimension || 'subject_matter').toLowerCase();
  const dimQuestions = _sparseQuestionsForDimension(dim, contentGenres, allAnchors, negatives, history, kg);

  // Always include a hard avoidance gate regardless of dimension
  const avoidanceQ = {
    question: `Does this content avoid categories this user has disengaged from?`,
    fired: !genrePenalty,
    confidence: genrePenalty ? 0.8 : 0.7,
    evidence: genrePenalty ? `penalty genre hit: ${contentGenres.filter(g => negatives.includes(g)).join(', ')}` : 'no avoidance patterns triggered',
  };

  // Combine: 2 dimension-specific questions + 1 shared avoidance gate
  const questions = [...dimQuestions.slice(0, 2), avoidanceQ];

  const questionsWithData = questions.length;
  const scoreSum = questions.reduce((s, q) => s + (q.fired ? q.confidence : 0), 0);
  const score = Math.round((scoreSum / questionsWithData) * 1000) / 1000;

  return { agent: agentName, questions, score, questionsWithData, source: 'sparse_structural' };
}

// ── Per-User Weight Learning ──────────────────────────────────────────────────

/**
 * Three-layer weight determination architecture:
 *
 * Layer 1 — LLM-inferred prior (from _generateFleetFromLLM)
 *   The LLM assigns weights based on motivation inference. Fast, works at cold
 *   start, but uncalibrated: educated guesses about what this user values.
 *
 * Layer 2 — Discriminability calibration (computeDynamicWeights)
 *   After scoring a candidate batch, agents that scored all candidates identically
 *   contribute no signal and get near-zero weight. Agents that differentiate
 *   candidates get boosted. Prevents dead-weight agents from diluting the ensemble.
 *
 * Layer 3 — Feedback-driven Bayesian update (learnWeightsFromFeedback)
 *   Each time a user likes/dislikes an item, shift weights toward agents that
 *   predicted correctly. Converges to a per-user weight profile over ~20 events.
 *
 * Architecture decision: dynamically inferred per user.
 * - Static weights ignore individual variation (user A is genre-driven, user B is era-driven)
 * - Learned-only weights require interaction history (cold start gap)
 * - LLM-inferred + discriminability covers cold start; feedback loop fills in as data grows
 *
 * @see computeDynamicWeights — Layer 2 implementation
 * @see learnWeightsFromFeedback — Layer 3 implementation
 * @see resolveAgentWeights — Merges all three layers into final weight vector
 */

/**
 * Update agent weights based on user feedback events.
 *
 * For each feedback event, agents that correctly predicted the outcome
 * (high score on liked items, low score on disliked items) receive a
 * weight boost. Agents that predicted incorrectly receive a reduction.
 *
 * Formula: w_new[a] = w_old[a] × (1 + lr × signal[a])
 * where signal[a] = liked ? (agentScore[a] - 0.5) : (0.5 - agentScore[a])
 *
 * @param {Array<Object>} feedbackBatch - Array of { agentScores, liked, weight? }
 *   agentScores: { [agentName]: 0–1 }  — scores this item received from each agent
 *   liked: boolean                     — whether the user liked this item
 *   weight: number (optional)          — importance of this event (default 1.0)
 * @param {Object} currentWeights - Current normalized weights { [agentName]: number }
 * @param {Object} [opts]
 *   lr: learning rate (default 0.15)   — higher = faster adaptation, more volatile
 *   minWeight: floor (default 0.02)    — no agent fully disappears
 * @returns {Object} Updated normalized weights
 */
export function learnWeightsFromFeedback(feedbackBatch, currentWeights, opts = {}) {
  const lr = opts.lr ?? 0.15;
  const minWeight = opts.minWeight ?? 0.02;

  if (!feedbackBatch || feedbackBatch.length === 0) return { ...currentWeights };

  const agentNames = Object.keys(currentWeights);
  const weights = { ...currentWeights };

  for (const event of feedbackBatch) {
    const { agentScores = {}, liked, weight: eventWeight = 1.0 } = event;

    for (const name of agentNames) {
      const score = agentScores[name] ?? 0.5;
      // Positive signal when agent correctly predicted outcome:
      // liked + high score → boost; liked + low score → penalize
      // disliked + low score → boost; disliked + high score → penalize
      const signal = liked ? (score - 0.5) : (0.5 - score);
      weights[name] = Math.max(minWeight, weights[name] * (1 + lr * signal * eventWeight));
    }
  }

  // Renormalize to sum=1
  const total = Object.values(weights).reduce((s, w) => s + w, 0);
  if (total === 0) return { ...currentWeights };

  const normalized = {};
  for (const name of agentNames) {
    normalized[name] = Math.round((weights[name] / total) * 1000) / 1000;
  }
  return normalized;
}

/**
 * Merge all three weight layers into a final weight vector.
 *
 * Priority: learned > discriminability-calibrated > LLM-inferred prior.
 * When learnedWeights is provided, it dominates but is tempered by the prior
 * to prevent overfitting on sparse feedback.
 *
 * @param {Object} priorWeights - Layer 1: LLM-assigned weights
 * @param {Array<Object>} [agentScoreMatrix] - Layer 2: per-item agent scores for discriminability
 * @param {Object} [learnedWeights] - Layer 3: feedback-learned weights
 * @param {Object} [opts]
 *   priorMix: prior blend factor (default 0.3) — higher = more conservative
 *   varianceThreshold: min variance to keep agent active (default 0.001)
 * @returns {Object} Final normalized weights
 */
export function resolveAgentWeights(priorWeights, agentScoreMatrix = null, learnedWeights = null, opts = {}) {
  const priorMix = opts.priorMix ?? 0.3;
  const varianceThreshold = opts.varianceThreshold ?? 0.001;

  // Layer 2: calibrate prior with discriminability if matrix provided
  const calibrated = agentScoreMatrix && agentScoreMatrix.length >= 2
    ? computeDynamicWeights(agentScoreMatrix, priorWeights, varianceThreshold)
    : { ...priorWeights };

  // Layer 3: blend with learned weights if available
  if (!learnedWeights || Object.keys(learnedWeights).length === 0) {
    return calibrated;
  }

  const agentNames = Object.keys(calibrated);
  const blended = {};
  for (const name of agentNames) {
    const prior = calibrated[name] ?? 1 / agentNames.length;
    const learned = learnedWeights[name] ?? prior;
    blended[name] = prior * priorMix + learned * (1 - priorMix);
  }

  // Normalize to sum=1
  const total = Object.values(blended).reduce((s, w) => s + w, 0);
  const normalized = {};
  for (const name of agentNames) {
    normalized[name] = total > 0 ? Math.round((blended[name] / total) * 1000) / 1000 : 1 / agentNames.length;
  }
  return normalized;
}

// ── Cross-Agent Question Deduplication ────────────────────────────────────────

/**
 * Remove semantically redundant questions across multiple agent results.
 *
 * When running a multi-agent swarm, sibling agents may still generate overlapping
 * questions despite exclusive_dimension constraints (e.g. LLM prompt non-compliance,
 * or fallback agents with no exclusive_dimension). This function detects near-duplicate
 * questions by Jaccard similarity on normalized word tokens and drops the lower-confidence
 * duplicate, keeping only the most informative signal per conceptual slot.
 *
 * Design choice: Jaccard over word tokens is fast, zero-dependency, and sufficient for
 * catching phrase-level overlap ("Does this match user preferences?" x 3 agents).
 * Embedding-based similarity would catch more subtle overlaps but costs an LLM call.
 *
 * @param {Array<{agent: string, questions: Array<{question: string, fired: boolean, confidence: number, evidence: string}>}>} agentResults
 *   Array of per-agent results from explodeAgentQuestions
 * @param {number} [threshold=0.55] - Jaccard similarity above which two questions are considered duplicates
 * @returns {Array} Same shape as input, with duplicate questions zeroed out (confidence=0, fired=false, note added)
 */
export function deduplicateAgentQuestions(agentResults, threshold = 0.55) {
  if (!Array.isArray(agentResults) || agentResults.length === 0) return agentResults;

  // Flatten all questions with (agentIdx, qIdx, tokens, confidence)
  const flat = [];
  for (let ai = 0; ai < agentResults.length; ai++) {
    const qs = agentResults[ai].questions || [];
    for (let qi = 0; qi < qs.length; qi++) {
      const tokens = new Set(
        (qs[qi].question || '').toLowerCase()
          .replace(/[^a-z0-9\s]/g, '')
          .split(/\s+/)
          .filter(w => w.length > 2)
      );
      flat.push({ ai, qi, tokens, confidence: qs[qi].confidence || 0, kept: true });
    }
  }

  // Compare all pairs: drop lower-confidence duplicate
  for (let i = 0; i < flat.length; i++) {
    if (!flat[i].kept) continue;
    for (let j = i + 1; j < flat.length; j++) {
      if (!flat[j].kept) continue;
      // Skip same agent (within-agent diversity already enforced by DIVERSITY CONSTRAINT)
      if (flat[i].ai === flat[j].ai) continue;

      const intersection = [...flat[i].tokens].filter(t => flat[j].tokens.has(t)).length;
      const union = new Set([...flat[i].tokens, ...flat[j].tokens]).size;
      const jaccard = union > 0 ? intersection / union : 0;

      if (jaccard >= threshold) {
        // Drop the one with lower confidence; on tie, drop the later one
        const dropIdx = flat[i].confidence >= flat[j].confidence ? j : i;
        flat[dropIdx].kept = false;
      }
    }
  }

  // Reconstruct results with dropped questions zeroed
  const result = agentResults.map((ar, ai) => ({
    ...ar,
    questions: (ar.questions || []).map((q, qi) => {
      const entry = flat.find(f => f.ai === ai && f.qi === qi);
      if (entry && !entry.kept) {
        return { ...q, fired: false, confidence: 0, evidence: `[deduplicated — covered by sibling agent]` };
      }
      return q;
    }),
  }));

  // Recompute per-agent scores after dedup
  return result.map(ar => {
    const qs = ar.questions || [];
    const qWithData = qs.filter(q => q.confidence > 0).length;
    const scoreSum = qs.reduce((s, q) => s + (q.fired && q.confidence > 0 ? q.confidence : 0), 0);
    const score = qWithData > 0 ? Math.round((scoreSum / qWithData) * 1000) / 1000 : 0;
    return { ...ar, score, questionsWithData: qWithData };
  });
}

/**
 * Record user feedback and update UserClone confidences.
 *
 * @param {Object} kg - KG instance with updateCloneConfidence / killWeakClones
 * @param {string} contentId - ID of the content item
 * @param {Object} clonePredictions - { cloneId: predictedScore } from swarmScore
 * @param {number} actualEngagement - Observed engagement score (0–1)
 */
export function recordFeedback(kg, contentId, clonePredictions, actualEngagement) {
  if (!clonePredictions || typeof kg?.updateCloneConfidence !== 'function') return;

  for (const [cloneId, predicted] of Object.entries(clonePredictions)) {
    const predictionCorrect = Math.abs(predicted - actualEngagement) < 0.3;
    kg.updateCloneConfidence(cloneId, predictionCorrect);

    // Log evaluation on the clone object itself
    const clone = kg.user?.clones?.find(c => c.id === cloneId);
    if (clone) {
      clone.evaluations = clone.evaluations || [];
      clone.evaluations.push({ contentId, predicted, actual: actualEngagement });
    }
  }

  kg.killWeakClones?.();
}
