/**
 * Marble Collaborative Filtering
 *
 * Implements user-based collaborative filtering alongside clone evolution.
 * When scoring for user A, checks if similar users (by KG overlap) engaged with this content.
 * CF complements clone scoring by adding "users like you" signal.
 *
 * Similarity: hybrid mode — 70% dense vector cosine (ONNX embeddings) + 30% topic-overlap cosine.
 */

import { embeddings } from './embeddings.js';

export class CollaborativeFilter {
  constructor(options = {}) {
    this.interactions = new Map(); // userId -> Map(contentId -> InteractionData)
    this.userProfiles = new Map(); // userId -> UserProfile (interests, topics)
    this.similarityCache = new Map(); // userId_userId -> similarity score
    this.minSimilarity = options.minSimilarity || 0.1;
    this.maxSimilarUsers = options.maxSimilarUsers || 10;
    this.coldStartThreshold = options.coldStartThreshold || 1; // allow CF from first similar user
    this.vectorWeight = options.vectorWeight || 0.7;   // ONNX embedding similarity weight
    this.topicWeight = options.topicWeight || 0.3;     // topic-overlap similarity weight
    this.userEmbeddings = new Map(); // userId -> Float32Array (384-dim)
  }

  /**
   * Record user interaction with content
   * @param {string} userId - User identifier
   * @param {string} contentId - Content identifier
   * @param {Object} interaction - Interaction data
   */
  recordInteraction(userId, contentId, interaction) {
    if (!this.interactions.has(userId)) {
      this.interactions.set(userId, new Map());
    }

    const userInteractions = this.interactions.get(userId);
    const existing = userInteractions.get(contentId) || {};

    // Merge interaction data
    const merged = {
      ...existing,
      contentId,
      userId,
      timestamp: interaction.timestamp || Date.now(),
      reaction: interaction.reaction, // 'up', 'down', 'skip', 'share'
      engagement_time: interaction.engagement_time || 0,
      topics: interaction.topics || [],
      implicit_score: this._computeImplicitScore(interaction),
      ...interaction
    };

    userInteractions.set(contentId, merged);

    // Clear similarity cache when interactions change
    this._invalidateSimilarityCache(userId);
  }

  /**
   * Update user profile for similarity computation
   * @param {string} userId - User identifier
   * @param {Object} profile - User profile (interests, context)
   */
  async updateUserProfile(userId, profile) {
    this.userProfiles.set(userId, {
      userId,
      interests: profile.interests || [],
      topics: profile.topics || [],
      context: profile.context || {},
      updated: Date.now()
    });

    // Generate dense embedding from user interests/topics text
    try {
      const textParts = [];
      for (const interest of (profile.interests || [])) {
        textParts.push(typeof interest === 'string' ? interest : interest.topic || '');
      }
      for (const topic of (profile.topics || [])) {
        textParts.push(typeof topic === 'string' ? topic : topic.name || '');
      }
      const profileText = textParts.filter(Boolean).join(' ');
      if (profileText.length > 0) {
        this.userEmbeddings.set(userId, await embeddings.embed(profileText));
      }
    } catch (err) {
      // Non-fatal: hybrid mode falls back to topic-only if embedding fails
    }

    // Clear similarity cache for this user
    this._invalidateSimilarityCache(userId);
  }

  /**
   * Get collaborative filtering score for content
   * @param {string} userId - Target user
   * @param {string} contentId - Content to score
   * @param {Object} contentMeta - Content metadata (topics, etc.)
   * @returns {Promise<Object>} CF score and metadata
   */
  async getCollaborativeScore(userId, contentId, contentMeta = {}) {
    // Get similar users
    const similarUsers = await this.findSimilarUsers(userId);

    if (similarUsers.length < this.coldStartThreshold) {
      return {
        cf_score: 0,
        confidence: 0,
        reason: 'insufficient_users',
        similar_users_count: similarUsers.length,
        cold_start: true
      };
    }

    // Aggregate interactions from similar users
    let totalScore = 0;
    let weightSum = 0;
    const interactions = [];

    for (const { userId: simUserId, similarity } of similarUsers) {
      const userInteractions = this.interactions.get(simUserId);
      if (!userInteractions || !userInteractions.has(contentId)) continue;

      const interaction = userInteractions.get(contentId);
      const weight = similarity; // Use similarity as weight

      totalScore += interaction.implicit_score * weight;
      weightSum += weight;

      interactions.push({
        userId: simUserId,
        similarity,
        reaction: interaction.reaction,
        score: interaction.implicit_score
      });
    }

    if (weightSum === 0) {
      return {
        cf_score: 0,
        confidence: 0,
        reason: 'no_interactions',
        similar_users_count: similarUsers.length,
        interactions_found: 0
      };
    }

    const cf_score = totalScore / weightSum;
    const confidence = this._computeConfidence(interactions, similarUsers.length);

    return {
      cf_score,
      confidence,
      reason: this._buildExplanation(interactions),
      similar_users_count: similarUsers.length,
      interactions_found: interactions.length,
      supporting_interactions: interactions
    };
  }

