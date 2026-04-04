/**
 * inspect-kg.mjs — Marble KG diagnostic script
 *
 * Shows what user KG context a marble swarm agent would receive.
 * Loads real KG data from examples/data/quickstart-kg.json (or test/test-kg.json as fallback).
 * Falls back to synthetic mock data if no real KG file is found.
 *
 * Usage:
 *   node scripts/inspect-kg.mjs
 *   node scripts/inspect-kg.mjs --kg /path/to/kg.json
 *   node scripts/inspect-kg.mjs --user myUserId
 */

import { readFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const kgPathArg = args.includes('--kg') ? args[args.indexOf('--kg') + 1] : null;
const userIdArg = args.includes('--user') ? args[args.indexOf('--user') + 1] : null;

// ── KG loading ────────────────────────────────────────────────────────────────

const KG_SEARCH_PATHS = [
  kgPathArg,
  resolve(REPO_ROOT, 'examples/data/quickstart-kg.json'),
  resolve(REPO_ROOT, 'test/test-kg.json'),
].filter(Boolean);

async function loadKGData() {
  for (const p of KG_SEARCH_PATHS) {
    try {
      const raw = await readFile(p, 'utf-8');
      const data = JSON.parse(raw);
      return { data, source: p, synthetic: false };
    } catch {
      // try next
    }
  }
  // No real KG found — return synthetic mock data
  return { data: buildSyntheticKG(), source: 'synthetic', synthetic: true };
}

function buildSyntheticKG() {
  const now = new Date().toISOString();
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
  return {
    user: {
      id: 'demo-user',
      interests: [
        { topic: 'machine learning', weight: 0.95, last_boost: daysAgo(1), trend: 'rising' },
        { topic: 'startups', weight: 0.85, last_boost: daysAgo(2), trend: 'rising' },
        { topic: 'product design', weight: 0.75, last_boost: daysAgo(3), trend: 'stable' },
        { topic: 'distributed systems', weight: 0.65, last_boost: daysAgo(7), trend: 'stable' },
        { topic: 'web3', weight: 0.2, last_boost: daysAgo(30), trend: 'falling' },
      ],
      context: {
        active_projects: ['recommendation-engine', 'mobile-app'],
        calendar: ['Demo call 14:00', 'Team sync 10:00'],
        recent_conversations: ['LLM fine-tuning', 'series A fundraising'],
        mood_signal: 'focused',
      },
      history: [
        { story_id: 's1', reaction: 'up',   date: daysAgo(1),  topics: ['machine learning', 'LLM'],  source: 'arxiv' },
        { story_id: 's2', reaction: 'share',date: daysAgo(1),  topics: ['startups', 'funding'],       source: 'techcrunch' },
        { story_id: 's3', reaction: 'up',   date: daysAgo(2),  topics: ['product design'],            source: 'substack' },
        { story_id: 's4', reaction: 'down', date: daysAgo(2),  topics: ['crypto', 'nft'],             source: 'coindesk' },
        { story_id: 's5', reaction: 'up',   date: daysAgo(3),  topics: ['distributed systems'],       source: 'hackernews' },
        { story_id: 's6', reaction: 'skip', date: daysAgo(4),  topics: ['politics'],                  source: 'bbc' },
        { story_id: 's7', reaction: 'up',   date: daysAgo(5),  topics: ['machine learning', 'vision'], source: 'arxiv' },
        { story_id: 's8', reaction: 'down', date: daysAgo(6),  topics: ['web3'],                      source: 'decrypt' },
        { story_id: 's9', reaction: 'up',   date: daysAgo(7),  topics: ['startups', 'product'],       source: 'producthunt' },
        { story_id: 's10',reaction: 'share',date: daysAgo(8),  topics: ['machine learning'],          source: 'arxiv' },
        { story_id: 's11',reaction: 'down', date: daysAgo(9),  topics: ['celebrity', 'gossip'],       source: 'buzzfeed' },
        { story_id: 's12',reaction: 'up',   date: daysAgo(10), topics: ['product design', 'ux'],      source: 'nngroup' },
        { story_id: 's13',reaction: 'up',   date: daysAgo(11), topics: ['startups'],                  source: 'ycombinator' },
        { story_id: 's14',reaction: 'down', date: daysAgo(12), topics: ['sports'],                    source: 'espn' },
        { story_id: 's15',reaction: 'skip', date: daysAgo(14), topics: ['real estate'],               source: 'zillow' },
      ],
      source_trust: {
        arxiv: 0.92,
        hackernews: 0.85,
        techcrunch: 0.72,
        substack: 0.68,
        producthunt: 0.70,
        ycombinator: 0.88,
        nngroup: 0.80,
        bbc: 0.60,
        coindesk: 0.35,
        decrypt: 0.30,
        buzzfeed: 0.15,
      },
      beliefs: [
        { topic: 'LLM quality', claim: 'Model size matters less than RLHF quality', strength: 0.75, evidence_count: 3, valid_from: daysAgo(14), valid_to: null, recorded_at: daysAgo(3) },
        { topic: 'startup fundraising', claim: 'Series A is harder in 2026 than 2021', strength: 0.85, evidence_count: 5, valid_from: daysAgo(30), valid_to: null, recorded_at: daysAgo(2) },
      ],
      preferences: [
        { type: 'content_style', description: 'long-form technical deep dives', strength: 0.85, valid_from: daysAgo(20), valid_to: null, recorded_at: daysAgo(5) },
        { type: 'content_style', description: 'hot takes without substance', strength: -0.70, valid_from: daysAgo(20), valid_to: null, recorded_at: daysAgo(5) },
        { type: 'format', description: 'paper summaries with code', strength: 0.80, valid_from: daysAgo(15), valid_to: null, recorded_at: daysAgo(4) },
        { type: 'tone', description: 'skeptical / contrarian analysis', strength: 0.65, valid_from: daysAgo(10), valid_to: null, recorded_at: daysAgo(2) },
      ],
      identities: [
        { role: 'founder', context: 'early-stage AI product', salience: 0.90, valid_from: daysAgo(60), valid_to: null, recorded_at: daysAgo(1) },
        { role: 'engineer', context: 'full-stack / ML', salience: 0.80, valid_from: daysAgo(60), valid_to: null, recorded_at: daysAgo(7) },
      ],
      confidence: {
        'machine learning': 0.78,
        'startups': 0.85,
        'product design': 0.65,
        'distributed systems': 0.60,
        'web3': 0.30,
      },
      clones: [],
    },
    _dimensionalPreferences: [],
    updated_at: now,
  };
}

// ── KG analysis helpers ───────────────────────────────────────────────────────

function applyDecay(interest) {
  const daysSinceBoost = (Date.now() - new Date(interest.last_boost).getTime()) / 86400000;
  const halfLife = 14; // 2-week half-life (matches core/kg.js)
  const decayFactor = Math.pow(0.5, daysSinceBoost / halfLife);
  return interest.weight * decayFactor;
}

function getTopInterests(user, n = 10) {
  return (user.interests || [])
    .map(i => ({ ...i, decayed_weight: applyDecay(i) }))
    .sort((a, b) => b.decayed_weight - a.decayed_weight)
    .slice(0, n);
}

function getTopLiked(user, n = 10) {
  return (user.history || [])
    .filter(h => h.reaction === 'up' || h.reaction === 'share')
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, n);
}

