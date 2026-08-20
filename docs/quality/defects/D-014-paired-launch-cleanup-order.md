# D-014: Paired launch cleanup ordering

## Status

Queued for a fresh isolated governed loop after the active Phase 0A slice. Do
not implement this defect in the control-plane contracts worktree or a product
project workspace.

## Confirmed failure

AI-CUR Runs 9 and 10 failed during paired startup on 2026-08-09. In both runs,
`codex-tmux-proxy-lifecycle.jsonl` recorded a cleanup request from
`paired-start-cleanup` followed by `decision=rejected-active-tmux`. The proxy
returned HTTP 409 because the same failed run's manifest still declared its
tmux session active. Run 9 then reported an app-server failed-start cleanup
timeout; Run 10 reported the same 409 alongside a Claude kickoff confirmation
timeout. Both proxies later stopped with `reason=inactive-run`.

This was not a stale proxy from another lane. Exact process, listener, manifest,
and socket checks showed no surviving AI-CUR Run 8, 9, or 10 owners before the
harness owner launched Run 11. Run 11 started successfully on the same isolated
socket and ports, with six healthy panes.

## Required behavior

- Failed paired startup must make the run non-owning before requesting its
  app-server/proxy teardown, or use an explicitly authenticated cleanup path
  that is valid for the still-starting run.
- Cleanup must terminate only processes recorded for the failed run and must
  never weaken cross-lane socket, session, thread, or requester checks.
- The original startup failure must remain the primary error; cleanup failures
  are recorded separately and cannot replace or obscure it.
- A terminal failed manifest cannot retain a live session or listener claim.
- A subsequent launch on the same lane must not depend on manual process or
  registry cleanup when the preceding failed launch had no surviving owners.

## Minimum regression evidence

- One focused producer-backed failed-start scenario reaches cleanup while the
  manifest initially declares a tmux session.
- The run becomes non-owning, its own proxy accepts the exact scoped shutdown,
  and no HTTP 409 is returned.
- The primary startup error remains intact and distinct from cleanup outcome.
- An unrelated live lane's proxy, socket, session, and listeners remain
  untouched.

## Producer evidence

- AI-CUR Run 9 proxy lifecycle, 2026-08-09T03:15:31Z:
  `declaredCaller=paired-start-cleanup`, `decision=rejected-active-tmux`, then
  `stopped reason=inactive-run`.
- AI-CUR Run 10 proxy lifecycle, 2026-08-09T03:16:42Z: same rejection and
  terminal stop.
- Recovery Run 11: session `ai-cur-loop-11`, socket
  `/private/tmp/ai-cur-tmux/tmux-501/default`, six live panes, app-server
  `4501`, proxy `4601`.
