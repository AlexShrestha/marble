#!/usr/bin/env node
/**
 * marble — CLI wrapping the full Marble lifecycle so consumers can cron it.
 *
 * Commands:
 *   marble init [--storage PATH]
 *   marble ingest <file> [--format chat|episodes] [--storage PATH]
 *   marble learn [--storage PATH]
 *   marble investigate [--rounds N] [--storage PATH]
 *   marble diagnose [--storage PATH] [--json]
 *   marble --help | --version
 *
 * Config (env):
 *   MARBLE_STORAGE          Default KG path if --storage is omitted
 *   LLM_PROVIDER            anthropic | openai | deepseek | openai-compatible
 *   ANTHROPIC_API_KEY       etc. — see core/llm-provider.js
 *   MARBLE_LLM_MODEL        Override model
 *
 * Exit codes:
 *   0  success
 *   1  usage / runtime error
 *   2  missing LLM provider credentials
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_PATH = path.resolve(__dirname, '..', 'package.json');
const DEFAULT_STORAGE = process.env.MARBLE_STORAGE || './marble-kg.json';

// Lazy-import `Marble` — keeping it out of the top-level import chain means
// `marble --help` / `--version` run without triggering the embeddings-
// provider probe banner that fires when core/kg.js is loaded. Commands that
// actually do work pay the one-time import cost via `loadMarble()`.
let _Marble = null;
async function loadMarble() {
  if (!_Marble) {
    const mod = await import('../core/index.js');
    _Marble = mod.Marble;
  }
  return _Marble;
}

// ─── ARG PARSING ──────────────────────────────────────────────────────────────

/**
 * Minimal flag parser. Avoids a dep for a tool that only needs --flag value
 * and --flag=value. Positional args come back as `_`.
 */
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        args[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          args[key] = next;
          i++;
        } else {
          args[key] = true;
        }
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

// ─── LLM WIRING ───────────────────────────────────────────────────────────────

/**
 * Build a `(prompt) => string` function over whichever provider `LLM_PROVIDER`
 * points at. Returns `{ llmFn, provider }` or throws with a message that
 * explains exactly what to set. Keeping the CLI thin means we don't try to
 * guess a provider — consumers set env vars the way they'd set them for any
 * other tool.
 */
async function buildLLM() {
  // Detect whether the configured provider is usable before we hit the Marble
  // constructor. The SDK-style client throws late (on first call), which
  // produces confusing errors for someone running `marble learn` without
  // any API key set.
  const provider = process.env.LLM_PROVIDER || 'anthropic';
  const keyVar = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    'openai-compatible': 'LLM_API_KEY',
  }[provider] || 'ANTHROPIC_API_KEY';

  if (!process.env[keyVar]) {
    const altHint = provider === 'openai-compatible' ? ' (or OPENAI_API_KEY as a fallback)' : '';
    const err = new Error(
      `${keyVar} is not set${altHint}.\n` +
      `The LLM_PROVIDER is "${provider}". Set ${keyVar} or change LLM_PROVIDER.\n` +
      'See core/llm-provider.js for the full list of supported providers.'
    );
    err.code = 'MISSING_LLM_CREDS';
    throw err;
  }

  const { createLLMClient } = await import('../core/llm-provider.js');
  const client = createLLMClient();
  // Marble expects `(prompt) => string`. Wrap the SDK client here so the
  // rest of the pipeline doesn't need to know about provider shape.
  const llmFn = async (prompt) => {
    const resp = await client.messages.create({
      model: client.defaultModel('fast'),
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });
    return resp?.content?.[0]?.text ?? '';
  };
  return { llmFn, provider };
}

// ─── LOADERS / HELPERS ────────────────────────────────────────────────────────

async function loadPackageVersion() {
  try {
    const raw = await readFile(PKG_PATH, 'utf-8');
    return JSON.parse(raw).version || 'unknown';
  } catch { return 'unknown'; }
}

async function openMarble({ storage, needsLLM }) {
  let llm = null;
  if (needsLLM) {
    const { llmFn } = await buildLLM();
    llm = llmFn;
  }
  const Marble = await loadMarble();
  const marble = new Marble({ storage, llm, silent: true });
  await marble.init();
  return marble;
}

/**
 * Read a generic episodes JSON file. Supports:
 *   - an array: [{ id, source, source_date, content, metadata? }, ...]
 *   - an object: { episodes: [...] }
 * Everything else throws with a usage hint.
 */
