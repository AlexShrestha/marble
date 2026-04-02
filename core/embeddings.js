/**
 * Local ONNX Embeddings for Marble
 *
 * Provides semantic embeddings using local ONNX models for privacy and speed.
 * Based on sentence-transformers/all-MiniLM-L6-v2 architecture.
 */

import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class LocalEmbeddings {
  constructor(options = {}) {
    this.session = null;
    this.tokenizer = null;
    this.maxLength = 512; // MiniLM max sequence length
    this.initialized = false;
    this.initPromise = null;

    // Performance optimization options
    this.options = {
      lazyLoad: options.lazyLoad ?? true,
      lightweightMode: options.lightweightMode ?? false,
      enableCaching: options.enableCaching ?? true,
      maxCacheSize: options.maxCacheSize ?? 1000,
      ...options
    };

    // Cache for embeddings
    this.cache = this.options.enableCaching ? new Map() : null;
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }

  async initialize() {
    // Prevent multiple initialization calls
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this._doInitialize();
    return this.initPromise;
  }

  async _doInitialize() {
    if (this.initialized) return;

    // If lightweight mode is enabled, skip ONNX model loading
    if (this.options.lightweightMode) {
      console.log('⚡ Lightweight mode enabled - using simple tokenizer only');
      this.tokenizer = new SimpleTokenizer();
      this.initialized = true;
      return;
    }

    try {
      const startTime = performance.now();

      // Try to dynamically import ONNX runtime
      const ort = await import('onnxruntime-node');

      // Load the actual MiniLM ONNX model
      const modelPath = path.join(__dirname, '..', 'models', 'all-MiniLM-L6-v2.onnx');
      this.session = await ort.InferenceSession.create(modelPath);

      // Load tokenizer files
      const tokenizerPath = path.join(__dirname, '..', 'models', 'tokenizer.json');
      const tokenizerData = JSON.parse(await readFile(tokenizerPath, 'utf8'));

      const vocabPath = path.join(__dirname, '..', 'models', 'vocab.txt');
      const vocabData = await readFile(vocabPath, 'utf8');

      this.tokenizer = new ONNXTokenizer(tokenizerData, vocabData);

      const loadTime = Math.round(performance.now() - startTime);
      console.log(`✓ ONNX embeddings initialized in ${loadTime}ms`);
      this.initialized = true;
    } catch (error) {
      console.warn('Failed to load ONNX model, using fallback embeddings:', error.message);
      this.tokenizer = new SimpleTokenizer();
      this.initialized = true;
    }
  }

  /**
   * Generate embedding for a text string
   * @param {string} text - Text to embed
   * @returns {Float32Array} - 384-dimensional embedding vector
   */
  async embed(text) {
    // Validation and safety checks
    if (!text || typeof text !== 'string') {
      console.warn('Invalid input to embed():', typeof text);
      return this._createEmptyEmbedding();
    }

    // Lazy initialization with timeout protection
    try {
      if (!this.initialized && this.options.lazyLoad) {
        const initTimeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Initialization timeout')), 5000)
        );
        await Promise.race([this.initialize(), initTimeout]);
      } else if (!this.tokenizer) {
        await this.initialize();
      }
    } catch (error) {
      console.warn('Embedding initialization failed, using keyword fallback:', error.message);
      return this._keywordFallback(text);
    }

    // Clean and truncate text
    const cleanText = text.toLowerCase().trim().slice(0, this.maxLength);
    if (!cleanText) {
      return this._createEmptyEmbedding();
    }

    // Check cache first
    if (this.cache && this.cache.has(cleanText)) {
      this.cacheHits++;
      return this.cache.get(cleanText);
    }
    this.cacheMisses++;

    const startTime = performance.now();
    let embedding;

    // Multi-layer error boundaries for ONNX inference
    if (this.session && this.tokenizer instanceof ONNXTokenizer) {
      try {
        // Attempt ONNX inference with circuit breaker pattern
        embedding = await this._tryONNXInference(cleanText);

        if (!embedding) {
          throw new Error('ONNX inference returned null');
        }
      } catch (onnxError) {
        console.warn('ONNX inference failed, trying simple tokenizer fallback:', onnxError.message);

        try {
          // Try simple tokenizer first
          embedding = this.tokenizer.encode(cleanText);
        } catch (tokenizerError) {
          console.warn('Tokenizer fallback failed, using keyword matching:', tokenizerError.message);
          // Final fallback to keyword matching
          embedding = this._keywordFallback(cleanText);
        }
      }
    } else if (this.tokenizer) {
      try {
        // Use simple tokenizer with error boundary
        embedding = this.tokenizer.encode(cleanText);
      } catch (tokenizerError) {
        console.warn('Tokenizer failed, using keyword fallback:', tokenizerError.message);
        embedding = this._keywordFallback(cleanText);
      }
    } else {
      // Direct keyword fallback if no tokenizer available
      embedding = this._keywordFallback(cleanText);
    }

    // Validate embedding result
    if (!embedding || !embedding.length) {
      console.warn('Generated embedding is empty, using keyword fallback');
      embedding = this._keywordFallback(cleanText);
    }

    // Cache the result
    if (this.cache && embedding) {
      this._addToCache(cleanText, embedding);
    }

    // Log slow operations in development
    const duration = performance.now() - startTime;
    if (duration > 100) {
      console.warn(`Slow embedding computation: ${duration.toFixed(1)}ms for "${cleanText.slice(0, 50)}..."`);
    }

    return embedding;
  }

  /**
   * Attempt ONNX inference with timeout protection
   * @private
   */
  async _tryONNXInference(cleanText) {
    const ort = await import('onnxruntime-node');
    const tokens = this.tokenizer.tokenize(cleanText);

    // Timeout protection for inference
    const inferenceTimeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('ONNX inference timeout')), 3000)
    );

    const inference = (async () => {
      const inputTensor = new ort.Tensor('int64', BigInt64Array.from(tokens.map(t => BigInt(t))), [1, tokens.length]);
      const attentionMask = new ort.Tensor('int64', BigInt64Array.from(tokens.map(() => BigInt(1))), [1, tokens.length]);

      const feeds = {
        input_ids: inputTensor,
        attention_mask: attentionMask
      };

      const results = await this.session.run(feeds);
      const embeddings = results.last_hidden_state.data;

      // Mean pooling (average across sequence length)
      const sequenceLength = tokens.length;
      const hiddenSize = 384;
      const pooled = new Float32Array(hiddenSize);

      for (let i = 0; i < hiddenSize; i++) {
        let sum = 0;
        for (let j = 0; j < sequenceLength; j++) {
          sum += embeddings[j * hiddenSize + i];
        }
        pooled[i] = sum / sequenceLength;
      }

      // Normalize the embedding
      this.normalizeVector(pooled);
      return pooled;
    })();

    return await Promise.race([inference, inferenceTimeout]);
  }

  /**
   * Keyword-based fallback when all embedding methods fail
   * @private
   */
  _keywordFallback(text) {
    const embedding = new Float32Array(384);

    // Enhanced keyword patterns for better semantic matching
    const keywordPatterns = {
      // Tech/AI
      tech: /\b(ai|artificial|intelligence|machine|learning|algorithm|neural|deep|model|data|analytics|automation|robot|digital|cyber|tech|innovation|software|programming|code|api|framework|cloud|saas)\b/gi,

      // Business
      business: /\b(business|company|market|revenue|profit|startup|enterprise|commerce|sales|customer|client|growth|strategy|partnership|investment|funding|capital|finance|economic)\b/gi,

      // Product
      product: /\b(product|feature|launch|release|update|version|platform|service|app|application|tool|solution|interface|user|experience|design|workflow)\b/gi,

      // Compliance/Legal
      compliance: /\b(compliance|regulation|legal|privacy|gdpr|security|audit|policy|rules|law|requirement|standard|certificate|risk|governance)\b/gi,

      // Performance
      performance: /\b(performance|speed|fast|slow|optimize|efficiency|scale|load|latency|throughput|benchmark|metric|monitoring|alert)\b/gi,

      // Sentiment
      positive: /\b(great|excellent|good|amazing|success|win|achieve|improve|better|best|love|like|happy|pleased|satisfied)\b/gi,
      negative: /\b(bad|terrible|fail|problem|issue|bug|error|wrong|slow|broken|hate|dislike|angry|frustrated|disappointed)\b/gi
    };

    let totalMatches = 0;

    // Score based on keyword pattern matches
    for (const [category, pattern] of Object.entries(keywordPatterns)) {
      const matches = (text.match(pattern) || []).length;
      if (matches > 0) {
        const categoryHash = this._hashString(category) % 384;
        const intensity = Math.min(matches / 5.0, 1.0); // Normalize to max 1.0

        // Spread influence across nearby dimensions
        for (let i = 0; i < 5; i++) {
          const index = (categoryHash + i) % 384;
          embedding[index] += intensity * (1.0 - i * 0.1);
        }

        totalMatches += matches;
      }
    }

    // Add text length and word diversity signals
    const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const uniqueWords = new Set(words);
    const diversity = uniqueWords.size / Math.max(words.length, 1);

    // Encode text properties into specific dimensions
    embedding[0] = Math.log(words.length + 1) / 10; // Length signal
    embedding[1] = diversity; // Diversity signal
    embedding[2] = Math.log(totalMatches + 1) / 10; // Keyword density

    // Add word-specific features for unknown content
    words.slice(0, 50).forEach((word, i) => {
      if (word.length > 3) {
        const hash = this._hashString(word) % 380 + 4; // Skip first 4 reserved dimensions
        embedding[hash] += 0.1;
      }
    });

    // Normalize the vector
    this.normalizeVector(embedding);
    return embedding;
  }

  /**
   * Create an empty embedding for invalid inputs
   * @private
   */
  _createEmptyEmbedding() {
    const embedding = new Float32Array(384);
    embedding[0] = 0.01; // Minimal signal to distinguish from null
    return embedding;
  }

  /**
   * Simple string hash function for consistent keyword mapping
   * @private
   */
  _hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }

  /**
   * Generate embeddings for multiple texts in batch
   * @param {string[]} texts - Array of texts to embed
   * @returns {Float32Array[]} - Array of embedding vectors
   */
  async embedBatch(texts) {
    return Promise.all(texts.map(text => this.embed(text)));
  }

  /**
   * Calculate cosine similarity between two embeddings
   * @param {Float32Array} a - First embedding
   * @param {Float32Array} b - Second embedding
   * @returns {number} - Similarity score between -1 and 1
   */
  cosineSimilarity(a, b) {
    if (a.length !== b.length) {
      throw new Error('Embeddings must have same dimensions');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);

    if (normA === 0 || normB === 0) return 0;

    return dotProduct / (normA * normB);
  }

  /**
   * Find the most similar text from a list
   * @param {string} query - Query text
   * @param {string[]} candidates - Candidate texts
   * @param {number} threshold - Minimum similarity threshold
   * @returns {Object} - {text, similarity, index}
   */
  async findMostSimilar(query, candidates, threshold = 0.3) {
    const queryEmbedding = await this.embed(query);
    const candidateEmbeddings = await this.embedBatch(candidates);

    let bestMatch = { text: null, similarity: -1, index: -1 };

    for (let i = 0; i < candidateEmbeddings.length; i++) {
      const similarity = this.cosineSimilarity(queryEmbedding, candidateEmbeddings[i]);
      if (similarity > bestMatch.similarity && similarity >= threshold) {
        bestMatch = { text: candidates[i], similarity, index: i };
      }
    }

    return bestMatch;
  }

  /**
   * Normalize a vector to unit length
   * @param {Float32Array} vector - Vector to normalize
   */
  normalizeVector(vector) {
    let norm = 0;
    for (let i = 0; i < vector.length; i++) {
      norm += vector[i] * vector[i];
    }
    norm = Math.sqrt(norm);

    if (norm > 0) {
      for (let i = 0; i < vector.length; i++) {
        vector[i] /= norm;
      }
    }
  }

  /**
   * Add embedding to cache with LRU eviction
   * @param {string} text - Input text
   * @param {Float32Array} embedding - Computed embedding
   */
  _addToCache(text, embedding) {
    if (!this.cache) return;

    // If cache is full, remove oldest entry (LRU)
    if (this.cache.size >= this.options.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    this.cache.set(text, embedding);
  }

  /**
   * Get cache performance statistics
   * @returns {Object} Cache stats
   */
  getCacheStats() {
    const total = this.cacheHits + this.cacheMisses;
    return {
      size: this.cache ? this.cache.size : 0,
      hits: this.cacheHits,
      misses: this.cacheMisses,
      hitRate: total > 0 ? (this.cacheHits / total * 100).toFixed(1) + '%' : '0%',
      enabled: !!this.cache
    };
  }

  /**
   * Clear embedding cache
   */
  clearCache() {
    if (this.cache) {
      this.cache.clear();
      this.cacheHits = 0;
      this.cacheMisses = 0;
    }
  }

  /**
   * Get current performance mode
   * @returns {string} Current mode
   */
  getPerformanceMode() {
    if (this.options.lightweightMode) return 'lightweight';
    if (this.session) return 'full-onnx';
    return 'fallback';
  }

  /**
   * Switch to lightweight mode for low-power devices
   */
  enableLightweightMode() {
    console.log('⚡ Switching to lightweight mode');
    this.options.lightweightMode = true;
    this.session = null; // Release ONNX session
    this.tokenizer = new SimpleTokenizer();
  }

  /**
   * Warm up the model with a dummy inference to reduce first-call latency
   */
  async warmUp() {
    if (!this.initialized) {
      await this.initialize();
    }

    const startTime = performance.now();
    await this.embed('warmup test');
    const warmUpTime = performance.now() - startTime;
    console.log(`🔥 Model warmed up in ${warmUpTime.toFixed(1)}ms`);
  }
}

