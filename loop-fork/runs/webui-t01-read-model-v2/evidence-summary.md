# T-01 evidence summary

## Outcome

The new control-surface layer materializes canonical fleet/run projections and
bounded timeline rows from durable Loop evidence through a capability-typed
read-only interface. It introduces no Web server, mutation, process, tmux,
maintenance, or message authority.

## Verification

- Focused control-surface suite: 19 tests pass.
- Full `bun run test:ci`: passes in final Harness regression attempt 009.
- Compiled Loop build: passes in final Harness build attempt 009.
- Scoped Ultracite check and `git diff --check`: pass.
- Harness preflight and stop-gate: pass with an empty named baseline.
- Independent exact-SHA review: PASS for
  `b3c33fcbf5fb415431e668e20ab2d2744ffee56e`.

## Safety boundaries

- Canonical identity is only matching repository ID plus run ID from the
  selected durable run root.
- Exact source revisions and directory/file identity fences prevent mixed or
  escaped evidence; source epoch changes retry once then fail bounded-unstable.
- Missing, malformed, stale, future-dated, legacy, and conflicting evidence
  remain explicit and cannot become healthy by default.
- Structured public DTOs use exact allowlists and omit socket, workspace, URL,
  credential, provider, prompt, proof, and hidden payload fields.
- Timeline text is redacted, escaped, deterministically ordered, page-bounded,
  and linked only through opaque evidence references.

## Scope

Product changes are exactly the five approved modules under
`src/loop/control-surface/`; tests are exactly the three new focused files under
`tests/loop/control-surface/`. Remaining changes are task-owned specs and
Harness evidence.
