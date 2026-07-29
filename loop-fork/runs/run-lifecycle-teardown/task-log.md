# Task run-lifecycle-teardown

Created: 2026-07-29T06:02:56Z
Mode: planned
Description: Make paired startup and Governess teardown own and reap run-scoped bridge and Codex app-server processes without touching desktop services

## What I changed

- Persist the detached Codex app-server PID with its run manifest.
- Register every bridge MCP process under its exact run directory.
- Reap registered bridge PIDs and the recorded app-server before Governess
  kills its own tmux session.
- Require the app-server PID to own the manifest's listener port before it can
  be signaled.
- Bound persistent transport bootstrap at 20 seconds and fall back to tmux
  bridge delivery after closing partial transport state.

## Why

Governess teardown marked a run stopped and killed tmux but did not own the
detached app-server or bridge children. Persistent transport bootstrap also sat
outside the paired-session rollback boundary and could wait for the general
turn timeout, leaving submitted/running manifests without panes.

## Notes

Regression: yes
Regression id: governed-run-lifecycle-orphans
Regression symptom: Teardown left bridge MCP processes and port 4500 owned by a detached app-server; bootstrap could remain before pane creation.
Regression guard: tests/loop/run-process-cleanup.test.ts and tests/loop/tmux.test.ts

Live smoke `lifecycle-smoke-1` started a full promptless governed workspace in
3.3 seconds. Its manifest recorded app-server PID 41453 on port 4500. Explicit
Governess teardown logged `killed:[41559,41473,41453]`, removed the tmux
session, freed port 4500, and left ChatGPT desktop app-server PID 44149 alive.

Full suite: 1185 pass, 0 fail. `bun run check` passes.
