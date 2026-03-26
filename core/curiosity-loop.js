/**
 * curiosity-loop.js — Active Insight Discovery Engine
 *
 * Makes Marble insight engine ACTIVE instead of PASSIVE.
 * Generates questions from insights and searches user data for answers.
 *
 * THE CURIOSITY LOOP:
 * 1. Every insight generates 3-5 follow-up questions (WHY, WHERE, HOW OFTEN, WHAT VALUE, WHO WITH)
 * 2. Each question becomes a search query against all available user data
 * 3. Answers found → new confirmed insights → which generate more questions
 * 4. Answers not found → open questions → can be inferred synthetically or left as gaps
 * 5. The loop runs until no new questions can be answered or max depth reached
 */

import { InsightEngine } from './insight-engine.js';

// ─── QUESTION GENERATION PATTERNS ────────────────────────────────────────
const QUESTION_PATTERNS = {
  // For personal preferences/behaviors
  preference: [
    'Why does {subject} prefer {object}?',
    'How often does {subject} engage with {object}?',
    'What value does {subject} get from {object}?',
    'Where does {subject} typically encounter {object}?',
    'Who else shares {subject}\'s interest in {object}?'
  ],

  // For location/place insights
  location: [
    'Why does {subject} spend time in {place}?',
    'How often does {subject} visit {place}?',
    'What does {subject} do in {place}?',
    'Who does {subject} go to {place} with?',
    'When does {subject} typically visit {place}?'
  ],

  // For relationship insights
  relationship: [
    'How did {subject} meet {person}?',
    'What activities do {subject} and {person} do together?',
    'How often does {subject} communicate with {person}?',
    'What role does {person} play in {subject}\'s life?',
    'Where do {subject} and {person} typically interact?'
  ],

  // For behavioral patterns
  behavior: [
    'Why does {subject} do {action}?',
    'When did {subject} start doing {action}?',
    'How often does {subject} do {action}?',
    'What triggers {subject} to do {action}?',
    'What outcome does {subject} expect from {action}?'
  ]
};

// ─── DATA SOURCE SEARCH ADAPTERS ─────────────────────────────────────────
class DataSourceManager {
  constructor(opts = {}) {
    this.sources = new Map();
    this.searchCache = new Map();
  }

  registerSource(name, searchFn) {
    this.sources.set(name, searchFn);
  }

  async searchAllSources(query, maxResults = 10) {
    const results = [];
    const cacheKey = `${query}:${maxResults}`;

    if (this.searchCache.has(cacheKey)) {
      return this.searchCache.get(cacheKey);
    }

    for (const [sourceName, searchFn] of this.sources) {
      try {
        const sourceResults = await searchFn(query, maxResults);
        results.push(...sourceResults.map(r => ({ ...r, source: sourceName })));
      } catch (error) {
        console.warn(`Search failed for ${sourceName}:`, error.message);
      }
    }

    this.searchCache.set(cacheKey, results);
    return results;
  }
}

// ─── MAIN CURIOSITY LOOP ENGINE ──────────────────────────────────────────
export class CuriosityLoop {
  constructor(kg, insightEngine, opts = {}) {
    this.kg = kg;
    this.insightEngine = insightEngine;
    this.dataSourceManager = new DataSourceManager();

    // Configuration
    this.maxDepth = opts.maxDepth || 3;
    this.maxQuestionsPerInsight = opts.maxQuestionsPerInsight || 5;
    this.confidenceThreshold = opts.confidenceThreshold || 0.6;
    this.llmCall = opts.llmCall || null;

    // State tracking
    this.questionsAsked = new Set();
    this.answersFound = new Map();
    this.openQuestions = new Set();
    this.loopHistory = [];
  }

  /**
   * Register a data source for searching
   * @param {string} name - Source identifier
   * @param {function} searchFn - async (query, maxResults) => [{ content, timestamp, metadata }]
   */
  registerDataSource(name, searchFn) {
    this.dataSourceManager.registerSource(name, searchFn);
  }

