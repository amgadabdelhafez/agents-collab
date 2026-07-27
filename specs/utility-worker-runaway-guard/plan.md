# Plan

1. Add red local-provider regressions for consecutive denial, reset-on-success,
   identical call repetition, and the 64-call emergency ceiling.
2. Add small runtime guard state and explicit fail-closed blocker messages.
3. Preserve existing evidence, usage, runtime, token, and cost semantics.
4. Run focused/full verification, build, independent evaluation, and the repo
   verification wrapper.
5. Install the verified binary without restarting loop-53 panes; prove hashes,
   pane PIDs, and governess doctor state.
