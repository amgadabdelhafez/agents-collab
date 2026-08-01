# Verify: Governess Exit-Request Control

## Producer evidence

- Capture a deterministic redacted transform of the run-109 manifest,
  Governess render/lifecycle log, and registered-process evidence.
- Bind the fixture to source byte hashes, the installed producer binary SHA-256,
  and its source commit. Do not persist agent conversation content.
- Prove that the fixture represents a live-rendering Governess and does not
  claim a specific stdin root cause.

## Unit checks

- Valid request and every receipt round-trip through malformed-tail input.
- Wrong run, repository, epoch, action, and terminal state fail closed.
- Duplicate commands reuse one pending request.
- A receipt without a prior matching request cannot authorize success.
- An accepted request without completion remains visible as interrupted.
- The CLI timeout leaves manifest, registered PIDs, and tmux untouched.
- A never-resolving keyboard promise does not delay a valid request beyond one
  Governess tick.

## Transaction check

In an isolated tmux fixture with registered bridge and app-server children,
assert this exact order:

1. request appended;
2. request accepted after the current epoch fence;
3. run manifest becomes terminal;
4. registered run-owned children are reaped and positively checked dead;
5. completion receipt appended;
6. old tmux session killed and positively checked absent;
7. CLI returns zero.

Degrade the completion receipt, epoch, manifest transition, child cleanup, and
tmux control one at a time. Every degraded case must return nonzero and must not
claim successful teardown.

## Release gates

- Focused tests, scoped lint, full tests, build, and realistic isolated smoke.
- Empty named baseline-failure list and passing eval.
- Exact-SHA independent CONCUR.
- No activation or deployment into the currently running loop.