  /**
   * Start the curiosity loop from all existing insights in KG
   * @returns {object} - { questionsGenerated, answersFound, newInsights, openQuestions }
   */
  async startCuriosityLoop() {
    console.log('🔍 Starting curiosity loop...');

    const results = {
      questionsGenerated: 0,
      answersFound: 0,
      newInsights: 0,
      openQuestions: 0,
      depth: 0
    };

    // Get all existing insights from KG
    const insights = this._extractInsights();
    console.log(`Found ${insights.length} existing insights to explore`);

    let currentDepth = 0;
    let activeInsights = insights;

    while (currentDepth < this.maxDepth && activeInsights.length > 0) {
      console.log(`\n--- Depth ${currentDepth + 1} ---`);

      const depthResults = await this._processInsightBatch(activeInsights, currentDepth);

      // Accumulate results
      results.questionsGenerated += depthResults.questionsGenerated;
      results.answersFound += depthResults.answersFound;
      results.newInsights += depthResults.newInsights;
      results.openQuestions += depthResults.openQuestions;

      // New insights become input for next depth
      activeInsights = depthResults.newInsightObjects;
      currentDepth++;

      // Stop if no new insights were generated
      if (depthResults.newInsights === 0) {
        console.log('No new insights generated, stopping loop');
        break;
      }
    }

    results.depth = currentDepth;
    this.loopHistory.push({ timestamp: Date.now(), results });

    console.log('\n🎯 Curiosity loop complete:', results);
    return results;
  }

  /**
   * Process a batch of insights at current depth
   */
  async _processInsightBatch(insights, depth) {
    const results = {
      questionsGenerated: 0,
      answersFound: 0,
      newInsights: 0,
      openQuestions: 0,
      newInsightObjects: []
    };

    for (const insight of insights) {
      try {
        const questions = this._generateQuestions(insight);
        results.questionsGenerated += questions.length;

        for (const question of questions) {
          if (this.questionsAsked.has(question)) continue;

          this.questionsAsked.add(question);
          const answer = await this._searchForAnswer(question);

          if (answer) {
            results.answersFound++;
            this.answersFound.set(question, answer);

            // Convert answer to new insight
            const newInsight = this._answerToInsight(question, answer, insight);
            if (newInsight) {
              // Store in KG
              this.kg.addInsight({
                id: newInsight.id,
                observation: `Found answer to: ${question}`,
                hypothesis: newInsight.content,
                confidence: newInsight.confidence,
                source: 'curiosity_loop',
                metadata: {
                  parent_insight: insight.id,
                  question: question,
                  depth: depth,
                  discovered_sources: answer.sources
                }
              });

              results.newInsights++;
              results.newInsightObjects.push(newInsight);
            }
          } else {
            this.openQuestions.add(question);
            results.openQuestions++;
          }
        }

      } catch (error) {
        console.warn(`Error processing insight ${insight.id}:`, error.message);
      }
    }

    return results;
  }

  /**
   * Generate questions from an insight
   */
  _generateQuestions(insight) {
    const questions = [];
    const insightType = this._categorizeInsight(insight);
    const patterns = QUESTION_PATTERNS[insightType] || QUESTION_PATTERNS.behavior;

    // Extract key entities from insight
    const entities = this._extractEntities(insight);

    // Generate questions using patterns
    for (let i = 0; i < Math.min(this.maxQuestionsPerInsight, patterns.length); i++) {
      try {
        const question = this._fillQuestionTemplate(patterns[i], entities, insight);
        if (question && !this.questionsAsked.has(question)) {
          questions.push(question);
        }
      } catch (error) {
        console.warn(`Error generating question from pattern: ${error.message}`);
      }
    }

    return questions;
  }

  /**
   * Categorize insight type for question generation
   */
  _categorizeInsight(insight) {
    const content = insight.content?.toLowerCase() || '';

    if (content.includes('location') || content.includes('place') || content.includes('live') || content.includes('visit')) {
      return 'location';
    }
    if (content.includes('relationship') || content.includes('friend') || content.includes('family') || content.includes('colleague')) {
      return 'relationship';
    }
    if (content.includes('prefer') || content.includes('like') || content.includes('interest')) {
      return 'preference';
    }

    return 'behavior';
  }

  /**
   * Extract entities from insight for question templates
   */
  _extractEntities(insight) {
    // Simple entity extraction - could be enhanced with NLP
    const content = insight.content || '';
    const matches = content.match(/(\w+(?:\s+\w+)*)/g) || [];

    return {
      subject: 'user', // Default subject
      object: matches.find(m => m.length > 3) || 'unknown',
      place: matches.find(m => /^[A-Z]/.test(m)) || 'unknown',
      person: matches.find(m => /^[A-Z][a-z]+$/.test(m)) || 'someone',
      action: matches.find(m => m.includes('ing') || m.includes('ed')) || 'activity'
    };
  }

  /**
   * Fill question template with entities
   */
  _fillQuestionTemplate(template, entities, insight) {
    let question = template;

    for (const [key, value] of Object.entries(entities)) {
      question = question.replace(new RegExp(`{${key}}`, 'g'), value);
    }

    return question;
  }

