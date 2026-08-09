# D-018 Unavailable tmux targets

## Problem

Several post-launch consumers still interpreted missing or malformed manifest
tmux identity as dead, or silently performed bookkeeping without recording the
skipped effect. That can grant cleanup, reuse, or mutation authority without an
exact socket-bound target.

## Required behavior

- Bridge runtime, Codex proxy, Governess replay/doctor, launch reservation, and
  paired option reuse derive targets only from manifest handles.
- Missing or invalid targets remain `unknown`, never dead.
- No cleanup, reuse, or ownership mutation is authorized from unknown state.
- Each skipped operational effect emits a field-complete skip record.
- Valid target behavior stays socket-qualified and unchanged.

## Acceptance

- Focused owning suites pass, including degraded missing/invalid target cases.
- Scoped static check, build, diff check, and independent review pass.
- No product or modernization production lane is touched.

## Provenance

This ports the previously independently reviewed `9f70701` source/test slice
onto the current D-014 through D-017 operational recovery branch, then reruns
all evidence against the current tree.