/**
 * ONNX-compatible tokenizer for BERT/MiniLM models
 * Handles proper BERT tokenization with special tokens
 */
class ONNXTokenizer {
  constructor(tokenizerConfig, vocabData) {
    this.tokenizerConfig = tokenizerConfig;
    this.vocab = new Map();
    this.reverseVocab = new Map();

    // Parse vocabulary
    const vocabLines = vocabData.trim().split('\n');
    vocabLines.forEach((word, index) => {
      this.vocab.set(word, index);
      this.reverseVocab.set(index, word);
    });

    // Special tokens
    this.clsToken = 101;  // [CLS]
    this.sepToken = 102;  // [SEP]
    this.padToken = 0;    // [PAD]
    this.unkToken = 100;  // [UNK]

    this.maxLength = 512;
  }

  /**
   * Basic wordpiece tokenization
   * @param {string} text - Text to tokenize
   * @returns {number[]} - Token IDs
   */
  tokenize(text) {
    const tokens = [this.clsToken]; // Start with [CLS] token

    // Basic whitespace and punctuation splitting
    const words = text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 0);

    for (const word of words) {
      // Simple word-to-token mapping (basic subword handling)
      const wordTokens = this.encodeWord(word);
      tokens.push(...wordTokens);

      // Check max length (leaving room for [SEP] token)
      if (tokens.length >= this.maxLength - 1) break;
    }

