/**
 * investigative-committee.js — LLM-powered investigative question engine.
 *
 * The committee is FULLY ADAPTIVE per user — its composition, question types,
 * and investigation angles change based on what data is available and what
 * kind of person we're investigating. Two users will never get the same committee.
 *
 * Architecture (5 layers of depth):
 *   1. analyzeDataLandscape() → what kinds of data do we have?
 *   2. assembleCommittee(landscape) → spawn investigators tailored to the data
 *   3. generateQuestions() → each investigator asks from their angle
 *   4. answerQuestion() → evidence-seeking decomposition + inference
 *   5. generateFollowUpQuestions() → RECURSIVE DEPTH — drill deeper on findings
 *   6. inferPsychology() → go from facts to psychological meaning
 *   7. crossReferenceBeliefs() → find contradictions, clusters, and synthesis gaps
 *   8. debateFindings() → investigators challenge each other's answers
 *   9. runInsightSwarm (external) → wired post-investigation for 7 psychological dimensions
 */

export class InvestigativeCommittee {
  /**
   * @param {Object} kg          - KnowledgeGraph instance
   * @param {Function} llmCall   - async (prompt: string) => string
   * @param {Object} [opts]
   * @param {number} [opts.maxRounds=5]
   * @param {number} [opts.maxQuestionsPerRound=6]
   * @param {number} [opts.maxFollowUpsPerFinding=2]
   * @param {number} [opts.minDiverseAngles=3]
   * @param {boolean} [opts.enableDebate=true]
   * @param {boolean} [opts.enablePsychInference=true]
   * @param {boolean} [opts.enableCrossRef=true]
   * @param {Function} [opts.insightSwarmFn] - async (kg) => Insight[] — called post-investigation
   */
  constructor(kg, llmCall, opts = {}) {
    this.kg = kg;
    this.llmCall = llmCall;
    this.maxRounds = opts.maxRounds || 5;
    this.maxQuestionsPerRound = opts.maxQuestionsPerRound || 6;
    this.maxFollowUpsPerFinding = opts.maxFollowUpsPerFinding ?? 2;
    this.minDiverseAngles = opts.minDiverseAngles || 3;
    this.enableDebate = opts.enableDebate !== false;
    this.enablePsychInference = opts.enablePsychInference !== false;
    this.enableCrossRef = opts.enableCrossRef !== false;
    this._embeddingsProvider = opts.embeddingsProvider || null;
    this._insightSwarmFn = opts.insightSwarmFn || null;

    // Registered data sources: Map<name, async (query) => string[]>
    this._sources = new Map();

    // State
    this._askedQuestions = new Set();
    this._answeredQuestions = new Map();
    this._gaps = [];
    this._committee = null;
    this._questionAngles = new Map();
    this._psychInferences = [];       // psychological inferences derived from findings
    this._crossRefResults = null;     // last cross-reference analysis
  }

  registerSource(name, searchFn) {
    this._sources.set(name, searchFn);
  }

  // ── Data Landscape Analysis ──────────────────────────────

