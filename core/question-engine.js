/**
 * Question Engine: Proactive Secondary Context Collection
 *
 * When a user rates/engages with an item (movie, article, song, place),
 * the engine generates follow-up questions to extract deeper context:
 *
 * 1. generateFollowUpQuestions - Based on item + rating, ask 2-3 contextual follow-ups
 * 2. recordSecondaryContext - Store answers as KG nodes (beliefs/preferences/identities)
 * 3. extractImplicitContext - Infer patterns from N>3 items (e.g., "You like Nolan films")
 * 4. getSummary - User's secondary context profile
 */

import { detectDomain, getDomainSchema, getDomainDimensions, getDimension } from './domain-schemas.js';

export class QuestionEngine {
  constructor(kg, opts = {}) {
    this.kg = kg;
    this.maxQuestionsDefault = opts.maxQuestions || 3;
    this.implicitThreshold = opts.implicitThreshold || 3;
    this.answeredDimensions = new Set();
    this.ratingHistory = [];
  }

  /**
   * Generate follow-up questions for an item based on its rating
   * @param {Object} item - Item with domain, title, metadata
   * @param {number} rating - User's rating (0-5 or 0-10 scale)
   * @param {Object} opts - Options { maxQuestions: 3 }
   * @returns {Array} - Array of question objects
   */
  generateFollowUpQuestions(item, rating, opts = {}) {
    const domain = detectDomain(item) || 'article'; // fallback to article
    const schema = getDomainSchema(domain);
    if (!schema) return [];

    const maxQuestions = opts.maxQuestions || this.maxQuestionsDefault;
    const dimensions = schema.dimensions;

    // Only ask about unanswered dimensions
    const available = Object.entries(dimensions)
      .filter(([dimId]) => !this.answeredDimensions.has(`${domain}:${dimId}`))
      .map(([dimId, config]) => ({
        dimensionId: dimId,
        ...config
      }));

    // Sort by infoGain (descending) - highest info gain first
    available.sort((a, b) => b.infoGain - a.infoGain);

    // Take top N
    const selected = available.slice(0, maxQuestions);

    // Convert to question format
    return selected.map((dim) => ({
      id: `${domain}:${dim.dimensionId}`,
      domain,
      dimension: dim.dimensionId,
      label: dim.label,
      options: dim.options,
      infoGain: dim.infoGain
    }));
  }

  /**
   * Record user's answers to secondary context questions
   * @param {Object} item - Original item
   * @param {number} rating - User's rating
   * @param {Array} answers - Array of { dimensionId, value }
   */
  recordSecondaryContext(item, rating, answers) {
    const domain = detectDomain(item) || 'article';
    const schema = getDomainSchema(domain);
    if (!schema) return;

    const dimensions = schema.dimensions;

    for (const answer of answers) {
      const dimensionId = answer.dimensionId;
      const value = answer.value;
      const dimension = dimensions[dimensionId];

      if (!dimension) continue;

      // Mark as answered
      this.answeredDimensions.add(`${domain}:${dimensionId}`);

      // Store in KG based on node type
      if (dimension.nodeType === 'belief') {
        this.kg.addBelief(dimension.nodeTopic, value, 0.7);
      } else if (dimension.nodeType === 'preference') {
        this.kg.addPreference(dimension.nodeType_val, value, 0.7);
      } else if (dimension.nodeType === 'identity') {
        this.kg.addIdentity(dimension.nodeRole, value, 0.8);
      }
    }
  }

  /**
   * Extract implicit context from patterns in rating history
   * When a user rates 3+ items with common attributes, infer preferences
   * @param {Object} item - Item being rated
   * @param {number} rating - User's rating
   */
  extractImplicitContext(item, rating) {
    const domain = detectDomain(item) || 'article';
    const schema = getDomainSchema(domain);
    if (!schema) return;

    this.ratingHistory.push({ item, rating, domain, timestamp: new Date().toISOString() });

    // Analyze patterns if we have enough history
    if (this.ratingHistory.length >= this.implicitThreshold) {
      this.#inferPatternsFromHistory(domain, schema);
    }
  }

  /**
   * Get a summary of collected secondary context
   * @returns {Object} - Summary including beliefs, preferences, identities, rating history count
   */
  getSummary() {
    const beliefs = this.kg.getActiveBeliefs();
    const preferences = this.kg.getActivePreferences();
    const identities = this.kg.getActiveIdentities();

    return {
      ratingHistoryCount: this.ratingHistory.length,
      answeredDimensions: Array.from(this.answeredDimensions),
      beliefs: beliefs.length,
      preferences: preferences.length,
      identities: identities.length,
      kgSummary: this.kg.getMemoryNodesSummary()
    };
  }

