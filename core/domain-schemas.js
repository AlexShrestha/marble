/**
 * Domain Schemas for Secondary Context Collection
 *
 * Defines:
 * - Domain detection (from item metadata/tags)
 * - Dimensions that matter for each domain (what to ask about)
 * - How dimensions map to KG node types (belief/preference/identity)
 */

const DOMAIN_PATTERNS = {
  movie: {
    detect: (item) =>
      item.domain === 'movie' ||
      item.type === 'film' ||
      item.type === 'movie' ||
      (item.tags && item.tags.includes('film')) ||
      (item.metadata && (item.metadata.director || item.metadata.genre === 'movie')),
    implicitSignals: [
      { attribute: 'director', kgKey: 'director_style', kgType: 'belief' },
      { attribute: 'genre', kgKey: 'genre_preference', kgType: 'preference' },
      { attribute: 'genres', kgKey: 'genre_preference', kgType: 'preference' },
      { attribute: 'year', kgKey: 'film_era', kgType: 'preference' },
      { attribute: 'themes', kgKey: 'theme', kgType: 'identity' },
      { attribute: 'pacing', kgKey: 'pacing', kgType: 'preference' },
      { attribute: 'style', kgKey: 'director_style', kgType: 'belief' }
    ],
    dimensions: {
      director_style: {
        label: 'Director/Creator Style',
        infoGain: 0.9,
        nodeType: 'belief',
        nodeTopic: 'director_style',
        options: ['narrative_complexity', 'visual_spectacle', 'character_focus', 'experimental']
      },
      film_era: {
        label: 'Film Era Preference',
        infoGain: 0.8,
        nodeType: 'preference',
        nodeType_val: 'film_era',
        options: ['1990s_2000s', '2000s_2010s', '2010s_present', 'silent_era', 'classic']
      },
      theme_resonance: {
        label: 'Theme/Concept Resonance',
        infoGain: 0.85,
        nodeType: 'identity',
        nodeRole: 'theme',
        options: ['scifi_concepts', 'psychological', 'human_relationships', 'action', 'mystery']
      },
      pacing_preference: {
        label: 'Pacing Preference',
        infoGain: 0.65,
        nodeType: 'preference',
        nodeType_val: 'pacing',
        options: ['slow_burn', 'fast_paced', 'methodical', 'variable']
      },
      genre_affinity: {
        label: 'Genre Affinity',
        infoGain: 0.7,
        nodeType: 'preference',
        nodeType_val: 'genre_preference',
        options: ['sci-fi', 'drama', 'action', 'thriller', 'comedy', 'horror']
      }
    }
  },

  music: {
    detect: (item) =>
      item.domain === 'music' ||
      item.type === 'song' ||
      item.type === 'album' ||
      (item.tags && (item.tags.includes('music') || item.tags.includes('song'))),
    implicitSignals: [
      { attribute: 'artist', kgKey: 'artist_preference', kgType: 'belief' },
      { attribute: 'genre', kgKey: 'tempo', kgType: 'preference' },
      { attribute: 'tempo', kgKey: 'tempo', kgType: 'preference' },
      { attribute: 'lyrics', kgKey: 'lyrics', kgType: 'preference' },
      { attribute: 'production', kgKey: 'production', kgType: 'preference' }
    ],
    dimensions: {
      artist_style: {
        label: 'Artist/Genre Style',
        infoGain: 0.9,
        nodeType: 'belief',
        nodeTopic: 'artist_preference',
        options: ['experimental', 'mainstream', 'indie', 'classical', 'electronic']
      },
      tempo_preference: {
        label: 'Tempo/Energy Level',
        infoGain: 0.8,
        nodeType: 'preference',
        nodeType_val: 'tempo',
        options: ['energetic', 'mellow', 'medium', 'variable']
      },
      lyrical_content: {
        label: 'Lyrical Content Preference',
        infoGain: 0.75,
        nodeType: 'preference',
        nodeType_val: 'lyrics',
        options: ['introspective', 'storytelling', 'political', 'abstract', 'minimal']
      },
      production_quality: {
        label: 'Production Quality Preference',
        infoGain: 0.7,
        nodeType: 'preference',
        nodeType_val: 'production',
        options: ['lo-fi', 'polished', 'raw', 'experimental']
      }
    }
  },

  article: {
    detect: (item) =>
      item.domain === 'article' ||
      item.type === 'article' ||
      item.type === 'blog' ||
      (item.tags && (item.tags.includes('article') || item.tags.includes('news'))),
    implicitSignals: [
      { attribute: 'topic', kgKey: 'topic_interest', kgType: 'belief' },
      { attribute: 'category', kgKey: 'topic_interest', kgType: 'belief' },
      { attribute: 'source', kgKey: 'reader_type', kgType: 'identity' },
      { attribute: 'style', kgKey: 'writing_style', kgType: 'preference' }
    ],
    dimensions: {
      depth_level: {
        label: 'Depth/Complexity Level',
        infoGain: 0.85,
        nodeType: 'preference',
        nodeType_val: 'depth',
        options: ['surface_level', 'intermediate', 'deep_technical', 'highly_specialized']
      },
      topic_area: {
        label: 'Topic Area Interest',
        infoGain: 0.9,
        nodeType: 'belief',
        nodeTopic: 'topic_interest',
        options: ['tech', 'science', 'politics', 'culture', 'business', 'opinion']
      },
      writing_style: {
        label: 'Writing Style Preference',
        infoGain: 0.7,
        nodeType: 'preference',
        nodeType_val: 'writing_style',
        options: ['analytical', 'narrative', 'humorous', 'academic', 'opinionated']
      },
      source_credibility: {
        label: 'Source Credibility Importance',
        infoGain: 0.75,
        nodeType: 'identity',
        nodeRole: 'reader_type',
        options: ['mainstream', 'independent', 'academic', 'industry_insider', 'contrarian']
      }
    }
  },

  place: {
    detect: (item) =>
      item.domain === 'place' ||
      item.type === 'restaurant' ||
      item.type === 'venue' ||
      item.type === 'location' ||
      (item.title && /restaurant|cafe|bar|hotel|museum|park/i.test(item.title)),
    implicitSignals: [
      { attribute: 'cuisine', kgKey: 'cuisine', kgType: 'preference' },
      { attribute: 'atmosphere', kgKey: 'atmosphere', kgType: 'preference' },
      { attribute: 'price', kgKey: 'price_sensitivity', kgType: 'preference' },
      { attribute: 'price_range', kgKey: 'price_sensitivity', kgType: 'preference' }
    ],
    dimensions: {
      atmosphere: {
        label: 'Atmosphere Preference',
        infoGain: 0.85,
        nodeType: 'preference',
        nodeType_val: 'atmosphere',
        options: ['cozy', 'upscale', 'casual', 'trendy', 'quiet', 'lively']
      },
      cuisine_or_type: {
        label: 'Cuisine/Type Preference',
        infoGain: 0.9,
        nodeType: 'preference',
        nodeType_val: 'cuisine',
        options: ['italian', 'asian', 'american', 'vegetarian', 'fine_dining', 'street_food']
      },
      price_range: {
        label: 'Price Range Preference',
        infoGain: 0.8,
        nodeType: 'preference',
        nodeType_val: 'price_sensitivity',
        options: ['budget', 'moderate', 'upscale', 'luxury']
      }
    }
  }
};

