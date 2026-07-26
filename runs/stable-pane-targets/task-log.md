# Task log: stable-pane-targets

## Scope

- Repair the regression where the default utility and governess layout causes
  bridge delivery to target a numeric pane index that no longer belongs to
  Codex.
- Preserve both live main-agent processes while repairing run 45.

## Acceptance criteria

- New paired loops persist the actual stable tmux pane IDs returned when the
  left, right, utility, and governess panes are created.
- Bridge and governess consumers continue using the persisted manifest targets.
- Default four-pane and utility-disabled three-pane layouts route to the correct
  main-agent panes.
- Focused tests, the full suite, build, disposable tmux verification, and an
  independent evaluation pass before installation.
- Run 45 drains its pending Codex messages without restarting Claude or Codex.

## Live baseline

- Session: `harvto-loop-45`, run directory
  `~/.loop/runs/harvto-b1e274e66299/45`.
- Actual panes: Claude `%0` / index 0, Codex `%1` / index 1, governess `%3` /
  index 2, utility `%2` / index 3.
- Manifest targets before repair: left `0.0`, utility `0.1`, right `0.2`,
  governess `0.3`.
- Claude review request `28cd0fc2` and supervisor request `66665141` were
  pending for Codex; Gemini-to-Claude delivery succeeded.

## Implementation

- Paired `new-session` and every pane-producing `split-window` now request
  tmux's `#{pane_id}` output and persist a validated `%<number>` target.
- Main-pane readiness, utility splitting/resizing, primary-pane selection,
  governess observation, and bridge delivery all consume those stable targets.
- The manifest is written with stable main/utility targets before governess
  starts, then updated immediately with the governess pane's returned ID.
- A fallback retains the prior session/index targets for test doubles or older
  tmux output that does not provide a valid pane ID.

## Verification

- `bun test tests/loop/tmux.test.ts tests/loop/bridge.test.ts`: 114 passed.
- Focused tmux/bridge/proxy integration set: 124 passed.
- Full `bun test`: 703 passed, 4 failed. The failures are the existing Codex
  model/config expectation drift in `paired-options.test.ts` and
  `runner.test.ts`; none touch pane routing.
- `bun run build`: passed.
- `scripts/verify.sh`: completed; its lint/typecheck/test slots remain repository
  placeholders.
- `bun run check`: unavailable because `ultracite` is not installed.
- Disposable real-tmux smoke: default four-pane and utility-disabled three-pane
  layouts both preserved each role when addressed through the returned stable
  pane ID, despite numeric index reordering.

## Integration and live repair

- Integrated locally on `feat/babysitter-pane` as `4cc0bc6`; no remote push.
- Rebuilt the canonical binary. `/Users/amgad/.local/bin/loop` resolves to it
  and has SHA-256 `b8d64bd325ef001a2bc88512a2fd4598c5c94fffec31dea8c89c461259a4637d`.
- Preserved the prior binary at
  `/private/tmp/loop-before-stable-pane-targets-20260726` for rollback.
- Updated only run 45's manifest targets to Claude `%0`, Codex `%1`, utility
  `%2`, and governess `%3`; no pane was restarted, signaled, or recreated.
- Claude's corrected T3 request `7ea0298b` was then acknowledged as
  `submitted through visible codex tmux pane`; Codex hook sequence 6 recorded
  `UserPromptSubmit`, and the active review was visible in the Codex pane.
- The governess doctor passed all 11 checks with zero journal issues. Claude,
  Codex, governess, and utility PIDs remained `13109`, `13111`, `13469`, and
  `13467` respectively.
