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
  `b595d362f441b25cd6aa46dc317c0283c053c2bac72f1df68d82246dfdecfc0b`.
- Runtime bridge evidence: message
  `9b41fc3d-23f5-4eb3-b1a8-08f2176f0961` carried a 9,279-byte review request
  to Claude and was still streaming after 12 minutes under the legacy
  `send-keys -l` path.
- Runtime implementation under evaluation: every tmux bridge body now travels
  through a mode-0600 private payload file, `tmux load-buffer`, and bracketed
  `paste-buffer -p`; the private file and tmux buffer are deleted immediately.
- Runtime ordering proof: a 9,279-byte Claude bridge unit test withholds the
  paste marker for two polls and proves the new marker precedes Enter. A
  compiled two-stage smoke repeats the check after the launch marker is already
  visible, proving stale paste chips cannot satisfy the runtime gate.
- Claim safety: the delivery claim remains live for 60 seconds, beyond the
  45-second readiness bound, so another worker cannot duplicate a slow paste.
- Updated full result: `scripts/verify.sh paste-submit-readiness
  paste-submit-readiness` passes lint, typecheck, build, all 1,189 tests, and
  the empty baseline allowlist gate.
