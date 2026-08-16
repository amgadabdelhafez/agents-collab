# D15 Plan

1. Preserve exact-base red evidence using a temporary run directory with two registered real child
   processes (launcher and Claude) plus one unregistered live control. Probe all three PIDs before
   cleanup and afterward; unchanged production must leave the two owned processes alive. Do not
   recapture this red. After plan approval, make the regression asynchronous and deterministically
   await owned child exit/reaping before its unchanged post-cleanup absence and exact `killed`
   assertions, so zombie timing cannot invalidate the instrument.
2. Extend the run-process registry with versioned launcher/agent ownership records containing exact
   PID, command, process start identity, run directory, role, and agent where applicable. Record a
   durable registration failure marker when identity cannot be captured. Treat exact command plus
   one-second-granularity `ps lstart` as the deliberate identity bound, including the accepted edge
   of identical-command PID reuse within one second.
3. Register launchers during paired-run binding. Prefix hook commands with shell `exec` so the
   emitter has the exact agent parent without shell ambiguity, explicitly retaining compatibility
   across every configured Claude/Codex hook event whose process shape changes. Register the parent
   only when the payload is `SessionStart` in main-agent context; `native-child` never registers.
4. Before every signal, walk exact `ps ppid` relationships from `process.pid`; never signal self or
   any ancestor. Non-launcher self and every ancestor remain `unresolved:self-or-ancestor`. For the
   sole exact `role=launcher` record with `pid === process.pid`, atomically write a versioned
   deferred-launcher receipt for startup GC, then remove the active record and return it as deferred,
   not unresolved; receipt failure leaves the active record unresolved and forces failure. Replace
   signal-only accounting with bounded TERM/reprobe, identity revalidation, optional KILL/reprobe,
   and removal of ordinary ownership records only after no PID, `Z`/defunct state, or proved PID
   reuse. Do not use bare `kill(pid, 0)` or `ps -p` success as the settled-absence predicate.
5. Reorder Governess teardown: resolve run-owned processes first, kill and directly probe the exact
   launch-recorded tmux socket plus session, then mark stopped. Never enumerate or fall back to a
   default socket; missing/unknown exact socket identity is unresolved. Permit `stopped` with an
   exact deferred self-launcher receipt only when the inline unresolved set is empty and every other
   process plus the exact tmux target is directly settled. Persist an unresolved receipt and
   `failed` lifecycle on every other unknown or failed branch; keep the journal non-accepted.
6. Replace module-local bare liveness decisions with one shared zombie-aware settled predicate and
   use it for teardown reprobes, `runIsProvablyAbandoned`, and deferred-launcher startup-GC cleanup.
   Startup GC retains the exact deferred receipt while the launcher is genuinely live and clears it
   only after no PID, `Z`/defunct state, or proved PID reuse.
7. Add named controls for an exited-but-unreaped teardown target, zombie manifest launcher GC,
   ordinary end-to-end teardown reaching `stopped` after exact self-launcher transfer, no signal
   authority for self/ancestors, and `native-child` SessionStart producing no record, alongside
   TERM/KILL, identity reuse, replay, exact-socket, registration-failure, and preserved-live-run
   isolation controls.
8. Run focused controls, mandatory verification, evals, Harness gates, and root verifier. Reconcile
   Git-derived scope, commit explicit implementation paths, obtain exact-SHA Claude `PASS`, close
   Harness once, and commit lifecycle/evidence separately.