function getTopDisliked(user, n = 5) {
  return (user.history || [])
    .filter(h => h.reaction === 'down')
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, n);
}

function getActiveBeliefs(user) {
  const now = Date.now();
  return (user.beliefs || []).filter(b => {
    const to = b.valid_to ? new Date(b.valid_to).getTime() : Infinity;
    return now < to;
  });
}

function getActivePreferences(user) {
  const now = Date.now();
  return (user.preferences || []).filter(p => {
    const to = p.valid_to ? new Date(p.valid_to).getTime() : Infinity;
    return now < to;
  });
}

function getActiveIdentities(user) {
  const now = Date.now();
  return (user.identities || []).filter(i => {
    const to = i.valid_to ? new Date(i.valid_to).getTime() : Infinity;
    return now < to;
  });
}

function getTopSources(user, n = 5) {
  const trust = user.source_trust || {};
  return Object.entries(trust)
    .sort(([, a], [, b]) => b - a)
    .slice(0, n)
    .map(([src, score]) => ({ source: src, trust: score }));
}

function inferTemporalPatterns(user) {
  const history = user.history || [];
  if (history.length < 5) return null;

  const dayBuckets = { weekday: {}, weekend: {} };
  for (const h of history) {
    if (h.reaction !== 'up' && h.reaction !== 'share') continue;
    const d = new Date(h.date);
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    const bucket = isWeekend ? 'weekend' : 'weekday';
    for (const topic of (h.topics || [])) {
      dayBuckets[bucket][topic] = (dayBuckets[bucket][topic] || 0) + 1;
    }
  }

  const topWeekday = Object.entries(dayBuckets.weekday)
    .sort(([, a], [, b]) => b - a).slice(0, 3).map(([t]) => t);
  const topWeekend = Object.entries(dayBuckets.weekend)
    .sort(([, a], [, b]) => b - a).slice(0, 3).map(([t]) => t);

  return { topWeekday, topWeekend };
}