  /**
   * Find users similar to the target user based on KG overlap
   * @param {string} userId - Target user
   * @returns {Promise<Array>} Similar users with similarity scores
   */
  async findSimilarUsers(userId) {
    const targetProfile = this.userProfiles.get(userId);
    if (!targetProfile) return [];

    const similarities = [];

    for (const [otherUserId, otherProfile] of this.userProfiles) {
      if (otherUserId === userId) continue;

      // Check cache first
      const cacheKey = [userId, otherUserId].sort().join('_');
      let similarity = this.similarityCache.get(cacheKey);

      if (similarity === undefined) {
        similarity = this._computeHybridSimilarity(userId, otherUserId, targetProfile, otherProfile);
        this.similarityCache.set(cacheKey, similarity);
      }

      if (similarity >= this.minSimilarity) {
        similarities.push({
          userId: otherUserId,
          similarity,
          profile: otherProfile
        });
      }
    }

    // Sort by similarity and limit
    return similarities
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, this.maxSimilarUsers);
  }

  /**
   * Hybrid similarity: 70% dense vector cosine (ONNX) + 30% topic-overlap cosine
   */
  _computeHybridSimilarity(userId1, userId2, profile1, profile2) {
    const topicSim = this._computeUserSimilarity(profile1, profile2);
    const emb1 = this.userEmbeddings.get(userId1);
    const emb2 = this.userEmbeddings.get(userId2);

    if (emb1 && emb2) {
      const vectorSim = embeddings.cosineSimilarity(emb1, emb2);
      // Clamp vectorSim to [0,1] since cosine can be negative
      const clampedVectorSim = Math.max(0, vectorSim);
      return this.vectorWeight * clampedVectorSim + this.topicWeight * topicSim;
    }

    // Fallback: topic-only when embeddings unavailable
    return topicSim;
  }

  /**
   * Compute similarity between two user profiles based on interest/topic overlap
   */
  _computeUserSimilarity(profile1, profile2) {
    // Extract interest topics with weights
    const interests1 = this._extractWeightedTopics(profile1.interests);
    const interests2 = this._extractWeightedTopics(profile2.interests);

    if (interests1.size === 0 || interests2.size === 0) return 0;

    // Compute weighted cosine similarity
    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    // Get all topics
    const allTopics = new Set([...interests1.keys(), ...interests2.keys()]);

    for (const topic of allTopics) {
      const weight1 = interests1.get(topic) || 0;
      const weight2 = interests2.get(topic) || 0;

      dotProduct += weight1 * weight2;
      norm1 += weight1 * weight1;
      norm2 += weight2 * weight2;
    }

    if (norm1 === 0 || norm2 === 0) return 0;

    const cosineSimilarity = dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));

    // Bonus for context overlap (active projects, calendar, etc.)
    const contextBonus = this._computeContextSimilarity(profile1.context, profile2.context);

    return Math.min(1, cosineSimilarity + contextBonus * 0.2);
  }

  /**
   * Extract weighted topics from user interests
   */
  _extractWeightedTopics(interests) {
    const topics = new Map();

    for (const interest of interests) {
      if (typeof interest === 'string') {
        topics.set(interest.toLowerCase(), 1.0);
      } else if (interest.topic && typeof interest.weight === 'number') {
        // Apply time decay if available
        let weight = interest.weight;
        if (interest.last_boost) {
          const daysSince = (Date.now() - new Date(interest.last_boost).getTime()) / (1000 * 60 * 60 * 24);
          weight *= Math.exp(-daysSince / 30); // Exponential decay over 30 days
        }
        topics.set(interest.topic.toLowerCase(), weight);
      }
    }

    return topics;
  }

  /**
   * Compute context similarity (projects, calendar, etc.)
   */
  _computeContextSimilarity(context1 = {}, context2 = {}) {
    let overlap = 0;
    let total = 0;

    // Check active projects overlap
    const projects1 = new Set((context1.active_projects || []).map(p => p.toLowerCase()));
    const projects2 = new Set((context2.active_projects || []).map(p => p.toLowerCase()));
    const projectOverlap = this._setIntersection(projects1, projects2).size;
    const projectUnion = this._setUnion(projects1, projects2).size;

    if (projectUnion > 0) {
      overlap += projectOverlap;
      total += projectUnion;
    }

    // Check conversation topics overlap
    const convos1 = new Set((context1.recent_conversations || []).map(c => c.toLowerCase()));
    const convos2 = new Set((context2.recent_conversations || []).map(c => c.toLowerCase()));
    const convoOverlap = this._setIntersection(convos1, convos2).size;
    const convoUnion = this._setUnion(convos1, convos2).size;

    if (convoUnion > 0) {
      overlap += convoOverlap;
      total += convoUnion;
    }

    return total > 0 ? overlap / total : 0;
  }

  /**
   * Compute implicit engagement score from interaction
   */
  _computeImplicitScore(interaction) {
    let score = 0.5; // neutral baseline

    // Explicit reaction signal
    switch (interaction.reaction) {
      case 'share': score = 1.0; break;
      case 'up': score = 0.8; break;
      case 'skip': score = 0.2; break;
      case 'down': score = 0.1; break;
      default: score = 0.5; break;
    }

    // Engagement time boost (if available)
    if (interaction.engagement_time > 0) {
      const timeBonus = Math.min(0.2, interaction.engagement_time / 60000 * 0.1); // 0.1 per minute up to 0.2
      score = Math.min(1, score + timeBonus);
    }

    return score;
  }

  /**
   * Compute confidence in CF score based on evidence quality
   */
  _computeConfidence(interactions, totalSimilarUsers) {
    if (interactions.length === 0) return 0;

    // Base confidence from number of interactions (floors at 0.15 so even 1 interaction contributes)
    const interactionConfidence = Math.max(0.15, Math.min(1, interactions.length / 5));

    // Average similarity of contributing users
    const avgSimilarity = interactions.reduce((sum, int) => sum + int.similarity, 0) / interactions.length;

    // Consensus among similar users (how aligned are their reactions?)
    const avgScore = interactions.reduce((sum, int) => sum + int.score, 0) / interactions.length;
    const variance = interactions.reduce((sum, int) => sum + Math.pow(int.score - avgScore, 2), 0) / interactions.length;
    const consensus = Math.max(0.2, 1 - variance * 2); // Floor at 0.2 so single-user CF still works

    // Additive blend instead of pure multiplicative (avoids any-zero-kills-all)
    return interactionConfidence * 0.4 + avgSimilarity * 0.3 + consensus * 0.3;
  }

  /**
   * Build human-readable explanation of CF score
   */
  _buildExplanation(interactions) {
    if (interactions.length === 0) return 'no similar user interactions';

    const positive = interactions.filter(i => i.score > 0.6).length;
    const negative = interactions.filter(i => i.score < 0.4).length;
    const neutral = interactions.length - positive - negative;

    if (positive > negative) {
      return `${positive} similar users engaged positively`;
    } else if (negative > positive) {
      return `${negative} similar users reacted negatively`;
    } else {
      return `mixed reactions from ${interactions.length} similar users`;
    }
  }

  /**
   * Invalidate similarity cache for a user
   */
  _invalidateSimilarityCache(userId) {
    const keysToDelete = [];
    for (const cacheKey of this.similarityCache.keys()) {
      if (cacheKey.includes(userId)) {
        keysToDelete.push(cacheKey);
      }
    }
    for (const key of keysToDelete) {
      this.similarityCache.delete(key);
    }
  }

  /**
   * Utility methods for set operations
   */
  _setIntersection(set1, set2) {
    return new Set([...set1].filter(x => set2.has(x)));
  }

  _setUnion(set1, set2) {
    return new Set([...set1, ...set2]);
  }

  /**
   * Get interaction statistics for debugging/monitoring
   */
  async getRecommendations(userId, kg, limit = 20) {
    const similarUsers = await this.findSimilarUsers(userId);
    if (similarUsers.length === 0) return [];

    const seen = new Set(this.interactions.get(userId)?.keys() || []);
    const scores = new Map();

    for (const { userId: otherId, similarity } of similarUsers) {
      const otherInteractions = this.interactions.get(otherId);
      if (!otherInteractions) continue;
      for (const [contentId, interaction] of otherInteractions) {
        if (seen.has(contentId)) continue;
        const current = scores.get(contentId) || 0;
        scores.set(contentId, current + similarity * interaction.implicit_score);
      }
    }

    return Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([contentId, score]) => ({ contentId, score }));
  }

  getStats() {
    return {
      total_users: this.userProfiles.size,
      users_with_interactions: this.interactions.size,
      users_with_embeddings: this.userEmbeddings.size,
      total_interactions: Array.from(this.interactions.values())
        .reduce((sum, userInts) => sum + userInts.size, 0),
      cache_size: this.similarityCache.size,
      similarity_mode: this.userEmbeddings.size > 0 ? 'hybrid' : 'topic-only',
      vector_weight: this.vectorWeight,
      topic_weight: this.topicWeight
    };
  }

  /**
   * Export user-item matrix for analysis (sparse format)
   */
  exportMatrix() {
    const matrix = [];

    for (const [userId, userInteractions] of this.interactions) {
      for (const [contentId, interaction] of userInteractions) {
        matrix.push({
          userId,
          contentId,
          score: interaction.implicit_score,
          reaction: interaction.reaction,
          timestamp: interaction.timestamp
        });
      }
    }

    return matrix;
  }
}

export const globalCollaborativeFilter = new CollaborativeFilter();