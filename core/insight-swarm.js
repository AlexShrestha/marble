/**
 * Marble L1.5 Insight Mining Swarm
 *
 * Slot: L1.5 — runs after L1 facts are loaded, before L2 inference gate.
 *
 * Five specialized agents interrogate L1 KG data in parallel, each with a
 * distinct analytical lens. High-confidence outputs (>= 0.7) are tagged as
 * L2 seeds so the inference engine can consume them directly.
 *
 * Usage:
 *   import { runInsightSwarm } from './insight-swarm.js';
 *   const insights = await runInsightSwarm(kg);
 *   // insights: Insight[]  (sorted by confidence desc)
 */

// ─── TYPE ──────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} Insight
 * @property {string} insight          - Human-readable finding
 * @property {number} confidence       - 0-1, certainty of the pattern
 * @property {string[]} supporting_facts - L1 fact refs that back the insight
 * @property {string} lens             - Which agent produced it
 * @property {boolean} [l2_seed]       - true if confidence >= 0.7 (feeds L2)
 */

// ─── HELPERS ───────────────────────────────────────────────────────────────

function getL1Facts(kg) {
  const summary = kg.getMemoryNodesSummary
    ? kg.getMemoryNodesSummary()
    : { beliefs: [], preferences: [], identities: [], confidence: {} };

  const user = kg.user || kg.getUser?.() || {};
  const interests = user.interests || [];
  const history   = user.history   || [];
  const dimPrefs  = kg.getDimensionalPreferences?.() || [];

  return { ...summary, interests, history, dimPrefs, user };
}

// ─── AGENT 1: ContradictionAgent ──────────────────────────────────────────

/**
 * Finds tensions between stated preferences/beliefs and observed behaviour
 * (reaction history + dimensional preferences).
 */
function runContradictionAgent(facts) {
  const insights = [];

  // Beliefs vs negative reactions on the same topic
  for (const belief of facts.beliefs) {
    const topic = belief.topic?.toLowerCase();
    if (!topic) continue;

    const negativeHits = facts.history.filter(h =>
      h.reaction === 'down' &&
      h.topics?.some(t => t.toLowerCase().includes(topic))
    );
    const positiveHits = facts.history.filter(h =>
      (h.reaction === 'up' || h.reaction === 'share') &&
      h.topics?.some(t => t.toLowerCase().includes(topic))
    );

    if (negativeHits.length >= 2 && belief.strength >= 0.6) {
      const ratio = negativeHits.length / Math.max(1, positiveHits.length + negativeHits.length);
      const confidence = Math.min(0.9, 0.4 + ratio * 0.5 + (belief.strength - 0.5) * 0.2);
      insights.push({
        insight: `States strong belief in "${belief.topic}" (strength ${belief.strength.toFixed(2)}) but consistently rejects related content (${negativeHits.length} down-votes vs ${positiveHits.length} up-votes).`,
        confidence,
        supporting_facts: [
          `belief:${belief.topic}:strength=${belief.strength.toFixed(2)}`,
          ...negativeHits.slice(0, 3).map(h => `history:${h.story_id}:down`)
        ],
        lens: 'contradiction'
      });
    }
  }

  // Dimensional preference conflicts: high strength but few positive reactions
  const dimByDomain = {};
  for (const dp of facts.dimPrefs) {
    if (!dimByDomain[dp.domain]) dimByDomain[dp.domain] = [];
    dimByDomain[dp.domain].push(dp);
  }
  for (const [domain, prefs] of Object.entries(dimByDomain)) {
    const strongPositive = prefs.filter(p => p.strength >= 0.6);
    const strongNegative = prefs.filter(p => p.strength <= -0.4);
    if (strongPositive.length > 0 && strongNegative.length > 0) {
      const confidence = Math.min(0.85, 0.45 + (strongNegative.length / (strongPositive.length + strongNegative.length)) * 0.4);
      insights.push({
        insight: `In domain "${domain}", user has ${strongPositive.length} strongly-liked dimensions but also ${strongNegative.length} strongly-disliked — mixed signals within the same domain suggest conflicting sub-preferences.`,
        confidence,
        supporting_facts: [
          ...strongPositive.slice(0, 2).map(p => `dim:${domain}:${p.dimensionId}=+${p.strength.toFixed(2)}`),
          ...strongNegative.slice(0, 2).map(p => `dim:${domain}:${p.dimensionId}=${p.strength.toFixed(2)}`)
        ],
        lens: 'contradiction'
      });
    }
  }

  return insights;
}

