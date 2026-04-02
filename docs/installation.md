# Installation & Setup

Get Marble running in under 5 minutes.

## Requirements

- **Node.js 18+** (ES modules support required)
- **npm** (comes with Node.js)
- No API keys needed for core functionality

## Install

### From npm

```bash
npm install marblism
```

### From source

```bash
git clone https://github.com/AlexShrestha/prism.git
cd prism
npm install
```

## Quick Verify

```bash
npm test
```

This runs the full test harness with 30 realistic stories, comparing Score mode vs Swarm mode output.

## Basic Setup

### 1. Create a Marble instance

```javascript
import { Marble } from 'marblism';

const marble = new Marble({
  dataPath: './data/user-kg.json',  // Where to store the knowledge graph
  count: 10,                         // Stories to return per selection
  mode: 'score'                      // 'score' (fast, local) or 'swarm' (richer, optional LLM)
});

await marble.init();
```

### 2. Select content

```javascript
const stories = [
  { id: '1', title: 'AI Funding Hits Record', summary: '...', source: 'techcrunch', topics: ['ai', 'funding'], published_at: new Date().toISOString() },
  { id: '2', title: 'Remote Work Tools Guide', summary: '...', source: 'hackernews', topics: ['remote', 'tools'], published_at: new Date().toISOString() },
  // ... more stories
];

const top10 = await marble.select(stories, {
  interests: ['AI', 'startups'],
  calendar: ['investor call 14:00'],
  projects: ['newsletter platform']
});
```

### 3. Record feedback

```javascript
// Explicit
await marble.react('story-1', 'up', ['ai', 'funding'], 'techcrunch');

// Implicit (dwell time, scroll depth)
await marble.signal('story-2', 'dwell', { duration: 35000 });

// Save state
await marble.save();
```

That's it. Marble is now learning from behavior and will improve rankings over time.

## Modes

### Score Mode (default)

Local-only. Uses ONNX embeddings for semantic matching. Zero API calls, zero cost.

```javascript
const marble = new Marble({ mode: 'score' });
```

Best for: high-volume, low-latency, privacy-first use cases.

### Swarm Mode

Five specialized AI agents evaluate each story through different lenses. Optionally uses an LLM for deeper reasoning.

```javascript
const marble = new Marble({
  mode: 'swarm',
  llm: async (prompt) => {
    // Your LLM provider (Claude, GPT, local model, etc.)
    const res = await fetch('https://api.anthropic.com/v1/messages', { ... });
    return res.text;
  }
});
```

Without an LLM function, swarm mode uses heuristic scoring (no API calls). With one, agents produce natural language reasoning.

### WorldSim Mode

Population-level product-market fit simulation. Requires an LLM for archetype engagement scoring.

```javascript
import { WorldSim } from 'marblism/worldsim';

const worldsim = new WorldSim({ populationSize: 50 });
const pmf = await worldsim.simulate({
  name: 'YourProduct',
  description: 'What it does and who it helps',
  categories: ['technology', 'productivity']
});
```

## Configuration Reference

### Marble Constructor Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dataPath` | string | `'./marble-kg.json'` | Path to store the user's knowledge graph |
| `count` | number | `10` | Number of stories to return from `select()` |
| `mode` | string | `'score'` | `'score'` (v1, local) or `'swarm'` (v2, multi-agent) |
| `llm` | function | `null` | Async function `(prompt) => string` for LLM-enhanced swarm |

### Story Object Format

Stories passed to `select()` must have this shape:

```javascript
{
  id: string,           // Unique identifier
  title: string,        // Headline
  summary: string,      // Description/excerpt (used for embedding similarity)
  source: string,       // Origin (e.g., 'hackernews', 'techcrunch')
  url: string,          // Link (optional)
  topics: string[],     // Tags/categories
  published_at: string  // ISO 8601 timestamp
}
```

### Context Object Format

The optional context passed to `select()`:

```javascript
{
  interests: string[],              // Current interests (supplements KG)
  calendar: string[],               // Today's events
  projects: string[],               // Active projects
  recent_conversations: string[],   // Recent discussion topics
  mood_signal: string,              // Optional mood context
  location: string                  // Optional location
}
```

## Environment Variables

Core Marble needs **no environment variables** in its default local mode. Optional variables:

### Embeddings Provider

By default, Marble uses a local ONNX model (`all-MiniLM-L6-v2`) — no API key, no network calls. To use a cloud embeddings API instead, set `EMBEDDINGS_PROVIDER`:

| Variable | Description |
|----------|-------------|
| `EMBEDDINGS_PROVIDER` | `local` (default), `openai`, or `deepseek` |
| `OPENAI_API_KEY` | Required when `EMBEDDINGS_PROVIDER=openai` |
| `OPENAI_EMBEDDING_MODEL` | Optional. Default: `text-embedding-3-small` |
| `DEEPSEEK_API_KEY` | Required when `EMBEDDINGS_PROVIDER=deepseek` |
| `DEEPSEEK_EMBEDDING_MODEL` | Optional. Default: `deepseek-embedding` |

**Important:** Different providers output different vector dimensions (local=384, OpenAI=1536, DeepSeek=1536). Do **not** mix providers across an existing knowledge graph — delete the KG file and let it rebuild after switching providers.

**Anthropic note:** Anthropic does not provide an embeddings API. Setting `EMBEDDINGS_PROVIDER=anthropic` logs a warning and falls back to local ONNX. Use the `llm` constructor option to plug Anthropic's Claude into Swarm mode instead.

