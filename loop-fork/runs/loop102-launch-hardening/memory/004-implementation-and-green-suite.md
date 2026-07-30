---
seq: 004
date: 2026-07-30T21:02:08Z
trigger: manual
topic: implementation-and-green-suite
---

## Decided

- Positive readiness is the final visible nonempty line equal to Claude's empty
  `❯` composer; stable warnings are never readiness.
- Detached paired launches use `220x60`; valid terminal dimensions remain
  authoritative and single-agent launch behavior is unchanged.

## Still open

- Freeze and independently review the exact candidate commit and binary.
- Run the exact-prebuilt smoke, Harness release gate, and announced deployment.

## Where we are

- Focused tmux tests: 76 pass.
- Formatter/static check: pass.
- Complete `bun run test:ci`: pass outside the socket-restricted sandbox.
- Disposable source-built large-prompt smoke: pass, including delayed Claude,
  timeout cleanup, and full eight-pane `220x60` geometry.