// ── Main inspection logic ─────────────────────────────────────────────────────

/**
 * Returns a structured user taste profile for agent injection.
 * @param {string} userId - User ID to look up (uses loaded data's user by default)
 * @param {Object} kgData - Raw KG JSON data (from file or synthetic)
 * @returns {Object} Structured taste profile
 */
export function getUserContext(userId, kgData) {
  const user = kgData?.user || {};
  const resolvedId = userId || user.id || 'unknown';

  const topInterests = getTopInterests(user);
  const liked = getTopLiked(user);
  const disliked = getTopDisliked(user);
  const beliefs = getActiveBeliefs(user);
  const preferences = getActivePreferences(user);
  const identities = getActiveIdentities(user);
  const temporal = inferTemporalPatterns(user);
  const trustedSources = getTopSources(user);

  const positivePrefs = preferences.filter(p => p.strength > 0)
    .sort((a, b) => b.strength - a.strength);
  const negativePrefs = preferences.filter(p => p.strength < 0)
    .sort((a, b) => a.strength - b.strength);

  return {
    userId: resolvedId,
    topInterests,
    liked,
    disliked,
    beliefs,
    positivePreferences: positivePrefs,
    negativePreferences: negativePrefs,
    identities,
    temporalPatterns: temporal,
    trustedSources,
    context: user.context || {},
    domainConfidence: user.confidence || {},
    historySize: (user.history || []).length,
  };
}

/**
 * Renders the <user-context> XML block that marble swarm agents receive.
 * Matches the structured block described in MARBLE-FIX-PLAN.md Fix 6.
 */
