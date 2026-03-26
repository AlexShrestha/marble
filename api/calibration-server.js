#!/usr/bin/env node

/**
 * Calibration API Server for Prism
 *
 * HTTP endpoints for startups to send outcome data and get calibration status.
 * Auto-tunes Marble weights based on real business metrics.
 */

import express from 'express';
import cors from 'cors';
import { Scorer } from '../core/scorer.js';
import { CalibrationAPI } from '../core/calibration-api.js';

class CalibrationServer {
  constructor(port = 3001) {
    this.app = express();
    this.port = port;
    this.scorers = new Map(); // useCase -> Scorer instance
    this.setupMiddleware();
    this.setupRoutes();
  }

  setupMiddleware() {
    this.app.use(cors());
    this.app.use(express.json({ limit: '10mb' }));

    // Request logging
    this.app.use((req, res, next) => {
      console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
      next();
    });

    // Error handling
    this.app.use((err, req, res, next) => {
      console.error('API Error:', err);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        timestamp: new Date().toISOString()
      });
    });
  }

  setupRoutes() {
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        activeUseCases: Array.from(this.scorers.keys())
      });
    });

    // Main calibration endpoint
    this.app.post('/calibrate', async (req, res) => {
      try {
        const { outcomes, useCase = 'default', targetMetrics } = req.body;

        if (!outcomes || !Array.isArray(outcomes)) {
          return res.status(400).json({
            success: false,
            error: 'outcomes must be a non-empty array',
            timestamp: new Date().toISOString()
          });
        }

        // Get or create scorer for this use case
        const scorer = this.getOrCreateScorer(useCase, targetMetrics);

        // Transform outcomes to validation format expected by CalibrationAPI
        const validationBatch = outcomes.map(outcome => ({
          dimensionScores: outcome.dimensionScores || this.extractDimensionScores(outcome),
          actualMetrics: outcome.actualMetrics || this.extractActualMetrics(outcome),
          baseline: outcome.baseline || this.extractBaseline(outcome),
          metadata: {
            user_id: outcome.user_id,
            content_id: outcome.content_id,
            timestamp: outcome.timestamp || new Date().toISOString(),
            ...outcome.metadata
          }
        }));

        // Run calibration
        const result = await scorer.calibrationApi.calibrateWeights(validationBatch);

        res.json({
          success: true,
          ...result,
          useCase,
          processedOutcomes: outcomes.length
        });

      } catch (error) {
        console.error('Calibration error:', error);
        res.status(500).json({
          success: false,
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    });

    // Get calibration status
    this.app.get('/calibration-status', (req, res) => {
      try {
        const { useCase } = req.query;

        if (useCase && !this.scorers.has(useCase)) {
          return res.status(404).json({
            success: false,
            error: `Use case '${useCase}' not found`,
            availableUseCases: Array.from(this.scorers.keys()),
            timestamp: new Date().toISOString()
          });
        }

        if (useCase) {
          // Status for specific use case
          const scorer = this.scorers.get(useCase);
          const history = scorer.calibrationApi.getCalibrationHistory();
          const configuration = scorer.calibrationApi.exportConfiguration();

          res.json({
            success: true,
            useCase,
            history,
            configuration,
            currentWeights: scorer.dynamicWeights.getCurrentWeights(),
            timestamp: new Date().toISOString()
          });
        } else {
          // Status for all use cases
          const allStatus = {};

          for (const [ucName, scorer] of this.scorers.entries()) {
            allStatus[ucName] = {
              history: scorer.calibrationApi.getCalibrationHistory(),
              currentWeights: scorer.dynamicWeights.getCurrentWeights(),
              targetMetrics: scorer.targetMetrics
            };
          }

          res.json({
            success: true,
            useCases: allStatus,
            totalUseCases: this.scorers.size,
            timestamp: new Date().toISOString()
          });
        }

      } catch (error) {
        console.error('Status error:', error);
        res.status(500).json({
          success: false,
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    });

    // Batch calibration endpoint
    this.app.post('/calibrate-batch', async (req, res) => {
      try {
        const { batchData } = req.body;

        if (!batchData || typeof batchData !== 'object') {
          return res.status(400).json({
            success: false,
            error: 'batchData must be an object with useCase -> outcomes mapping',
            timestamp: new Date().toISOString()
          });
        }

        const results = {};

        for (const [useCase, outcomes] of Object.entries(batchData)) {
          try {
            const scorer = this.getOrCreateScorer(useCase);

            const validationBatch = outcomes.map(outcome => ({
              dimensionScores: outcome.dimensionScores || this.extractDimensionScores(outcome),
              actualMetrics: outcome.actualMetrics || this.extractActualMetrics(outcome),
              baseline: outcome.baseline || this.extractBaseline(outcome),
              metadata: { ...outcome.metadata, user_id: outcome.user_id, content_id: outcome.content_id }
            }));

            results[useCase] = await scorer.calibrationApi.calibrateWeights(validationBatch);
            results[useCase].processedOutcomes = outcomes.length;

          } catch (error) {
            results[useCase] = { success: false, error: error.message };
          }
        }

        res.json({
          success: Object.values(results).every(r => r.success),
          results,
          timestamp: new Date().toISOString()
        });

      } catch (error) {
        console.error('Batch calibration error:', error);
        res.status(500).json({
          success: false,
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    });

    // Get available use cases
    this.app.get('/use-cases', (req, res) => {
      try {
        const mockScorer = this.getOrCreateScorer('temp');
        const availableUseCases = mockScorer.getAvailableUseCases();

        res.json({
          success: true,
          availableUseCases,
          activeUseCases: Array.from(this.scorers.keys()),
          timestamp: new Date().toISOString()
        });

      } catch (error) {
        res.status(500).json({
          success: false,
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    });
  }

  getOrCreateScorer(useCase, targetMetrics = null) {
    if (!this.scorers.has(useCase)) {
      // Create mock KG for API usage
      const mockKG = {
        getInterestWeight: () => 0.5,
        getSourceTrust: () => 0.7,
        hasSeen: () => false,
        getTopInterests: () => ['AI', 'business']
      };

      const scorer = new Scorer(mockKG, {
        useCase,
        legacyMode: false,
        targetMetrics
      });

      // Initialize CalibrationAPI
      scorer.calibrationApi = new CalibrationAPI(scorer);

      this.scorers.set(useCase, scorer);
      console.log(`Created new scorer for use case: ${useCase}`);
    }

    return this.scorers.get(useCase);
  }

  // Helper methods to extract scoring dimensions from outcome data
  extractDimensionScores(outcome) {
    return outcome.dimensionScores || {
      interest_match: outcome.interest_match || 0.5,
      temporal_relevance: outcome.temporal_relevance || 0.5,
      novelty: outcome.novelty || 0.5,
      actionability: outcome.actionability || 0.5,
      source_trust: outcome.source_trust || 0.7
    };
  }

  extractActualMetrics(outcome) {
    const metrics = {};

    // Standard metric mapping
    if ('conversion_rate' in outcome) metrics.conversion_rate = outcome.conversion_rate;
    if ('revenue' in outcome) metrics.revenue = outcome.revenue;
    if ('engagement_time' in outcome) metrics.engagement_time = outcome.engagement_time;
    if ('click_through_rate' in outcome) metrics.click_through_rate = outcome.click_through_rate;
    if ('metric_value' in outcome) metrics.primary = outcome.metric_value;

    return metrics;
  }

  extractBaseline(outcome) {
    const baseline = {};

    // Use baseline values or defaults
    if (outcome.baseline) return outcome.baseline;

    if ('conversion_rate' in outcome) baseline.conversion_rate = 0.10; // 10% baseline
    if ('revenue' in outcome) baseline.revenue = 1000; // $1000 baseline
    if ('engagement_time' in outcome) baseline.engagement_time = 30; // 30s baseline
    if ('click_through_rate' in outcome) baseline.click_through_rate = 0.05; // 5% baseline
    if ('metric_value' in outcome) baseline.primary = 0.5; // 50% baseline

    return baseline;
  }

  start() {
    this.server = this.app.listen(this.port, () => {
      console.log(`🎯 Prism Calibration API Server running on port ${this.port}`);
      console.log(`📊 POST /calibrate - Send outcome data for weight tuning`);
      console.log(`📈 GET /calibration-status - Get calibration history and status`);
      console.log(`🔄 POST /calibrate-batch - Batch calibration for multiple use cases`);
      console.log(`📋 GET /use-cases - List available use cases`);
      console.log(`❤️  GET /health - Health check`);
    });

    return this.server;
  }

  stop() {
    if (this.server) {
      this.server.close();
    }
  }
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = process.env.PORT || 3001;
  const server = new CalibrationServer(port);
  server.start();

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down gracefully');
    server.stop();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down gracefully');
    server.stop();
    process.exit(0);
  });
}

export { CalibrationServer };