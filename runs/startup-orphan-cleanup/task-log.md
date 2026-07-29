# Startup orphan cleanup task log

- Live evidence: `/Users/amgad/.loop/runs/harvto-b1e274e66299/88/manifest.json`
  has no tmux session, a dead launcher PID, and a still-live manifest-owned
  app-server on port 4500.
- Live loop-98 remains read-only and is excluded from all mutation during this
  implementation slice.
- Existing explicit Governess teardown ownership checks are the authority
  boundary; this slice does not broaden which processes qualify as owned.
- Failed paired-workspace construction now closes the local persistent Codex
  session within a five-second bound, preserves the original launch error,
  and marks the durable manifest failed. If close fails, ownership stays in
  the manifest for startup GC retry.
- Startup GC scans only the current Git repository's run storage, takes one
  bounded tmux session snapshot, preserves live/unknown sessions and live
  launcher PIDs, and invokes the existing strict bridge/app-server ownership
  checks only for provably abandoned runs.
- Settled historical runs without ownership evidence skip PID and listener
  probes. Cleanup emits one aggregate line, never deletes run artifacts, and
  retains app-server ownership evidence after signal failure.
- A final failure-containment audit found and closed a launch-safety gap:
  tmux-snapshot errors now become unknown liveness, each stored run is isolated
  from the next, and active-state repair must persist before any process is
  signaled. Manifest-write failure therefore preserves all ownership evidence
  and cannot abort the new launch. Bridge registrations are also retained after
  signal failure for a later retry.
- Focused lifecycle verification passed 103/103; lint passed.
- The full repository verifier passed lint, TypeScript, compiled build, every
  sequential test file, and the empty baseline allowlist.
