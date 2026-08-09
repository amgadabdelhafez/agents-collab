# D-027 Two-server tmux certification

## Problem

A single tmux server cannot expose the original cross-server targeting defect.
The operational candidate needs producer-backed evidence that every post-launch
consumer remains bound to the manifest socket when ambient tmux state points at
a same-named decoy on another real server.

## Required behavior

- Install cleanup traps before creating any server or process.
- Compile and launch the candidate on real server A using current OSS/Claude
  fixtures; create a same-named decoy session on real server B.
- Drive named consumer assertions under hostile `LOOP_TMUX_SOCKET`, `TMUX`, and
  `TMUX_TMPDIR` values pointing to B.
- Consumers without a CLI surface must read the producer-written manifest.
- Assert all A contacts are exact socket/session contacts, B receives zero
  consumer contact, destructive consumers cannot act from B evidence, and the
  decoy is byte-identical before and after.
- Record every created server/run process before cleanup, prove the survivor
  detector fails on a known-live recorded PID, then prove zero survivors,
  sockets, sessions, or product-path writes after exact cleanup.

## Acceptance

- `evals/smoke/tmux-socket-normalization.sh` passes against two real servers.
- The consumer harness emits one named PASS record per required consumer seam.
- Trap, positive-control, decoy-integrity, exact-target, and zero-survivor
  assertions are non-vacuous.
- No installed binary, product lane, modernization file, or live product run is
  changed.
- Static checks and independent zero-write review pass.
