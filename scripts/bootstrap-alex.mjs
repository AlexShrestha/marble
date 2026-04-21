#!/usr/bin/env node
/**
 * bootstrap-alex.mjs — Seed Marble KG for Alex via the public `Marble` API.
 *
 * Previous versions of this script went straight to `ConversationMiner` and
 * `InvestigativeCommittee`, skipping `Marble.learn()` and the L1.5/L2/L3
 * pipeline entirely. This rewrite drives everything through the lifecycle
 * documented at the top of `core/index.js`:
 *
 *   init → ingestConversations / ingestEpisodes → learn → investigate → save
 *
 * Pipeline:
 *   Phase 0: Seed Alex's profile (interests, initial beliefs/prefs/identities)
 *   Phase 1: Ingest ChatGPT exports via `marble.ingestConversations()`
 *   Phase 2: Ingest Claude memory + GitHub READMEs as generic episodes
 *   Phase 3: `marble.learn()` — L1.5 swarm, L2 inference, L3 clone evolution
 *   Phase 4: `marble.investigate()` — adaptive committee fills gaps
 *
 * Usage:
 *   node scripts/bootstrap-alex.mjs
 *   node scripts/bootstrap-alex.mjs --dry-run
 *   ROUNDS=3 node scripts/bootstrap-alex.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marble } from '../core/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const KG_PATH = path.join(ROOT, 'data', 'kg', 'alex.json');
const DRY_RUN = process.argv.includes('--dry-run');
const HOME = process.env.HOME;

// ── LLM provider ────────────────────────────────────────────────────────
const LLM_URL = 'https://vad-serv-1.tail5fdf86.ts.net/api/chat';
const LLM_MODEL = 'kimi-k2.5:cloud';
const LLM_API_KEY = process.env.MARBLE_API_KEY || '';
const LLM_TIMEOUT = 600_000; // 600s
const MAX_RETRIES = 5;

async function llmCall(prompt) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(LLM_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(LLM_API_KEY ? { 'x-api-key': LLM_API_KEY } : {}),
        },
        body: JSON.stringify({
          model: LLM_MODEL,
          stream: false,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(LLM_TIMEOUT),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }

      const j = await res.json();
      const content = j.message?.content || j.choices?.[0]?.message?.content || '';
      if (!content) throw new Error('Empty LLM response');
      return content;
    } catch (err) {
      const isNetworkError = err.name === 'AbortError' || err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.message.includes('fetch failed');
      if (isNetworkError && attempt < MAX_RETRIES - 1) {
        const delay = Math.min(5000, 1000 * (attempt + 1));
        console.warn(`[LLM] Retry ${attempt + 1}/${MAX_RETRIES} after ${err.message} (waiting ${delay}ms)`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

// ── Data gathering ─────────────────────────────────────────────────────

/**
 * Walk `~/.claude/projects/*/memory/*.md` and return episode-shaped objects
 * ready for `marble.ingestEpisodes()`. One episode per memory file; source
 * date reads the file's mtime rather than substituting "now".
 */
function gatherClaudeMemory() {
  const baseDir = path.join(HOME, '.claude', 'projects');
  const results = [];
  if (!fs.existsSync(baseDir)) return results;
  for (const proj of fs.readdirSync(baseDir)) {
    const memDir = path.join(baseDir, proj, 'memory');
    if (!fs.existsSync(memDir)) continue;
    for (const file of fs.readdirSync(memDir).filter(f => f.endsWith('.md'))) {
      const full = path.join(memDir, file);
      try {
        const content = fs.readFileSync(full, 'utf8');
        const stat = fs.statSync(full);
        results.push({
          id: `claude:${proj}/${file}`,
          source: 'claude-memory',
          source_date: stat.mtime.toISOString(),
          content,
          metadata: { project: proj, file },
        });
      } catch { /* skip unreadable files */ }
    }
  }
  return results;
}

function gatherGitHubReadmes() {
  const ghDir = path.join(HOME, 'Documents', 'GitHub');
  const results = [];
  if (!fs.existsSync(ghDir)) return results;
  for (const repo of fs.readdirSync(ghDir)) {
    const readme = path.join(ghDir, repo, 'README.md');
    if (!fs.existsSync(readme)) continue;
    try {
      const content = fs.readFileSync(readme, 'utf8');
      const stat = fs.statSync(readme);
      results.push({
        id: `github:${repo}/README.md`,
        source: 'github-readme',
        source_date: stat.mtime.toISOString(),
        content,
        metadata: { repo },
      });
    } catch { /* skip */ }
  }
  return results;
}

function gatherChatGPTExports() {
  const dlDir = path.join(HOME, 'Downloads');
  if (!fs.existsSync(dlDir)) return [];
  return fs.readdirSync(dlDir)
    .filter(f => f.startsWith('conversations-') && f.endsWith('.json'))
    .map(f => path.join(dlDir, f));
}

