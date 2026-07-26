# lower-agent-hardening Research

## Research Question

Which existing loop-fork primitives and standard process/git patterns can close
the six supervisor-reported gaps without weakening the pure router or adding a
new framework?

## Candidates Reviewed

- Existing `UtilityToolBroker`: already centralizes canonical containment,
  symlink rejection, protected paths, literal argv, scrubbed tool environments,
  bounded output/time, and patch preimages. Extend this boundary instead of
  introducing a second command or patch policy.
- Existing utility job journal: already owns idempotent transitions, epochs,
  claims, route decisions, and terminal state. Add PID/application metadata to
  the same journal so recovery and replay remain authoritative.
- Existing governess dependency injection: worker spawn and time are already
  testable. Add liveness/termination dependencies there so tests never signal a
  real process.
- Git's `apply --check` plus literal `git apply`: suitable after independent
  artifact, scope, patch-hash, and byte-preimage validation. It preserves diff
  semantics without parsing hunks into a second patch engine.
- Node process signaling: signal `0` provides a liveness probe, while actual
  termination remains an explicit signal operation. Liveness and termination
  are separate injected dependencies so PID behavior is deterministic in tests.
- npm `npx`: can fetch a missing remote package, so a repository policy that
  enables `npx vitest run` must also require a locally installed Vitest binary
  and execute npm offline to preserve the utility tier's no-open-world boundary.
- Repository policy JSON: a small checked/configured literal-prefix file is
  easier to audit than shell strings and lets Harvto opt into
  `npx vitest run` without broadening every repository's defaults.

## Open-Source Patterns

- Supervisors own leases and external deadlines; workers report identity and
  progress but do not self-certify liveness.
- Capability brokers validate configuration at the boundary and fail closed on
  malformed policy.
- Optimistic concurrency uses preimage/version checks immediately before a
  mutation, then records postimages for idempotency and audit.
- Child processes receive a minimal environment assembled from an allowlist,
  not a copy with a few secrets removed.
- Budget schedulers reserve pessimistic cost before dispatch and reconcile
  reservations with actual usage afterward.

## Reuse Decision

Extend the existing router/store/runtime/broker boundaries. Keep routing pure;
put repository policy and guarded apply in the broker, liveness/run-budget
coordination in the governess runtime, and diagnostics in persisted decisions
plus the observer. Use standard process liveness and `git apply` primitives with
injectable test seams. Do not add dependencies or another service.

## Sources

- `src/loop/task-router.ts`
- `src/loop/utility-store.ts`
- `src/loop/utility-runtime.ts`
- `src/loop/utility-tools.ts`
- `src/loop/bridge-utility.ts`
- `src/loop/governess.ts`
- `tests/loop/utility-runtime.test.ts`
- `tests/loop/utility-tools.test.ts`
- https://nodejs.org/api/process.html#processkillpid-signal
- https://nodejs.org/api/child_process.html#child_processspawncommand-args-options
- https://git-scm.com/docs/git-apply
- https://docs.npmjs.com/cli/v7/commands/npx/
