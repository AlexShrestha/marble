/**
 * investigative-committee.js — LLM-powered investigative question engine.
 *
 * Given a KG snapshot, generates questions that would INCREASE understanding
 * of the user. Each question must pass an "understanding gate" — if knowing
 * the answer would not meaningfully change the user model, the question is
 * dropped. No predefined options. No fallbacks.
 *
 * Flow:
 *   1. generateQuestions(kgSnapshot) → questions that pass the gate
 *   2. answerQuestion(question, sources) → answer or null
 *   3. investigate(maxRounds) → runs the full loop, updates KG, returns gaps
 */

export class InvestigativeCommittee {
  /**
   * @param {Object} kg          - KnowledgeGraph instance
   * @param {Function} llmCall   - async (prompt: string) => string
   * @param {Object} [opts]
   * @param {number} [opts.maxRounds=5]
   * @param {number} [opts.maxQuestionsPerRound=6]
   */
  constructor(kg, llmCall, opts = {}) {
    this.kg = kg;
    this.llmCall = llmCall;
    this.maxRounds = opts.maxRounds || 5;
    this.maxQuestionsPerRound = opts.maxQuestionsPerRound || 6;
    // Optional embeddings provider forwarded to kg.semanticSearch() — useful for
    // testing with mock embeddings or when using a non-default provider.
    this._embeddingsProvider = opts.embeddingsProvider || null;

    // Registered data sources: Map<name, async (query) => string[]>
    this._sources = new Map();

    // State
    this._askedQuestions = new Set();
    this._answeredQuestions = new Map(); // question → answer
    this._gaps = [];                     // questions asked but not answerable
  }

  /**
   * Register a data source.
   * @param {string} name
   * @param {Function} searchFn - async (query: string) => string[]
   */
  registerSource(name, searchFn) {
    this._sources.set(name, searchFn);
  }

  /**
   * Given a KG snapshot string, ask the LLM what questions would increase
   * understanding. Returns only questions that pass the understanding gate.
   *
   * @param {string} kgSnapshot - Serialised summary of current KG state
   * @returns {Promise<string[]>} - Approved questions
   */
  async generateQuestions(kgSnapshot) {
    const prompt = `You are investigating a user to build a deep understanding of who they are.

Here is everything we currently know about them:
${kgSnapshot}

Your task: generate up to ${this.maxQuestionsPerRound} questions. For EACH question you must answer internally: "If we knew the answer, would it meaningfully change our model of this user?"

Rules:
- Only include questions where the answer would change something meaningful.
- Do NOT ask questions with predefined answer sets or multiple-choice framing.
- Do NOT confirm things we already know.
- Do NOT ask vague open-ended questions — each question must probe a specific unknown.
- If you cannot think of any question that would increase understanding, return an empty JSON array.

Return ONLY a JSON array of question strings. No explanation. No commentary.
Example format: ["Why does this person run?", "What is driving their interest in TRT?"]`;

    const raw = await this.llmCall(prompt);
    const questions = this._parseJSONArray(raw);

    // Filter out already-asked questions
    return questions.filter(q => !this._askedQuestions.has(q));
  }

