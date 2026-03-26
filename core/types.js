/**
 * Prism type definitions
 */

/**
 * @typedef {Object} Story
 * @property {string} id - Unique story identifier
 * @property {string} title - Story headline
 * @property {string} summary - 1-2 sentence summary
 * @property {string} source - Source name (e.g., "hackernews", "techcrunch")
 * @property {string} url - Original URL
 * @property {string[]} topics - Multi-label topics
 * @property {Date} published_at - Publication timestamp
 * @property {number} [freshness] - Hours since published (computed)
 * @property {'inspiring'|'alarming'|'neutral'|'fun'} [valence] - Emotional valence
 * @property {number} [actionability] - 0-1, can user act on this?
 */

/**
 * @typedef {Object} ScoredStory
 * @property {Story} story - The original story
 * @property {number} magic_score - Composite score (0-1)
 * @property {number} interest_match - Topic relevance (0-1)
 * @property {number} temporal_relevance - Today-relevance (0-1)
 * @property {number} novelty - Surprise factor (0-1)
 * @property {number} actionability - Can act on it (0-1)
 * @property {number} source_trust - Source credibility (0-1)
 * @property {number} arc_position - Position in narrative arc (1-10)
 * @property {string} why - Human-readable reason for selection
 */

/**
 * @typedef {Object} UserNode
 * @property {string} id - User identifier
 * @property {InterestEdge[]} interests - Weighted, decaying interests
 * @property {ContextSnapshot} context - Ephemeral daily context
 * @property {ReactionHistory[]} history - Past reactions
 */

/**
 * @typedef {Object} InterestEdge
 * @property {string} topic - Topic name
 * @property {number} weight - Current weight (0-1, decays over time)
 * @property {Date} last_boost - Last time this was reinforced
 * @property {'rising'|'stable'|'falling'} trend - Direction
 */

/**
 * @typedef {Object} ContextSnapshot
 * @property {string[]} calendar - Today's events
 * @property {string[]} active_projects - Current projects
 * @property {string[]} recent_conversations - Topics discussed recently
 * @property {string} [mood_signal] - Optional mood indicator
 */

/**
 * @typedef {Object} ReactionHistory
 * @property {string} story_id - Story that was reacted to
 * @property {'up'|'down'|'skip'|'share'} reaction - User reaction
 * @property {Date} date - When reacted
 * @property {string[]} topics - Topics of the story
 * @property {string} source - Source of the story
 */

export const SCORE_WEIGHTS = {
  interest_match: 0.25,
  temporal_relevance: 0.30,
  novelty: 0.20,
  actionability: 0.15,
  source_trust: 0.10
};

export const ARC_SLOTS = {
  OPENER: 1,       // High energy, attention-grabbing
  BRIDGE: 2,       // Transition to substance
  DEEP_1: 3,       // First deep-dive
  DEEP_2: 4,       // Second deep-dive
  PIVOT: 5,        // Change of pace / surprise
  DEEP_3: 6,       // Third deep-dive
  PRACTICAL: 7,    // Actionable / how-to
  HORIZON: 8,      // Future-looking
  PERSONAL: 9,     // Close to home (local, relationships)
  CLOSER: 10       // Warm, human, memorable
};
