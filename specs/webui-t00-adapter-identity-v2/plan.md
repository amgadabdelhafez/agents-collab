# Plan

1. Characterize current manifest, paired-option, and tmux launch/diagnostic
   boundaries with the four focused test suites clean.
2. Add failing tests for persisted bytes/revision, legacy purity, config
   redaction/freeze, PID/birth identity, socket mismatch/reincarnation, and
   exact-socket diagnostics.
3. Implement the smallest changes within the strict source allowlist.
4. Run focused suites, isolated real two-socket tmux smoke, full test/build/
   check gates, and diff/no-secret/no-default-tmux assertions.
5. Complete Harness evidence and obtain an exact-SHA zero-write review.
