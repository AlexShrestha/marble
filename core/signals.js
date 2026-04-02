/**
 * Signal Processing — Implicit User Feedback
 *
 * Converts user behavior signals into reaction data for the knowledge graph.
 * Tracks dwell time, clicks, forwards, replies, and silence patterns.
 */

/**
 * Processes implicit user signals to generate synthetic reactions
 */
export class SignalProcessor {
  constructor() {
    this.signals = new Map(); // storyId -> signals[]
    this.sessionThreshold = 10; // Stories needed for silence detection
    this.dwellThresholds = {
      quick: 5000,   // < 5s = potential down signal
      medium: 15000, // 5-15s = neutral
      long: 30000    // > 30s = up signal
    };
  }

  /**
   * Record a user signal for a story
   * @param {string} storyId - Unique story identifier
   * @param {string} type - Signal type: 'dwell', 'scroll', 'click', 'forward', 'reply', 'silence'
   * @param {number|Object} value - Signal value (time in ms for dwell, depth for scroll, etc.)
   */
  recordSignal(storyId, type, value) {
    if (!this.signals.has(storyId)) {
      this.signals.set(storyId, []);
    }

    const signal = {
      type,
      value,
      timestamp: Date.now()
    };

    this.signals.get(storyId).push(signal);
    return signal;
  }

  /**
   * Convert raw signals into synthetic up/down/share reactions for KG
   * @param {Map<string, Array>} [signalData] - Optional signal data, uses this.signals if not provided
   * @returns {Array<Object>} Array of {storyId, reaction, confidence} objects
   */
  inferReactions(signalData = null) {
    const signals = signalData || this.signals;
    const reactions = [];
    const storyIds = Array.from(signals.keys());

    // Apply silence detection first
    const silenceReactions = this._detectSilence(storyIds, signals);
    reactions.push(...silenceReactions);

    // Process explicit signals for each story
    for (const [storyId, storySignals] of signals) {
      const explicit = this._processExplicitSignals(storyId, storySignals);
      if (explicit) {
        reactions.push(explicit);
      }
    }

    return reactions;
  }

  /**
   * Detect implicit 'down' signals from silence patterns
   * If 7+ stories have signals but some don't, the silent ones are implicit downs
   * @private
   * @param {Array} storyIds - Story IDs to check
   * @param {Map} signals - Signal data map
   */
  _detectSilence(storyIds, signals) {
    if (storyIds.length < this.sessionThreshold) {
      return []; // Not enough stories for silence detection
    }

    const storiesWithSignals = storyIds.filter(id => {
      const storySignals = signals.get(id);
      return storySignals && storySignals.length > 0 &&
             storySignals.some(s => s.type !== 'silence');
    });

    const silentStories = storyIds.filter(id => !storiesWithSignals.includes(id));
    const engagementRatio = storiesWithSignals.length / storyIds.length;

    // If 70%+ of stories have engagement, silent ones are implicit downs
    if (engagementRatio >= 0.7 && silentStories.length > 0) {
      return silentStories.map(storyId => ({
        storyId,
        reaction: 'down',
        confidence: 0.6, // Medium confidence for implicit signals
        source: 'silence_detection'
      }));
    }

    return [];
  }

  /**
   * Process explicit user signals for a single story
   * @private
   */
  _processExplicitSignals(storyId, storySignals) {
    if (!storySignals || storySignals.length === 0) {
      return null;
    }

    let reaction = 'neutral';
    let confidence = 0.5;
    const signalWeights = {
      reply: { reaction: 'up', weight: 0.9 },
      forward: { reaction: 'share', weight: 0.8 },
      click: { reaction: 'up', weight: 0.7 },
      scroll: { reaction: 'up', weight: 0.4 },
      dwell: { reaction: 'variable', weight: 0.6 }
    };

    let totalWeight = 0;
    let reactionScore = 0;

    for (const signal of storySignals) {
      if (signal.type === 'silence') continue;

      const weight = signalWeights[signal.type]?.weight || 0.3;
      totalWeight += weight;

      if (signal.type === 'dwell') {
        // Dwell time analysis
        if (signal.value < this.dwellThresholds.quick) {
          reactionScore -= weight; // Quick exit = down signal
        } else if (signal.value > this.dwellThresholds.long) {
          reactionScore += weight * 1.5; // Long dwell = strong up
        } else {
          reactionScore += weight * 0.5; // Medium dwell = weak up
        }
      } else if (['reply', 'forward', 'click'].includes(signal.type)) {
        reactionScore += weight;
      } else if (signal.type === 'scroll') {
        // Deep scroll = engagement
        const scrollDepth = signal.value?.depth || 0;
        if (scrollDepth > 0.8) {
          reactionScore += weight;
        } else if (scrollDepth > 0.5) {
          reactionScore += weight * 0.7;
        }
      }
    }

    if (totalWeight === 0) return null;

    // Determine final reaction
    const normalizedScore = reactionScore / totalWeight;

    if (normalizedScore > 0.3) {
      reaction = 'up';
      confidence = Math.min(0.9, 0.5 + normalizedScore);
    } else if (normalizedScore < -0.3) {
      reaction = 'down';
      confidence = Math.min(0.8, 0.5 + Math.abs(normalizedScore));
    }

    // Special case: explicit share signals
    const hasShare = storySignals.some(s => ['forward', 'reply'].includes(s.type));
    if (hasShare) {
      reaction = 'share';
      confidence = Math.max(confidence, 0.8);
    }

    return {
      storyId,
      reaction,
      confidence: Math.round(confidence * 100) / 100,
      source: 'signal_inference'
    };
  }

  /**
   * Clear stored signals (call after processing a session)
   */
  clearSignals() {
    this.signals.clear();
  }

  /**
   * Get current signal count for debugging
   */
  getSignalCount() {
    return this.signals.size;
  }

  // ── Post-Rating Context Collection Hooks ────────────

  /**
   * Hook: after a rating is recorded, trigger secondary context collection.
   * Connects to QuestionEngine for follow-up questions and implicit extraction.
   * @param {Object} questionEngine - QuestionEngine instance
   * @param {Object} item - Rated item
   * @param {number|string} rating - User's rating
   * @param {Object} [opts] - Options for question generation
   * @returns {{ questions: Array, implicitExtracted: boolean }}
   */
  onPostRating(questionEngine, item, rating, opts = {}) {
    // Generate follow-up questions
    const questions = questionEngine.generateFollowUpQuestions(item, rating, opts);

    // Always run implicit extraction (no user input needed)
    questionEngine.extractImplicitContext(item, rating);

    return { questions, implicitExtracted: true };
  }
}