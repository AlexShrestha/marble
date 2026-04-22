/**
 * llm-provider.js — Configurable LLM client for Marble
 *
 * Reads LLM_PROVIDER env var (default: anthropic) and returns a client
 * with a standard messages.create() interface compatible with swarm.js.
 *
 * Supported providers:
 *   anthropic          — Anthropic SDK, claude-opus-4-6 / claude-sonnet-4-6
 *   openai             — OpenAI SDK, gpt-4o / gpt-4o-mini
 *   deepseek           — OpenAI SDK with DeepSeek base URL (API-compatible)
 *   openai-compatible  — Any OpenAI-compatible host (Moonshot/Kimi, Together,
 *                        Fireworks, Groq, OpenRouter, Azure OpenAI, vLLM, etc.)
 *
 * Environment variables:
 *   LLM_PROVIDER            — "anthropic" | "openai" | "deepseek" | "openai-compatible"
 *   ANTHROPIC_API_KEY       — required for anthropic
 *   OPENAI_API_KEY          — required for openai
 *   DEEPSEEK_API_KEY        — required for deepseek
 *   DEEPSEEK_BASE_URL       — optional; defaults to https://api.deepseek.com
 *   DEEPSEEK_IS_OLLAMA      — set to "1" to route DEEPSEEK_BASE_URL through
 *                             the Ollama-native chat endpoint (/api/chat + x-api-key)
 *                             instead of the OpenAI-compatible one
 *   LLM_BASE_URL            — required for openai-compatible
 *   LLM_API_KEY             — required for openai-compatible (falls back to OPENAI_API_KEY)
 *   MARBLE_LLM_MODEL        — optional override for the model used (provider-appropriate default used if not set)
 */

const PROVIDER_DEFAULTS = {
  anthropic:           { heavy: 'claude-opus-4-6',        fast: 'claude-sonnet-4-6' },
  openai:              { heavy: 'gpt-4o',                  fast: 'gpt-4o-mini' },
  deepseek:            { heavy: 'deepseek-chat',           fast: 'deepseek-chat' },
  // openai-compatible has no sensible default — callers MUST set MARBLE_LLM_MODEL
  'openai-compatible': { heavy: null,                      fast: null },
};

// Read lazily at call time — module is imported before dotenv runs in ESM
const getDeepSeekBaseURL = () => process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';

// ─── RETRY HELPERS ─────────────────────────────────────────────────────────

const RETRYABLE_HTTP_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const DEFAULT_RETRY_DELAYS_MS = [250, 1000, 4000];  // 3 retries, exponential-ish

/**
 * Compute a retry delay honoring a Retry-After header (either seconds or an
 * HTTP-date), falling back to the per-attempt default.
 */
function _retryAfterMs(headerValue, fallbackMs) {
  if (!headerValue) return fallbackMs;
  const asInt = parseInt(headerValue, 10);
  if (!Number.isNaN(asInt)) return Math.max(asInt * 1000, fallbackMs);
  const asDate = Date.parse(headerValue);
  if (!Number.isNaN(asDate)) return Math.max(asDate - Date.now(), fallbackMs);
  return fallbackMs;
}

/**
 * Wrap a fetch-returning function so it retries on transient failures with
 * exponential backoff. Honors Retry-After headers (seconds or HTTP-date).
 *
 * Retries on: network errors, 408, 409, 425, 429, 500, 502, 503, 504.
 * Does NOT retry on: 400, 401, 403, 404, 422, etc. (client errors).
 */
