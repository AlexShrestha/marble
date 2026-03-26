# Marble Calibration API

HTTP API for startups to send outcome data and auto-tune Marble scoring weights based on real business metrics.

## Quick Start

```bash
# Start the calibration API server
node api/calibration-server.js

# Server runs on port 3001 (or PORT environment variable)
```

## API Endpoints

### POST /calibrate

Send outcome data to auto-tune scoring weights.

```json
POST /calibrate
Content-Type: application/json

{
  "outcomes": [
    {
      "user_id": "user_123",
      "content_id": "content_456",
      "conversion_rate": 0.15,
      "revenue": 2500,
      "baseline": {
        "conversion_rate": 0.10,
        "revenue": 1800
      },
      "dimensionScores": {
        "interest_match": 0.8,
        "temporal_relevance": 0.6,
        "novelty": 0.7,
        "actionability": 0.9,
        "source_trust": 0.8
      }
    }
  ],
  "useCase": "ecommerce",
  "targetMetrics": ["conversion_rate", "revenue"]
}
```

**Response:**
```json
{
  "success": true,
  "processedRecords": 1,
  "performanceImprovement": 0.35,
  "confidence": 0.75,
  "insights": {
    "keyFindings": ["Scoring performance improving significantly"],
    "weightChanges": {...}
  }
}
```

### GET /calibration-status

Get calibration history and current system status.

```bash
GET /calibration-status?useCase=ecommerce
```

**Response:**
```json
{
  "success": true,
  "useCase": "ecommerce",
  "history": {
    "totalCalibrations": 5,
    "averageImprovement": 0.234,
    "confidence": 0.85
  },
  "currentWeights": {
    "interest_match": 0.35,
    "actionability": 0.25,
    "temporal_relevance": 0.20,
    "novelty": 0.15,
    "source_trust": 0.05
  }
}
```

### POST /calibrate-batch

Batch calibration for multiple use cases.

```json
POST /calibrate-batch
Content-Type: application/json

{
  "batchData": {
    "ecommerce": [...outcomes...],
    "email_campaign": [...outcomes...]
  }
}
```

### GET /use-cases

List available use case configurations.

```bash
GET /use-cases
```

### GET /health

Health check endpoint.

```bash
GET /health
```

## Data Flow

1. **Startup defines target metric** (e.g., `conversion_rate`)
2. **Marble scores content** for users using current weights
3. **Startup sends outcomes** via POST /calibrate with actual results
4. **Marble correlates** which scoring dimensions predicted success
5. **Weights auto-adjust** - predictive dimensions get boosted
6. **Clone fitness evolves** to optimize for the real target metric

## Weight Learning

The system learns which dimensions actually predict your business metrics:

- **High performers** with high `interest_match` → boost interest_match weight
- **Low performers** with high `novelty` → reduce novelty weight
- **Consistent patterns** → increase confidence and stability

## Testing

```bash
# Run calibration API tests
node test/test-calibration-api.js

# Run comprehensive metric-agnostic tests
node test/test-metric-agnostic-scorer.js
```

## Use Cases

- **E-commerce**: Optimize for conversion_rate, revenue
- **Email campaigns**: Optimize for reply_rate, click_through_rate
- **Content curation**: Optimize for engagement_time, share_rate
- **Custom**: Define your own metrics and use cases

The system adapts to YOUR business metrics, not generic engagement scores.