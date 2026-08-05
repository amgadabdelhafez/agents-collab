# Verify: Governess Runtime

## Static and focused

```bash
cd loop-fork
rg -n -i 'babysit' src tests README.md | rg -v 'legacy-governess-compat|legacy compatibility'
bun test tests/loop/governess*.test.ts
bun test tests/loop/governess-runtime.test.ts
bun run build
git diff --check
```

Only the documented compatibility module and migration tests may contain the
legacy term.

## Full

```bash
bun test
cd .. && scripts/verify.sh
```

## Live, non-destructive

1. Record agent and governess pane PIDs and persisted state.
2. Rebuild and respawn only the supervisor pane.
3. Confirm the board identifies itself as governess and ticks advance.
4. Exercise only the reversible `x`/cancel menu.
5. Confirm agent PIDs, bridge traffic, roles and lifecycle state are unchanged.

## Unified agent table

1. Confirm there is one `AGENT` header and one row per configured agent.
2. Confirm no separate activity header or duplicate agent rows remain.
3. Confirm every unified row exposes state/age, model/run mode, context,
   limits/resets, spend/burn, token split, activity totals and bridge counts.
4. Confirm the header and agent rows are at most 180 visible columns.

## Disposable handover

1. Launch a paired governed loop in a disposable Git repository.
2. Press `x`, then `h` in the governess pane.
3. Confirm no agent TUI receives an exit command before its epoch-matching
   bundle exists and its latest hook is a completed `Stop` event.
4. Confirm each drained TUI receives exactly one `/exit`, the replacement has
   three live panes, and only then the old tmux session exits.
5. Restart only the Governess after both epoch-bound bundles are persisted;
   confirm the replacement manifest retains the original transaction epoch,
   the replacement launches, and the fresh Governess fencing epoch remains
   current for subsequent controls.
