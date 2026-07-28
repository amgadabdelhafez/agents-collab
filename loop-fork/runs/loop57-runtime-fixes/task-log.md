# Task loop57-runtime-fixes

Created: 2026-07-28T00:31:44Z
Mode: planned
Description: Fix Loop 57 helper routing stalls, broker diagnostics and tool use, result draining, Governess summaries, and Recon pane layout

## What I changed

- Captured Loop 57 live evidence before implementation.
- Isolated the work on `codex/loop57-runtime-fixes` and completed reuse research.
- Made deterministic pending-route events exactly idempotent while preserving
  collision rejection for changed payloads.
- Added structural Git inspection requests and Direct execution for exact
  mixed read plans; unsafe or malformed variants still fail closed.
- Changed the Pi broker breaker to count rejected model rounds rather than
  sibling calls and retain the exact last broker code, tool, and message.
- Added atomic utility-only result draining to the next same-requester
  `route_task` response and derived bridge pending from the real bridge inbox.
- Anchored Governess summaries to current human instructions and filtered
  terminal composer placeholders.
- Preserved the launch prompt's `Task:` objective while excluding automatic
  bridge/helper deliveries from human-message extraction and objective choice.
- Added three read-only Recon panes for route, tool, and result/bridge truth.
- Added an explicit regression proving a full Nanny slot does not block an
  eligible Au Pair job in the same routing tick.

## Why

Loop 57 showed a deterministic route-event collision, failed helper adaptation,
undrained results, a false Governess objective, and missing Recon panes. These
are runtime contract failures rather than a need for broader permissions.

## Notes

- Full Harness unit verification passed; the compiled build passed; focused
  suites passed; `git diff --check` passed.
- Independent local Qwen review returned `pass` with no findings. See
  `independent-review.md`.
- Installed binary SHA-256:
  `ecc0e1f4743769eaf682ea96b42b30b48b4edc4108f2819cf29d6f663feb1c9b`.
- Hot-swapped only Governess, Nanny, and Au Pair. Live Claude pane `%0` stayed
  PID `70452`; Codex pane `%1` stayed PID `70454`.
- Added live Recon panes `%6`, `%7`, `%8`; resized Governess to 187/234 columns
  and the Nanny/Au Pair column to 47/234 columns (4/5 and 1/5).
- Live canary `8a7b21f4-2e12-427f-8fec-8f6b225ded67` adopted registered worktree
  `/private/tmp/harvto-loop57-base`, ran on `utility-nanny`, completed with three
  brokered tools, and updated routing from 11/87 to 12/88.
- No `route-selected` collision was written after the new Governess epoch; the
  last historical collision remains at `2026-07-28T00:36:05.545Z`.
- Live bridge pending remained zero and Recon showed the completed canary.
- The canary delivery exposed and then verified the final summary edge case:
  after the Governess-only reload, the live Objective returned exactly to
  `Loop-57 — EXECUTION: analyser → marked clip → R12(b) measurement → census → T1′ floor → (if open) T4`.
- Regression marker: `utility event id collision: route-selected`.
- Regression marker: three sibling `not_found` calls must count as one rejected
  model round, not exhaust the breaker before the model can adapt.