/**
 * Build a registerSource()-compatible search function over a list of raw
 * documents. Used to give the InvestigativeCommittee evidence to query.
 */
function buildSearchFn(documents) {
  return async (query) => {
    const q = query.toLowerCase();
    const hits = [];
    for (const { content, id } of documents) {
      const words = q.split(/\s+/).filter(w => w.length > 3);
      const matches = words.filter(w => content.toLowerCase().includes(w));
      if (matches.length === 0) continue;
      if (matches.length >= 3) {
        hits.push(`[${id}] ${content.slice(0, 2000)}`);
      } else {
        const lines = content.split('\n');
        const relevant = lines.filter(l => matches.some(w => l.toLowerCase().includes(w)));
        hits.push(`[${id}] ${relevant.slice(0, 8).join(' | ')}`);
      }
    }
    return hits.slice(0, 12);
  };
}

// ── Alex seed ─────────────────────────────────────────────────────────

const ALEX_SEED = {
  interests: [
    { topic: 'LLMs / Generative AI', weight: 0.92, trend: 'rising' },
    { topic: 'AI Agents & Orchestration', weight: 0.91, trend: 'rising' },
    { topic: 'Entrepreneurship / Indie Hacking', weight: 0.90, trend: 'stable' },
    { topic: 'Revenue & Monetisation', weight: 0.95, trend: 'rising' },
    { topic: 'SaaS / Product Building', weight: 0.88, trend: 'rising' },
    { topic: 'Growth Marketing', weight: 0.80, trend: 'stable' },
    { topic: 'Shopify / E-commerce', weight: 0.78, trend: 'rising' },
    { topic: 'Cold Email / Outreach', weight: 0.75, trend: 'stable' },
    { topic: "Men's Coaching / Psychology", weight: 0.68, trend: 'stable' },
    { topic: 'Fitness & Biohacking', weight: 0.65, trend: 'rising' },
    { topic: 'Logistics & Trade', weight: 0.55, trend: 'stable' },
    { topic: 'Crypto / Web3', weight: 0.45, trend: 'stable' },
  ],
  context: {
    active_projects: ['AhaRoll', 'SuperstateX', 'BooRadar', 'Vivo', 'Marble'],
    location: 'Barcelona',
  },
  beliefs: [
    { topic: 'building', claim: 'Ship fast, learn from real users — not from planning', strength: 0.9 },
    { topic: 'AI', claim: 'AI agents will replace most solo founder execution within 2 years', strength: 0.85 },
  ],
  preferences: [
    { type: 'work_style', description: 'Prefers systems thinking + delegation over manual execution', strength: 0.85 },
    { type: 'content', description: 'Direct, no-fluff communication — skips pleasantries', strength: 0.9 },
  ],
  identities: [
    { role: 'multi-venture founder', context: 'Barcelona, 5-month runway', salience: 1.0 },
    { role: 'builder', context: 'AI tools, consumer apps', salience: 0.9 },
  ],
  confidence: { AI: 0.9, marketing: 0.75, logistics: 0.6, coaching: 0.65 },
};

/**
 * Apply the seed to a freshly-initialised KG. Skips if the KG already has
 * beliefs — that way re-running bootstrap over an existing file only adds
 * new episodes and doesn't replay the seed.
 */
