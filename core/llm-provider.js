/**
 * llm-provider.js — Configurable LLM client for Marble
 *
 * Reads LLM_PROVIDER env var (default: anthropic) and returns a client
 * with a standard messages.create() interface compatible with swarm.js.
 *
 * Supported providers:
 *   anthropic  — Anthropic SDK, claude-opus-4-6 / claude-sonnet-4-6
 *   openai     — OpenAI SDK, gpt-4o / gpt-4o-mini
 *   deepseek   — OpenAI SDK with DeepSeek base URL (API-compatible)
 *
 * Environment variables:
 *   LLM_PROVIDER            — "anthropic" | "openai" | "deepseek" (default: anthropic)
 *   ANTHROPIC_API_KEY       — required for anthropic
 *   OPENAI_API_KEY          — required for openai
 *   DEEPSEEK_API_KEY        — required for deepseek
 *   MARBLE_LLM_MODEL        — optional override for the model used (provider-appropriate default used if not set)
 */

const PROVIDER_DEFAULTS = {
  anthropic: { heavy: 'claude-opus-4-6',        fast: 'claude-sonnet-4-6' },
  openai:    { heavy: 'gpt-4o',                  fast: 'gpt-4o-mini' },
  deepseek:  { heavy: 'deepseek-chat',           fast: 'deepseek-chat' },
};

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

/**
 * Build a unified LLM client from env config.
 *
 * The returned client exposes a single method:
 *   client.messages.create({ model, max_tokens, messages }) → standard response
 *
 * For Anthropic: native SDK, native response format.
 * For OpenAI/DeepSeek: OpenAI SDK wrapped to match Anthropic response shape.
 *
 * @param {Object} [opts]
 * @param {string} [opts.provider]  - Override LLM_PROVIDER env var
 * @param {string} [opts.apiKey]    - Override API key env var
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
  } else {
    console.warn(`[llm-provider] Unknown provider "${provider}", falling back to anthropic`);
    return _buildAnthropicClient(opts);
  }
}

/**
 * Get the default model name for a given tier and provider.
 * @param {'heavy'|'fast'} tier
 * @param {string} [provider]
 */
export function defaultModel(tier = 'heavy', provider = null) {
  const p = provider || process.env.LLM_PROVIDER || 'anthropic';
  return PROVIDER_DEFAULTS[p]?.[tier] || PROVIDER_DEFAULTS.anthropic[tier];
}

// ─── ANTHROPIC ─────────────────────────────────────────────────────────────

function _buildAnthropicClient(opts) {
  const { default: Anthropic } = await_import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: opts.apiKey || process.env.ANTHROPIC_API_KEY });
  client.provider = 'anthropic';
  client.defaultModel = (tier) => defaultModel(tier, 'anthropic');
  return client;
}

// ─── OPENAI / DEEPSEEK ─────────────────────────────────────────────────────

function _buildOpenAIClient(opts) {
  return _buildOpenAICompatClient('openai', {
    apiKey: opts.apiKey || process.env.OPENAI_API_KEY,
  });
}

function _buildDeepSeekClient(opts) {
  return _buildOpenAICompatClient('deepseek', {
    apiKey: opts.apiKey || process.env.DEEPSEEK_API_KEY,
    baseURL: DEEPSEEK_BASE_URL,
  });
}

function _buildOpenAICompatClient(providerName, clientOpts) {
  const OpenAI = _requireOpenAI();

  const openai = new OpenAI(clientOpts);

  // Wrap in Anthropic-compatible interface so swarm.js works unchanged
  return {
    provider: providerName,
    defaultModel: (tier) => defaultModel(tier, providerName),
    messages: {
      async create({ model, max_tokens, messages }) {
        const response = await openai.chat.completions.create({
          model,
          max_tokens,
          messages,
        });

        // Translate OpenAI response → Anthropic shape
        const text = response.choices[0]?.message?.content || '';
        return {
          content: [{ type: 'text', text }],
          usage: response.usage,
          model: response.model,
        };
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