    tokens.push(this.sepToken); // End with [SEP] token

    // Pad to consistent length (optional, for batching)
    while (tokens.length < Math.min(128, this.maxLength)) {
      tokens.push(this.padToken);
    }

    return tokens;
  }

  /**
   * Encode a single word into token IDs
   * @param {string} word - Word to encode
   * @returns {number[]} - Token IDs for the word
   */
  encodeWord(word) {
    // Try exact match first
    if (this.vocab.has(word)) {
      return [this.vocab.get(word)];
    }

    // Basic subword fallback - split into characters if word not found
    const tokens = [];
    for (let i = 0; i < word.length; i++) {
      const char = word[i];
      if (this.vocab.has(char)) {
        tokens.push(this.vocab.get(char));
      } else {
        tokens.push(this.unkToken);
      }

      // Limit subword tokens per word
      if (tokens.length >= 8) break;
    }

    return tokens.length > 0 ? tokens : [this.unkToken];
  }
}

/**
 * Simple fallback tokenizer that creates basic semantic vectors
 * This would be replaced by proper ONNX model tokenization in production
 */
class SimpleTokenizer {
  constructor() {
    // Common semantic keywords for scoring
    this.vocabulary = new Map();
    this.embeddingSize = 384; // MiniLM-L6-v2 embedding dimension
    this.buildVocabulary();
  }