function applySeed(marble) {
  const kg = marble.kg;
  if ((kg.user.beliefs || []).length > 0) return false;

  kg.user.id = 'alex';
  kg.user.context = { ...(kg.user.context || {}), ...ALEX_SEED.context };
  kg.user.confidence = { ...(kg.user.confidence || {}), ...ALEX_SEED.confidence };

  const now = new Date().toISOString();
  kg.user.interests = ALEX_SEED.interests.map(i => ({ ...i, last_boost: now }));

  for (const b of ALEX_SEED.beliefs) {
    kg.addBelief(b.topic, b.claim, b.strength);
  }
  for (const p of ALEX_SEED.preferences) {
    kg.addPreference(p.type, p.description, p.strength);
  }
  for (const id of ALEX_SEED.identities) {
    kg.addIdentity(id.role, id.context, id.salience);
  }
  return true;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Marble Bootstrap: Alex ===\n');

  const marble = new Marble({ storage: KG_PATH, llm: llmCall, silent: true });
  await marble.init();

  const seeded = applySeed(marble);
  console.log(seeded ? '✓ Seeded fresh KG with Alex\'s profile' : '→ Reusing existing KG (skipping seed)');

  // ── Phase 0: Data gathering ──────────────────────────────
  const claudeMemory = gatherClaudeMemory();
  const chatGPTExports = gatherChatGPTExports();
  const githubReadmes = gatherGitHubReadmes();

  console.log('\nData sources found:');
  console.log(`  Claude memory files: ${claudeMemory.length}`);
  console.log(`  ChatGPT export files: ${chatGPTExports.length}`);
  console.log(`  GitHub READMEs: ${githubReadmes.length}`);

  // ── Phase 1: Ingest ChatGPT exports ───────────────────────
  if (chatGPTExports.length > 0) {
    console.log('\n── Phase 1: Ingesting ChatGPT exports ──');
    for (const exportPath of chatGPTExports) {
      console.log(`\n  Processing: ${path.basename(exportPath)}`);
      try {
        const stats = await marble.ingestConversations(exportPath, {
          exchangeMode: false,
          runInference: true,
          sourceLabel: 'chatgpt-export',
          onProgress: (s) => {
            if (s.phase === 'extract' && s.chunksProcessed && s.chunksProcessed % 10 === 0) {
              console.log(`    chunk ${s.chunksProcessed} → ${s.nodesExtracted} nodes`);
            }
          },
        });
        console.log(`    → ${stats.ingested} nodes (${stats.beliefs}b/${stats.preferences}p/${stats.identities}i), ${stats.inferences} inferences, ${stats.episodes} episodes`);
        if (stats.reconciled && (stats.reconciled.beliefs_invalidated + stats.reconciled.preferences_invalidated + stats.reconciled.identities_invalidated) > 0) {
          console.log(`    reconciled: ${JSON.stringify(stats.reconciled)}`);
        }
      } catch (err) {
        console.warn(`    ✗ Failed: ${err.message}`);
      }
    }
  } else {
    console.log('\n[skip] No ChatGPT exports found in ~/Downloads/');
  }

  // ── Phase 2: Ingest Claude memory + GitHub READMEs as generic episodes ──
  const docEpisodes = [...claudeMemory, ...githubReadmes];
  if (docEpisodes.length > 0) {
    console.log(`\n── Phase 2: Ingesting ${docEpisodes.length} generic episodes ──`);
    try {
      const stats = await marble.ingestEpisodes(docEpisodes, { runInference: true });
      console.log(`  → ${stats.ingested} nodes, ${stats.inferences} inferences, ${stats.episodes} episodes`);
    } catch (err) {
      console.warn(`  ✗ Failed: ${err.message}`);
    }
  }

  console.log(`\n  KG state: ${marble.kg.user.beliefs.length} beliefs, ${marble.kg.user.preferences.length} prefs, ${marble.kg.user.identities.length} identities, ${marble.kg.user.episodes.length} episodes`);

  // ── Phase 3: learn() — L1.5 swarm, L2 inference, L3 clone evolution ──
  console.log('\n── Phase 3: marble.learn() ──');
  try {
    const learnResult = await marble.learn();
    console.log(`  insights: ${learnResult.insights}, candidates: ${learnResult.candidates}, clones: ${learnResult.clones}`);
    console.log(`  stages: ${JSON.stringify(learnResult.stages)}`);
    if (learnResult.failures.length > 0) {
      console.warn(`  failures: ${learnResult.failures.map(f => `${f.stage}:${f.message}`).join(' | ')}`);
    }
  } catch (err) {
    console.warn(`  learn() failed: ${err.message}`);
  }

  // ── Phase 4: investigate() — committee fills gaps ───────
  console.log('\n── Phase 4: marble.investigate() ──');
  const MAX_ROUNDS = parseInt(process.env.ROUNDS || '2');
  try {
    const result = await marble.investigate({
      maxRounds: MAX_ROUNDS,
      sources: {
        'claude-memory': buildSearchFn(claudeMemory),
        'github-readmes': buildSearchFn(githubReadmes),
      },
    });
    console.log(`  answered: ${result.answered || 0}, gaps: ${result.gaps?.length || 0}, psychInferences: ${result.psychInferences?.length || 0}`);
    if (result.gaps?.length) {
      console.log('  Top gaps:');
      result.gaps.slice(0, 5).forEach((g, i) => console.log(`    ${i + 1}. ${g}`));
    }
  } catch (err) {
    console.warn(`  investigate() failed: ${err.message}`);
  }

  // ── Save ────────────────────────────────────────────────
  if (DRY_RUN) {
    console.log('\n[dry-run] KG not saved.');
    return;
  }

  fs.mkdirSync(path.dirname(KG_PATH), { recursive: true });
  await marble.save();
  console.log(`\n✓ KG saved to ${KG_PATH}`);
  console.log(`  Beliefs: ${marble.kg.user.beliefs.length}`);
  console.log(`  Preferences: ${marble.kg.user.preferences.length}`);
  console.log(`  Identities: ${marble.kg.user.identities.length}`);
  console.log(`  Episodes: ${marble.kg.user.episodes.length}`);
  console.log(`  Clones: ${marble.kg.user.clones?.length || 0}`);
}

main().catch(console.error);