  analyzeDataLandscape() {
    const beliefs = this.kg.getActiveBeliefs?.() || [];
    const prefs = this.kg.getActivePreferences?.() || [];
    const ids = this.kg.getActiveIdentities?.() || [];
    const interests = this.kg.user?.interests || [];
    const history = this.kg.user?.history || [];
    const dimPrefs = this.kg.getDimensionalPreferences?.() || [];
    const sourceNames = [...this._sources.keys()];

    const dataTypes = {};

    if (interests.length > 0) dataTypes.interests = { count: interests.length, sample: interests.slice(0, 5).map(i => i.topic) };
    if (beliefs.length > 0) dataTypes.beliefs = { count: beliefs.length, sample: beliefs.slice(0, 5).map(b => `${b.topic}: ${b.claim}`) };
    if (prefs.length > 0) dataTypes.preferences = { count: prefs.length, sample: prefs.slice(0, 5).map(p => `${p.type}: ${p.description}`) };
    if (ids.length > 0) dataTypes.identities = { count: ids.length, sample: ids.slice(0, 5).map(i => i.role) };
    if (history.length > 0) dataTypes.behavioral = { count: history.length, sample: [] };
    if (dimPrefs.length > 0) dataTypes.taste_dimensions = { count: dimPrefs.length, sample: dimPrefs.slice(0, 5).map(d => `${d.domain}/${d.dimensionId}`) };

    const topics = new Set();
    for (const i of interests) topics.add(i.topic?.toLowerCase());
    for (const b of beliefs) topics.add(b.topic?.toLowerCase());

    const hasHealthData = [...topics].some(t => ['health', 'fitness', 'running', 'diet', 'exercise', 'medical', 'wellness'].includes(t));
    const hasLocationData = [...topics].some(t => ['location', 'city', 'country', 'travel', 'geography', 'moving'].includes(t));
    const hasCareerData = ids.some(i => ['engineer', 'developer', 'designer', 'manager', 'founder', 'investor', 'researcher'].includes(i.role?.toLowerCase()));
    const hasRelationshipData = ids.some(i => ['parent', 'partner', 'spouse', 'sibling', 'friend'].includes(i.role?.toLowerCase()));
    const hasContentData = history.length > 10;

    if (hasHealthData) dataTypes.health_signals = { detected: true };
    if (hasLocationData) dataTypes.location_signals = { detected: true };
    if (hasCareerData) dataTypes.career_signals = { detected: true };
    if (hasRelationshipData) dataTypes.relationship_signals = { detected: true };
    if (hasContentData) dataTypes.content_behavior = { detected: true, interactions: history.length };

    for (const name of sourceNames) {
      dataTypes[`source:${name}`] = { external: true };
    }

    const richness = Math.min(1, (
      interests.length * 0.05 + beliefs.length * 0.1 + prefs.length * 0.08 +
      ids.length * 0.15 + Math.min(history.length, 50) * 0.01 + dimPrefs.length * 0.03
    ));

    const uniqueDomains = new Set([...interests.map(i => i.topic), ...beliefs.map(b => b.topic)]);

    return {
      dataTypes,
      richness,
      userComplexity: Math.min(1, uniqueDomains.size / 10),
      totalSignals: interests.length + beliefs.length + prefs.length + ids.length + history.length,
    };
  }

  // ── Adaptive Committee Assembly ──────────────────────────

  async assembleCommittee() {
    const landscape = this.analyzeDataLandscape();
    const kgSnapshot = this._buildKGSnapshot();

    const prompt = `You are designing an investigative committee to understand a specific user deeply.

DATA LANDSCAPE — what we have to work with:
${JSON.stringify(landscape.dataTypes, null, 2)}

CURRENT KNOWLEDGE:
${kgSnapshot}

DATA RICHNESS: ${(landscape.richness * 100).toFixed(0)}% (${landscape.totalSignals} total signals)
USER COMPLEXITY: ${(landscape.userComplexity * 100).toFixed(0)}% (diversity of domains)

DESIGN A COMMITTEE of 4-6 investigators. Each investigator must:
1. Focus on a SPECIFIC data type or signal category that we actually have
2. Have a unique investigation ANGLE that doesn't overlap with others
3. Ask questions that are ANSWERABLE from the available data types
4. Target a different dimension of understanding (behavioral, psychological, aspirational, relational, temporal, identity)

CRITICAL RULES:
- Do NOT create investigators for data types we don't have
- Each investigator should approach from a DIFFERENT angle
- The committee must collectively cover wide ground
- If data is sparse, create fewer but more focused investigators
- Adapt investigation depth to data richness

Return ONLY a JSON array:
[
  {
    "name": "InvestigatorName",
    "angle": "specific investigation angle for THIS user",
    "dataFocus": "which data types this investigator will primarily query",
    "questionStrategy": "how this investigator approaches questioning given the available data",
    "rationale": "why this investigator matters for THIS specific user"
  }
]`;

    try {
      const raw = await this.llmCall(prompt);
      const committee = this._parseJSON(raw);
      if (Array.isArray(committee) && committee.length > 0) {
        this._committee = committee;
        return committee;
      }
    } catch (err) {
      console.error('[InvestigativeCommittee] committee assembly failed:', err.message);
    }

    this._committee = this._buildFallbackCommittee(landscape);
    return this._committee;
  }