  // ── Private Methods ──────────────────────────────

  /**
   * Infer preferences/beliefs from patterns in rating history
   * @private
   */
  #inferPatternsFromHistory(domain, schema) {
    // Only infer if we have positively-rated items (rating >= 4)
    const positiveRatings = this.ratingHistory.filter(r => r.rating >= 4);
    if (positiveRatings.length < this.implicitThreshold) return;

    if (domain === 'movie') {
      this.#inferMoviePatterns(positiveRatings, schema);
    } else if (domain === 'music') {
      this.#inferMusicPatterns(positiveRatings, schema);
    } else if (domain === 'article') {
      this.#inferArticlePatterns(positiveRatings, schema);
    }
  }

  /**
   * Infer movie-specific patterns
   * @private
   */
  #inferMoviePatterns(items, schema) {
    const movies = items.map(r => r.item);

    // Pattern 1: Same director (count >= 3)
    const directors = {};
    for (const movie of movies) {
      const director = movie.metadata?.director;
      if (director) {
        directors[director] = (directors[director] || 0) + 1;
      }
    }

    for (const [director, count] of Object.entries(directors)) {
      if (count >= this.implicitThreshold) {
        // Infer director preference
        this.kg.addBelief('director_style', director.toLowerCase(), 0.8);
        this.answeredDimensions.add('movie:director_style');
      }
    }

    // Pattern 2: Genre preference (count >= 3)
    const genres = {};
    for (const movie of movies) {
      const genre = movie.metadata?.genre;
      if (genre) {
        genres[genre] = (genres[genre] || 0) + 1;
      }
    }

    for (const [genre, count] of Object.entries(genres)) {
      if (count >= this.implicitThreshold) {
        this.kg.addPreference('genre_preference', genre, 0.8);
        this.answeredDimensions.add('movie:genre_affinity');
      }
    }

    // Pattern 3: Era inference (most common year range)
    const years = movies
      .map(m => parseInt(m.metadata?.year))
      .filter(y => !isNaN(y));

    if (years.length >= this.implicitThreshold) {
      const avgYear = Math.round(years.reduce((a, b) => a + b, 0) / years.length);
      let eraLabel = 'modern';
      if (avgYear < 1980) eraLabel = 'classic';
      else if (avgYear < 2000) eraLabel = '1990s_2000s';
      else if (avgYear < 2010) eraLabel = '2000s_2010s';
      else eraLabel = '2010s_present';

      this.kg.addPreference('film_era', eraLabel, 0.75);
      this.answeredDimensions.add('movie:film_era');
    }
  }

  /**
   * Infer music-specific patterns
   * @private
   */
  #inferMusicPatterns(items, schema) {
    const songs = items.map(r => r.item);

    // Pattern 1: Artist preference
    const artists = {};
    for (const song of songs) {
      const artist = song.metadata?.artist;
      if (artist) {
        artists[artist] = (artists[artist] || 0) + 1;
      }
    }

    for (const [artist, count] of Object.entries(artists)) {
      if (count >= this.implicitThreshold) {
        this.kg.addBelief('artist_preference', artist, 0.8);
        this.answeredDimensions.add('music:artist_style');
      }
    }

    // Pattern 2: Genre preference
    const genres = {};
    for (const song of songs) {
      const genre = song.metadata?.genre;
      if (genre) {
        genres[genre] = (genres[genre] || 0) + 1;
      }
    }

    for (const [genre, count] of Object.entries(genres)) {
      if (count >= this.implicitThreshold) {
        this.kg.addPreference('genre_preference', genre, 0.8);
        this.answeredDimensions.add('music:artist_style');
      }
    }
  }

  /**
   * Infer article-specific patterns
   * @private
   */
  #inferArticlePatterns(items, schema) {
    const articles = items.map(r => r.item);

    // Pattern 1: Topic interest
    const topics = {};
    for (const article of articles) {
      const topic = article.metadata?.topic || article.tags?.[0];
      if (topic) {
        topics[topic] = (topics[topic] || 0) + 1;
      }
    }

    for (const [topic, count] of Object.entries(topics)) {
      if (count >= this.implicitThreshold) {
        this.kg.addBelief('topic_interest', topic, 0.8);
        this.answeredDimensions.add('article:topic_area');
      }
    }
  }
}
