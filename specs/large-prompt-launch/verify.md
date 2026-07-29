# Verification

1. Focused paired-tmux tests pass with prompt content of at least 10,257 bytes.
2. Lifecycle smoke launches with a generated prompt of at least 8 KB and
   observes a real tmux session.
3. A simulated workspace creation failure returns false/nonzero instead of
   reporting successful handoff.
4. `scripts/verify.sh` passes.
5. `runs/large-prompt-launch/eval.json` records commands, results, and the
   reviewed commit.
