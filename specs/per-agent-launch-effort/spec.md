# Per-agent launch effort

## Problem

New paired loops hardcode Claude at maximum effort and Codex at xhigh effort. That slows routine loops and prevents a launch from assigning a stronger reviewer without rebuilding Loop.

## Requirements

- Default both paired roles to `medium` for newly launched runs.
- Add `--effort <level>` as a convenience setting for both roles.
- Add `--effort-driver <level>` and `--effort-reviewer <level>` as first-class per-role launch arguments.
- Resolve precedence independently for each role: role CLI, global CLI, role environment, global environment, then `medium`.
- Support `LOOP_DRIVER_EFFORT`, `LOOP_REVIEWER_EFFORT`, and `LOOP_EFFORT` as optional environment fallbacks.
- Validate every explicitly provided level before any launch side effect. Invalid or missing values fail closed.
- Map the resolved role effort to the actual provider invocation: Claude receives `--effort`; Codex receives `model_reasoning_effort`.
- Persist the resolved driver and reviewer effort in the run manifest so live smoke evidence can prove the launched values.
- Do not modify or restart any active loop.

## Accepted levels

`low`, `medium`, `high`, `xhigh`, `max`.

## Non-goals

- Changing effort in a running session.
- Changing model selection or service tier.
- Changing Nanny or Au Pair inference settings.
