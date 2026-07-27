# Live runtime: concurrent automatic canaries

Verdict: PASS

Run: `harvto-loop-51`

## Deployment boundary

- Installed independently reviewed binary SHA-256:
  `0e80de544f426bcd787cb234949217b065b7661a8a53eaf252048bfef63662a7`.
- Moved the reviewed executable inode into
  `/Users/amgad/dev_projects/agents-collab/loop-fork/loop`.
- Restarted only governess pane `%2` (`3800` to `53502`) and utility display
  pane `%3` (`3803` to `53504`).
- Claude remained PID `22530`; Codex remained PID `22532`, both with their
  original `2026-07-26 22:46:42` start time.

## Concurrent automatic jobs

Both requests entered `pending-route` at `2026-07-27T07:58:12.541Z`, were
routed in the same governess cycle, and claimed by separate worker processes.

- Directory listing `63757dd8-a8fc-4875-a054-b7db630d6e69`:
  `file-list`, claimed by PID `55364`, one successful `list_files` event, zero
  denied/failed tool events, completed at `07:58:28.641Z` with five bounded
  entries and no writes.
- Focused check `3abf8489-0324-4ea3-bf55-fa10cbd33840`:
  `focused-check`, claimed by PID `55365`, one successful `run_check` event,
  zero denied/failed tool events, completed at `07:58:43.863Z`; the exact
  `coordinate-utils.test.js` file passed 19/19 with no writes.

No worker timed out, fell back, or routed work to Claude/Codex.

## Runtime health and display

- `loop governess doctor 51` returned `ok: true`; all adapter, epoch, handoff,
  journal, lease, manifest, replacement, runDir, session, state, and transport
  checks passed before and after the canaries.
- Two pane captures spanning governess refreshes kept every cost cell present:
  Claude `$105.00/$59` to `$105.75/$59`, Codex `$21.12/$23` in both, and worker
  `$0.0990/—` to `$0.11/—`. No cost value blanked during refresh.
