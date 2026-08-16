# D15 Teardown Process Orphans

## Problem

At exact base `fb71f47bb126a39eae7f1613fa952c994421de5e`, Governess teardown marks a run
`stopped` before process cleanup, cleanup only owns registered bridge and manifest app-server PIDs,
and a successful signal is counted without directly proving exit. Manifest-owned launchers and
Claude processes can therefore remain alive behind a completed lifecycle.

## Required behavior

1. Every governed launcher and main-agent process has a durable run-scoped ownership record binding
   its PID to an immutable process identity observed while that process is alive.
2. Teardown signals only exact current identities recorded for that run. PID reuse, missing or
   changed identity, another run, the cleanup process itself, and every ancestor of the cleanup
   process never grant signal authority. A self-or-ancestor target remains durable as
   `unresolved:self-or-ancestor` for a reaper outside that process tree, except that the one exact
   `role=launcher` record whose PID equals the teardown executor may be atomically transferred from
   active ownership to a versioned deferred-launcher receipt owned by startup GC. The active record
   is removed only after that receipt is durable; no other role or ancestor is eligible.
3. Cleanup positively probes each owned PID alive before teardown, sends bounded TERM/KILL only
   while identity still matches, and reports it settled only after directly observing either no
   such PID or process state `Z`/defunct. Bare `kill(pid, 0)` and `ps -p` success are not absence
   proofs because both treat an exited-but-unreaped zombie as present.
4. Governess may write `stopped` only after owned-process cleanup succeeds, its tmux kill is
   directly observed dead on the exact launch-recorded tmux socket and session, and no unresolved
   ownership remains. Missing or unknown exact socket identity cannot fall back to the default
   socket and cannot authorize success. One durably transferred exact self-launcher receipt is not
   inline unresolved ownership: it permits `stopped` only after every other process and tmux target
   is settled, and it remains visible until startup GC directly confirms that launcher settled.
5. Any cleanup exception, surviving owned PID, failed signal, or unknown tmux liveness produces a
   durable run-scoped unresolved-cleanup receipt and terminal `failed` lifecycle rather than false
   completion. The sole exception is the exact self-launcher transfer defined above, which records
   deferred cleanup rather than failure so ordinary in-process teardown can finish. A later cleanup
   pass retains enough exact evidence to retry safely.
6. Tests spawn only fixture-owned processes in an isolated temporary run directory, prove launcher
   and Claude fixture PIDs alive before teardown, deterministically await their exit/reaping before
   post-cleanup absence assertions, and prove an unregistered control PID remains alive and receives
   no signal. A separate fixture proves zombie settlement while its parent intentionally has not
   reaped it.
7. Agent ownership registration occurs only for a main-agent `SessionStart`. A `native-child`
   `SessionStart` never creates an ownership record. Adding shell `exec` changes the process shape
   of every configured Claude and Codex hook invocation, so all hook-event compatibility controls
   remain required even though registration is gated to one event/context.

## Compatibility and boundaries

- Existing exact bridge-command and app-server listener ownership checks remain fail closed.
- Process identity is exact command text plus `ps lstart`; `lstart` has one-second granularity, so
  identical-command PID reuse within the same second is deliberately accepted as the bounded
  identity limit.
- The shared zombie-aware settled predicate applies to every PID-liveness consumer in the process
  cleanup module, including abandoned-run classification and deferred-launcher receipt cleanup;
  startup GC cannot use bare `kill(pid, 0)` to keep a zombie launcher falsely active.
- Active or contradictory runs remain protected from abandoned-run GC.
- No process is discovered or signaled by broad name matching, shell-expanded PID lists, or a
  repository-wide sweep during teardown. Ownership enumeration is confined to registry files under
  the exact run directory; preserved live-run registries and default tmux sockets are never swept.
- Root `.loop/`, preserved live runs, Harvto, provider/model configuration, dependencies, remote
  systems, release flows, and D6-D12 are out of scope.
- No UI behavior changes.

## Acceptance

- The exact-base named real-process regression fails before production changes and passes after.
- Focused ownership, hook-registration, tmux-launch, Governess exit, replay, and GC controls pass.
- Mandatory check, canonical typecheck, build, complete serial suite, both passing eval schemas,
  Harness gates, and root verifier pass with empty baseline failures.
- One explicit implementation commit receives Claude literal zero-write `PASS` for its exact SHA;
  Harness closes exactly once, followed by a separate bookkeeping commit.