  /**
   * Search all data sources for answer to question
   */
  async _searchForAnswer(question) {
    try {
      const searchResults = await this.dataSourceManager.searchAllSources(question, 5);

      if (searchResults.length === 0) {
        return null;
      }

      // Simple answer extraction - combine top results
      const combinedContent = searchResults
        .slice(0, 3)
        .map(r => r.content)
        .join(' ');

      // Could enhance with LLM-based answer extraction
      if (this.llmCall) {
        const prompt = `Based on this data: "${combinedContent}", answer the question: "${question}". Keep it concise and factual.`;
        const answer = await this.llmCall(prompt);
        return {
          content: answer,
          sources: searchResults.map(r => r.source),
          confidence: this._calculateAnswerConfidence(searchResults),
          raw_data: combinedContent
        };
      }

      return {
        content: combinedContent.substring(0, 200) + '...',
        sources: searchResults.map(r => r.source),
        confidence: this._calculateAnswerConfidence(searchResults),
        raw_data: combinedContent
      };

    } catch (error) {
      console.warn(`Search error for question "${question}":`, error.message);
      return null;
    }
  }

  /**
   * Calculate confidence score for answer
   */
  _calculateAnswerConfidence(searchResults) {
    if (searchResults.length === 0) return 0;

    // Simple confidence calculation - could be enhanced
    const sourceScore = Math.min(searchResults.length / 3, 1) * 0.4;
    const recencyScore = searchResults.every(r => r.timestamp && Date.now() - r.timestamp < 30 * 24 * 60 * 60 * 1000) ? 0.3 : 0.1;
    const contentScore = 0.3; // Placeholder

    return sourceScore + recencyScore + contentScore;
  }

  /**
   * Convert answer to insight object
   */
  _answerToInsight(question, answer, parentInsight) {
    if (!answer || answer.confidence < this.confidenceThreshold) {
      return null;
    }

    return {
      id: `curiosity_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      content: `${question} ${answer.content}`,
      confidence: answer.confidence,
      type: 'discovered_fact',
      timestamp: Date.now(),
      metadata: {
        question,
        answer: answer.content,
        sources: answer.sources,
        parent: parentInsight.id
      }
    };
  }

  /**
   * Extract existing insights from KG
   */
  _extractInsights() {
    const insights = this.kg.getInsights() || [];

    return insights.map(insight => ({
      id: insight.id,
      content: insight.hypothesis || insight.observation || '',
      confidence: insight.confidence || 0.5,
      type: 'insight',
      observation: insight.observation,
      hypothesis: insight.hypothesis,
      source: insight.source,
      ...insight
    }));
  }

  /**
   * Get current status of curiosity loop
   */
  getStatus() {
    return {
      questionsAsked: this.questionsAsked.size,
      answersFound: this.answersFound.size,
      openQuestions: this.openQuestions.size,
      registeredSources: Array.from(this.dataSourceManager.sources.keys()),
      loopHistory: this.loopHistory
    };
  }

  /**
   * Get all open questions (unanswered)
   */
  getOpenQuestions() {
    return Array.from(this.openQuestions);
  }

  /**
   * Get all answered questions
   */
  getAnsweredQuestions() {
    return Object.fromEntries(this.answersFound);
  }
}

// ─── EXAMPLE DATA SOURCE ADAPTERS ────────────────────────────────────────

/**
 * Example: Search Telegram messages
 */
export function createTelegramSearchAdapter(telegramData) {
  return async (query, maxResults) => {
    if (!telegramData || !Array.isArray(telegramData)) return [];

    const results = [];
    const queryWords = query.toLowerCase().split(' ');

    for (const message of telegramData.slice(-1000)) { // Last 1000 messages
      if (!message.text) continue;

      const text = message.text.toLowerCase();
      const matchCount = queryWords.filter(word => text.includes(word)).length;

      if (matchCount > 0) {
        results.push({
          content: message.text,
          timestamp: message.date * 1000,
          metadata: {
            chat: message.chat?.title || 'unknown',
            from: message.from?.first_name || 'unknown',
            relevance: matchCount / queryWords.length
          }
        });
      }

      if (results.length >= maxResults) break;
    }

    return results.sort((a, b) => b.metadata.relevance - a.metadata.relevance);
  };
}

/**
 * Example: Search file system / git history
 */
export function createFileSystemSearchAdapter(basePath) {
  return async (query, maxResults) => {
    // This would use grep, ripgrep, or similar
    // Implementation placeholder
    return [];
  };
}

/**
 * Example: Search calendar/email data
 */
export function createCalendarSearchAdapter(calendarData) {
  return async (query, maxResults) => {
    // Implementation placeholder
    return [];
  };
}