# Plan

1. Add failing regressions for event idempotency, Pi rejection rounds, exact Git
   plans, utility-only result draining, summary objective anchoring, and tmux
   Recon layout.
2. Extend existing router/store/runtime interfaces with the smallest structural
   fields needed to satisfy those tests.
3. Build Recon as read-only projections over the existing journals.
4. Run focused tests, full tests/build, evaluator review, Harness preflight, and
   stop gate.
5. Install the verified CLI and hot-swap only lower live panes; then capture live
   evidence that collisions stopped and helper throughput/results improved.