async function readEpisodesFile(filePath) {
  const raw = await readFile(filePath, 'utf-8');
  const data = JSON.parse(raw);
  const list = Array.isArray(data) ? data : data.episodes;
  if (!Array.isArray(list)) {
    throw new Error(
      `[marble ingest] Expected an array of episodes or { episodes: [...] } in ${filePath}. ` +
      'Each episode is `{ id?, source, source_date, content, metadata? }`.'
    );
  }
  return list;
}

function prettyJSON(x) { return JSON.stringify(x, null, 2); }

// ─── COMMANDS ─────────────────────────────────────────────────────────────────

const HELP = `marble — zero-day personalization engine CLI

USAGE
  marble <command> [options]

COMMANDS
  init                         Create an empty KG at --storage (or MARBLE_STORAGE).
  ingest <file>                Ingest a chat export or generic episodes file.
                               --format chat|episodes (default: auto-detect)
                               --source-label LABEL (override the episode source)
                               --no-inference (skip the L2 inference pass)
  learn                        Run L1.5 swarm, L2 inference, L3 clone evolution.
  investigate                  Run the adaptive investigative committee.
                               --rounds N (default: 2)
  diagnose                     Print KG health summary.
                               --json (machine-readable output)
  -h, --help                   Show this help.
  -v, --version                Show version.

OPTIONS
  --storage PATH               KG path. Defaults to \$MARBLE_STORAGE or ./marble-kg.json.

ENV
  LLM_PROVIDER                 anthropic | openai | deepseek | openai-compatible
  ANTHROPIC_API_KEY / ...      Per-provider credentials.
  MARBLE_LLM_MODEL             Override model for the configured provider.

EXAMPLES
  # First run
  MARBLE_STORAGE=./data/alex.json marble init
  marble --storage ./data/alex.json ingest ./exports/chatgpt-2024.json

  # Nightly cron
  0 3 * * * cd /path/to/project && marble learn && marble investigate --rounds 3

  # Health check
  marble diagnose --json | jq .
`;

async function cmdInit(args) {
  const storage = args.storage || DEFAULT_STORAGE;
  if (existsSync(storage)) {
    console.error(`[marble init] ${storage} already exists — refusing to overwrite.`);
    process.exit(1);
  }
  // Loading + saving a fresh Marble produces a valid empty KG.
  const Marble = await loadMarble();
  const marble = new Marble({ storage, llm: null, silent: true });
  await marble.init();
  await marble.save();
  console.log(`✓ Created empty KG at ${storage}`);
}

async function cmdIngest(args) {
  if (!args._[1]) {
    console.error('[marble ingest] Missing file argument. See `marble --help`.');
    process.exit(1);
  }
  const file = args._[1];
  if (!existsSync(file)) {
    console.error(`[marble ingest] File not found: ${file}`);
    process.exit(1);
  }

  const storage = args.storage || DEFAULT_STORAGE;
  const format = args.format || 'auto';
  const runInference = args['no-inference'] !== true;

  const marble = await openMarble({ storage, needsLLM: true });

  // Auto-detect: if the file parses as `{ conversations: [...] }` or
  // `{ mapping: ... }` or an array of `{ role, content }`, treat as chat.
  // Otherwise expect a generic episodes shape.
  let resolvedFormat = format;
  if (format === 'auto') {
    try {
      const head = JSON.parse(await readFile(file, 'utf-8'));
      const looksChatty = !!(head.conversations || head.mapping || head.chat_messages
        || (Array.isArray(head) && head[0]?.role)
        || (Array.isArray(head.messages)));
      resolvedFormat = looksChatty ? 'chat' : 'episodes';
    } catch (err) {
      console.error(`[marble ingest] Could not read ${file}: ${err.message}`);
      process.exit(1);
    }
  }

  let stats;
  if (resolvedFormat === 'chat') {
    stats = await marble.ingestConversations(file, {
      exchangeMode: false,
      runInference,
      sourceLabel: args['source-label'] || 'chat-export',
    });
  } else if (resolvedFormat === 'episodes') {
    const episodes = await readEpisodesFile(file);
    stats = await marble.ingestEpisodes(episodes, { runInference });
  } else {
    console.error(`[marble ingest] Unknown --format: ${format}`);
    process.exit(1);
  }

  console.log(`✓ Ingested ${stats.ingested} nodes (${stats.beliefs}b / ${stats.preferences}p / ${stats.identities}i) from ${stats.episodes ?? 0} episodes`);
  if (stats.reconciled) {
    const { beliefs_invalidated, preferences_invalidated, identities_invalidated } = stats.reconciled;
    if (beliefs_invalidated + preferences_invalidated + identities_invalidated > 0) {
      console.log(`  reconciled: ${beliefs_invalidated}b / ${preferences_invalidated}p / ${identities_invalidated}i invalidated`);
    }
  }
  if (typeof stats.entities_resolved === 'number' && stats.entities_resolved > 0) {
    console.log(`  entities_resolved: ${stats.entities_resolved}`);
  }
}