  buildVocabulary() {
    // Build a simple vocabulary with semantic clusters
    const categories = {
      tech: ['technology', 'ai', 'software', 'algorithm', 'data', 'digital', 'cyber', 'tech', 'innovation'],
      business: ['business', 'company', 'market', 'revenue', 'profit', 'startup', 'enterprise', 'commerce'],
      development: ['development', 'programming', 'code', 'coding', 'build', 'deploy', 'api', 'framework'],
      compliance: ['compliance', 'regulation', 'legal', 'privacy', 'gdpr', 'security', 'audit', 'rules'],
      finance: ['finance', 'investment', 'funding', 'money', 'capital', 'financial', 'bank', 'payment'],
      product: ['product', 'feature', 'launch', 'release', 'update', 'version', 'platform', 'service']
    };

    let index = 0;
    for (const [category, words] of Object.entries(categories)) {
      for (const word of words) {
        this.vocabulary.set(word, index++);
      }
    }
  }

  encode(text) {
    const words = text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);

    // Create embedding vector
    const embedding = new Float32Array(this.embeddingSize);

    // Simple bag-of-words with TF-IDF-like weighting
    const wordCounts = new Map();
    for (const word of words) {
      wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
    }

    // Fill embedding dimensions based on word presence and frequency
    for (const [word, count] of wordCounts) {
      const vocabIndex = this.vocabulary.get(word);
      if (vocabIndex !== undefined && vocabIndex < this.embeddingSize) {
        // Use log frequency to avoid dominance by common words
        embedding[vocabIndex] = Math.log(1 + count);
      }

      // Add some randomness for unknown words to create unique signatures
      const hash = this.simpleHash(word) % this.embeddingSize;
      embedding[hash] += 0.1;
    }

