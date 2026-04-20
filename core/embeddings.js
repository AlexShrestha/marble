/**
 * Embeddings for Marble
 *
 * Provides semantic embeddings via API providers.
 * Supported providers: openai (default), deepseek, none
 *
 * Requires OPENAI_API_KEY (or DEEPSEEK_API_KEY for deepseek provider).
 * Set EMBEDDINGS_PROVIDER=none to explicitly opt into keyword-only scoring.
 * If the provider cannot be initialised (missing key) or an API call fails at
 * runtime, a NullEmbeddings fallback is used (with a one-time prominent
 * warning) so callers fall through to their keyword/topic-based fallback paths.
 */

// ─── RETRY HELPERS ─────────────────────────────────────────────────────────

const RETRYABLE_HTTP_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const DEFAULT_RETRY_DELAYS_MS = [250, 1000, 4000];

function _retryAfterMs(headerValue, fallbackMs) {
  if (!headerValue) return fallbackMs;
  const asInt = parseInt(headerValue, 10);
  if (!Number.isNaN(asInt)) return Math.max(asInt * 1000, fallbackMs);
  const asDate = Date.parse(headerValue);
  if (!Number.isNaN(asDate)) return Math.max(asDate - Date.now(), fallbackMs);
  return fallbackMs;
}

/**
 * Retry wrapper around fetch for embedding calls. Retries on transient HTTP
 * statuses (429, 5xx) and network errors with exponential backoff, honoring
 * Retry-After headers. Does NOT retry on 4xx client errors (401, 403, etc).
 */
async function _fetchWithRetry(fetchFn, label = 'embeddings') {
  let lastErr;
  const delays = DEFAULT_RETRY_DELAYS_MS;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const res = await fetchFn();
      if (!res.ok && RETRYABLE_HTTP_STATUS.has(res.status) && attempt < delays.length) {
        const retryAfter = res.headers.get?.('retry-after');
        const wait = _retryAfterMs(retryAfter, delays[attempt]);
        console.warn(`[${label}] ${res.status} — retrying in ${wait}ms (attempt ${attempt + 1}/${delays.length})`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < delays.length) {
        const wait = delays[attempt];
        console.warn(`[${label}] network error (${err.message}) — retrying in ${wait}ms (attempt ${attempt + 1}/${delays.length})`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error(`[${label}] exhausted retries`);
}

/**
 * OpenAI Embeddings provider
 *
 * Uses OpenAI's text-embedding API (text-embedding-3-small by default).
 * Requires OPENAI_API_KEY (or OPENAI_EMBEDDINGS_API_KEY for split-provider setups).
 *
 * Env-var resolution (most-specific wins):
 *   apiKey:   OPENAI_EMBEDDINGS_API_KEY → OPENAI_API_KEY
 *   baseUrl:  OPENAI_EMBEDDINGS_BASE_URL → 'https://api.openai.com/v1'
 *   model:    OPENAI_EMBEDDINGS_MODEL → OPENAI_EMBEDDING_MODEL → 'text-embedding-3-small'
 *
 * Dedicated OPENAI_EMBEDDINGS_* vars let callers point embeddings at one host
 * while chat is routed through a different OpenAI-compatible host via
 * LLM_PROVIDER=openai-compatible + LLM_BASE_URL.
 *
 * Output dimensions: 1536 (text-embedding-3-small) or 3072 (text-embedding-3-large)
 */
class OpenAIEmbeddings {
  constructor(options = {}) {
    this.apiKey = (options.apiKey !== undefined && options.apiKey !== null)
      ? options.apiKey
      : (process.env.OPENAI_EMBEDDINGS_API_KEY || process.env.OPENAI_API_KEY);
    this.model = options.model
      || process.env.OPENAI_EMBEDDINGS_MODEL
      || process.env.OPENAI_EMBEDDING_MODEL
      || 'text-embedding-3-small';
    this.baseUrl = options.baseUrl
      || process.env.OPENAI_EMBEDDINGS_BASE_URL
      || 'https://api.openai.com/v1';

    if (!this.apiKey) {
      throw new Error(
        'OpenAI embeddings require OPENAI_API_KEY (or OPENAI_EMBEDDINGS_API_KEY). ' +
        'Set it in your environment or pass apiKey to the constructor.'
      );
    }
  }

  async embed(text) {
    if (!text || typeof text !== 'string') return new Float32Array(1536);

    const cleanText = text.trim().slice(0, 8191);

    const response = await _fetchWithRetry(
      () => fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({ model: this.model, input: cleanText })
      }),
      'embeddings',
    );

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

  normalizeVector(vector) {
    let norm = 0;
    for (let i = 0; i < vector.length; i++) norm += vector[i] * vector[i];
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < vector.length; i++) vector[i] /= norm;
    }
  }
}

