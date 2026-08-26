# Verification

- Manifest exact-byte revision and atomic failure behavior.
- Invalid UTF-8, JSON, and schema rejection through both readers.
- Legacy purity and unknown adapter identity.
- Strict config freeze, redaction, resume, and absent-boolean behavior.
- Strict PID plus Linux/Darwin process-birth parsing.
- Explicit socket mismatch, timeout, malformed output, two sockets with equal
  session names, and same-socket server reincarnation.
- Both existing-server and cold-launch identity capture paths.
- Every new diagnostic tmux invocation includes exact `-S`; no default tmux.
- Focused suites, real isolated tmux smoke, `test:ci`, `check`, `build`, and
  committed diff check pass with an empty named baseline failure list.