  // ── Question Generation ──────────────────────────────────

  async generateQuestions(kgSnapshot) {
    const snapshot = kgSnapshot || this._buildKGSnapshot();

    if (!this._committee) {
      await this.assembleCommittee();
    }

    const allQuestions = [];

    for (const investigator of this._committee) {
      const prompt = `You are ${investigator.name}, an investigator on a committee studying a user.

YOUR ANGLE: ${investigator.angle}
YOUR DATA FOCUS: ${investigator.dataFocus}
YOUR STRATEGY: ${investigator.questionStrategy}

CURRENT USER KNOWLEDGE:
${snapshot}

PREVIOUSLY ASKED (do not repeat):
${[...this._askedQuestions].slice(-20).map(q => `- ${q}`).join('\n') || '(none yet)'}

Generate 1-2 questions from YOUR specific angle. For each question:
- It must pass the "understanding gate": knowing the answer would meaningfully change our model
- It must be answerable (at least partially) from the data types you focus on
- It must NOT overlap with what other investigators would ask
- It must probe a SPECIFIC unknown, not a vague open-ended inquiry

Return ONLY a JSON array of question strings.`;

      try {
        const raw = await this.llmCall(prompt);
        const questions = this._parseJSONArray(raw);
        for (const q of questions) {
          if (!this._askedQuestions.has(q)) {
            allQuestions.push({ question: q, angle: investigator.angle, investigator: investigator.name });
          }
        }
      } catch {
        // Individual investigator failure is non-fatal
      }
    }

    const selected = allQuestions.slice(0, this.maxQuestionsPerRound);
    for (const q of selected) {
      this._questionAngles.set(q.question, q.angle);
    }
    return selected;
  }

  // ── Gap 1: Recursive Follow-Up Questions ─────────────────

  /**
   * Given a finding, generate deeper follow-up questions.
   * This is the recursive depth mechanism — don't just move to the next
   * topic, DRILL DOWN on what you just found.
   *
   * @param {string} originalQuestion
   * @param {string} finding
   * @returns {Promise<string[]>}
   */
  async generateFollowUpQuestions(originalQuestion, finding) {
    if (this.maxFollowUpsPerFinding <= 0) return [];

    const prompt = `We just discovered this about a user:
Question: "${originalQuestion}"
Finding: "${finding.slice(0, 600)}"

Generate ${this.maxFollowUpsPerFinding} DEEPER follow-up questions that would:
1. Cross-validate — is this finding really true? What would contradict it?
2. Explore meaning — what does this finding MEAN for who this person is?
3. Find consequences — what other behaviors/preferences does this finding predict?

Do NOT re-ask the original question in different words.
Do NOT ask generic questions — each must be specific to this finding.

Return ONLY a JSON array of question strings.`;

    try {
      const raw = await this.llmCall(prompt);
      const followUps = this._parseJSONArray(raw);
      return followUps.filter(q => !this._askedQuestions.has(q)).slice(0, this.maxFollowUpsPerFinding);
    } catch {
      return [];
    }
  }

  // ── Gap 2: Psychological Inference Layer ──────────────────

