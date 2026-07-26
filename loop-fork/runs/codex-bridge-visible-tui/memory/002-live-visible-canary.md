---
seq: 002
date: 2026-07-26T04:03:16Z
trigger: manual
topic: live-visible-canary
---

## Decided

Every incoming Codex bridge request is submitted through the visible TUI. The
proxy no longer originates app-server turns or steers for bridge delivery.

## Still open

No commit or push was requested. The serial suite retains the unrelated stale
`gpt-5.5` expectation in `paired-options.test.ts`.

## Where we are

Focused lint, 111 tests, build, install, harness preflight, and stop-gate pass.
Live run 38 visibly rendered canary `e9f6b36d-6b05-44a0-9884-5a43dbe92aa9`
and returned `VISIBLE-BRIDGE-CANARY-OK`; its proxy remains live on port 4600.