function renderUserContextBlock(profile) {
  const { userId, topInterests, liked, disliked, positivePreferences, negativePreferences,
          beliefs, identities, temporalPatterns, trustedSources, context, domainConfidence } = profile;

  const lines = [];
  lines.push(`<user-context user="${userId}">`);

  // Interests with decay
  lines.push('  <interests>');
  for (const i of topInterests.slice(0, 8)) {
    const dw = i.decayed_weight.toFixed(3);
    const raw = i.weight.toFixed(2);
    lines.push(`    <interest topic="${i.topic}" weight="${dw}" raw="${raw}" trend="${i.trend || 'stable'}" />`);
  }
  lines.push('  </interests>');

  // Top liked
  lines.push('  <liked_items>');
  for (const h of liked.slice(0, 10)) {
    const topics = (h.topics || []).join(', ');
    const reaction = h.reaction === 'share' ? 'share (strong positive)' : 'up';
    lines.push(`    <item id="${h.story_id}" reaction="${reaction}" topics="${topics}" source="${h.source}" date="${h.date}" />`);
  }
  lines.push('  </liked_items>');

  // Top disliked
  lines.push('  <disliked_items>');
  for (const h of disliked.slice(0, 5)) {
    const topics = (h.topics || []).join(', ');
    lines.push(`    <item id="${h.story_id}" topics="${topics}" source="${h.source}" date="${h.date}" />`);
  }
  lines.push('  </disliked_items>');

  // Explicit preferences
  if (positivePreferences.length > 0) {
    lines.push('  <positive_preferences>');
    for (const p of positivePreferences) {
      lines.push(`    <preference type="${p.type}" description="${p.description}" strength="${p.strength.toFixed(2)}" />`);
    }
    lines.push('  </positive_preferences>');
  }
  if (negativePreferences.length > 0) {
    lines.push('  <negative_preferences>');
    for (const p of negativePreferences) {
      lines.push(`    <preference type="${p.type}" description="${p.description}" strength="${p.strength.toFixed(2)}" />`);
    }
    lines.push('  </negative_preferences>');
  }

  // Beliefs
  if (beliefs.length > 0) {
    lines.push('  <beliefs>');
    for (const b of beliefs) {
      lines.push(`    <belief topic="${b.topic}" strength="${b.strength.toFixed(2)}" evidence="${b.evidence_count || 1}">${b.claim}</belief>`);
    }
    lines.push('  </beliefs>');
  }

  // Identities
  if (identities.length > 0) {
    lines.push('  <identities>');
    for (const id of identities) {
      lines.push(`    <identity role="${id.role}" context="${id.context}" salience="${id.salience.toFixed(2)}" />`);
    }
    lines.push('  </identities>');
  }

  // Temporal patterns
  if (temporalPatterns) {
    lines.push('  <temporal_patterns>');
    if (temporalPatterns.topWeekday.length > 0) {
      lines.push(`    <weekday_topics>${temporalPatterns.topWeekday.join(', ')}</weekday_topics>`);
    }
    if (temporalPatterns.topWeekend.length > 0) {
      lines.push(`    <weekend_topics>${temporalPatterns.topWeekend.join(', ')}</weekend_topics>`);
    }
    lines.push('  </temporal_patterns>');
  }

  // Domain confidence
  const confEntries = Object.entries(domainConfidence).sort(([, a], [, b]) => b - a);
  if (confEntries.length > 0) {
    lines.push('  <domain_confidence>');
    for (const [domain, conf] of confEntries.slice(0, 5)) {
      lines.push(`    <domain name="${domain}" confidence="${conf.toFixed(2)}" />`);
    }
    lines.push('  </domain_confidence>');
  }

  // Trusted sources
  if (trustedSources.length > 0) {
    lines.push('  <trusted_sources>');
    for (const s of trustedSources) {
      lines.push(`    <source name="${s.source}" trust="${s.trust.toFixed(2)}" />`);
    }
    lines.push('  </trusted_sources>');
  }

  // Context signals
  const ctx = context || {};
  if ((ctx.active_projects || []).length > 0 || ctx.mood_signal) {
    lines.push('  <current_context>');
    if ((ctx.active_projects || []).length > 0) {
      lines.push(`    <active_projects>${ctx.active_projects.join(', ')}</active_projects>`);
    }
    if (ctx.mood_signal) {
      lines.push(`    <mood_signal>${ctx.mood_signal}</mood_signal>`);
    }
    if ((ctx.recent_conversations || []).length > 0) {
      lines.push(`    <recent_conversations>${ctx.recent_conversations.join('; ')}</recent_conversations>`);
    }
    lines.push('  </current_context>');
  }

  lines.push('</user-context>');
  return lines.join('\n');
}

// ── Pretty print helpers ──────────────────────────────────────────────────────

function header(title) {
  const bar = '─'.repeat(60);
  console.log(`\n${bar}`);
  console.log(`  ${title}`);
  console.log(bar);
}