  /**
   * Go from surface facts to psychological meaning.
   * "He prays daily" is a fact. "He struggles with uncertainty and uses
   * ritual as a grounding mechanism" is an insight.
   *
   * @param {string} fact - The raw finding
   * @param {string[]} evidenceSnippets - Supporting evidence
   * @returns {Promise<Object|null>} { surface, underlying, crossCheck, contentImplication }
   */
  async inferPsychology(fact, evidenceSnippets = []) {
    if (!this.enablePsychInference) return null;

    const evidenceBlock = evidenceSnippets.length > 0
      ? `\nSupporting evidence:\n${evidenceSnippets.slice(0, 8).join('\n')}`
      : '';

    const prompt = `A person has this behavior/fact:
"${fact}"
${evidenceBlock}

What does this reveal about this person psychologically?
Consider: motivations, fears, coping mechanisms, identity formation,
attachment patterns, decision-making biases, self-perception gaps.

Return ONLY a JSON object:
{
  "surface": "what they're doing (1 sentence)",
  "underlying": "why they're really doing it — the psychological driver (1-2 sentences)",
  "crossCheck": "what evidence would confirm or deny this interpretation",
  "contentImplication": "what content would resonate or repel based on this insight"
}`;

    try {
      const raw = await this.llmCall(prompt);
      const result = this._parseJSON(raw);
      if (result && result.surface && result.underlying) {
        this._psychInferences.push({ fact, ...result, inferredAt: new Date().toISOString() });

        // Store as a typed belief distinguishable from raw facts
        this.kg.addBelief(
          `psych:${this._slugify(fact)}`,
          result.underlying,
          0.65 // lower confidence than raw facts — this is interpretation
        );

        return result;
      }
    } catch {
      // non-fatal
    }
    return null;
  }

  // ── Gap 4: Cross-Referencing Across Beliefs ───────────────

  /**
   * Find contradictions, clusters, and synthesis gaps across all known beliefs.
   * This is where the real insights emerge — "values authenticity" + "uses
   * numerology for business decisions" → "how does he reconcile rational
   * engineering with mystical decision-making?" That tension IS the insight.
   *
   * @returns {Promise<{ contradictions: string[], clusters: string[], gaps: string[] }>}
   */
  async crossReferenceBeliefs() {
    if (!this.enableCrossRef) return { contradictions: [], clusters: [], gaps: [] };

    const beliefs = this.kg.getActiveBeliefs?.() || [];
    if (beliefs.length < 3) return { contradictions: [], clusters: [], gaps: [] };

    const prompt = `Here are all known beliefs/findings about a person:
${beliefs.slice(0, 30).map(b => `- [${b.topic}] ${b.claim} (strength: ${b.strength?.toFixed(2) ?? '?'})`).join('\n')}

Find:

1. CONTRADICTIONS — beliefs that conflict with each other. These are gold: the tension
   between contradicting beliefs reveals deep personality structure.
   Format: "Belief A vs Belief B — why this tension matters"

2. CLUSTERS — beliefs that reinforce each other and form a coherent pattern.
   Name the pattern. What archetype does this cluster suggest?
   Format: "Pattern name: [beliefs] — what this cluster reveals"

3. GAPS — obvious questions that SHOULD be asked given the interplay of these beliefs.
   What's missing from the picture that would resolve contradictions or confirm clusters?
   Format: "Question — why answering this would be high-value"

Return ONLY a JSON object:
{
  "contradictions": ["Belief A vs Belief B — why this tension matters", ...],
  "clusters": ["Pattern name: [beliefs] — what this cluster reveals", ...],
  "gaps": ["Question — why answering this would be high-value", ...]
}`;

    try {
      const raw = await this.llmCall(prompt);
      const result = this._parseJSON(raw);
      if (result && (result.contradictions || result.clusters || result.gaps)) {
        this._crossRefResults = {
          ...result,
          contradictions: result.contradictions || [],
          clusters: result.clusters || [],
          gaps: result.gaps || [],
          analyzedAt: new Date().toISOString(),
        };

        // Feed gaps back into the investigation as new questions
        for (const gap of (result.gaps || [])) {
          if (!this._gaps.includes(gap) && !this._askedQuestions.has(gap)) {
            this._gaps.push(gap);
          }
        }

        // Store clusters as identity nodes
        for (const cluster of (result.clusters || [])) {
          const clusterName = cluster.split(':')[0]?.trim();
          if (clusterName) {
            this.kg.addBelief(`cluster:${this._slugify(clusterName)}`, cluster, 0.7);
          }
        }

        return this._crossRefResults;
      }
    } catch {
      // non-fatal
    }

    return { contradictions: [], clusters: [], gaps: [] };
  }

