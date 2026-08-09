# Task d027-two-server-tmux-certification

## Objective

Prove the compiled candidate and every post-launch tmux consumer remain bound to
producer-recorded server A under hostile same-named server B ambient state.

Regression: yes
Regression id: ambient-tmux-cross-server-targeting
Regression symptom: A consumer treats a same-named session on another tmux
server as evidence about the run.
Regression guard: producer-backed real two-server smoke matrix

## Verification

- `evals/smoke/tmux-socket-normalization.sh`: PASS twice. Candidate SHA-256
  `84dbcdc47c32efa415b1542cd1294316ea1eace84ccaa5bda1f663ff8d9027fc`,
  tmux 3.7b, compiled producer on A, same-named hostile B, 27 named seams, 74
  per-seam-attributed exact-A contacts, decoy SHA-256
  `4262629fc8a0c172ff3d27908c2dc3f9f44e45c459bfa508cc7cc4fed0486457`.
- Destructive non-effects: bridge topology and process-GC manifest bytes
  unchanged; Claude registration retained; zero process signals; reservation
  reuses the live run; proxy emits no `dead-tmux`; Governess emits no kill or
  respawn; B bytes unchanged.
- Cleanup: assertion-failure and SIGTERM traps PASS; empty PID set fails closed;
  six live recorded PIDs make the positive zero-survivor check fail before
  cleanup; post-cleanup PIDs, sockets, sessions, and isolated product paths are
  all zero.
- `bash -n`, consumer harness bundle, scoped Ultracite, and `git diff --check`:
  PASS.
- Independent zero-write review: PASS for T-14 and verify 7/8/9/15/16.

## Scope

Certification fixtures, evaluator harness, authoritative task checklist, and
D-027 run metadata only. No production source, installed binary, product lane,
or modernization file changed.
