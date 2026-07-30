# informational-command-no-maintenance Plan

Mode: planned
Description: Dispatch nested CLI help and version requests before every startup maintenance action, with exact parser semantics and isolated smoke coverage

## Objective

Ensure syntactically active nested help/version requests return before every
startup maintenance action, without treating option values or post-`--`
literals as information requests.

## Scope

- Parser-shared, side-effect-free informational-request detection.
- CLI early dispatch and zero-maintenance regression coverage.
- Realistic launch-smoke isolation for HOME, Claude, Codex, loop storage, and
  tmux state.
- Fail-closed paired startup accounting and cold macOS tmux-socket handling.
- Exact-binary release smoke plus a disposable default-mode build.
- Replayable Harness evidence and exact-SHA independent review.


## Proposed Tasks

### 1. Implement

- [x] Add the parser-shared information probe.
- [x] Move nested information dispatch ahead of global startup maintenance.
- [x] Harden smoke environment isolation and real-home absence assertions.
- [x] Preserve ownership on unknown liveness and terminalize only confirmed
      missing paired workspaces.
- [x] Recognize cold-socket ENOENT only during the initial pre-resource probe.
- [x] Add hash-bound prebuilt smoke mode and move default compilation into
      disposable smoke storage.

### 2. Test and verify

- [x] Run focused CLI/parser tests.
- [x] Run the full sequential suite with an empty baseline-failure list.
- [x] Bank exact installed-binary and default disposable-build smoke evidence.
- [x] Obtain exact-SHA reviews for production code and release-smoke source.
- [x] Pass Harness preflight and stop-gate before canonical adoption.

## Non-goals

- Repairing or mutating run-101.
- Changing routing, pane layout, teardown policy, or worker behavior.
- Launching loop-66; the supervisor owns launch after the joint QA gate.