export async function _fetchWithRetry(fetchFn, { retries = DEFAULT_RETRY_DELAYS_MS, label = 'fetch' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries.length; attempt++) {
    try {
      const res = await fetchFn();
      if (!res.ok && RETRYABLE_HTTP_STATUS.has(res.status) && attempt < retries.length) {
        const wait = _retryAfterMs(res.headers.get?.('retry-after'), retries[attempt]);
        console.warn(`[${label}] ${res.status} — retrying in ${wait}ms (attempt ${attempt + 1}/${retries.length})`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries.length) {
        const wait = retries[attempt];
        console.warn(`[${label}] network error (${err.message}) — retrying in ${wait}ms (attempt ${attempt + 1}/${retries.length})`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error(`[${label}] exhausted retries`);
}

/**
 * Build a unified LLM client from env config.
 *
 * The returned client exposes a single method:
 *   client.messages.create({ model, max_tokens, messages }) → standard response
 *
 * For Anthropic: native SDK, native response format.
 * For OpenAI/DeepSeek/openai-compatible: OpenAI SDK wrapped to match Anthropic response shape.
 *
 * @param {Object} [opts]
 * @param {string} [opts.provider]  - Override LLM_PROVIDER env var
 * @param {string} [opts.apiKey]    - Override API key env var
 * @param {string} [opts.baseURL]   - Override base URL (for openai-compatible)
 * @returns {{ messages: { create: Function }, provider: string, defaultModel: Function }}
 */
export function createLLMClient(opts = {}) {
  const provider = opts.provider || process.env.LLM_PROVIDER || 'anthropic';

  if (provider === 'anthropic') {
    return _buildAnthropicClient(opts);
  } else if (provider === 'openai') {
    return _buildOpenAIClient(opts);
  } else if (provider === 'deepseek') {
    return _buildDeepSeekClient(opts);
  } else if (provider === 'openai-compatible') {
    return _buildOpenAICompatibleClient(opts);
  } else {
    console.warn(`[llm-provider] Unknown provider "${provider}", falling back to anthropic`);
    return _buildAnthropicClient(opts);
  }
}

/**
 * Wrap a user-supplied `async (prompt: string) => string` function into an
 * Anthropic-shape client that exposes `messages.create({ model, max_tokens, messages })`.
 *
 * This lets callers that expect the internal client shape (kg.seedClones,
 * runInsightSwarm, InferenceEngine, etc.) use a raw user LLM function
 * without each call site needing its own adapter.
 *
 * Multi-message arrays are flattened into a single text prompt; callers that
 * need structured turn-taking with a non-Anthropic provider should build
 * their own client rather than pass a raw function.
 *
 * @param {Function} userFn - async (prompt: string) => string
 * @param {Object} [opts]
 * @param {string} [opts.provider='custom'] - Provider label for diagnostics
 * @param {string} [opts.model='user-supplied'] - Model label returned by defaultModel()
 * @returns {{ messages: { create: Function }, provider: string, defaultModel: Function }}
 */
export function wrapUserLLM(userFn, { provider = 'custom', model = 'user-supplied' } = {}) {
  if (typeof userFn !== 'function') {
    throw new TypeError('[llm-provider] wrapUserLLM requires an async (prompt) => string function');
  }
  return {
    provider,
    defaultModel: () => model,
    messages: {
      async create({ messages } = {}) {
        const prompt = (messages || [])
          .map(m => m.role === 'user' ? m.content : `[${m.role}]: ${m.content}`)
          .join('\n\n');
        const text = await userFn(prompt);
        return { content: [{ type: 'text', text: String(text ?? '') }] };
      },
    },
  };
}

/**
 * Get the default model name for a given tier and provider.
 * @param {'heavy'|'fast'} tier
 * @param {string} [provider]
 */
export function defaultModel(tier = 'heavy', provider = null) {
  if (process.env.MARBLE_LLM_MODEL) return process.env.MARBLE_LLM_MODEL;
  const p = provider || process.env.LLM_PROVIDER || 'anthropic';
  const fromProvider = PROVIDER_DEFAULTS[p]?.[tier];
  if (fromProvider) return fromProvider;
  // openai-compatible has no default — caller must set MARBLE_LLM_MODEL
  if (p === 'openai-compatible') {
    throw new Error(
      '[llm-provider] openai-compatible provider requires MARBLE_LLM_MODEL ' +
      'to be set (no sensible default — depends on the remote host).'
    );
  }
  return PROVIDER_DEFAULTS.anthropic[tier];
}

// ─── ANTHROPIC ─────────────────────────────────────────────────────────────

function _buildAnthropicClient(opts) {
  const { default: Anthropic } = await_import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: opts.apiKey || process.env.ANTHROPIC_API_KEY });
  client.provider = 'anthropic';
  client.defaultModel = (tier) => defaultModel(tier, 'anthropic');
  return client;
}

// ─── OPENAI / DEEPSEEK / OPENAI-COMPATIBLE ─────────────────────────────────

function _buildOpenAIClient(opts) {
  return _buildOpenAICompatClient('openai', {
    apiKey: opts.apiKey || process.env.OPENAI_API_KEY,
  });
}

function _buildDeepSeekClient(opts) {
  const apiKey = opts.apiKey || process.env.DEEPSEEK_API_KEY;
  const baseURL = opts.baseURL || getDeepSeekBaseURL();

  // Ollama detection is now EXPLICIT: either the user sets DEEPSEEK_IS_OLLAMA=1,
  // or the base URL path looks like Ollama's native chat endpoint (/api, no /v1).
  // The old "anything not api.deepseek.com is Ollama" heuristic hijacked every
  // OpenAI-compatible endpoint that users tried to route through DEEPSEEK_BASE_URL.
  const explicitOllamaFlag = process.env.DEEPSEEK_IS_OLLAMA === '1';
  const ollamaPathShape = /\/api(\/|$)/.test(baseURL || '') && !/\/v1(\/|$)/.test(baseURL || '');
  const isOllama = explicitOllamaFlag || ollamaPathShape;

  if (isOllama) {
    // Self-hosted Ollama: uses x-api-key header, bypass OpenAI SDK to avoid auth conflicts.
    // If you need to accept self-signed TLS certs, set NODE_TLS_REJECT_UNAUTHORIZED=0
    // in your environment explicitly — Marble will NOT disable TLS verification for you.
    const ollamaBase = baseURL.replace(/\/v1\/?$/, '').replace(/^http:\/\//, 'https://');
    return {
      provider: 'deepseek',
      defaultModel: (tier) => defaultModel(tier, 'deepseek'),
      messages: {
        async create({ model, max_tokens, messages }) {
          const body = { model, stream: false, messages };
          if (max_tokens) body.options = { num_predict: max_tokens };
          const resp = await _fetchWithRetry(
            () => fetch(`${ollamaBase}/api/chat`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
              body: JSON.stringify(body),
            }),
            { label: 'ollama' },
          );
          if (!resp.ok) throw new Error(`Ollama ${resp.status}: ${await resp.text()}`);
          const data = await resp.json();
          const text = data.message?.content || data.choices?.[0]?.message?.content || '';
          return { content: [{ type: 'text', text }] };
        },
      },
    };
  }

  return _buildOpenAICompatClient('deepseek', { apiKey, baseURL });
}

function _buildOpenAICompatibleClient(opts) {
  const apiKey =
    opts.apiKey ||
    process.env.LLM_API_KEY ||
    process.env.OPENAI_API_KEY; // last-resort fallback

  const baseURL = opts.baseURL || process.env.LLM_BASE_URL;

  if (!baseURL) {
    throw new Error(
      '[llm-provider] LLM_PROVIDER=openai-compatible requires LLM_BASE_URL to be set ' +
      '(e.g. https://api.moonshot.cn/v1). Also set LLM_API_KEY and MARBLE_LLM_MODEL.'
    );
  }
  if (!apiKey) {
    throw new Error(
      '[llm-provider] LLM_PROVIDER=openai-compatible requires LLM_API_KEY (or OPENAI_API_KEY) to be set.'
    );
  }

  return _buildOpenAICompatClient('openai-compatible', { apiKey, baseURL });
}

function _buildOpenAICompatClient(providerName, { defaultHeaders, ...clientOpts }) {
  const OpenAI = _requireOpenAI();

  const openai = new OpenAI({ ...clientOpts, ...(defaultHeaders && { defaultHeaders }) });

  // Wrap in Anthropic-compatible interface so swarm.js works unchanged.
  // Retry transient failures — the OpenAI SDK has its own internal retry for
  // some errors but not all (429 with short Retry-After, 5xx on streaming, etc.),
  // and this wrapper makes the behavior uniform across providers.
  return {
    provider: providerName,
    defaultModel: (tier) => defaultModel(tier, providerName),
    messages: {
      async create({ model, max_tokens, messages }) {
        let lastErr;
        const delays = DEFAULT_RETRY_DELAYS_MS;
        for (let attempt = 0; attempt <= delays.length; attempt++) {
          try {
            const response = await openai.chat.completions.create({ model, max_tokens, messages });
            const text = response.choices[0]?.message?.content || '';
            return {
              content: [{ type: 'text', text }],
              usage: response.usage,
              model: response.model,
            };
          } catch (err) {
            lastErr = err;
            const status = err?.status || err?.response?.status;
            const retryable = status && RETRYABLE_HTTP_STATUS.has(status);
            if (!retryable || attempt >= delays.length) throw err;
            const retryAfterHdr =
              err?.headers?.['retry-after'] ||
              err?.response?.headers?.get?.('retry-after');
            const wait = _retryAfterMs(retryAfterHdr, delays[attempt]);
            console.warn(
              `[llm-provider:${providerName}] ${status} — retrying in ${wait}ms ` +
              `(attempt ${attempt + 1}/${delays.length})`,
            );
            await new Promise(r => setTimeout(r, wait));
          }
        }
        throw lastErr;
      },
    },
  };
}

// ─── DYNAMIC IMPORTS ───────────────────────────────────────────────────────

// Sync require shim — dynamic import not usable inside non-async factory.
// We use createRequire so the module can be used in ESM without top-level await.
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);

function _requireOpenAI() {
  try {
    return _require('openai');
  } catch {
    throw new Error(
      '[llm-provider] "openai" package not installed. Run: npm install openai'
    );
  }
}

// Anthropic sync import helper (already a dependency, should always resolve)
function await_import(pkg) {
  try {
    return _require(pkg);
  } catch {
    throw new Error(`[llm-provider] "${pkg}" not found. Run: npm install ${pkg}`);
  }
}