  // ── Debate Mechanism ─────────────────────────────────────

  async debateFindings(findings) {
    if (!this.enableDebate || findings.length === 0) return findings;

    const findingsText = findings.map(f =>
      `[${f.investigator}] Q: ${f.question}\n  A: ${f.answer}`
    ).join('\n\n');

    const prompt = `You are a debate moderator for an investigative committee studying a user.

The committee has produced these findings:
${findingsText}

Your job:
1. Identify any CONTRADICTIONS between findings
2. Flag answers that seem WEAKLY SUPPORTED or OVERCONFIDENT
3. Identify CONNECTIONS between findings that the investigators missed
4. Suggest REVISED confidence levels (0.0-1.0) for each finding
5. Note any SYNTHESIS — what do these findings collectively reveal?

Return ONLY a JSON array matching each finding:
[
  {
    "question": "original question",
    "answer": "original or revised answer",
    "confidence": 0.0-1.0,
    "debateNotes": "what the debate revealed about this finding"
  }
]`;

    try {
      const raw = await this.llmCall(prompt);
      const debated = this._parseJSON(raw);
      if (Array.isArray(debated) && debated.length > 0) {
        return debated;
      }
    } catch {
      // Debate failure is non-fatal
    }

    return findings.map(f => ({
      question: f.question, answer: f.answer, confidence: 0.75, debateNotes: '',
    }));
  }

  // ── Answer Question ──────────────────────────────────────

  async answerQuestion(question) {
    const hasKG = this.kg &&
      typeof this.kg.semanticSearch === 'function' &&
      this.kg._vectorIndex?.size > 0;
    if (this._sources.size === 0 && !hasKG) return null;

    // Step 1 — generate evidence-seeking search queries
    const queryPrompt = `You are building a user understanding system. You have this question about a user:
"${question}"

The data sources available will NOT directly answer this question. You need to find indirect evidence.

Generate up to 5 short search queries that would surface indirect signals relevant to answering this question.
Think about: behavioral data, subscriptions, frequency metrics, content interactions, stated preferences, demographics.

Return ONLY a JSON array of short search query strings. No explanation.
Example: ["run distance logs", "marathon newsletter", "training frequency", "weekly mileage"]`;

    const rawQueries = await this.llmCall(queryPrompt);
    const evidenceQueries = this._parseJSONArray(rawQueries);

    if (evidenceQueries.length === 0) {
      evidenceQueries.push(question);
    }

    // Step 2 — semantic search on KG
    const snippets = [];
    if (hasKG) {
      for (const query of evidenceQueries) {
        try {
          const kgResults = await this.kg.semanticSearch(query, 5, this._embeddingsProvider);
          for (const result of kgResults) {
            snippets.push(`[KG:${result.type}] ${result.text}`);
          }
        } catch { /* non-fatal */ }
      }
    }

    // Step 3 — external data sources (Gap 3: increased snippet limit)
    for (const [, searchFn] of this._sources) {
      for (const query of evidenceQueries) {
        try {
          const results = await searchFn(query);
          if (Array.isArray(results)) snippets.push(...results);
        } catch { /* non-fatal */ }
      }
    }

    if (snippets.length === 0) return null;

    // Step 4 — infer answer from indirect evidence (increased to 20 snippets)
    const context = snippets.slice(0, 20).join('\n---\n');
    const inferPrompt = `Question: "${question}"

The following are indirect signals collected from available data — not direct answers:
${context}

Based on these signals, infer the most likely answer to the question.
Be explicit about what signals led to your conclusion.
If the signals are insufficient to draw a reasonable inference, return exactly: null`;

    const answer = await this.llmCall(inferPrompt);
    const trimmed = answer.trim();
    if (trimmed === 'null' || trimmed === '') return null;
    return trimmed;
  }

  // ── Main Investigation Loop ──────────────────────────────

