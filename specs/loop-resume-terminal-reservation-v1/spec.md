# Terminal released-run reservation

## Problem

Installed Loop v1.0.38 at integration commit
`62e8103d9181bad85012830f8170cca8e21fd0d6` correctly reconciles dead active
runs and starts headless paired runs, but an explicit `--tmux` launch is blocked
by legacy Run 42:

```text
launch conflict: run 42 (agents-collab-loop-42) still owns workspace /private/tmp/agents-collab-d001-handover-run1 on legacy-unknown
```

Run 42 is positively terminal and released: `status=stopped`,
`state=stopped`, `workspaceReleasedAt=2026-08-18T18:30:00Z`, PID 9598 is
absent, tmux session `agents-collab-loop-42` is absent, and its temporary
workspace is absent. The manifest reader drops the release marker, while the
reservation predicate treats an unusable legacy tmux target as unknown and
therefore owning forever.

## Requirements

1. Preserve and validate the existing camel-case and snake-case workspace
   release timestamp when reading a manifest. Invalid or ambiguous release
   values are not authority.
2. Exclude a legacy unusable tmux target only when the manifest is terminal,
   has a valid explicit workspace release timestamp, and neither the run PID
   nor launch-attempt PID is alive.
3. Continue to fail closed for active state, missing or invalid release proof,
   a surviving run PID, a surviving launch-attempt PID, live tmux, and a usable
   tmux target whose liveness is unknown.
4. Add an exact Run 42 regression fixture and direct positive and negative
   predicate tests. Assert every required fixture exists before comparing or
   aggregating results.
5. Scope product changes to manifest read/validation and the terminal
   reservation predicate. No lifecycle redesign, manifest mutation, Run 42
   edit, dependency change, device work, Web UI work, or provider/model change.

## Acceptance

- The exact Run 42 fixture no longer blocks a fresh launch reservation.
- Every negative control remains a conflict and leaves its manifest unchanged.
- Focused tests, the full named test suite, static check, build, and
  `git diff --check` pass with an empty unexpected-failure set.
- One immutable candidate receives a separate literal zero-write exact-SHA
  review.
- After explicit install authority, the successor binary hash is recorded and
  an explicit `--tmux` launch succeeds without editing Run 42.

## Non-goals

- No cleanup of historical runs or tmux sessions.
- No automatic migration of preserved L4, Harvto, Agent Viz, or device lanes.
- No relaxation based only on terminal state, absent files, or unknown tmux.