/**
 * DeepSeek Embeddings provider
 *
 * Uses DeepSeek's embeddings API, which is OpenAI-compatible.
 * Requires DEEPSEEK_API_KEY environment variable.
 *
 * Model: deepseek-embedding (1536 dimensions)
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
 * NullEmbeddings — zero-capability fallback used when no API key is available
 * or when the real provider fails.  All methods return "no match" so callers
 * fall through to their topic/keyword-based fallback paths automatically.
 */
class NullEmbeddings {
  async embed(_text) { return new Float32Array(0); }
  async embedBatch(texts) { return texts.map(() => new Float32Array(0)); }
  cosineSimilarity(_a, _b) { return 0; }
  async findMostSimilar(_query, _candidates, _threshold) {
    return { text: null, similarity: -1, index: -1 };
  }
}

/**
 * Factory: create an embeddings provider based on EMBEDDINGS_PROVIDER env var
 * or the provider option.
 *
 * Supported providers:
 *   openai    — (default) OpenAI text-embedding-3-small, requires OPENAI_API_KEY, 1536 dimensions
 *   deepseek  — DeepSeek embeddings API, requires DEEPSEEK_API_KEY, 1536 dimensions
 *
 * If the provider cannot be initialised (e.g. missing API key) a NullEmbeddings
 * instance is returned so the rest of the system degrades gracefully.
 *
 * @param {Object} options - Options passed to the provider constructor
 * @returns {OpenAIEmbeddings|DeepSeekEmbeddings|NullEmbeddings}
 */
function createEmbeddingsProvider(options = {}) {
  const provider = (options.provider || process.env.EMBEDDINGS_PROVIDER || 'openai').toLowerCase();

  switch (provider) {
    case 'openai':
      return new OpenAIEmbeddings(options);

    case 'deepseek':
      return new DeepSeekEmbeddings(options);

    case 'none':
      // Explicit opt-in to keyword-only scoring. No semantic matching.
      return new NullEmbeddings();

    case 'anthropic':
      throw new Error(
        'Anthropic does not offer an embeddings API. ' +
        'Use EMBEDDINGS_PROVIDER=openai or EMBEDDINGS_PROVIDER=deepseek instead.'
      );

    case 'local':
      throw new Error(
        'Local ONNX embeddings have been removed from Marble. ' +
        'Set OPENAI_API_KEY and use EMBEDDINGS_PROVIDER=openai (default), ' +
        'or use EMBEDDINGS_PROVIDER=none for explicit keyword-only scoring.'
      );

    default:
      throw new Error(
        `Unknown EMBEDDINGS_PROVIDER "${provider}". ` +
        `Supported: "openai", "deepseek", "none".`
      );
  }
}

// Export singleton instance (respects EMBEDDINGS_PROVIDER env var).
// If the provider cannot be initialised (e.g. missing API key) we fall back to
// NullEmbeddings so the module loads cleanly, but emit a prominent one-time
// warning so integrators don't silently lose semantic scoring on the happy path.
// Callers who want to suppress this should either:
//   (a) set EMBEDDINGS_PROVIDER=none to explicitly opt into keyword-only, or
//   (b) pass their own provider to `new Marble({ embeddings: ... })`.
export const embeddings = (() => {
  try {
    return createEmbeddingsProvider();
  } catch (err) {
    const requestedNone = (process.env.EMBEDDINGS_PROVIDER || '').toLowerCase() === 'none';
    if (!requestedNone) {
      const banner =
        '\n' +
        '┌─ Marble embeddings ─────────────────────────────────────────┐\n' +
        '│  Provider init failed — falling back to NullEmbeddings.     │\n' +
        '│  Semantic scoring is DISABLED; scorer uses keyword only.    │\n' +
        '│  Fix: set OPENAI_API_KEY (or DEEPSEEK_API_KEY) and a valid  │\n' +
        '│       EMBEDDINGS_PROVIDER, or pass { embeddings: ... } to   │\n' +
        '│       the Marble constructor. To silence this warning,      │\n' +
        '│       set EMBEDDINGS_PROVIDER=none explicitly.              │\n' +
        `│  Reason: ${err.message.slice(0, 50).padEnd(50)} │\n` +
        '└─────────────────────────────────────────────────────────────┘';
      console.warn(banner);
    }
    return new NullEmbeddings();
  }
})();

export { OpenAIEmbeddings, DeepSeekEmbeddings, NullEmbeddings, createEmbeddingsProvider };
