# Task webui-control-plane-spec

Created: 2026-08-20T06:38:25Z
Mode: planned
Description: Define the local-first Web UI control surface, authority boundaries, migration slices, and verification contract.

## What I changed

- Created an isolated branch/worktree from `github/main`.
- Inventoried the existing fleet panel, four-pane workspace, Governess board,
  durable manifests/journals, usage readers, bridge, utility-worker view, and
  lifecycle controls.
- Reviewed the prior shadow control-plane design and current upstream Bun,
  React, Vite, SSE, and accessibility guidance.
- Completed the product, architecture, task, and evaluator contracts for the Web UI.
- Incorporated independent runtime, architecture, and UX reviews, including
  server-instance tmux identity, source-purity, deterministic data quality,
  bounded timeline, bootstrap security, responsive interaction, and measurable
  proof contracts.
- Mapped all 20 acceptance criteria to 83 uniquely identified checks.

## Why

The existing tmux surface contains valuable concepts but compresses facts,
interpretation, controls, and adapter state into dense terminal output. A Web UI
can improve legibility and interaction only if it remains a projection of the
durable run state and routes every future mutation through the existing
Governess authority boundary.

## Notes

Regression: no

This is a design-only slice. It does not add dependencies, a server, a browser
bundle, commands, or runtime authority.
