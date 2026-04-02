/**
 * Marble Lightweight Scorer
 *
 * Optimized version with lazy loading and lightweight mode for mobile devices.
 * Falls back to keyword matching when embeddings are not available.
 */

class LightweightMarbleScorer {
  constructor(userContext, options = {}) {
    this.userContext = userContext;
    this.options = {
      enableEmbeddings: options.enableEmbeddings !== false,
      enableLazyLoading: options.enableLazyLoading !== false,
      lightweightMode: options.lightweightMode === true,
      deviceProfile: options.deviceProfile || 'auto'
    };

    // Lazy-loaded components
    this.embeddings = null;
    this.swarm = null;
    this.evolution = null;

    // Simple scoring components (always loaded)
    this.keywordMatcher = new KeywordMatcher();
    this.temporalScorer = new TemporalScorer();
    this.basicScorer = new BasicScorer(userContext);

    // Auto-detect device capability
    if (this.options.deviceProfile === 'auto') {
      this.options.deviceProfile = this.detectDeviceProfile();
    }

    // Enable lightweight mode for low-power devices
    if (this.options.deviceProfile === 'low' || this.options.lightweightMode) {
      this.options.enableEmbeddings = false;
      this.options.enableLazyLoading = false;
    }
  }

  /**
   * Detect device performance profile
   * @returns {string} 'high', 'medium', or 'low'
   */
  detectDeviceProfile() {
    if (typeof window === 'undefined') return 'high'; // Server-side

    const navigator = window.navigator;
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;

    // Check memory
    const memory = navigator.deviceMemory || 4; // Default to 4GB if unknown

    // Check CPU cores
    const cores = navigator.hardwareConcurrency || 4;

    // Check network
    const isSlowNetwork = connection && (
      connection.effectiveType === '2g' ||
      connection.effectiveType === 'slow-2g' ||
      connection.downlink < 1
    );

    // Classify device
    if (memory <= 2 || cores <= 2 || isSlowNetwork) {
      return 'low';
    } else if (memory <= 4 || cores <= 4) {
      return 'medium';
    } else {
      return 'high';
    }
  }

  /**
   * Lazy load embeddings component
   */
  async loadEmbeddings() {
    if (this.embeddings || !this.options.enableEmbeddings) return this.embeddings;

    try {
      console.log('🔄 Loading embeddings component...');
      const { default: Embeddings } = await import('./embeddings.js');
      this.embeddings = new Embeddings();
      await this.embeddings.initialize();
      console.log('✓ Embeddings loaded successfully');
    } catch (error) {
      console.warn('Failed to load embeddings, using keyword fallback:', error.message);
      this.embeddings = null;
      this.options.enableEmbeddings = false;
    }

    return this.embeddings;
  }

  /**
   * Lazy load swarm component
   */
  async loadSwarm() {
    if (this.swarm || this.options.lightweightMode) return this.swarm;

    try {
      console.log('🔄 Loading swarm component...');
      const { default: Swarm } = await import('./swarm.js');
      this.swarm = new Swarm(this.userContext);
      console.log('✓ Swarm loaded successfully');
    } catch (error) {
      console.warn('Failed to load swarm:', error.message);
      this.swarm = null;
    }

    return this.swarm;
  }

  /**
   * Score a single story with optimization for device capability
   * @param {Object} story - Story object
   * @returns {Object} Score breakdown
   */
  async score(story) {
    const startTime = performance.now();

    // Always use basic fast scoring
    const basicScore = this.basicScorer.score(story);
    let enhancedScore = basicScore;

    // Add semantic similarity if embeddings are available and enabled
    if (this.options.enableEmbeddings) {
      const embeddings = await this.loadEmbeddings();
      if (embeddings) {
        try {
          const semanticScore = await this.computeSemanticScore(story, embeddings);
          enhancedScore = this.blendScores(basicScore, semanticScore, 0.7);
        } catch (error) {
          console.warn('Semantic scoring failed, using basic score:', error.message);
        }
      }
    }

    // Add swarm intelligence for high-end devices only
    if (this.options.deviceProfile === 'high' && !this.options.lightweightMode) {
      const swarm = await this.loadSwarm();
      if (swarm) {
        try {
          const swarmScore = await swarm.processStory(story);
          enhancedScore = this.blendScores(enhancedScore, swarmScore, 0.3);
        } catch (error) {
          console.warn('Swarm processing failed:', error.message);
        }
      }
    }

    const processingTime = performance.now() - startTime;

    return {
      ...enhancedScore,
      meta: {
        processing_time_ms: processingTime,
        device_profile: this.options.deviceProfile,
        lightweight_mode: this.options.lightweightMode,
        embeddings_used: !!this.embeddings,
        swarm_used: !!this.swarm
      }
    };
  }