// ─── AGENT 2: TemporalDriftAgent ──────────────────────────────────────────

/**
 * Detects values/interests shifting over time by comparing early vs recent
 * reaction windows.
 */
function runTemporalDriftAgent(facts) {
  const insights = [];
  const history = facts.history;
  if (history.length < 10) return insights;

  const sorted = [...history].sort((a, b) => new Date(a.date) - new Date(b.date));
  const mid = Math.floor(sorted.length / 2);
  const early  = sorted.slice(0, mid);
  const recent = sorted.slice(mid);

  // Topic frequency comparison
  const topicFreq = (entries) => {
    const freq = {};
    for (const h of entries) {
      for (const t of (h.topics || [])) {
        const key = t.toLowerCase();
        if (!freq[key]) freq[key] = { up: 0, down: 0, skip: 0 };
        if (h.reaction === 'up' || h.reaction === 'share') freq[key].up++;
        else if (h.reaction === 'down') freq[key].down++;
        else freq[key].skip++;
      }
    }
    return freq;
  };

  const earlyFreq  = topicFreq(early);
  const recentFreq = topicFreq(recent);

  const allTopics = new Set([...Object.keys(earlyFreq), ...Object.keys(recentFreq)]);

  for (const topic of allTopics) {
    const e = earlyFreq[topic]  || { up: 0, down: 0, skip: 0 };
    const r = recentFreq[topic] || { up: 0, down: 0, skip: 0 };

    const earlyScore  = (e.up - e.down) / Math.max(1, e.up + e.down + e.skip);
    const recentScore = (r.up - r.down) / Math.max(1, r.up + r.down + r.skip);
    const drift = recentScore - earlyScore;

    if (Math.abs(drift) >= 0.4 && (e.up + e.down + r.up + r.down) >= 4) {
      const direction = drift > 0 ? 'growing' : 'declining';
      const confidence = Math.min(0.88, 0.45 + Math.abs(drift) * 0.5);
      insights.push({
        insight: `Interest in "${topic}" is ${direction} over time (early engagement score ${earlyScore.toFixed(2)} → recent ${recentScore.toFixed(2)}, drift ${drift > 0 ? '+' : ''}${drift.toFixed(2)}).`,
        confidence,
        supporting_facts: [
          `temporal:${topic}:early_score=${earlyScore.toFixed(2)}`,
          `temporal:${topic}:recent_score=${recentScore.toFixed(2)}`,
          `temporal:${topic}:sample_size=${e.up+e.down+r.up+r.down}`
        ],
        lens: 'temporal_drift'
      });
    }
  }

  // Interest trend flags from KG
  for (const interest of facts.interests) {
    if (interest.trend === 'falling' && interest.weight >= 0.5) {
      insights.push({
        insight: `Topic "${interest.topic}" has a high weight (${interest.weight.toFixed(2)}) but is trending downward — may represent a fading but once-strong interest.`,
        confidence: 0.62,
        supporting_facts: [
          `interest:${interest.topic}:weight=${interest.weight.toFixed(2)}`,
          `interest:${interest.topic}:trend=falling`
        ],
        lens: 'temporal_drift'
      });
    }
  }

  return insights;
}

// ─── AGENT 3: CorrelationAgent ────────────────────────────────────────────

/**
 * Surfaces unexpected co-occurrence links across domains — e.g. stories
 * liked together that span career + health, or belief clusters that bridge
 * unrelated domains.
 */
