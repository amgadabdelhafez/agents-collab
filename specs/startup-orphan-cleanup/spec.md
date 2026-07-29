# Failed-start and abandoned-run cleanup

## Problem

Harvto run 88 is a reproduced abandoned startup: its manifest remained
`submitted/running`, had no tmux session, its launcher PID was dead, and its
manifest-owned Codex app-server remained alive on port 4500 with PPID 1.
Normal Governess exit already cleans exact run-owned bridge processes and the
manifest-owned app-server, but failed workspace construction only tears down
tmux locally and startup maintenance removes stale Claude registrations rather
than the orphaned processes.

## Requirements

1. Any paired-workspace construction failure must close the locally started
   persistent Codex session before returning the error.
2. Normal startup maintenance must scan only the current repository's durable
   run directory and identify abandoned runs from persisted liveness facts.
3. A run may be reaped only when its launcher PID is dead and it has no live
   tmux session. Unknown tmux liveness must preserve the run.
4. Process signaling must reuse the existing strict ownership checks: exact
   bridge registration plus run-dir command argument, or manifest app-server
   PID plus app-server command and owned listener port.
5. Live run 98, the ChatGPT Desktop app-server, unrelated repositories, and
   malformed or identity-mismatched manifests must never be signaled.
6. A provably abandoned active manifest becomes `failed` after cleanup so the
   same dead startup is not treated as running forever.
7. Startup maintenance failures must be contained per run and must never turn
   cleanup into a new launcher failure; failed manifest repairs retain their
   durable ownership evidence for a later retry.

## Scope

- Paired tmux startup rollback.
- Current-repository abandoned-run process GC during normal CLI startup.
- Focused lifecycle, safety, and CLI-ordering tests.
- No deletion of run artifacts and no mutation or restart of live loop-98.