#### Example configurations

```bash
# Local (default) — no API keys needed
EMBEDDINGS_PROVIDER=local

# OpenAI
EMBEDDINGS_PROVIDER=openai
OPENAI_API_KEY=sk-...

# DeepSeek
EMBEDDINGS_PROVIDER=deepseek
DEEPSEEK_API_KEY=sk-...
```

You can also pass the provider directly to the constructor (overrides env vars):

```javascript
import { createEmbeddingsProvider } from 'marblism/core/embeddings.js';

const emb = createEmbeddingsProvider({
  provider: 'openai',
  apiKey: 'sk-...',       // or omit to read OPENAI_API_KEY
  model: 'text-embedding-3-large'
});
```

### Source & delivery adapters

| Variable | Used by | Required? |
|----------|---------|-----------|
| `NEWSAPI_KEY` | NewsAPI source adapter | Only if using NewsAPI |
| `TELEGRAM_TOKEN` | Telegram delivery adapter | Only if delivering via Telegram |
| `TELEGRAM_CHAT_ID` | Telegram delivery adapter | Only if delivering via Telegram |

## Data Storage

Marble stores state in JSON files (no database required):

```
your-app/
├── data/
│   ├── user-kg.json            # User knowledge graph (interests, history, source trust)
│   └── evolution/
│       └── population.json     # Clone population (50 variants, fitness scores)
└── marble-observer.json        # Optional: KPI tracking
```

Files are created automatically on first `save()`. You can point multiple Marble instances at different `dataPath` values to support multiple users.

## Source Adapters Setup

### RSS (built-in, no config needed)

```javascript
import { RSSAdapter } from 'marblism/adapters/sources/rss.js';

const rss = new RSSAdapter({
  feeds: [
    'https://feeds.feedburner.com/techcrunch/HKDS',
    'https://rss.cnn.com/rss/edition.rss'
  ]
});
const stories = await rss.fetchStories({ limit: 50 });
```

### HackerNews (built-in, no config needed)

```javascript
import { HackerNewsAdapter } from 'marblism/adapters/sources/hackernews.js';

const hn = new HackerNewsAdapter();
const stories = await hn.fetchStories({ type: 'top', limit: 30 });
```

### NewsAPI (requires API key)

```bash
export NEWSAPI_KEY=your-key-here
```

```javascript
import { NewsAPIAdapter } from 'marblism/adapters/sources/newsapi.js';

const newsapi = new NewsAPIAdapter({ apiKey: process.env.NEWSAPI_KEY });
const stories = await newsapi.fetchStories({ endpoint: 'top-headlines', country: 'us' });
```

## Delivery Adapters Setup

### Telegram

```bash
export TELEGRAM_TOKEN=your-bot-token
export TELEGRAM_CHAT_ID=your-chat-id
```

```javascript
import { TelegramAdapter } from 'marblism/adapters/delivery/telegram.js';

const tg = new TelegramAdapter(process.env.TELEGRAM_TOKEN, 'https://yourapp.com');
await tg.sendStories(stories, process.env.TELEGRAM_CHAT_ID, {
  format: 'compact',
  includeReactions: true
});
```

### Email

```javascript
import { EmailAdapter } from 'marblism/adapters/delivery/email.js';

const email = new EmailAdapter({
  baseUrl: 'https://yourapp.com',
  fromEmail: 'digest@yourapp.com'
});
await email.sendNewsletterEmail(stories, 'user@example.com');
```

### JSON API / Webhook

```javascript
import { APIAdapter } from 'marblism/adapters/delivery/api.js';
import { WebhookAdapter } from 'marblism/adapters/delivery/webhook.js';

// JSON API
const api = new APIAdapter({ baseUrl: 'https://yourapp.com' });

// Webhook
const webhook = new WebhookAdapter();
await webhook.deliverToWebhooks(stories, [{ url: 'https://yourapp.com/hook', payloadFormat: 'json' }]);
```

## Web Interface

Marble includes a web reader with built-in signal tracking:

```bash
npm run web          # Full interface (reader + tracker + dashboard)
npm run web:reader   # Story pages only
npm run web:tracker  # Signal collection endpoint only
npm run web:dashboard # User profile visualization only
```

The web reader automatically tracks dwell time, scroll depth, and clicks — feeding signals back into the KG.

## Troubleshooting

### `Error: Cannot find module 'onnxruntime-node'`

The ONNX runtime is a native module. If it fails to install:

```bash
npm rebuild onnxruntime-node
```

On Apple Silicon Macs, ensure you're using a native ARM Node.js build (not Rosetta).

### `Error: Model file not found`

The ONNX embedding model ships in `models/`. If cloning from source, make sure the `models/` directory is present:

```bash
ls models/all-MiniLM-L6-v2.onnx
```

### KG file not loading

Check file permissions and path. The `dataPath` should be writable:

```javascript
const marble = new Marble({ dataPath: '/absolute/path/to/kg.json' });
```

### Swarm mode slow without LLM

Without an LLM function, swarm mode falls back to heuristic scoring — this is fast but less nuanced. For production swarm mode, provide an LLM:

```javascript
const marble = new Marble({
  mode: 'swarm',
  llm: yourLLMFunction  // async (prompt) => string
});
```

## Next Steps

- [How It Works](how-it-works.md) — The data synthesis process explained
- [API Reference](api-reference.md) — Every function with examples
- [Usage Examples](usage-examples.md) — Real integration patterns
- [Architecture](architecture.md) — System design deep-dive
