/**
 * Observer - KPI tracking and monitoring for Prism
 *
 * Tracks key performance indicators across the system:
 * - signal_capture_rate: Rate of signal extraction from sources
 * - clone_fitness: How well clones match user preferences
 * - prediction_accuracy: Accuracy of story prediction algorithms
 * - world_signal_freshness: How recent/fresh the world signals are
 */

import fs from 'fs/promises';
import path from 'path';

/**
 * Observer class for tracking KPIs and monitoring system health
 */
export class Observer {
  /**
   * @param {string} dataPath - Path to store observer data (default: ./prism-observer.json)
   */
  constructor(dataPath = './prism-observer.json') {
    this.dataPath = dataPath;
    this.data = {
      kpis: {},
      thresholds: {
        signal_capture_rate: { min: 0.7, max: 1.0 },
        clone_fitness: { min: 0.6, max: 1.0 },
        prediction_accuracy: { min: 0.65, max: 1.0 },
        world_signal_freshness: { min: 0.8, max: 1.0 }
      }
    };
    this.loaded = false;
  }

  /**
   * Load existing observer data from disk
   * @private
   */
  async _load() {
    try {
      const fileContent = await fs.readFile(this.dataPath, 'utf-8');
      this.data = JSON.parse(fileContent);
      this.loaded = true;
    } catch (error) {
      // File doesn't exist or is invalid, use defaults
      this.data.kpis = {};
      this.loaded = true;
    }
  }

  /**
   * Save observer data to disk
   * @private
   */
  async _save() {
    await fs.writeFile(this.dataPath, JSON.stringify(this.data, null, 2));
  }

  /**
   * Track a KPI data point
   * @param {string} name - KPI name (signal_capture_rate, clone_fitness, prediction_accuracy, world_signal_freshness)
   * @param {number} value - KPI value (typically 0-1)
   * @param {Date|number} [timestamp] - Timestamp (defaults to now)
   */
  async trackKPI(name, value, timestamp = Date.now()) {
    if (!this.loaded) await this._load();

    const ts = timestamp instanceof Date ? timestamp.getTime() : timestamp;

    if (!this.data.kpis[name]) {
      this.data.kpis[name] = [];
    }

    this.data.kpis[name].push({
      value,
      timestamp: ts
    });

    // Keep only last 1000 data points per KPI to prevent unbounded growth
    if (this.data.kpis[name].length > 1000) {
      this.data.kpis[name] = this.data.kpis[name].slice(-1000);
    }

    await this._save();
  }

  /**
   * Get a report of all KPIs with trends
   * @param {string} [period='week'] - Time period: 'hour', 'day', 'week', 'month'
   * @returns {Object} Report object with KPI summaries and trends
   */
  async getReport(period = 'week') {
    if (!this.loaded) await this._load();

    const periodMs = {
      hour: 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
      week: 7 * 24 * 60 * 60 * 1000,
      month: 30 * 24 * 60 * 60 * 1000
    };

    const cutoff = Date.now() - (periodMs[period] || periodMs.week);
    const report = {
      period,
      generated_at: new Date().toISOString(),
      kpis: {}
    };

    for (const [name, dataPoints] of Object.entries(this.data.kpis)) {
      const recentPoints = dataPoints.filter(p => p.timestamp >= cutoff);

      if (recentPoints.length === 0) {
        report.kpis[name] = {
          count: 0,
          trend: 'no_data',
          status: 'unknown'
        };
        continue;
      }

      const values = recentPoints.map(p => p.value);
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      const min = Math.min(...values);
      const max = Math.max(...values);

      // Calculate trend (comparing first half vs second half)
      let trend = 'stable';
      if (recentPoints.length >= 4) {
        const mid = Math.floor(recentPoints.length / 2);
        const firstHalf = values.slice(0, mid);
        const secondHalf = values.slice(mid);
        const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
        const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

        const change = (secondAvg - firstAvg) / firstAvg;
        if (change > 0.05) trend = 'improving';
        else if (change < -0.05) trend = 'declining';
      }

      // Check status against thresholds
      const threshold = this.data.thresholds[name];
      let status = 'ok';
      if (threshold) {
        if (avg < threshold.min) status = 'below_threshold';
        else if (avg > threshold.max) status = 'above_threshold';
      }

      report.kpis[name] = {
        count: recentPoints.length,
        average: Number(avg.toFixed(3)),
        min: Number(min.toFixed(3)),
        max: Number(max.toFixed(3)),
        latest: Number(values[values.length - 1].toFixed(3)),
        trend,
        status,
        threshold: threshold || null
      };
    }

    return report;
  }

  /**
   * Check thresholds and return alerts
   * @returns {Array} Array of alert objects for KPIs that cross thresholds
   */
  async checkThresholds() {
    if (!this.loaded) await this._load();

    const alerts = [];
    const now = Date.now();
    const recentCutoff = now - (5 * 60 * 1000); // Last 5 minutes

    for (const [name, dataPoints] of Object.entries(this.data.kpis)) {
      const threshold = this.data.thresholds[name];
      if (!threshold) continue;

      const recentPoints = dataPoints.filter(p => p.timestamp >= recentCutoff);
      if (recentPoints.length === 0) continue;

      const latestValue = recentPoints[recentPoints.length - 1].value;

      if (latestValue < threshold.min) {
        alerts.push({
          kpi: name,
          type: 'below_threshold',
          value: latestValue,
          threshold: threshold.min,
          severity: 'warning',
          timestamp: now,
          message: `${name} is below minimum threshold: ${latestValue} < ${threshold.min}`
        });
      } else if (latestValue > threshold.max) {
        alerts.push({
          kpi: name,
          type: 'above_threshold',
          value: latestValue,
          threshold: threshold.max,
          severity: 'info',
          timestamp: now,
          message: `${name} is above maximum threshold: ${latestValue} > ${threshold.max}`
        });
      }
    }

    return alerts;
  }

  /**
   * Get the latest value for a specific KPI
   * @param {string} name - KPI name
   * @returns {number|null} Latest value or null if no data
   */
  async getLatestKPI(name) {
    if (!this.loaded) await this._load();

    const dataPoints = this.data.kpis[name];
    if (!dataPoints || dataPoints.length === 0) return null;

    return dataPoints[dataPoints.length - 1].value;
  }

  /**
   * Update threshold for a KPI
   * @param {string} name - KPI name
   * @param {Object} threshold - Threshold object with min/max values
   */
  async setThreshold(name, threshold) {
    if (!this.loaded) await this._load();

    this.data.thresholds[name] = threshold;
    await this._save();
  }
}