/**
 * Detect domain from an item
 * @param {Object} item - Item with optional domain, type, tags, title, metadata
 * @returns {string|null} - Domain name or null if undetectable
 */
export function detectDomain(item) {
  if (item.domain) return item.domain;

  for (const [domainName, schema] of Object.entries(DOMAIN_PATTERNS)) {
    if (schema.detect(item)) {
      return domainName;
    }
  }

  return null;
}

/**
 * Get schema for a domain
 * @param {string} domain - Domain name
 * @returns {Object|null} - Domain schema or null
 */
export function getDomainSchema(domain) {
  return DOMAIN_PATTERNS[domain] || null;
}

/**
 * Get all dimensions for a domain
 * @param {string} domain - Domain name
 * @returns {Object} - Dimensions keyed by dimension ID
 */
export function getDomainDimensions(domain) {
  const schema = getDomainSchema(domain);
  return schema ? schema.dimensions : {};
}

/**
 * Get a specific dimension
 * @param {string} domain - Domain name
 * @param {string} dimensionId - Dimension ID
 * @returns {Object|null} - Dimension config or null
 */
export function getDimension(domain, dimensionId) {
  const dimensions = getDomainDimensions(domain);
  return dimensions[dimensionId] || null;
}

/**
 * Export DOMAINS as alias for entity-extractor compatibility
 */
export const DOMAINS = DOMAIN_PATTERNS;
