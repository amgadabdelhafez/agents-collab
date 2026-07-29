# Paste-submit readiness task log

- Live evidence: loop-62 launched as `harvto-loop-98`; both Claude and Codex
  rendered the approximately 22 KB charter as paste chips but ignored the
  launcher's immediate Enter until the supervisor manually submitted them.
- Claude marker: `[Pasted text #N]`, including 21 fragmented chips.
- Codex marker: `[Pasted Content 22083 chars]`.
- Implementation under evaluation: bracketed tmux paste plus a concurrent,
  bounded readiness poll for large Claude/Codex prompts before Enter.
- Focused result: 56 tmux tests pass, including delayed marker ordering for
  both real render shapes and the 45-second bounded fallback.
- Compiled smoke: a bracketed-paste-aware fake Claude deliberately withheld its
  render marker for one second and would fail on an early Enter. The candidate
  waited, then submitted both panes with `early-enter=absent`.
- Full result: `scripts/verify.sh paste-submit-readiness
  paste-submit-readiness` passes lint, typecheck, build, all 1,187 tests, and
  the empty baseline allowlist gate.
- Candidate SHA-256:
  `a8aca48e2898c42d7f07ebb3f533a671f1099646215a626659c97a419fe2d7ff`.
