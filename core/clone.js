/**
 * Prism Clone — Digital Twin of the User
 *
 * Creates a synthetic representation of the user from their KG data.
 * The clone is used by swarm agents to simulate user reactions
 * without needing the real user in the loop.
 *
 * Think of it as: "if I were Alex right now, would I care about this?"
 */

export class Clone {
  constructor(kg) {
    this.kg = kg;
    this._snapshot = null;
  }

  /**
   * Take a snapshot of the user's current state.
   * This becomes the "mind" that swarm agents use.
   */
  takeSnapshot() {
    const user = this.kg.user;
    if (!user) {
      this._snapshot = { interests: {}, patterns: {}, context: {}, source_trust: {}, beliefs: [], preferences: [], identities: [], dimensionalPreferences: [], created_at: new Date().toISOString() };
      return;
    }

    // Build active interest map with decay applied
    const interests = {};
    for (const i of user.interests) {
      const weight = this.kg.getInterestWeight(i.topic);
      if (weight > 0.05) {
        interests[i.topic] = { weight, trend: i.trend };
      }
    }

    // Extract reaction patterns from recent history
    const patterns = this.#extractPatterns(user.history.slice(-100));

    // Build context fingerprint
    const context = {
      projects: user.context.active_projects || [],
      calendar: user.context.calendar || [],
      conversations: user.context.recent_conversations || [],
      mood: user.context.mood_signal
    };

    // Capture typed memory nodes
    const beliefs = this.kg.getActiveBeliefs?.() || [];
    const preferences = this.kg.getActivePreferences?.() || [];
    const identities = this.kg.getActiveIdentities?.() || [];
    const dimensionalPreferences = this.kg.getDimensionalPreferences?.() || [];

    this._snapshot = {
      interests,
      patterns,
      context,
      source_trust: { ...user.source_trust },
      beliefs,
      preferences,
      identities,
      dimensionalPreferences,
      created_at: new Date().toISOString()
    };

    return this._snapshot;
  }

  /**
   * Generate a natural language profile for LLM-based agents
   */
  toPrompt() {
    const s = this._snapshot || this.takeSnapshot();

    const lines = ['You are simulating a user with the following profile:\n'];

    // Interests
    const topInterests = Object.entries(s.interests)
      .sort(([, a], [, b]) => b.weight - a.weight)
      .slice(0, 15);

    if (topInterests.length) {
      lines.push('## Active Interests (strongest first)');
      for (const [topic, { weight, trend }] of topInterests) {
        const arrow = trend === 'rising' ? '↑' : trend === 'falling' ? '↓' : '→';
        lines.push(`- ${topic} (${(weight * 100).toFixed(0)}% ${arrow})`);
      }
      lines.push('');
    }

    // Today's context
    if (s.context.projects.length || s.context.calendar.length) {
      lines.push('## What\'s happening today');
      for (const p of s.context.projects) lines.push(`- Active project: ${p}`);
      for (const c of s.context.calendar) lines.push(`- Calendar: ${c}`);
      for (const t of s.context.conversations) lines.push(`- Recent topic: ${t}`);
      if (s.context.mood) lines.push(`- Current energy: ${s.context.mood}`);
      lines.push('');
    }

    // Reaction patterns
    if (s.patterns.loves.length || s.patterns.avoids.length) {
      lines.push('## Reaction patterns');
      if (s.patterns.loves.length) {
        lines.push(`Engages strongly with: ${s.patterns.loves.join(', ')}`);
      }
      if (s.patterns.avoids.length) {
        lines.push(`Tends to skip/dislike: ${s.patterns.avoids.join(', ')}`);
      }
      if (s.patterns.shares.length) {
        lines.push(`Shares with others: ${s.patterns.shares.join(', ')}`);
      }
      lines.push('');
    }

    // Trusted sources
    const trusted = Object.entries(s.source_trust)
      .filter(([, v]) => v > 0.6)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10);
    const distrusted = Object.entries(s.source_trust)
      .filter(([, v]) => v < 0.4)
      .sort(([, a], [, b]) => a - b)
      .slice(0, 5);

    if (trusted.length) {
      lines.push(`## Trusted sources: ${trusted.map(([s]) => s).join(', ')}`);
    }
    if (distrusted.length) {
      lines.push(`## Distrusted sources: ${distrusted.map(([s]) => s).join(', ')}`);
    }

    // Beliefs
    if (s.beliefs?.length) {
      lines.push('\n## Core Beliefs');
      for (const b of s.beliefs.slice(0, 15)) {
        lines.push(`- ${b.topic}: ${b.claim} (strength: ${(b.strength * 100).toFixed(0)}%)`);
      }
    }

    // Preferences
    if (s.preferences?.length) {
      lines.push('\n## Preferences');
      for (const p of s.preferences.slice(0, 15)) {
        const dir = p.strength > 0 ? 'likes' : p.strength < 0 ? 'dislikes' : 'neutral on';
        lines.push(`- ${dir} ${p.type}: ${p.description}`);
      }
    }

    // Identities
    if (s.identities?.length) {
      lines.push('\n## Identity');
      for (const i of s.identities.slice(0, 10)) {
        lines.push(`- ${i.role}${i.context ? ' — ' + i.context : ''}`);
      }
    }

    // Dimensional preferences
    if (s.dimensionalPreferences?.length) {
      lines.push('\n## Taste Dimensions');
      for (const d of s.dimensionalPreferences.slice(0, 10)) {
        lines.push(`- ${d.domain || '?'}/${d.dimensionId || '?'}: strength ${d.strength?.toFixed(2)}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Simulate: would this user engage with a story?
   * Returns a quick heuristic prediction without LLM call.
   * For deeper simulation, use SwarmAgent.evaluate()
   */
  wouldEngage(story) {
    const s = this._snapshot || this.takeSnapshot();
    let probability = 0.3; // base engagement rate

    // Topic match
    for (const topic of story.topics || []) {
      const interest = s.interests[topic];
      if (interest) {
        probability += interest.weight * 0.3;
      }
    }

    // Context match
    const text = `${story.title} ${story.summary}`.toLowerCase();
    for (const project of s.context.projects) {
      if (text.includes(project.toLowerCase())) {
        probability += 0.2;
        break;
      }
    }

    // Source trust
    const trust = s.source_trust[story.source] ?? 0.5;
    probability *= (0.5 + trust * 0.5);

    // Avoidance patterns
    for (const avoid of s.patterns.avoids) {
      if (text.includes(avoid.toLowerCase())) {
        probability *= 0.3;
        break;
      }
    }

    return Math.min(1, probability);
  }

  // ── Private ──────────────────────────────────────────

  #extractPatterns(history) {
    const topicReactions = {};

    for (const h of history) {
      for (const topic of h.topics || []) {
        if (!topicReactions[topic]) {
          topicReactions[topic] = { up: 0, down: 0, share: 0, skip: 0 };
        }
        topicReactions[topic][h.reaction] = (topicReactions[topic][h.reaction] || 0) + 1;
      }
    }

    const loves = [];
    const avoids = [];
    const shares = [];

    for (const [topic, counts] of Object.entries(topicReactions)) {
      const total = counts.up + counts.down + counts.skip + counts.share;
      if (total < 3) continue; // not enough data

      const positiveRate = (counts.up + counts.share) / total;
      const shareRate = counts.share / total;

      if (positiveRate > 0.7) loves.push(topic);
      if (positiveRate < 0.3) avoids.push(topic);
      if (shareRate > 0.3) shares.push(topic);
    }

    return { loves, avoids, shares };
  }
}