function runCorrelationAgent(facts) {
  const insights = [];

  // Build co-reaction map: when user reacts positively to a story, record ALL topics together
  const coMatrix = {};
  for (const h of facts.history) {
    if (h.reaction !== 'up' && h.reaction !== 'share') continue;
    const topics = (h.topics || []).map(t => t.toLowerCase());
    for (let i = 0; i < topics.length; i++) {
      for (let j = i + 1; j < topics.length; j++) {
        const key = [topics[i], topics[j]].sort().join('|||');
        coMatrix[key] = (coMatrix[key] || 0) + 1;
      }
    }
  }

  // Find pairs that co-occur more than expected (>= 3 times)
  for (const [pair, count] of Object.entries(coMatrix)) {
    if (count < 3) continue;
    const [a, b] = pair.split('|||');

    // Check that individual frequencies are not trivially linked
    const aCount = facts.history.filter(h =>
      (h.reaction === 'up' || h.reaction === 'share') &&
      h.topics?.some(t => t.toLowerCase() === a)
    ).length;
    const bCount = facts.history.filter(h =>
      (h.reaction === 'up' || h.reaction === 'share') &&
      h.topics?.some(t => t.toLowerCase() === b)
    ).length;

    const expected = (aCount * bCount) / Math.max(1, facts.history.length);
    const lift = count / Math.max(0.01, expected);

    if (lift >= 2.5) {
      const confidence = Math.min(0.85, 0.4 + Math.min(lift / 10, 0.3) + Math.min(count / 20, 0.15));
      insights.push({
        insight: `Unexpected cross-domain link: "${a}" and "${b}" co-occur ${count}× in positive reactions (lift ${lift.toFixed(1)}x above baseline) — suggests an untracked bridging interest.`,
        confidence,
        supporting_facts: [
          `cooccurrence:${a}+${b}:count=${count}`,
          `cooccurrence:${a}+${b}:lift=${lift.toFixed(1)}`,
          `topic:${a}:positive_count=${aCount}`,
          `topic:${b}:positive_count=${bCount}`
        ],
        lens: 'correlation'
      });
    }
  }

  // Cross-domain belief clusters
  const beliefTopics = facts.beliefs.map(b => b.topic?.toLowerCase()).filter(Boolean);
  const identityDomains = facts.identities.map(i => i.role?.toLowerCase()).filter(Boolean);
  const overlap = beliefTopics.filter(t => identityDomains.some(d => d.includes(t) || t.includes(d)));
  if (overlap.length >= 2) {
    insights.push({
      insight: `Identity domains and belief topics overlap on: ${overlap.slice(0, 4).join(', ')} — identity may be reinforcing or constraining belief formation in these areas.`,
      confidence: 0.66,
      supporting_facts: overlap.slice(0, 4).map(t => `belief-identity-overlap:${t}`)
    });
  }

  return insights;
}

// ─── AGENT 4: BlindSpotAgent ──────────────────────────────────────────────

/**
 * Identifies what is absent from the KG that should be present given other facts.
 * E.g. strong career identity but no health/wellness signals, or many beliefs but
 * no corresponding confidence entries.
 */
