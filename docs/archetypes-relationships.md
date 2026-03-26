# Archetypes & Relationship Simulation

## Overview

Marble models the people in a user's life to improve content recommendations. A story about "summer camps for 8-year-olds" only matters if the user has a school-age child. Marble knows that — and uses it.

Two systems work together:
1. **Archetype Generator** — Bootstraps user models from minimal data
2. **Relationship Simulator** — Models dynamics between users and their relationships

## Archetype Generator

### What It Does

Given minimal facts about a person, the archetype generator fills in statistically likely traits to create a full behavioral profile.

```javascript
import { generateArchetype } from './core/archetype-generator.js';

const archetype = generateArchetype({
  relationshipType: 'parent-child',
  ageRange: 'school-age',          // or specific age
  mentionedInterests: ['soccer', 'minecraft'],
  name: 'Maya',
  contextSignals: ['mentioned school pickup']
});
```

**Output:**
```javascript
{
  name: 'Maya',
  relationshipType: 'parent-child',
  ageStage: 'school-age',
  traits: {
    curiosity: 0.8,
    socialNeeds: 0.7,
    independence: 0.4,
    routineDependence: 0.8,
    // ... age-appropriate defaults
  },
  confidenceScores: {
    age: 0.75,
    interests: 0.6,
    traits: 0.45,
    overall: 0.52
  },
  insights: [/* KG-compatible insights */],
  impact: {
    timeCompetition: 'high',
    contentRelevance: ['parenting', 'kids activities', 'education'],
    schedulingImpact: ['school hours', 'pickup', 'bedtime']
  }
}
```

### Archetype Templates

Built-in templates for common relationship types:

| Type | Age Stages | Default Traits |
|------|-----------|----------------|
| Parent-child (daughter) | infant, preschool, school-age, teenager, young-adult | Age-specific curiosity, independence, social needs |
| Parent-child (son) | infant, preschool, school-age, teenager, young-adult | Age-specific with activity preferences |
| Partner | — | Shared decision-making, quality time, communication |
| Colleague | — | Professional boundaries, collaboration style |
| Friend | — | Shared interests, social frequency |
| Parent | — | Care patterns, generational context |
| Sibling | — | Shared history, rivalry/closeness balance |

### Confidence Scoring

Confidence reflects how much the system actually knows vs. assumes:

```
Base: 0.15
+ Relationship type known:  +0.10
+ Age/stage known:          +0.15
+ Each mentioned interest:  +0.05 (max +0.15)
+ Name provided:            +0.05
+ Extra facts:              +0.05 each
```

Low-confidence archetypes get tested through hypothesis injection (see [insight-kg.md](insight-kg.md)).

### Updating Archetypes

As new signals arrive, archetype confidence updates:

```javascript
import { updateArchetype } from './core/archetype-generator.js';

const updated = updateArchetype(archetype, {
  type: 'confirmation',
  trait: 'curiosity',
  evidence: 'User clicked article about kids science experiments'
});
// archetype.confidenceScores.traits increases
```

## Relationship Simulator

### What It Does

Models the dynamics between a user and the people in their life. Predicts needs, detects tensions, and generates relationship-aware content recommendations.

```javascript
import { RelationshipSimulator } from './core/relationship-simulator.js';

const sim = new RelationshipSimulator();

sim.addRelationship({
  person_a: 'alex',              // the user
  person_b: 'maya',              // the archetype
  relationship_type: 'parent-child',
  person_b_profile: archetypeProfile
});
```

### Simulation

Run a relationship simulation to discover opportunities and tensions:

```javascript
const result = sim.simulate('rel-maya', {
  includeActivities: true,
  includeGrowth: true
});
```

**Output:**
```javascript
{
  dynamics: {
    sharedInterests: ['outdoor activities', 'minecraft'],
    tensionPoints: [
      { type: 'time-competition', description: 'Career demands compete with school pickup schedule' },
      { type: 'unmet-need', description: 'Child needs more outdoor time, user focused indoors' }
    ],
    opportunities: [
      'Saturday morning coding together (shared interest + quality time)',
      'After-school soccer practice attendance (presence signal)'
    ]
  },
  recommendations: [
    {
      content_type: 'activity',
      suggestion: 'Weekend coding camps for kids',
      why: 'Combines user interest (tech) with child need (learning + social)',
      confidence: 0.7
    }
  ],
  activities: {
    shared: ['hiking', 'board games', 'cooking'],
    parent_growth: ['patience techniques', 'age-appropriate communication'],
    child_growth: ['STEM activities', 'social skills']
  }
}
```

### Tension Detection

The simulator automatically detects three types of tension:

1. **Time-competition** — User's career/hobby time conflicts with relationship needs
2. **Unmet-need** — The other person's needs aren't reflected in the user's behavior
3. **Interest-misalignment** — Divergent interests creating distance

Tensions influence the swarm agents:
- Career agent factors in relationship time boundaries
- Timing agent knows about school pickup, date nights, family dinners
- Serendipity agent looks for cross-interest discoveries

### Temporal Awareness

The simulator understands time contexts:

| Context | When | Impact on Content |
|---------|------|-------------------|
| School day | Mon-Fri during school year | Productivity window 8am-3pm, pickup at 3pm |
| School holiday | Jun-Aug, Dec breaks | Family activity content boosted |
| Weekend | Sat-Sun | Couple time, family activities |
| Back-to-school | Aug-Sep | School supplies, routine tips |
| Evening | After 7pm | Couple content, personal growth |

### Content Platform Integration

Relationships feed directly into content recommendations:

```javascript
const recommendations = sim.getContentRecommendations({
  limit: 5,
  includeRelationshipContext: true
});

// Returns stories with relationship-aware "why" explanations:
// "Recommended because your daughter Maya (age 8) might enjoy
//  this weekend activity, and it overlaps with your interest in tech"
```

## How Swarm Agents Use Relationships

Each swarm agent incorporates relationship data:

**Career Agent (25%)**
- Boosts content about work-life balance if family relationships detected
- Adjusts for remote work content if parent of young children
- Factors time management content for users with many relationships

**Timing Agent (25%)**
- Knows school schedule (8am-3pm productivity, 3pm pickup)
- Accounts for partner evening time
- Seasonal awareness (summer camps, back-to-school, holiday traditions)
- Age-specific rhythms (baby nap schedules, teenager late nights)

**Serendipity Agent (20%)**
- Finds cross-interest discoveries (user likes coding + child likes art → creative coding)
- Age-appropriate activity suggestions
- Relationship-building opportunities

**Growth Agent (15%)**
- Parenting skills, relationship communication
- Age-stage transitions (toddler → school-age resources)
- Partner relationship improvement content

**Contrarian Agent (15%)**
- Surfaces avoided relationship topics that matter
- Emotional vulnerability content for users who avoid it
- Time boundary content for workaholics with families

## WorldSim: Population-Level Archetypes

The same archetype system powers WorldSim's PMF analysis, but at population scale:

```javascript
import { WorldSim } from 'marble/worldsim';

const worldsim = new WorldSim({ populationSize: 50 });
const pmf = await worldsim.simulate({
  name: 'KidCode',
  description: 'Coding platform for children aged 6-12',
  categories: ['education', 'technology', 'children']
});
```

WorldSim generates 50 synthetic archetypes across 8 segments (early adopter, mainstream, professional, creative, etc.), each evaluating the product through their unique profile. The result tells you which segments care and why.
