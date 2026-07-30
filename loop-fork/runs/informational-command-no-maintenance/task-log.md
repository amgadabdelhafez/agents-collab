# Task informational-command-no-maintenance

Created: 2026-07-30T08:13:38Z
Mode: planned
Description: Dispatch nested CLI help and version requests before every startup maintenance action, with exact parser semantics and isolated smoke coverage

## What I changed

Added a side-effect-free information probe that reuses the normal parser's
token consumption, then dispatches it before utility commands, hidden helpers,
and every startup maintenance action.

## Why

`loop collab --help` from run-101 fell through to global startup cleanup,
falsely terminalized the live run, and signaled registered transport processes.

## Notes

Run-101 is frozen read-only. Live smoke and activation remain held until its
running Governess completes governed teardown.

Focused parser and CLI tests pass 95/0. Lint, source typecheck, and compiled
build pass. The full sequential suite passes outside the localhost-binding
sandbox. The realistic smoke is statically validated but execution remains
held until run-101 teardown.

The mandated repository verifier also passed lint, typecheck, build, and the
complete sequential suite, then correctly failed closed at the pending eval
gate. Exact-SHA review and post-teardown smoke are still outstanding.

Independent review then caught that rendering re-entered ambient `parseArgs`.
The descendant uses a dedicated config-independent renderer and adds invalid
ambient-config coverage; focused tests pass 99/0. The earlier review request is
superseded before verdict.

Smoke/lifecycle review then found that a workspace confirmed dead outside the
inner startup catch could leave its manifest active. The descendant routes
every confirmed-dead pre-handoff path through one exact-storage terminalizer,
preserves completed and unknown-liveness semantics, and retains ownership
recorded by another launcher. Focused tmux coverage passes 71/0.

The smoke now seeds a fresh update throttle in every disposable home, verifies
the complete randomized source prompt buffer at greater than 8 KiB, and
requires the missing-workspace manifest to persist `failed/failed`. Runtime
execution remains held until run-101 governed teardown.

All paired pre-bind, layout, attach, and handoff probes now use tri-state
liveness: only recognized no-server/no-session evidence grants failure
authority. Timeout, thrown control errors, and unrecognized nonzero results
preserve active state and current/external transport ownership; a fresh live
probe overrides a stale attach error. Lint, source typecheck, compiled build,
and the complete sequential suite pass.

Regression: yes
Regression id: nested-info-runs-maintenance
Regression symptom: Nested help/version can execute destructive startup maintenance.
Regression guard: bun test tests/loop.test.ts tests/loop/args.test.ts
