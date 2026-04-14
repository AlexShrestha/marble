#!/usr/bin/env node
/**
 * bootstrap-alex.mjs — Seed Marble KG for Alex
 *
 * Pipeline:
 *   Phase 1: ConversationMiner on all chat exports → thousands of raw nodes
 *   Phase 2: Inference pass on clusters → psychological patterns
 *   Phase 3: InvestigativeCommittee fills gaps with recursive follow-ups
 *   Phase 4: Cross-reference all beliefs → contradictions, clusters
 *
 * Usage:
 *   node scripts/bootstrap-alex.mjs
 *   node scripts/bootstrap-alex.mjs --dry-run
 *   ROUNDS=3 node scripts/bootstrap-alex.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob } from 'node:fs/promises';

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
      // Ollama format: data.message.content
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

// ── Data sources ─────────────────────────────────────────────────────────

// Claude memory files (all projects)
function findClaudeMemory() {
  const baseDir = path.join(HOME, '.claude', 'projects');
  const results = [];
  if (!fs.existsSync(baseDir)) return results;
  try {
    const projects = fs.readdirSync(baseDir);
    for (const proj of projects) {
      const memDir = path.join(baseDir, proj, 'memory');
      if (fs.existsSync(memDir)) {
        const files = fs.readdirSync(memDir).filter(f => f.endsWith('.md'));
        for (const file of files) {
          try {
            results.push({ file: `claude:${proj}/${file}`, content: fs.readFileSync(path.join(memDir, file), 'utf8') });
          } catch { /* skip */ }
        }
      }
    }
  } catch { /* skip */ }
  return results;
}

// ChatGPT exports
function findChatGPTExports() {
  const dlDir = path.join(HOME, 'Downloads');
  if (!fs.existsSync(dlDir)) return [];
  return fs.readdirSync(dlDir)
    .filter(f => f.startsWith('conversations-') && f.endsWith('.json'))
    .map(f => path.join(dlDir, f));
}