function printProfile(profile) {
  const { userId, topInterests, liked, disliked, beliefs, positivePreferences, negativePreferences,
          identities, temporalPatterns, trustedSources, domainConfidence, historySize } = profile;

  header(`User KG Profile — "${userId}"`);
  console.log(`  History entries : ${historySize}`);

  header('Top Interests (with temporal decay)');
  for (const i of topInterests) {
    const bar = '█'.repeat(Math.round(i.decayed_weight * 20));
    const trend = i.trend === 'rising' ? '↑' : i.trend === 'falling' ? '↓' : '→';
    console.log(`  ${trend} ${i.topic.padEnd(28)} ${bar.padEnd(20)} ${(i.decayed_weight * 100).toFixed(1)}%  (raw: ${(i.weight * 100).toFixed(0)}%)`);
  }

  header('Top 10 Liked / Shared Items');
  for (const h of liked) {
    const label = h.reaction === 'share' ? '[SHARE]' : '[UP]   ';
    const topics = (h.topics || []).join(', ');
    console.log(`  ${label}  ${h.story_id.padEnd(10)}  topics: ${topics}  (${h.source})`);
  }

  header('Top 5 Disliked Items');
  for (const h of disliked) {
    const topics = (h.topics || []).join(', ');
    console.log(`  [DOWN]  ${h.story_id.padEnd(10)}  topics: ${topics}  (${h.source})`);
  }

  if (positivePreferences.length > 0 || negativePreferences.length > 0) {
    header('Explicit Preferences');
    for (const p of positivePreferences) {
      console.log(`  [+${p.strength.toFixed(2)}]  ${p.type}: ${p.description}`);
    }
    for (const p of negativePreferences) {
      console.log(`  [${p.strength.toFixed(2)}]  ${p.type}: ${p.description}`);
    }
  }

  if (beliefs.length > 0) {
    header('Active Beliefs');
    for (const b of beliefs) {
      console.log(`  [${(b.strength * 100).toFixed(0)}% conf / ${b.evidence_count || 1} evidence]  ${b.topic}: "${b.claim}"`);
    }
  }

  if (identities.length > 0) {
    header('Identity Attributes');
    for (const id of identities) {
      console.log(`  [salience ${(id.salience * 100).toFixed(0)}%]  ${id.role} — ${id.context}`);
    }
  }

  if (temporalPatterns) {
    header('Temporal Patterns');
    if (temporalPatterns.topWeekday.length > 0)
      console.log(`  Weekday topics : ${temporalPatterns.topWeekday.join(', ')}`);
    if (temporalPatterns.topWeekend.length > 0)
      console.log(`  Weekend topics : ${temporalPatterns.topWeekend.join(', ')}`);
  }

  const confEntries = Object.entries(domainConfidence).sort(([, a], [, b]) => b - a);
  if (confEntries.length > 0) {
    header('Domain Confidence');
    for (const [domain, conf] of confEntries) {
      console.log(`  ${domain.padEnd(28)} ${(conf * 100).toFixed(0)}%`);
    }
  }

  if (trustedSources.length > 0) {
    header('Source Trust Scores (top 5)');
    for (const s of trustedSources) {
      const bar = '█'.repeat(Math.round(s.trust * 20));
      console.log(`  ${s.source.padEnd(20)} ${bar.padEnd(20)} ${(s.trust * 100).toFixed(0)}%`);
    }
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  const { data, source, synthetic } = await loadKGData();
  const userId = userIdArg || data?.user?.id || 'default';

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║          Marble KG Inspector — Agent Context View        ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`\n  KG source : ${source}`);
  if (synthetic) {
    console.log('  ⚠  NOTE: No real KG data found — using SYNTHETIC mock data');
  }

  const profile = getUserContext(userId, data);

  // 1. Human-readable summary
  printProfile(profile);

  // 2. <user-context> block that agents would receive
  header('Agent Injection Block — <user-context>');
  console.log('\nThis is the XML block a marble swarm agent would receive:\n');
  console.log(renderUserContextBlock(profile));

  console.log('\n' + '─'.repeat(60));
  console.log('  Done. Export getUserContext(userId, kgData) for programmatic use.');
  console.log('─'.repeat(60) + '\n');
}

main().catch(err => {
  console.error('inspect-kg error:', err.message);
  process.exit(1);
});
