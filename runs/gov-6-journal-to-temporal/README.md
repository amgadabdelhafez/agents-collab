# gov-6 evidence (branch `claude/gov6-journal-to-temporal-v3`)

Certified commit: `d00a4af0fb3359109b49f66fb001e168f6318a45` (base `c5585411`).

| Proof | Evidence | Result |
|---|---|---|
| 1 golden replays identically through Temporal | `tests/loop/governess-temporal-journal.test.ts` › `golden: the fixture journal replays identically through the Temporal path` | pass |
| 2 live, 192.168.1.18:7233 / harness | `live-proof.log`, `live-proof-after-fix.log` (script `loop-fork/scripts/governess-temporal-live-proof.ts`); server history pulled independently from the UI HTTP API into `live-history*.json` and compared by `compare-live-history-to-golden.ts` | `governess-beat:gov6-live-20260919055320724` run `9212472e-d717-4b43-b2b1-0bc2a93c9917` and `governess-beat:gov6-live-20260919060351515` run `f2ae9e22-fa69-45ea-92a8-aa0143460640`: 36 events at readback (11 signals), 37 on server after terminate; recovery with the file journal deleted rewrote 11 records from Temporal; signalled records equal golden |
| 3 fallback, no network | test `fallback: with no Temporal configured ...` (injected connector that throws, 0 calls) + `fallback-no-temporal-import-probe.ts` (real default path: 0 `@temporalio` modules loaded, 0 socket dials; control import loads 79) | pass |
| recovery after pane death | tests `recovery: a dead governess pane's journal is read back from Temporal` (deletes journal + index) and the live proof's `recoveryRewroteFromTemporal` | pass |
| 4 mutation | client-side `appendRecord` skipped → golden + 3 recovery tests fail (`WorkflowNotFoundError`); workflow-side append dropped (bundle regenerated) → golden fails on the workflow-state leg (history fold still correct, by design: history is authoritative). Both reverted; baseline 7/7 again | golden fails under both |
| 5 check + suite | `bun run check` clean (939 files); 122/122 test files run one by one: 121 pass, `tests/loop.test.ts` fails 3 with TMUX inherited, 1 (`runCli awaits auto-update before handing off promptless paired tmux startup`) with `env -u TMUX -u TMUX_PANE`; identical on base `c5585411` | only the allowlisted failure |
| 6 numstat | see status.md | two inherited blank-line deltas, named |