// GitHub READMEs
function findGitHubReadmes() {
  const ghDir = path.join(HOME, 'Documents', 'GitHub');
  const results = [];
  if (!fs.existsSync(ghDir)) return results;
  try {
    const repos = fs.readdirSync(ghDir);
    for (const repo of repos) {
      const readme = path.join(ghDir, repo, 'README.md');
      if (fs.existsSync(readme)) {
        try {
          results.push({ file: `github:${repo}/README.md`, content: fs.readFileSync(readme, 'utf8') });
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
  return results;
}

function readDirText(dir, maxFiles = 50) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md') || f.endsWith('.txt')).slice(0, maxFiles);
  for (const file of files) {
    try {
      results.push({ file, content: fs.readFileSync(path.join(dir, file), 'utf8') });
    } catch { /* skip */ }
  }
  return results;
}

function buildSearchFn(documents) {
  return async (query) => {
    const q = query.toLowerCase();
    const hits = [];
    for (const { file, content } of documents) {
      const words = q.split(/\s+/).filter(w => w.length > 3);
      const matches = words.filter(w => content.toLowerCase().includes(w));
      if (matches.length > 0) {
        // For strong matches (3+ keywords), return full content (capped at 2000 chars)
        if (matches.length >= 3) {
          hits.push(`[${file}] ${content.slice(0, 2000)}`);
        } else {
          const lines = content.split('\n');
          const relevant = lines.filter(l => matches.some(w => l.toLowerCase().includes(w)));
          hits.push(`[${file}] ${relevant.slice(0, 8).join(' | ')}`);
        }
      }
    }
    return hits.slice(0, 12);
  };
}

// ── Seed facts ────────────────────────────────────────────────────────────

const ALEX_SEED = {
  id: 'alex',
  dob: '1988-11-02',
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
  ].map(i => ({ ...i, last_boost: new Date().toISOString() })),
  context: {
    calendar: [],
    active_projects: ['AhaRoll', 'SuperstateX', 'BooRadar', 'Vivo', 'Marble'],
    recent_conversations: [],
    mood_signal: null,
    location: 'Barcelona',
  },
  history: [],
  source_trust: {},
  beliefs: [
    { topic: 'building', claim: 'Ship fast, learn from real users — not from planning', strength: 0.9, evidence_count: 1, valid_from: new Date().toISOString(), valid_to: null, recorded_at: new Date().toISOString() },
    { topic: 'AI', claim: 'AI agents will replace most solo founder execution within 2 years', strength: 0.85, evidence_count: 1, valid_from: new Date().toISOString(), valid_to: null, recorded_at: new Date().toISOString() },
  ],
  preferences: [
    { type: 'work_style', description: 'Prefers systems thinking + delegation over manual execution', strength: 0.85, valid_from: new Date().toISOString(), valid_to: null, recorded_at: new Date().toISOString() },
    { type: 'content', description: 'Direct, no-fluff communication — skips pleasantries', strength: 0.9, valid_from: new Date().toISOString(), valid_to: null, recorded_at: new Date().toISOString() },
  ],
  identities: [
    { role: 'multi-venture founder', context: 'Barcelona, 5-month runway', salience: 1.0, valid_from: new Date().toISOString(), valid_to: null, recorded_at: new Date().toISOString() },
    { role: 'builder', context: 'AI tools, consumer apps', salience: 0.9, valid_from: new Date().toISOString(), valid_to: null, recorded_at: new Date().toISOString() },
  ],
  confidence: { AI: 0.9, marketing: 0.75, logistics: 0.6, coaching: 0.65 },
  clones: [],
};

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Marble Bootstrap: Alex ===\n');

  // ── Phase 0: Gather data sources ──────────────────────
  const claudeMemory = findClaudeMemory();
  const chatGPTExports = findChatGPTExports();
  const githubReadmes = findGitHubReadmes();

  console.log(`Data sources found:`);
  console.log(`  Claude memory files: ${claudeMemory.length}`);
  console.log(`  ChatGPT export files: ${chatGPTExports.length}`);
  console.log(`  GitHub READMEs: ${githubReadmes.length}`);

  const allDocs = [...claudeMemory, ...githubReadmes];
  const searchFn = buildSearchFn(allDocs);

  // Initialise KG with seed
  const kgData = {
    user: ALEX_SEED,
    _dimensionalPreferences: [],
    updated_at: new Date().toISOString(),
  };

  // KG proxy that maps to real field names
  const kgProxy = {
    user: kgData.user,
    getActiveBeliefs: () => kgData.user.beliefs.filter(b => !b.valid_to),
    getActivePreferences: () => kgData.user.preferences.filter(p => !p.valid_to),
    getActiveIdentities: () => kgData.user.identities.filter(i => !i.valid_to),
    getDimensionalPreferences: () => kgData._dimensionalPreferences || [],
    getInterestWeight: (topic) => {
      const i = kgData.user.interests.find(x => x.topic.toLowerCase() === topic.toLowerCase());
      return i ? i.weight : 0;
    },
    addBelief: (topic, claim, strength = 0.75) => {
      const now = new Date().toISOString();
      kgData.user.beliefs.push({ topic, claim, strength, evidence_count: 1, valid_from: now, valid_to: null, recorded_at: now });
    },
    addPreference: (type, description, strength = 0.7) => {
      const now = new Date().toISOString();
      kgData.user.preferences.push({ type, description, strength, valid_from: now, valid_to: null, recorded_at: now });
    },
    addIdentity: (role, context = '', salience = 0.7) => {
      const now = new Date().toISOString();
      kgData.user.identities.push({ role, context, salience, valid_from: now, valid_to: null, recorded_at: now });
    },
    tagEmotions: (type, topic, emotions) => {
      const topicLower = topic.toLowerCase();
      let collection;
      if (type === 'belief') collection = kgData.user.beliefs;
      else if (type === 'preference') collection = kgData.user.preferences;
      else if (type === 'identity') collection = kgData.user.identities;
      else return;
      for (const item of collection) {
        const key = item.topic || item.type || item.role || '';
        if (key.toLowerCase() === topicLower && !item.valid_to) {
          item.emotions = [...new Set([...(item.emotions || []), ...emotions])];
        }
      }
    },
  };

  // ── Phase 1: Mine conversations ──────────────────────────
  if (chatGPTExports.length > 0) {
    console.log('\n── Phase 1: Mining conversations ──');
    const { ConversationMiner } = await import('../core/conversation-miner.js');
    const miner = new ConversationMiner(llmCall, {
      chunkSize: 20,
      onProgress: (stats) => {
        if (stats.phase === 'extract' && stats.chunksProcessed % 10 === 0) {
          process.stdout.write(`\r  Chunks: ${stats.chunksProcessed} | Nodes: ${stats.nodesExtracted}`);
        }
        if (stats.phase === 'infer') {
          process.stdout.write(`\r  Inference batch: ${stats.inferBatch} | Inferences: ${stats.inferencesGenerated}`);
        }
      },
    });

    let totalStats = { ingested: 0, beliefs: 0, preferences: 0, identities: 0, inferences: 0, duplicates_merged: 0 };

    for (const exportPath of chatGPTExports) {
      console.log(`\n  Processing: ${path.basename(exportPath)}`);
      try {
        const stats = await miner.ingestIntoKG(exportPath, kgProxy, { exchangeMode: false, runInference: true });
        totalStats.ingested += stats.ingested;
        totalStats.beliefs += stats.beliefs;
        totalStats.preferences += stats.preferences;
        totalStats.identities += stats.identities;
        totalStats.inferences += stats.inferences;
        totalStats.duplicates_merged += stats.duplicates_merged;
        console.log(`    → ${stats.ingested} nodes (${stats.beliefs}b/${stats.preferences}p/${stats.identities}i), ${stats.inferences} inferences, ${stats.duplicates_merged} dupes merged`);
      } catch (err) {
        console.warn(`    ✗ Failed: ${err.message}`);
      }
    }

    console.log(`\n  Phase 1 total: ${totalStats.ingested} nodes ingested, ${totalStats.inferences} inferences`);
    console.log(`  KG now has: ${kgData.user.beliefs.length} beliefs, ${kgData.user.preferences.length} prefs, ${kgData.user.identities.length} identities`);
  } else {
    console.log('\n[skip] No ChatGPT exports found in ~/Downloads/');
  }

  // ── Phase 2: Mine Claude memory ──────────────────────────
  if (claudeMemory.length > 0) {
    console.log('\n── Phase 2: Mining Claude memory files ──');
    for (const { file, content } of claudeMemory) {
      // Direct extraction from structured memory files (simpler than conversation mining)
      try {
        const prompt = `Extract knowledge graph nodes from this AI assistant memory file about a user.

File: ${file}
Content:
${content.slice(0, 3000)}

Return ONLY a JSON array:
[{ "type": "belief"|"preference"|"identity", "value": "statement about user", "confidence": 0.7-0.9, "topic": "category" }]`;

        const raw = await llmCall(prompt);
        const nodes = parseNodesFromRaw(raw);
        for (const node of nodes) {
          if (node.type === 'belief' || node.type === 'decision') kgProxy.addBelief(node.topic, node.value, node.confidence);
          else if (node.type === 'preference') kgProxy.addPreference(node.topic, node.value, node.confidence);
          else if (node.type === 'identity') kgProxy.addIdentity(node.topic, node.value, node.confidence);
        }
        if (nodes.length > 0) console.log(`  ${file}: ${nodes.length} nodes`);
      } catch (err) {
        console.warn(`  ${file}: failed (${err.message})`);
      }
    }
    console.log(`  KG now has: ${kgData.user.beliefs.length} beliefs, ${kgData.user.preferences.length} prefs, ${kgData.user.identities.length} identities`);
  }

  // ── Phase 3: Investigative Committee fills gaps ──────────
  console.log('\n── Phase 3: Investigative Committee (gap-filling) ──');

  const { InvestigativeCommittee } = await import('../core/investigative-committee.js');

  const MAX_ROUNDS = parseInt(process.env.ROUNDS || '2');
  const committee = new InvestigativeCommittee(kgProxy, llmCall, {
    maxRounds: MAX_ROUNDS,
    maxQuestionsPerRound: 4,
    maxFollowUpsPerFinding: 2,
    enableDebate: true,
    enablePsychInference: true,
    enableCrossRef: true,
  });

  // Register all document sources for evidence search
  committee.registerSource('claude-memory', buildSearchFn(claudeMemory));
  committee.registerSource('github-readmes', buildSearchFn(githubReadmes));

  console.log(`  Running ${MAX_ROUNDS} round(s) with ${kgData.user.beliefs.length} beliefs as starting context...\n`);
  try {
    const result = await committee.investigate(MAX_ROUNDS);
    console.log(`\n  Investigation complete:`);
    console.log(`    Questions answered: ${result.answered}`);
    console.log(`    Knowledge gaps: ${result.gaps.length}`);
    console.log(`    Psych inferences: ${result.psychInferences?.length || 0}`);
    console.log(`    Committee: ${result.committee?.map(c => c.name).join(', ') || '(fallback)'}`);

    if (result.crossRefResults) {
      console.log(`    Contradictions: ${result.crossRefResults.contradictions?.length || 0}`);
      console.log(`    Clusters: ${result.crossRefResults.clusters?.length || 0}`);
    }

    if (result.gaps.length) {
      console.log('\n  Knowledge gaps (for clone hypotheses):');
      result.gaps.slice(0, 10).forEach((g, i) => console.log(`    ${i + 1}. ${g}`));
    }
  } catch (err) {
    console.error('  Investigation error:', err.message);
    console.log('  Continuing with mined data...');
  }

  // ── Save ────────────────────────────────────────────────
  if (DRY_RUN) {
    console.log('\n[dry-run] KG not saved.');
    console.log(`  Would save: ${kgData.user.beliefs.length} beliefs, ${kgData.user.preferences.length} prefs, ${kgData.user.identities.length} identities`);
    return;
  }

  fs.mkdirSync(path.join(ROOT, 'data', 'kg'), { recursive: true });
  fs.writeFileSync(KG_PATH, JSON.stringify(kgData, null, 2));
  console.log(`\n✓ KG saved to ${KG_PATH}`);
  console.log(`  Beliefs: ${kgData.user.beliefs.length}`);
  console.log(`  Preferences: ${kgData.user.preferences.length}`);
  console.log(`  Identities: ${kgData.user.identities.length}`);
  console.log(`  Clones: ${kgData.user.clones.length}`);
}

// Helper for raw LLM response parsing (used in Phase 2)
function parseNodesFromRaw(responseText) {
  let text = responseText.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  try {
    const nodes = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(nodes)) return [];
    return nodes.filter(n => n && n.type && n.value).map(n => ({
      type: String(n.type).toLowerCase(),
      value: String(n.value).trim(),
      confidence: Math.max(0, Math.min(1, parseFloat(n.confidence) || 0.6)),
      topic: String(n.topic || n.type).trim(),
    }));
  } catch {
    return [];
  }
}

main().catch(console.error);