  /**
   * Run the full investigative loop with:
   * - Adaptive committee (re-assembles each round)
   * - Recursive follow-up questions (drill deeper on findings)
   * - Psychological inference (facts → meaning)
   * - Cross-referencing (contradictions, clusters, gaps)
   * - Debate (investigators challenge each other)
   * - InsightSwarm wiring (post-investigation psychological dimensions)
   *
   * @param {number} [maxRounds]
   * @returns {Promise<Object>}
   */
  async investigate(maxRounds) {
    const limit = maxRounds ?? this.maxRounds;
    let totalAnswered = 0;
    let rounds = 0;

    for (let round = 0; round < limit; round++) {
      rounds++;

      // Re-assemble committee each round (adapts as we learn more)
      if (round > 0) {
        this._committee = null;
      }

      const questionObjs = await this.generateQuestions();
      if (questionObjs.length === 0) break;

      const roundFindings = [];
      const followUpQueue = []; // queue for recursive follow-ups

      for (const qObj of questionObjs) {
        const question = typeof qObj === 'string' ? qObj : qObj.question;
        const investigator = typeof qObj === 'string' ? 'unknown' : qObj.investigator;

        this._askedQuestions.add(question);
        const answer = await this.answerQuestion(question);

        if (answer) {
          roundFindings.push({ question, answer, investigator });

          // Gap 1: Generate recursive follow-ups for this finding
          const followUps = await this.generateFollowUpQuestions(question, answer);
          for (const fq of followUps) {
            followUpQueue.push({ question: fq, investigator: `${investigator}:followup` });
          }
        } else {
          if (!this._gaps.includes(question)) {
            this._gaps.push(question);
          }
        }
      }

      // Process follow-up questions (one level deep per round)
      for (const fuObj of followUpQueue) {
        if (roundFindings.length >= this.maxQuestionsPerRound * 2) break; // cap total work

        this._askedQuestions.add(fuObj.question);
        const answer = await this.answerQuestion(fuObj.question);

        if (answer) {
          roundFindings.push({ question: fuObj.question, answer, investigator: fuObj.investigator });
        }
      }

      // Debate round
      const debated = await this.debateFindings(roundFindings);

      // Store findings + run psychological inference
      for (const finding of debated) {
        this._answeredQuestions.set(finding.question, finding.answer);
        totalAnswered++;

        const confidence = finding.confidence ?? 0.75;
        this.kg.addBelief(
          `investigation:${this._slugify(finding.question)}`,
          finding.answer,
          confidence
        );

        // Gap 2: Psychological inference on significant findings
        if (confidence >= 0.6) {
          await this.inferPsychology(finding.answer);
        }
      }

      // Gap 4: Cross-reference all beliefs at end of round
      if (round === limit - 1 || debated.length === 0) {
        await this.crossReferenceBeliefs();
      }

      if (debated.length === 0) break;
    }

    // Wire InsightSwarm post-investigation
    let insightSwarmResults = null;
    if (this._insightSwarmFn && totalAnswered > 0) {
      try {
        insightSwarmResults = await this._insightSwarmFn(this.kg);
      } catch (err) {
        console.warn('[InvestigativeCommittee] InsightSwarm post-investigation failed:', err.message);
      }
    }

    return {
      answered: totalAnswered,
      gaps: [...this._gaps],
      rounds,
      committee: this._committee,
      psychInferences: this._psychInferences,
      crossRefResults: this._crossRefResults,
      insightSwarmResults,
    };
  }

  // ── Utility Methods ──────────────────────────────────────

  scoreAgainstKG(story, kg) {
    const graph = kg ?? this.kg;
    const topics = story.topics || [];
    if (topics.length === 0) return graph.getInterestWeight('general');
    const weights = topics.map(t => graph.getInterestWeight(t));
    const nonZero = weights.filter(w => w > 0);
    if (nonZero.length === 0) return graph.getInterestWeight('general');
    return nonZero.reduce((sum, w) => sum + w, 0) / nonZero.length;
  }

  getKnowledgeGaps() { return [...this._gaps]; }
  getAnswers() { return new Map(this._answeredQuestions); }
  getCommittee() { return this._committee; }
  getPsychInferences() { return [...this._psychInferences]; }
  getCrossRefResults() { return this._crossRefResults; }

