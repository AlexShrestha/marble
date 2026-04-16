/**
 * Entity-Attribute Extractor for Candidate Items
 *
 * Extracts structured attributes from content items (movies, music, articles, etc.)
 * Domain-agnostic: infers item type and extracts attributes from available metadata
 * without hardcoded domain schemas. Works for ANY item type.
 */

/**
 * Detect the domain/type of an item from its metadata.
 * Generic — inspects fields rather than using a hardcoded registry.
 * @param {Object} item
 * @returns {string|null}
 */
function detectDomain(item) {
  // Explicit domain/type field from caller — pass through unchanged
  if (item.domain) return item.domain.toLowerCase();
  if (item.type) return item.type.toLowerCase();

  const meta = item.metadata || {};
  if (meta.domain) return meta.domain.toLowerCase();
  if (meta.type) return meta.type.toLowerCase();

  // Infer from metadata fields using neutral domain labels that don't
  // leak into user beliefs as content-specific jargon.
  if (meta.director || meta.cast) return 'visual_media';
  if (meta.artist || meta.album) return 'audio';
  if (meta.author && (meta.publisher || meta.isbn)) return 'long_form_text';
  if (meta.cuisine || meta.chef) return 'place';
  if (item.tags?.includes('film') || item.tags?.includes('movie')) return 'visual_media';
  if (item.tags?.includes('music') || item.tags?.includes('album')) return 'audio';
  if (item.tags?.includes('book')) return 'long_form_text';

  // Default: generic item with source attribution
  return item.source ? 'article' : null;
}

/**
 * Field-to-KG mapping: common metadata fields and their KG node types.
 * This replaces hardcoded domain schemas with a generic field registry.
 */
const FIELD_KG_MAP = {
  director:    { kgKey: 'director_style', kgType: 'belief' },
  creator:     { kgKey: 'creator_style', kgType: 'belief' },
  author:      { kgKey: 'author_style', kgType: 'belief' },
  artist:      { kgKey: 'artist_style', kgType: 'belief' },
  cast:        { kgKey: 'cast_preference', kgType: 'belief' },
  genre:       { kgKey: 'genre_preference', kgType: 'preference' },
  genres:      { kgKey: 'genre_preference', kgType: 'preference' },
  style:       { kgKey: 'style_preference', kgType: 'preference' },
  pacing:      { kgKey: 'pacing', kgType: 'preference' },
  tone:        { kgKey: 'tone_preference', kgType: 'preference' },
  themes:      { kgKey: 'theme', kgType: 'identity' },
  mood:        { kgKey: 'mood_preference', kgType: 'identity' },
  year:        { kgKey: 'era_preference', kgType: 'preference' },
  era:         { kgKey: 'era_preference', kgType: 'preference' },
  cuisine:     { kgKey: 'cuisine_preference', kgType: 'preference' },
  price_point: { kgKey: 'price_preference', kgType: 'preference' },
  ambience:    { kgKey: 'ambience_preference', kgType: 'preference' },
  format:      { kgKey: 'format_preference', kgType: 'preference' },
  complexity:  { kgKey: 'complexity_preference', kgType: 'preference' },
  language:    { kgKey: 'language_preference', kgType: 'preference' },
  category:    { kgKey: 'category_preference', kgType: 'preference' },
  topic:       { kgKey: 'topic_preference', kgType: 'preference' },
  duration:    { kgKey: 'duration_preference', kgType: 'preference' },
};

/**
 * Extract entity attributes from a candidate item, normalized to KG-compatible keys.
 * Fully generic — no hardcoded domain schemas.
 * @param {Object} item - Candidate item with metadata
 * @returns {{ domain: string|null, attributes: Object<string, {value: string, kgKey: string, kgType: string, attribute: string}[]> }}
 */
export function extractEntityAttributes(item) {
  const domain = detectDomain(item);
  if (!domain) {
    return { domain: null, attributes: {} };
  }

  const attributes = {};
  const meta = item.metadata || item;

  // Extract from known metadata fields using generic field map
  for (const [field, config] of Object.entries(FIELD_KG_MAP)) {
    const rawValue = meta[field];
    if (!rawValue) continue;

    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    const normalized = values.map(v => ({
      value: String(v).toLowerCase().trim(),
      kgKey: config.kgKey,
      kgType: config.kgType,
      attribute: field
    }));

    if (normalized.length > 0) {
      attributes[config.kgKey] = (attributes[config.kgKey] || []).concat(normalized);
    }
  }

  // Text-based extraction from title/summary for additional signals
  _extractTextAttributes(item, domain, attributes);

  return { domain, attributes };
}

/**
 * Extract attributes from text fields when structured metadata is missing.
 * Works across item types — year/era, genre keywords, theme keywords.
 */
function _extractTextAttributes(item, domain, attributes) {
  const text = `${item.title || ''} ${item.summary || item.description || ''}`.toLowerCase();

  // Year extraction → era_preference
  const yearMatch = text.match(/\b(19[2-9]\d|20[0-2]\d)\b/);
  if (yearMatch && !attributes.era_preference) {
    const year = parseInt(yearMatch[1]);
    let era;
    if (year < 1970) era = 'classic_pre1970';
    else if (year < 1990) era = '1970s_1980s';
    else if (year < 2010) era = '1990s_2000s';
    else era = 'modern_2010s_plus';

    attributes.era_preference = [{
      value: era, kgKey: 'era_preference', kgType: 'preference', attribute: 'year'
    }];
  }

  // Genre extraction from common genre keywords
  const genres = ['action', 'comedy', 'drama', 'thriller', 'horror', 'sci-fi', 'romance',
    'documentary', 'animation', 'fantasy', 'mystery', 'crime', 'war', 'western',
    'jazz', 'rock', 'pop', 'classical', 'hip-hop', 'electronic', 'indie'];
  const foundGenres = genres.filter(g => text.includes(g));
  if (foundGenres.length > 0 && !attributes.genre_preference) {
    attributes.genre_preference = foundGenres.map(g => ({
      value: g, kgKey: 'genre_preference', kgType: 'preference', attribute: 'genre'
    }));
  }

  // Theme extraction
  const themeMap = {
    'redemption': 'redemption_arcs', 'transformation': 'redemption_arcs',
    'family': 'family_bonds', 'relationship': 'family_bonds',
    'existential': 'existential', 'philosophical': 'existential',
    'crime': 'crime_power', 'power': 'crime_power',
    'sci-fi': 'scifi_concepts', 'futurism': 'scifi_concepts', 'futuristic': 'scifi_concepts',
    'love': 'love_connection', 'adventure': 'adventure', 'survival': 'survival'
  };
  const foundThemes = [];
  for (const [keyword, themeValue] of Object.entries(themeMap)) {
    if (text.includes(keyword) && !foundThemes.includes(themeValue)) {
      foundThemes.push(themeValue);
    }
  }
  if (foundThemes.length > 0 && !attributes.theme) {
    attributes.theme = foundThemes.map(t => ({
      value: t, kgKey: 'theme', kgType: 'identity', attribute: 'themes'
    }));
  }
}

/**
 * Count the number of attribute dimensions extracted.
 * Used for confidence scaling — more attributes = more confident scoring.
 */
export function attributeCount(attributes) {
  return Object.keys(attributes).length;
}