async function cmdLearn(args) {
  const storage = args.storage || DEFAULT_STORAGE;
  const marble = await openMarble({ storage, needsLLM: true });
  const result = await marble.learn();
  const { changes } = result;
  console.log(`✓ learn() complete`);
  console.log(`  stages: ${JSON.stringify(result.stages)}`);
  console.log(
    `  changes: +${changes.beliefs_added}b/-${changes.beliefs_invalidated}, ` +
    `+${changes.preferences_added}p/-${changes.preferences_invalidated}, ` +
    `+${changes.identities_added}i/-${changes.identities_invalidated}, ` +
    `clones ${changes.clones_seeded}seed/${changes.clones_bred}bred/${changes.clones_killed}kill, ` +
    `insights ${changes.insights_generated}, candidates ${changes.candidates_generated}`
  );
  if (result.failures.length > 0) {
    console.error(`  failures: ${result.failures.map(f => `${f.stage}:${f.message}`).join(' | ')}`);
    // Exit 0 by default — learn() tolerates degraded stages. Set MARBLE_STRICT=1
    // to treat any failure as an error exit (useful in cron with alerting).
    if (process.env.MARBLE_STRICT === '1') process.exit(1);
  }
}

async function cmdInvestigate(args) {
  const storage = args.storage || DEFAULT_STORAGE;
  const rounds = parseInt(args.rounds ?? '2', 10);
  const marble = await openMarble({ storage, needsLLM: true });
  const result = await marble.investigate({ maxRounds: rounds });
  console.log(`✓ investigate() complete`);
  console.log(`  answered: ${result.answered || 0}, gaps: ${result.gaps?.length || 0}, psychInferences: ${result.psychInferences?.length || 0}`);
}

async function cmdDiagnose(args) {
  const storage = args.storage || DEFAULT_STORAGE;
  const marble = await openMarble({ storage, needsLLM: false });
  const report = marble.diagnose();
  if (args.json) {
    console.log(prettyJSON(report));
    return;
  }
  const f = report.facts;
  const daysLearn = report.days_since_last_learn;
  const daysInv = report.days_since_last_investigate;
  console.log(`KG ${storage} (schema v${report.version})`);
  console.log(`  beliefs:     ${f.beliefs.active} active / ${f.beliefs.invalidated} invalidated / ${f.beliefs.with_evidence} with_evidence / ${f.beliefs.with_valid_from} with_valid_from`);
  console.log(`  preferences: ${f.preferences.active} active / ${f.preferences.invalidated} invalidated / ${f.preferences.with_evidence} with_evidence`);
  console.log(`  identities:  ${f.identities.active} active / ${f.identities.invalidated} invalidated / ${f.identities.with_evidence} with_evidence`);
  console.log(`  episodes:    ${report.episodes.total}`);
  console.log(`  clones:      ${report.clones.active} active / ${report.clones.killed} killed`);
  console.log(`  decay:       half-life ${report.decay.half_life_days}d, threshold ${report.decay.threshold}, ${report.decay.below_threshold} below threshold`);
  console.log(`  gaps:        ${report.gaps.open} open`);
  console.log(`  last learn:       ${report.last_learn_at || '(never)'}${daysLearn != null ? ` (${daysLearn.toFixed(1)}d ago)` : ''}`);
  console.log(`  last investigate: ${report.last_investigate_at || '(never)'}${daysInv != null ? ` (${daysInv.toFixed(1)}d ago)` : ''}`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (args.help || args.h || cmd === 'help') {
    console.log(HELP);
    return;
  }
  if (args.version || args.v || cmd === 'version') {
    console.log(await loadPackageVersion());
    return;
  }
  if (!cmd) {
    console.log(HELP);
    process.exit(1);
  }

  const commands = {
    init: cmdInit,
    ingest: cmdIngest,
    learn: cmdLearn,
    investigate: cmdInvestigate,
    diagnose: cmdDiagnose,
  };
  const fn = commands[cmd];
  if (!fn) {
    console.error(`Unknown command: ${cmd}\n`);
    console.log(HELP);
    process.exit(1);
  }
  try {
    await fn(args);
  } catch (err) {
    if (err.code === 'MISSING_LLM_CREDS') {
      console.error(`[marble ${cmd}] ${err.message}`);
      process.exit(2);
    }
    console.error(`[marble ${cmd}] ${err.message || err}`);
    process.exit(1);
  }
}

main();
