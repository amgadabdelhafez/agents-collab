# Context-pressure loop handoff

## Objective

Restart paired loops before repeated context compaction makes them expensive and
less coherent. Context pressure is the primary signal. Model-specific assistant
turn counts are a secondary guardrail, never the sole universal threshold.

## Evidence and provisional thresholds

The supplied 281-session analysis observed 186 compactions in 47 sessions.
First compaction clustered near 217K context for GPT-5.6-sol, 229K for GPT-5.5,
111K for Codex Spark, and 272-273K for Claude Opus. Turn counts varied sharply
at similar context pressure, so a global turn threshold is invalid.

The first policy version uses the midpoint of the requested operating bands:

| Profile | Handoff context | Handoff assistant turns |
|---|---:|---:|
| GPT-5.6-sol | 185K | 18 |
| GPT-5.5 | 225K | 96 |
| GPT-5.4-mini | 225K | 73 |
| Codex Spark | 105K | 11 |
| Other Codex | 185K | 40 |
| Claude Opus 4.8 | 230K | 95 |
| Claude Opus 5 | 230K | 90 |
| Other Claude | 230K | 90 |

Preparation begins at 75% of the applicable context or turn threshold.

## Decision order

For each primary agent, evaluate in this order:

1. two or more automatic compactions: hard-ceiling handoff;
2. first automatic compaction: handoff after the current atomic step;
3. measured context at or above the profile threshold: handoff;
4. assistant turns at or above the profile threshold: handoff;
5. measured context at or above 75%: prepare;
6. assistant turns at or above 75%: prepare;
7. otherwise healthy.

The reason must name the highest-priority producer-backed signal. Missing or
zero context never becomes context evidence; the turn fallback may still act.
Claude's producer records provider-labeled automatic compactions separately,
so an explicitly manual boundary does not activate this rule. Current Codex
records do not expose trigger kind; its decision records
`compactionBasis="provider-unspecified"` and conservatively treats an observed
compaction as due instead of inventing an automatic label.

## Operational behavior

- Governess persists the current pressure decision for each agent and logs only
  phase transitions.
- On the first transition to `prepare`, Governess sends each primary agent one
  action-oriented, evidence-bearing request to update `PLAN.md`/`status.md`,
  preserve exact checks and blockers, and finish the current bounded milestone.
- In `enforce` mode, the first `handoff` or `hard-ceiling` decision starts the
  existing governed two-phase handover. That controller lets agents finish only
  their current atomic step, validates both bundles, requests safe exits, and
  launches a replacement loop.
- In `observe` mode, decisions and transition logs are produced but no messages
  or lifecycle mutation occurs. `off` disables evaluation.
- Default mode is `enforce` for newly launched Governess processes. Set
  `LOOP_GOVERNESS_CONTEXT_HANDOFF=observe` or `off` to change it.
- Repeated ticks, Governess respawns, and context values fluctuating around a
  boundary must not repeat preparation messages or start multiple handovers.

## Authority and safety boundaries

- Never inject `/compact`, `/rename`, or destructive commands.
- Never kill a working agent to satisfy a threshold. The existing handover
  controller owns drain, bundle validation, safe exit, and replacement launch.
- A context estimate, turn count, or compaction record is lifecycle evidence,
  not release, deployment, permission, routing, or spending authority.
- Unknown tmux control state, stale Governess epoch, dry-run mode, or an already
  active exit lifecycle prevents automatic handover.
- This policy applies only to future processes running the new binary; it does
  not mutate a healthy live loop during development.

## Experiment support

The persisted decisions and transition log must contain model, context, turns,
compactions, selected profile, phase, and reason. This is the producer evidence
for a later matched comparison of pre-compaction restart, one-compaction
restart, and three-compaction continuation. Quality scoring remains separate.

## Out of scope

- Claiming the thresholds are a proven quality optimum.
- Automatically judging task acceptance or milestone quality.
- Deploying the candidate or restarting the currently running loop.
