/**
 * rebuild-alex-kg.mjs
 *
 * Rebuilds Alex Shrestha's Marble KG from actual user data.
 * Wipes simulated entries, synthesises beliefs + identities using DeepSeek.
 *
 * Usage:
 *   node /Users/aleksandrshrestha/.nvm/versions/node/v20.20.2/bin/node \
 *        /Users/aleksandrshrestha/repos/marble/scripts/rebuild-alex-kg.mjs
 *
 * Sources used:
 *   - USER.md (profile, ventures, style)
 *   - memory files (location, preferences)
 *   - KG-DEEPENING-REPORT (interests validated via ChatGPT analysis)
 *   - project files (active ventures, runway context)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load env
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.+)/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

const KG_PATH = '/Users/aleksandrshrestha/.openclaw/workspace/data/marble/alex.json';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
if (!DEEPSEEK_KEY) { console.error('DEEPSEEK_API_KEY not set'); process.exit(1); }

const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const client = new OpenAI({
  apiKey: 'n/a',
  baseURL: DEEPSEEK_BASE,
  defaultHeaders: { 'x-api-key': DEEPSEEK_KEY },
});

// ── Real data sources ──────────────────────────────────────────────────────

const USER_DATA = `
# Alex Shrestha — Real User Data

## Profile
- Name: Alex Shrestha
- Location: Barcelona, Spain (GMT+1), Airbnb-hopping since 2022
- Age range: 30s (has a daughter named Fleur)
- Diet: Carnivore since April 2025
- Training: Ultra-marathon runner
- Bilingual: English (tech/business) + Russian (health/legal/personal)

## Active Ventures
1. AhaRoll — Shopify AI product photos, Antler startup program applicant
2. SuperstateX — Men's coaching / self-development
3. BooRadar — Ghost hunting iOS app
4. Logistics/Trade — China Railway Express, Belarus terminals
5. CommentAssist — Automated comment system (maintenance mode)

## Financial Context
- 5-month runway to 7k EUR/month (as of Feb 2026)
- Survival urgency — every decision has cost/time weight
- Bottleneck: his own review and approval time

## Working Style
- Ships fast, thinks in systems
- Responds to challenge and pushback, not hand-holding
- Tests claims skeptically — wants proof over theory
- Risk pattern: spreading thin, context-switching as avoidance
- Says: "I don't need a boss, I need a carer" — wants to feel known

## Validated Interests (from 926 ChatGPT conversations analysis)
- Coding & software development (weight: ~1.0, AI-first workflow)
- Artificial Intelligence / LLMs (weight: ~1.0, heavy daily user)
- Startups & entrepreneurship (weight: ~0.85, founder identity)
- Ultra-running / endurance sports (weight: ~0.85, identity-level)
- Deep house / tech house music (weight: ~0.85, daily listener)
- Health optimisation — carnivore, biohacking (weight: ~0.8)
- Business / revenue systems (weight: ~0.75)
- Hiring / delegation / leverage (weight: ~0.6)

## Personality Signals
- Prefers experiences over sightseeing
- Events: time-limited, happening-now (festivals, pop-ups)
- Social contexts: with girlfriend, with daughter Fleur, or startup work
- Hates bureaucracy, slow feedback loops, vague answers
- Loves systems that do heavy lifting so he can focus on decision-making

## Known Projects This Week (April 2026)
- AhaRoll: Shopify Partner access done, 10k+ stores scanned for outreach
- SuperstateX: Reddit week 4 promotion phase, 8 subs, account jarviswilldoitnow@gmail.com
- Marble: Rebuilding KG + dynamic agent committee (this script)
- Node.js: Fixed — using NVM v20.20.2 (brew node broken)
`;

// ── LLM synthesis ──────────────────────────────────────────────────────────

async function synthesiseKG() {
  console.log('[rebuild-alex-kg] Synthesising beliefs from real data via DeepSeek...');

  const res = await client.chat.completions.create({
    model: 'deepseek-r1:14b',
    max_tokens: 3000,
    messages: [{
      role: 'user',
      content: `You are building a knowledge graph for a user modelling system called Marble.
      
Based on the REAL user data below, synthesise:
1. beliefs — what this person genuinely believes/values (with strength 0-1)
2. identities — stable identity labels this person holds
3. interests — refined from the data (with weight 0-1 and trend)

This data is REAL. Do not invent. Extract from what is documented.

${USER_DATA}

Respond with JSON only:
{
  "beliefs": [
    { "topic": "string", "content": "what they believe", "strength": 0.0-1.0, "evidence_count": N }
  ],
  "identities": [
    { "type": "identity_type", "label": "display label", "confidence": 0.0-1.0, "source": "data_source" }
  ],
  "interests": [
    { "topic": "string", "weight": 0.0-1.0, "trend": "rising|stable|falling" }
  ]
}`
    }],
  });

  const text = res.choices[0]?.message?.content || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in LLM response');
  return JSON.parse(jsonMatch[0]);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  // Load existing KG
  const existing = JSON.parse(fs.readFileSync(KG_PATH, 'utf-8'));

  // Strip simulated history
  const realHistory = (existing.user?.history || []).filter(
    h => h.story_id && !h.story_id.startsWith('sim_')
  );
  console.log(`[rebuild-alex-kg] Kept ${realHistory.length} real history entries, removed simulated ones`);

  // Synthesise from real data
  const synthesised = await synthesiseKG();

  // Merge — replace interests with synthesised (more accurate), keep real history
  const rebuilt = {
    ...existing,
    user: {
      ...existing.user,
      id: 'alex',
      interests: synthesised.interests,
      history: realHistory,
      context: {
        ...(existing.user?.context || {}),
        location: 'Barcelona, Spain',
        updated: new Date().toISOString(),
        source: 'real-data-rebuild-2026-04-07',
      },
    },
    beliefs:               synthesised.beliefs,
    identities:            synthesised.identities,
    dimensionalPreferences: existing.dimensionalPreferences || [],
    _meta: {
      rebuilt_at:   new Date().toISOString(),
      source:       'rebuild-alex-kg.mjs',
      data_sources: ['USER.md', 'memory-files', 'KG-DEEPENING-REPORT', 'project-state'],
      history_real: realHistory.length,
      beliefs:      synthesised.beliefs.length,
      identities:   synthesised.identities.length,
      interests:    synthesised.interests.length,
    },
  };

  // Backup original
  const backupPath = KG_PATH.replace('.json', `.backup-${Date.now()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(existing, null, 2));
  console.log(`[rebuild-alex-kg] Backed up original to ${path.basename(backupPath)}`);

  // Write rebuilt KG
  fs.writeFileSync(KG_PATH, JSON.stringify(rebuilt, null, 2));

  console.log('[rebuild-alex-kg] Done.');
  console.log(`  beliefs:    ${rebuilt.beliefs.length}`);
  console.log(`  identities: ${rebuilt.identities.length}`);
  console.log(`  interests:  ${rebuilt.user.interests.length}`);
  console.log(`  history:    ${rebuilt.user.history.length} real entries`);
  console.log(`  location:   ${rebuilt.user.context.location}`);
}

main().catch(err => { console.error(err); process.exit(1); });
