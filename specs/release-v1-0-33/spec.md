# Loop v1.0.33 release packaging

## Problem

The integrated harness is on both remote `main` branches, but GitHub still
serves the July 5 `v1.0.32` release. The repository is now rooted above
`loop-fork/`, while the release workflow remains nested under
`loop-fork/.github/workflows/`; GitHub does not discover that nested workflow.
Consequently, `loop-fork/install.sh` installs the old binary on a new machine.

The World Model and worktree reaper tasks also remain indexed as active after
their reviewed deployment, and the World Model missing-manifest cleanup path
lacks a producer-backed regression.

## Outcome

- The package version is `1.0.33`.
- A root GitHub Actions workflow builds release binaries from `loop-fork/` for
  Linux x64, macOS x64, macOS arm64, and Windows x64.
- Every binary is accompanied by a SHA-256 checksum, and the workflow refuses
  to publish a tag that does not match the package version.
- `v1.0.33` becomes GitHub's latest release only after the exact committed SHA
  passes governed review.
- `install.sh latest` is verified against the published macOS arm64 asset in an
  isolated install directory.
- A missing run manifest causes World Model activation to fail closed and
  removes every database and bootstrap artifact produced by the failed bind.
- The World Model activation and worktree reaper tasks are recorded as done.
- The first newly launched post-release loop is checked for bound World Model
  paths and a stable bridge-worker descriptor count. Already-live run 137 is
  neither restarted nor mutated.

## Authority and safety

- Release publication requires an exact-SHA supervisor concurrence.
- The workflow publishes only from an explicit `v*` tag.
- The release must not rewrite history or overwrite an existing tag.
- Runtime validation must not restart or inject input into a healthy live pane.

## Non-goals

- Retrofitting World Model artifacts into already-live loops.
- Running the worktree reaper in apply mode.
- Changing routing, agent authority, or lifecycle policy.
