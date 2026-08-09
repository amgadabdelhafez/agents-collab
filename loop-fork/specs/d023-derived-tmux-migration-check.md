# D-023 Derived tmux migration check

## Problem

The socket migration currently relies on focused consumer tests and manual
source sweeps. A newly added direct tmux invocation, bare-session liveness
call, unqualified attach formatter, or authority-widening API can silently
reintroduce ambient server selection.

## Required behavior

- A source-derived check scans tracked production TypeScript rather than a
  hand-maintained consumer list.
- Direct Bun-array and Node command/args tmux invocations fail unless produced
  through the approved tmux authority module. The sole installation exception
  is the exact `tmux -V` probe in `install.ts`.
- Bare-session shared-liveness calls and unqualified attach formatters fail.
- Imports or re-exports of the private socket-only composer, caller-supplied
  target flags outside the authority module, and pane-effect APIs accepting
  bare pane strings or separable target-plus-pane arguments fail.
- The check is wired into the repository verifier before tests or smoke can
  contact tmux.
- Each rule family has an independent temporary seeded-tree regression proving
  a violation returns nonzero without modifying tracked source.

## Acceptance

- The checker passes on tracked production source.
- Seeded Bun-array, Node spawn, second install invocation, indirect alias,
  private-composer import, target-flag, bare-pane, bare-liveness, and attach
  violations each fail independently.
- The implementation states its analysis method and records what it cannot
  prove about runtime value provenance.
- Exported compatibility dependency surfaces may retain pane lookup strings
  only with the explicit `@tmux-pane-request-only` restriction; those strings
  cannot carry socket authority and the default adapter must re-resolve them
  through a current manifest handle before contact.
- Focused checker tests, scoped static analysis, build, diff check, and an
  independent zero-write review pass.