  // ── Private ──────────────────────────────────────────

  _buildKGSnapshot() {
    try {
      const beliefs = this.kg.getActiveBeliefs?.() || [];
      const prefs   = this.kg.getActivePreferences?.() || [];
      const ids     = this.kg.getActiveIdentities?.() || [];

      const lines = [];

      if (beliefs.length)  lines.push('BELIEFS:\n' + beliefs.map(b => `  - ${b.topic}: ${b.claim} (strength: ${b.strength?.toFixed(2) ?? '?'})`).join('\n'));
      if (prefs.length)    lines.push('PREFERENCES:\n' + prefs.map(p => `  - ${p.type}: ${p.description} (strength: ${p.strength?.toFixed(2) ?? '?'})`).join('\n'));
      if (ids.length)      lines.push('IDENTITIES:\n' + ids.map(i => `  - ${i.role}${i.context ? ': ' + i.context : ''} (salience: ${i.salience?.toFixed(2) ?? '?'})`).join('\n'));

      if (this._answeredQuestions.size > 0) {
        const answered = [...this._answeredQuestions.entries()].slice(-10);
        lines.push('PREVIOUS FINDINGS:\n' + answered.map(([q, a]) => `  - Q: ${q}\n    A: ${a}`).join('\n'));
      }

      // Include psychological inferences if available
      if (this._psychInferences.length > 0) {
        lines.push('PSYCHOLOGICAL INFERENCES:\n' + this._psychInferences.slice(-5).map(p =>
          `  - Surface: ${p.surface}\n    Underlying: ${p.underlying}`
        ).join('\n'));
      }

      return lines.join('\n\n') || '(no data yet)';
    } catch {
      return '(unable to read KG)';
    }
  }

  _buildFallbackCommittee(landscape) {
    const committee = [];
    const types = Object.keys(landscape.dataTypes);

    if (types.includes('interests') || types.includes('behavioral')) {
      committee.push({ name: 'BehavioralAnalyst', angle: 'behavioral patterns and engagement signals', dataFocus: 'interests, history', questionStrategy: 'infer motivations from actions', rationale: 'fallback' });
    }
    if (types.includes('beliefs') || types.includes('identities')) {
      committee.push({ name: 'IdentityProber', angle: 'identity and worldview', dataFocus: 'beliefs, identities', questionStrategy: 'probe self-concept and values', rationale: 'fallback' });
    }
    if (types.includes('preferences') || types.includes('taste_dimensions')) {
      committee.push({ name: 'TasteMapper', angle: 'taste patterns and aesthetic preferences', dataFocus: 'preferences, taste_dimensions', questionStrategy: 'map decision patterns', rationale: 'fallback' });
    }
    committee.push({ name: 'GapFinder', angle: 'missing context and unexplored dimensions', dataFocus: 'all available', questionStrategy: 'identify what we dont know', rationale: 'fallback' });

    return committee;
  }

  _parseJSON(raw) {
    const s = String(raw).trim();
    try { return JSON.parse(s); } catch {}
    const fence = s.match(/```json?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fence) { try { return JSON.parse(fence[1].trim()); } catch {} }
    const arr = s.indexOf('['), arrE = s.lastIndexOf(']');
    if (arr !== -1 && arrE > arr) { try { return JSON.parse(s.slice(arr, arrE + 1)); } catch {} }
    const obj = s.indexOf('{'), objE = s.lastIndexOf('}');
    if (obj !== -1 && objE > obj) { try { return JSON.parse(s.slice(obj, objE + 1)); } catch {} }
    return null;
  }

  _parseJSONArray(raw) {
    try {
      const match = raw.match(/\[[\s\S]*\]/);
      if (!match) return [];
      const parsed = JSON.parse(match[0]);
      return Array.isArray(parsed) ? parsed.filter(q => typeof q === 'string' && q.trim()) : [];
    } catch {
      return [];
    }
  }

  _slugify(str) {
    return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 60);
  }
}
