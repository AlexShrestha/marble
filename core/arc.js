/**
 * Prism Arc Reranker
 *
 * Takes the top-scored stories and sequences them into a narrative arc.
 * The 10 stories should flow — not just be ranked by score.
 *
 * Arc structure:
 * 1. OPENER     — High energy, attention-grabbing
 * 2. BRIDGE     — Transition to substance
 * 3. DEEP_1     — First deep-dive
 * 4. DEEP_2     — Second deep-dive
 * 5. PIVOT      — Change of pace / surprise
 * 6. DEEP_3     — Third deep-dive
 * 7. PRACTICAL  — Actionable / how-to
 * 8. HORIZON    — Future-looking
 * 9. PERSONAL   — Close to home
 * 10. CLOSER    — Warm, human, memorable
 */

import { ARC_SLOTS } from './types.js';

export class ArcReranker {
  /**
   * Reorder scored stories into a narrative arc
   * @param {ScoredStory[]} scored - Top stories sorted by magic_score
   * @param {number} count - Number of stories to select (default 10)
   * @returns {ScoredStory[]} - Reordered with arc_position set
   */
  reorder(scored, count = 10) {
    const pool = scored.slice(0, Math.min(count * 2, scored.length)); // work with top 2x
    const selected = [];
    const used = new Set();

    // Assign each arc slot from the pool
    const slots = [
      { pos: ARC_SLOTS.OPENER, pick: s => this.#bestForOpener(s) },
      { pos: ARC_SLOTS.PIVOT, pick: s => this.#bestForPivot(s) },
      { pos: ARC_SLOTS.CLOSER, pick: s => this.#bestForCloser(s) },
      { pos: ARC_SLOTS.PRACTICAL, pick: s => this.#bestForPractical(s) },
      { pos: ARC_SLOTS.PERSONAL, pick: s => this.#bestForPersonal(s) },
      { pos: ARC_SLOTS.HORIZON, pick: s => this.#bestForHorizon(s) },
      // Fill remaining slots by score
      { pos: ARC_SLOTS.DEEP_1, pick: null },
      { pos: ARC_SLOTS.DEEP_2, pick: null },
      { pos: ARC_SLOTS.DEEP_3, pick: null },
      { pos: ARC_SLOTS.BRIDGE, pick: null },
    ];

    // First pass: assign specialty slots
    for (const slot of slots) {
      const available = pool.filter(s => !used.has(s.story.id));
      if (available.length === 0) break;

      let pick;
      if (slot.pick) {
        pick = slot.pick(available);
      } else {
        // Default: highest remaining score
        pick = available[0];
      }

      if (pick) {
        pick.arc_position = slot.pos;
        selected.push(pick);
        used.add(pick.story.id);
      }
    }

    // Sort by arc position
    selected.sort((a, b) => a.arc_position - b.arc_position);

    return selected.slice(0, count);
  }

  // ── Slot pickers ──────────────────────────────────────

  #bestForOpener(stories) {
    // High energy, high interest, inspiring or alarming valence
    return this.#pickBest(stories, s => {
      let score = s.magic_score;
      if (s.story.valence === 'inspiring') score += 0.2;
      if (s.story.valence === 'alarming') score += 0.15;
      if (s.interest_match > 0.7) score += 0.1;
      return score;
    });
  }

  #bestForPivot(stories) {
    // Highest novelty — the "didn't see that coming" story
    return this.#pickBest(stories, s => s.novelty * 2 + s.magic_score * 0.5);
  }

  #bestForCloser(stories) {
    // Warm, human, personal, fun
    return this.#pickBest(stories, s => {
      let score = s.magic_score * 0.5;
      if (s.story.valence === 'fun') score += 0.3;
      if (s.story.valence === 'inspiring') score += 0.2;
      if (s.temporal_relevance > 0.5) score += 0.15;
      return score;
    });
  }

  #bestForPractical(stories) {
    // Highest actionability
    return this.#pickBest(stories, s => s.actionability * 2 + s.magic_score * 0.5);
  }

  #bestForPersonal(stories) {
    // Highest temporal relevance — close to the user's context
    return this.#pickBest(stories, s => s.temporal_relevance * 2 + s.magic_score * 0.5);
  }

  #bestForHorizon(stories) {
    // Future-looking: high novelty + moderate interest (stretches the user)
    return this.#pickBest(stories, s => {
      const isStretch = s.interest_match < 0.5 && s.interest_match > 0.1;
      return s.novelty + (isStretch ? 0.3 : 0) + s.magic_score * 0.3;
    });
  }

  #pickBest(stories, scoreFn) {
    let best = null;
    let bestScore = -Infinity;
    for (const s of stories) {
      const score = scoreFn(s);
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return best;
  }
}