  /**
   * Attempt to answer a question using registered data sources.
   *
   * Answers are almost never direct. For "Is this person an ultra runner?",
   * the data source won't return that string — but it might contain run
   * distances, training frequency, newsletter subscriptions, or other indirect
   * signals. So we first decompose the question into evidence-seeking search
   * queries, then infer from whatever indirect signals we collect.
   *
   * @param {string} question
   * @returns {Promise<string|null>}
   */
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
      // Fallback: use question directly as last resort
      evidenceQueries.push(question);
    }

    // Step 2 — semantic search on KG first (finds related nodes even without exact keyword match)
    const snippets = [];
    if (this.kg && typeof this.kg.semanticSearch === 'function' && this.kg._vectorIndex?.size > 0) {
      for (const query of evidenceQueries) {
        try {
          const kgResults = await this.kg.semanticSearch(query, 5, this._embeddingsProvider);
          for (const result of kgResults) {
            snippets.push(`[KG:${result.type}] ${result.text}`);
          }
        } catch {
          // KG search failure is non-fatal
        }
      }
    }

    // Step 3 — supplement with external data sources
    for (const [, searchFn] of this._sources) {
      for (const query of evidenceQueries) {
        try {
          const results = await searchFn(query);
          if (Array.isArray(results)) snippets.push(...results);
        } catch {
          // Source failure is non-fatal
        }
      }
    }

    if (snippets.length === 0) return null;

    // Step 4 — infer answer from indirect evidence
    const context = snippets.slice(0, 12).join('\n---\n');
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

  /**
   * Run the full investigative loop.
   * Generates questions, searches for answers, stores findings in KG,
   * and records unanswerable questions as knowledge gaps.
   *
   * @param {number} [maxRounds] - Override constructor default
   * @returns {Promise<{ answered: number, gaps: string[], rounds: number }>}
   */
  async investigate(maxRounds) {
    const limit = maxRounds ?? this.maxRounds;
    let totalAnswered = 0;
    let rounds = 0;

    for (let round = 0; round < limit; round++) {
      rounds++;
      const kgSnapshot = this._buildKGSnapshot();
      const questions = await this.generateQuestions(kgSnapshot);

      if (questions.length === 0) break; // Committee has no more useful questions

      let answeredThisRound = 0;

      for (const question of questions) {
        this._askedQuestions.add(question);
        const answer = await this.answerQuestion(question);

        if (answer) {
          this._answeredQuestions.set(question, answer);
          totalAnswered++;
          answeredThisRound++;

          // Store finding in KG as a belief
          this.kg.addBelief(
            `investigation:${this._slugify(question)}`,
            answer,
            0.75
          );
        } else {
          // Unanswerable → knowledge gap
          if (!this._gaps.includes(question)) {
            this._gaps.push(question);
          }
        }
      }

      // If nothing was answered this round, no point continuing
      if (answeredThisRound === 0) break;
    }

    return {
      answered: totalAnswered,
      gaps: [...this._gaps],
      rounds
    };
  }

  /**
   * Score a story against a KnowledgeGraph.
   * All weights are derived from the KG — no hardcoded values.
   *
   * @param {Object} story - Story object with topics[] array
   * @param {Object} [kg]  - KnowledgeGraph instance (defaults to this.kg)
   * @returns {number} Relevance score in [0, 1]
   */
  scoreAgainstKG(story, kg) {
    const graph = kg ?? this.kg;
    const topics = story.topics || [];

    if (topics.length === 0) return graph.getInterestWeight('general');

    const weights = topics.map(t => graph.getInterestWeight(t));
    const nonZero = weights.filter(w => w > 0);
    if (nonZero.length === 0) return graph.getInterestWeight('general');

    return nonZero.reduce((sum, w) => sum + w, 0) / nonZero.length;
  }

  /**
   * Return gaps: questions asked but not answered.
   * @returns {string[]}
   */
  getKnowledgeGaps() {
    return [...this._gaps];
  }

  /**
   * Return all answers found so far.
   * @returns {Map<string, string>}
   */
  getAnswers() {
    return new Map(this._answeredQuestions);
  }

  // ── Private ──────────────────────────────────────────

  _buildKGSnapshot() {
    try {
      const beliefs = this.kg.getActiveBeliefs?.() || [];
      const prefs   = this.kg.getActivePreferences?.() || [];
      const ids     = this.kg.getActiveIdentities?.() || [];
      const insights = this.kg.getInsights?.() || [];

      const lines = [];

      if (beliefs.length)  lines.push('BELIEFS:\n' + beliefs.map(b => `  - ${b.topic}: ${b.value} (confidence: ${b.confidence?.toFixed(2) ?? '?'})`).join('\n'));
      if (prefs.length)    lines.push('PREFERENCES:\n' + prefs.map(p => `  - ${p.category}: ${p.value}`).join('\n'));
      if (ids.length)      lines.push('IDENTITIES:\n' + ids.map(i => `  - ${i.role}: ${i.value}`).join('\n'));
      if (insights.length) lines.push('INSIGHTS:\n' + insights.slice(0, 10).map(i => `  - ${i.hypothesis || i.observation}`).join('\n'));

      return lines.join('\n\n') || '(no data yet)';
    } catch {
      return '(unable to read KG)';
    }
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
    return str.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 60);
  }
}