  /**
   * Batch score multiple stories with performance optimization
   */
  async scoreMultiple(stories, options = {}) {
    const batchSize = options.batchSize || this.getBatchSize();
    const results = [];

    console.log(`📊 Scoring ${stories.length} stories (batch size: ${batchSize})`);

    for (let i = 0; i < stories.length; i += batchSize) {
      const batch = stories.slice(i, i + batchSize);
      const batchStart = performance.now();

      // Process batch
      const batchResults = await Promise.all(
        batch.map(story => this.score(story))
      );

      results.push(...batchResults);

      const batchTime = performance.now() - batchStart;
      console.log(`  Batch ${Math.floor(i/batchSize) + 1}: ${batchTime.toFixed(2)}ms`);

      // Throttle for low-end devices
      if (this.options.deviceProfile === 'low') {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }

    return results;
  }

  getBatchSize() {
    switch (this.options.deviceProfile) {
      case 'high': return 100;
      case 'medium': return 50;
      case 'low': return 20;
      default: return 50;
    }
  }

  /**
   * Compute semantic similarity score
   */
  async computeSemanticScore(story, embeddings) {
    const userInterests = this.userContext.interests || [];
    const storyText = `${story.title} ${story.content}`.slice(0, 500); // Limit length

    try {
      const storyEmbedding = await embeddings.embed(storyText);

      let maxSimilarity = 0;
      for (const interest of userInterests) {
        const interestEmbedding = await embeddings.embed(interest);
        const similarity = this.cosineSimilarity(storyEmbedding, interestEmbedding);
        maxSimilarity = Math.max(maxSimilarity, similarity);
      }

      return {
        interest_match: maxSimilarity,
        temporal_relevance: this.temporalScorer.score(story),
        novelty: this.computeNoveltyScore(story),
        actionability: this.computeActionabilityScore(story),
        source_trust: this.computeSourceTrust(story)
      };
    } catch (error) {
      console.warn('Semantic scoring error:', error.message);
      return this.keywordMatcher.score(story, userInterests);
    }
  }

  /**
   * Blend multiple score objects
   */
  blendScores(score1, score2, weight1 = 0.5) {
    const weight2 = 1 - weight1;
    const blended = {};

    for (const key in score1) {
      if (typeof score1[key] === 'number' && typeof score2[key] === 'number') {
        blended[key] = score1[key] * weight1 + score2[key] * weight2;
      } else {
        blended[key] = score1[key]; // Keep non-numeric values from first score
      }
    }

    return blended;
  }

  cosineSimilarity(a, b) {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  computeNoveltyScore(story) {
    // Simple novelty based on date and uniqueness
    const daysSincePublished = (Date.now() - new Date(story.date)) / (1000 * 60 * 60 * 24);
    return Math.exp(-daysSincePublished / 7); // Decay over a week
  }

  computeActionabilityScore(story) {
    const actionWords = ['how', 'guide', 'tutorial', 'step', 'build', 'create', 'learn'];
    const content = `${story.title} ${story.content}`.toLowerCase();
    return actionWords.reduce((score, word) => {
      return score + (content.includes(word) ? 0.1 : 0);
    }, 0.1);
  }

  computeSourceTrust(story) {
    const trustedSources = ['techcrunch', 'hackernews', 'arstechnica', 'github'];
    const source = (story.source || '').toLowerCase();
    return trustedSources.includes(source) ? 0.8 : 0.5;
  }

  /**
   * Get performance statistics
   */
  getStats() {
    return {
      device_profile: this.options.deviceProfile,
      lightweight_mode: this.options.lightweightMode,
      embeddings_loaded: !!this.embeddings,
      swarm_loaded: !!this.swarm,
      features_enabled: {
        embeddings: this.options.enableEmbeddings,
        lazy_loading: this.options.enableLazyLoading,
        swarm_intelligence: !this.options.lightweightMode
      }
    };
  }
}

/**
 * Simple keyword matcher fallback
 */
class KeywordMatcher {
  score(story, interests) {
    const content = `${story.title} ${story.content}`.toLowerCase();
    let matchScore = 0;

    for (const interest of interests || []) {
      if (content.includes(interest.toLowerCase())) {
        matchScore += 0.2;
      }
    }

    return {
      interest_match: Math.min(matchScore, 1.0),
      temporal_relevance: 0.5,
      novelty: 0.5,
      actionability: 0.5,
      source_trust: 0.5
    };
  }
}

/**
 * Temporal relevance scorer
 */
class TemporalScorer {
  score(story) {
    const now = Date.now();
    const storyDate = new Date(story.date).getTime();
    const hoursSincePublished = (now - storyDate) / (1000 * 60 * 60);

    // Peak relevance at 0-6 hours, then decay
    if (hoursSincePublished <= 6) return 1.0;
    if (hoursSincePublished <= 24) return 0.8;
    if (hoursSincePublished <= 168) return 0.6; // 1 week
    return 0.3;
  }
}

/**
 * Basic scorer (always loaded)
 */
class BasicScorer {
  constructor(userContext) {
    this.userContext = userContext;
    this.keywordMatcher = new KeywordMatcher();
    this.temporalScorer = new TemporalScorer();
  }

  score(story) {
    const keywordScore = this.keywordMatcher.score(story, this.userContext.interests);
    const temporalScore = this.temporalScorer.score(story);

    return {
      interest_match: keywordScore.interest_match,
      temporal_relevance: temporalScore,
      novelty: keywordScore.novelty,
      actionability: keywordScore.actionability,
      source_trust: keywordScore.source_trust,
      final_score: (
        keywordScore.interest_match * 0.3 +
        temporalScore * 0.3 +
        keywordScore.novelty * 0.2 +
        keywordScore.actionability * 0.1 +
        keywordScore.source_trust * 0.1
      )
    };
  }
}

export default LightweightMarbleScorer;