function runBlindSpotAgent(facts) {
  const insights = [];

  const beliefTopics     = new Set(facts.beliefs.map(b => b.topic?.toLowerCase()).filter(Boolean));
  const confidenceDomains = new Set(Object.keys(facts.confidence || {}).map(k => k.toLowerCase()));
  const identityDomains   = new Set(facts.identities.map(i => i.role?.toLowerCase()).filter(Boolean));
  const interestTopics    = new Set(facts.interests.map(i => i.topic?.toLowerCase()).filter(Boolean));

  // Strong beliefs with no confidence tracking
  for (const belief of facts.beliefs) {
    const t = belief.topic?.toLowerCase();
    if (!t) continue;
    if (belief.strength >= 0.7 && !confidenceDomains.has(t)) {
      insights.push({
        insight: `Strong belief in "${belief.topic}" (strength ${belief.strength.toFixed(2)}) but no confidence score tracked for this domain — blind spot in self-calibration.`,
        confidence: 0.68,
        supporting_facts: [
          `belief:${belief.topic}:strength=${belief.strength.toFixed(2)}`,
          `missing:confidence:${belief.topic}`
        ],
        lens: 'blind_spot'
      });
    }
  }

  // Career/professional identity without any health/wellness interests
  const hasCareerIdentity = [...identityDomains].some(d => d.includes('career') || d.includes('work') || d.includes('professional'));
  const hasHealthInterest = [...interestTopics].some(t => t.includes('health') || t.includes('wellness') || t.includes('fitness'));
  if (hasCareerIdentity && !hasHealthInterest && facts.history.length >= 20) {
    insights.push({
      insight: 'Professional identity is present but health/wellness is entirely absent from interests — common blind spot where career focus crowds out self-care signals.',
      confidence: 0.72,
      supporting_facts: [
        'identity:career_or_professional:present',
        'interest:health/wellness:absent',
        `history:sample_size=${facts.history.length}`
      ],
      lens: 'blind_spot'
    });
  }

  // Topics frequently in history but not in interests/beliefs
  const historyTopicCounts = {};
  for (const h of facts.history) {
    for (const t of (h.topics || [])) {
      const key = t.toLowerCase();
      historyTopicCounts[key] = (historyTopicCounts[key] || 0) + 1;
    }
  }
  for (const [topic, count] of Object.entries(historyTopicCounts)) {
    if (count >= 5 && !interestTopics.has(topic) && !beliefTopics.has(topic)) {
      insights.push({
        insight: `Topic "${topic}" appears ${count}× in reaction history but is absent from tracked interests and beliefs — unacknowledged recurring interest.`,
        confidence: Math.min(0.80, 0.45 + Math.min(count / 30, 0.35)),
        supporting_facts: [
          `history:${topic}:count=${count}`,
          `interest:${topic}:absent`,
          `belief:${topic}:absent`
        ],
        lens: 'blind_spot'
      });
    }
  }

  return insights;
}

// ─── AGENT 5: IntensityAgent ──────────────────────────────────────────────

/**
 * Ranks what the user cares about most vs least by aggregating signal density
 * across beliefs, interests, history reactions, and dimensional preferences.
 */
function runIntensityAgent(facts) {
  const insights = [];
  const scores = {};

  // Accumulate signal per topic
  const bump = (topic, amount) => {
    const key = topic.toLowerCase();
    if (!scores[key]) scores[key] = { total: 0, signals: [] };
    scores[key].total += amount;
  };

  for (const b of facts.beliefs) {
    if (b.topic) bump(b.topic, b.strength * 2 + (b.evidence_count || 1) * 0.1);
  }
  for (const i of facts.interests) {
    if (i.topic) bump(i.topic, i.weight * 1.5 + (i.trend === 'rising' ? 0.2 : i.trend === 'falling' ? -0.1 : 0));
  }
  for (const h of facts.history) {
    const delta = h.reaction === 'up' ? 0.1 : h.reaction === 'share' ? 0.15 : h.reaction === 'down' ? -0.05 : 0;
    for (const t of (h.topics || [])) bump(t, delta);
  }
  for (const dp of facts.dimPrefs) {
    if (dp.domain) bump(dp.domain, dp.strength * dp.confidence);
  }

  const ranked = Object.entries(scores)
    .filter(([, v]) => v.total > 0)
    .sort((a, b) => b[1].total - a[1].total);

  if (ranked.length < 2) return insights;

  const top5    = ranked.slice(0, 5);
  const bottom5 = ranked.slice(-5).reverse();
  const maxScore = top5[0][1].total;

  if (top5.length >= 3) {
    insights.push({
      insight: `Top signal-density topics: ${top5.map(([t, v]) => `${t} (${v.total.toFixed(1)})`).join(', ')} — these dominate the user's cognitive footprint.`,
      confidence: Math.min(0.90, 0.55 + Math.min(ranked.length / 50, 0.35)),
      supporting_facts: top5.map(([t, v]) => `intensity:${t}:score=${v.total.toFixed(1)}`),
      lens: 'intensity'
    });
  }

  if (bottom5.length >= 2) {
    insights.push({
      insight: `Weakest signal topics: ${bottom5.map(([t, v]) => `${t} (${v.total.toFixed(1)})`).join(', ')} — low density despite appearing in KG.`,
      confidence: 0.58,
      supporting_facts: bottom5.map(([t, v]) => `intensity:${t}:score=${v.total.toFixed(1)}`),
      lens: 'intensity'
    });
  }

  // Extreme concentration: top topic has >> 3× second topic
  if (top5.length >= 2 && top5[0][1].total > top5[1][1].total * 3) {
    insights.push({
      insight: `Hyper-concentrated focus: "${top5[0][0]}" outscores the #2 topic by ${(top5[0][1].total / top5[1][1].total).toFixed(1)}× — risk of tunnel-vision or filter bubble.`,
      confidence: 0.74,
      supporting_facts: [
        `intensity:${top5[0][0]}:score=${top5[0][1].total.toFixed(1)}`,
        `intensity:${top5[1][0]}:score=${top5[1][1].total.toFixed(1)}`
      ],
      lens: 'intensity'
    });
  }

  return insights;
}

