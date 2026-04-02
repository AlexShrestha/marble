# Marble Examples

Quick-start examples to get up and running with Marble.

## 5-Minute Quickstart

The fastest way to see Marble in action:

```bash
# From the marble-core directory
npm run quickstart

# Or run directly
node examples/quickstart.js
```

This example demonstrates:
- ✅ **Knowledge Graph Setup** - Initialize a user model with interests
- ✅ **Multi-Dimensional Scoring** - Score content across 5 dimensions:
  - Interest Match (how well aligned with user preferences)
  - Temporal Relevance (context and time sensitivity)
  - Novelty (freshness and uniqueness)
  - Actionability (practical utility)
  - Source Trust (source credibility)
- ✅ **Ranking** - See how stories are ranked by relevance
- ✅ **Learning from Feedback** - Observe how user interactions boost related interests

### What You'll See

```
🎯 Marble Quickstart Demo
=========================

1️⃣ Setting up user Knowledge Graph...
   ✅ User model loaded with 3 interests
   📊 Current interests:
      • ai: 0.80
      • startups: 0.60
      • javascript: 0.70

2️⃣ Initializing Marble Scorer...
   ✅ Scorer ready

3️⃣ Scoring sample content...
   ✅ Scored 3 sample stories

📈 Results (ranked by relevance):
=====================================

🏆 #1: New AI Breakthrough Revolutionizes Startups
   📊 Relevance Score: 0.430
   📋 Breakdown:
      • Interest Match: 0.985
      • Temporal Relevance: 0.200
      • Novelty: 1.000
      • Actionability: 0.200
      • Source Trust: 0.500
```

## Next Steps

After running the quickstart:

1. **Explore the Code** - Check `quickstart.js` to understand the basic flow
2. **Read the Docs** - See `../docs/` for detailed documentation:
   - `api-reference.md` - Complete API guide
   - `how-it-works.md` - Deep dive into the algorithm
   - `usage-examples.md` - Real-world integration patterns
3. **Customize** - Try modifying the sample stories or interests
4. **Enable Features** - Uncomment `enableCollaborativeFiltering: true` in the scorer

## File Structure

```
examples/
├── README.md                    # This file
├── quickstart.js                # 5-minute demo
└── data/
    └── quickstart-kg.json       # Demo user knowledge graph
```

## Troubleshooting

**Module not found error?**
Make sure you're running from the `marble-core` directory:
```bash
cd jarvis-dashboard/core/marble
npm run quickstart
```

**Want to see more detail?**
Edit `quickstart.js` and change line 53:
```javascript
enableCollaborativeFiltering: true  // Enable for more comprehensive demo
```

## Questions?

See the documentation in `../docs/` or check out the full API in `../README.md`.