    // Normalize the vector
    this.normalize(embedding);
    return embedding;
  }

  normalize(vector) {
    let norm = 0;
    for (let i = 0; i < vector.length; i++) {
      norm += vector[i] * vector[i];
    }
    norm = Math.sqrt(norm);

    if (norm > 0) {
      for (let i = 0; i < vector.length; i++) {
        vector[i] /= norm;
      }
    }
  }

  simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }
}

/**
 * OpenAI Embeddings provider
 *
 * Uses OpenAI's text-embedding API (text-embedding-3-small by default).
 * Requires OPENAI_API_KEY environment variable.
 *
 * Output dimensions: 1536 (text-embedding-3-small) or 3072 (text-embedding-3-large)
 * Note: dimensions differ from local ONNX (384) — do not mix providers
 *       in the same knowledge graph.
 */
class OpenAIEmbeddings {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.OPENAI_API_KEY;
    this.model = options.model || process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
    this.baseUrl = options.baseUrl || 'https://api.openai.com/v1';

    if (!this.apiKey) {
      throw new Error(
        'OpenAI embeddings require OPENAI_API_KEY. ' +
        'Set it in your environment or pass apiKey to the constructor.'
      );
    }
  }

  async embed(text) {
    if (!text || typeof text !== 'string') return new Float32Array(1536);

    const cleanText = text.trim().slice(0, 8191);

    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({ model: this.model, input: cleanText })
    });

    if (!response.ok) {
      throw new Error(`OpenAI embeddings API error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    return new Float32Array(data.data[0].embedding);
  }

  async embedBatch(texts) {
    return Promise.all(texts.map(t => this.embed(t)));
  }

  cosineSimilarity(a, b) {
    if (a.length !== b.length) throw new Error('Embeddings must have same dimensions');
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);
    return normA === 0 || normB === 0 ? 0 : dot / (normA * normB);
  }
}

/**
 * DeepSeek Embeddings provider
 *
 * Uses DeepSeek's embeddings API, which is OpenAI-compatible.
 * Requires DEEPSEEK_API_KEY environment variable.
 *
 * Model: deepseek-embedding (1536 dimensions)
 * Note: dimensions differ from local ONNX (384) — do not mix providers
 *       in the same knowledge graph.
 */
class DeepSeekEmbeddings extends OpenAIEmbeddings {
  constructor(options = {}) {
    super({
      apiKey: options.apiKey || process.env.DEEPSEEK_API_KEY,
      model: options.model || process.env.DEEPSEEK_EMBEDDING_MODEL || 'deepseek-embedding',
      baseUrl: options.baseUrl || 'https://api.deepseek.com/v1',
      ...options
    });

    if (!this.apiKey) {
      throw new Error(
        'DeepSeek embeddings require DEEPSEEK_API_KEY. ' +
        'Set it in your environment or pass apiKey to the constructor.'
      );
    }
  }
}

/**
 * Factory: create an embeddings provider based on EMBEDDINGS_PROVIDER env var
 * or the provider option.
 *
 * Supported providers:
 *   local     — (default) Local ONNX model, no API key needed, 384 dimensions
 *   openai    — OpenAI text-embedding-3-small, requires OPENAI_API_KEY, 1536 dimensions
 *   deepseek  — DeepSeek embeddings API, requires DEEPSEEK_API_KEY, 1536 dimensions
 *   anthropic — NOT SUPPORTED: Anthropic does not provide an embeddings API.
 *               Falls back to local ONNX with a warning.
 *
 * @param {Object} options - Options passed to the provider constructor
 * @returns {LocalEmbeddings|OpenAIEmbeddings|DeepSeekEmbeddings}
 */
function createEmbeddingsProvider(options = {}) {
  const provider = (options.provider || process.env.EMBEDDINGS_PROVIDER || 'local').toLowerCase();

  switch (provider) {
    case 'openai':
      console.log('🔌 Using OpenAI embeddings provider (text-embedding-3-small)');
      return new OpenAIEmbeddings(options);

    case 'deepseek':
      console.log('🔌 Using DeepSeek embeddings provider (deepseek-embedding)');
      return new DeepSeekEmbeddings(options);

    case 'anthropic':
      console.warn(
        '⚠️  Anthropic does not offer an embeddings API. ' +
        'Falling back to local ONNX embeddings (all-MiniLM-L6-v2). ' +
        'Use EMBEDDINGS_PROVIDER=openai or EMBEDDINGS_PROVIDER=deepseek for API-based embeddings.'
      );
      return new LocalEmbeddings(options);

    case 'local':
    default:
      if (provider !== 'local') {
        console.warn(`⚠️  Unknown EMBEDDINGS_PROVIDER "${provider}", falling back to local ONNX.`);
      }
      return new LocalEmbeddings(options);
  }
}

// Export singleton instance (respects EMBEDDINGS_PROVIDER env var)
export const embeddings = createEmbeddingsProvider();

export { LocalEmbeddings, OpenAIEmbeddings, DeepSeekEmbeddings, createEmbeddingsProvider };