// ─── AGGREGATOR ───────────────────────────────────────────────────────────

/**
 * Deduplicates insights by fuzzy key, ranks by confidence + novelty (lens diversity).
 * Tags high-confidence outputs as L2 seeds.
 */
function aggregate(rawInsights) {
  // Simple dedup: if two insights share the same first 60 chars, keep the higher confidence one
  const seen = new Map();
  for (const ins of rawInsights) {
    const key = ins.insight.slice(0, 60).toLowerCase().replace(/\s+/g, ' ');
    const existing = seen.get(key);
    if (!existing || ins.confidence > existing.confidence) {
      seen.set(key, ins);
    }
  }

  const deduped = [...seen.values()];

  // Boost score for cross-lens diversity (reward lenses not yet well-represented)
  const lensCount = {};
  for (const ins of deduped) lensCount[ins.lens] = (lensCount[ins.lens] || 0) + 1;

  const scored = deduped.map(ins => ({
    ...ins,
    _rank: ins.confidence + (1 / (lensCount[ins.lens] || 1)) * 0.05,
    l2_seed: ins.confidence >= 0.7
  }));

  scored.sort((a, b) => b._rank - a._rank);

  // Remove internal rank helper before returning.
  // Add swarm.js consumer aliases (B3 fix — schema bridge).
  return scored.map(({ _rank, ...rest }) => ({
    ...rest,
    observation:           rest.insight,
    hypothesis:            rest.insight,
    derived_predictions:   [],
    contradicting_signals: rest.lens === 'contradiction' ? (rest.supporting_facts || []) : [],
    source_layer:          'l1.5',
  }));
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────

/**
 * Run the L1.5 Insight Mining Swarm.
 *
 * @param {import('./kg.js').KnowledgeGraph} kg - Loaded KG instance
 * @returns {Promise<Insight[]>} Insights sorted by confidence descending
 */
export async function runInsightSwarm(kg) {
  const facts = getL1Facts(kg);

  // Run all agents in parallel
  const [
    contradictions,
    temporalDrifts,
    correlations,
    blindSpots,
    intensities
  ] = await Promise.all([
    Promise.resolve(runContradictionAgent(facts)),
    Promise.resolve(runTemporalDriftAgent(facts)),
    Promise.resolve(runCorrelationAgent(facts)),
    Promise.resolve(runBlindSpotAgent(facts)),
    Promise.resolve(runIntensityAgent(facts))
  ]);

  const all = [
    ...contradictions,
    ...temporalDrifts,
    ...correlations,
    ...blindSpots,
    ...intensities
  ];

  return aggregate(all);
}

/**
 * Get only L2-seed insights (confidence >= 0.7).
 *
 * @param {import('./kg.js').KnowledgeGraph} kg
 * @returns {Promise<Insight[]>}
 */
export async function getL2Seeds(kg) {
  const insights = await runInsightSwarm(kg);
  return insights.filter(i => i.l2_seed);
}
