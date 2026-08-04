# Plan

1. Separate stdin-drain shutdown from hard parent/signal shutdown.
2. Add a regression that kills the parent-loss exit decision after EOF while
   preserving the live-input cleanup branch.
3. Add a short-lived two-frame integration regression that requires both
   initialize and tool responses with one durable ledger message.
4. Run focused and complete verification, commit, and request exact-SHA review.
