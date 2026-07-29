# Plan: Governess pane liveness

## Approach

Keep tmux as the liveness signal and place policy in a small hidden helper.
The launch path configures generic dead-pane visibility and a pane-scoped hook
only after the stable Governess pane ID exists. The helper validates durable
manifest ownership and tmux state twice, applies a run-owned rolling budget,
then asks tmux to respawn the recorded command.

## Sequence

1. Add a focused liveness module containing helper argument parsing, ownership
   checks, durable budget parsing/journaling, and bounded respawn behavior.
2. Dispatch the hidden helper before normal CLI startup maintenance.
3. Configure dead-pane formatting and arm the pane-scoped hook during paired
   workspace creation.
4. Add unit tests for every fail-closed branch, rolling-window behavior,
   tmux command construction, and retained/live pane formatting.
5. Run focused tests, the full verification suite, isolated tmux proof, and an
   exact-SHA independent review before any deploy.

## Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Liveness source | tmux `pane-died` hook | It observes the process exit directly and does not add polling load. |
| Recovery authority | exact manifest + session + pane binding | A stale hook cannot act on a different run or pane. |
| Restart limit | 3 attempts per rolling 5 minutes | Recovers isolated exits while stopping rapid crash loops. |
| Evidence | append-only run-owned JSONL | Survives helper restarts and makes every decision auditable. |
| Process command | `respawn-pane` without replacement command | Reuses the exact original environment and invocation recorded by tmux. |
| Dead display | dynamic border plus `remain-on-exit-format` | Makes the failure visible even when recovery is suppressed or fails. |

## Affected subsystems

- CLI and tmux — adds one hidden lifecycle subcommand and pane hook wiring.
- Governess — only its tmux-hosted process is eligible for bounded recovery.
- Run state — read-only ownership authority; no manifest schema change.
- Observability — adds a run-owned Governess liveness journal.

## Risks

- A stale hook could respawn after teardown. Mitigation: require active
  manifest state and exact session/pane ownership twice, including immediately
  before action.
- A crashing Governess could spin. Mitigation: record attempts before action
  and fail closed at three attempts in five minutes.
- A malformed journal could reset the budget. Mitigation: invalid lines or
  timestamps suppress recovery.
- Quoting errors could arm a nonfunctional hook. Mitigation: construct the
  hook from argv-safe shell quoting and test with an isolated tmux server.

## Not doing

This slice does not change signal handling, add a daemon, or recover any pane
other than the exact Governess pane named by the active manifest.
