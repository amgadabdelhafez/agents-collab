# loop58-runtime-corrections

Task completed 2026-07-28T06:26:26Z, mode planned.

## What was built

- Ported conservative Claude startup GC, then changed paired tmux launches to
  load `claude-mcp.json` with `--strict-mcp-config` instead of writing another
  home-scoped registration.
- Made reviewer delegation explicitly dormant until a primary/human targeted
  request while retaining immediate decomposition for the primary.
- Added broker-native `count_lines` for one through eight canonical scoped
  regular files and automatic `wc -l` intent translation without shell access.
- Removed Governess advisory/project summaries and request IDs from helper
  panes, display actual results/errors, propagate isolated config to Nanny, and
  suppress legacy placeholder summaries in favor of their real persisted
  result/blocker. Repaints stay inside the pane viewport without duplicating
  frames into tmux scrollback.
- Focused verification passed (441 tests); the complete per-file suite,
  compiled build, and `git diff --check` also passed. Repository-wide Ultracite
  remains noisy from 280 pre-existing generated-run formatting diagnostics.
- Rebuilt and installed the source runtime, then hot-swapped only Governess,
  Nanny, and Au Pair. Claude stayed on PID `49723`; Codex stayed on PID `49725`.
- A live Codex-originated canary routed to Au Pair, called native `count_lines`
  once, completed successfully, and was delivered to Codex. Its five counts
  exactly matched local `wc -l` (643, 440, 984, 214, and 5156).
- Startup GC left exactly one home Claude MCP registration:
  `loop-bridge-harvto-58`, the bridge still required by the preserved Claude
  process. Fresh launches use only the run-scoped strict MCP config.

## Decisions made

_No entries recorded._

## Open items at completion

_No entries recorded._

## Trajectory

- 001 - initial (2026-07-28T05:56:21Z)
- 002 - implementation and full verification complete; ready for narrow Loop-58 hot-swap (2026-07-28T06:18:10Z)
