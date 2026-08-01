# Plan: Governess Exit-Request Control

1. Land this specification on the canonical base.
2. Rebase or transplant the implementation task onto the current lifecycle
   integration stack after registered-process cleanup and baseline fixes land.
3. Add a small append-only request/receipt store with strict parsing,
   deduplication, target binding, and epoch fencing.
4. Add the public `loop stop --run-id <id>` dispatcher before normal task and
   auto-update startup paths.
5. Poll requests inside the live Governess loop and reuse the canonical teardown
   transaction, extending it only to record a completion receipt in the correct
   cleanup order.
6. Verify with producer-bound run-109 evidence, unit failure paths, and an
   isolated tmux/process lifecycle smoke.
7. Obtain exact-SHA independent review and activate only in the next loop.
