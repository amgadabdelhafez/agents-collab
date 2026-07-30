# Plan: tmux redraw backpressure

1. Trace the capture, mutation, render, and exception paths in the Governess
   cycle and identify the smallest per-tick control boundary.
2. Add tick-scoped tmux availability/circuit state that records the first
   unavailable operation, suppresses later tmux probes/mutations for that tick,
   and carries a display-only degraded snapshot between ticks.
3. Render durable state plus a compact degraded marker even when pane observation
   is unavailable. Keep every recovery and delivery decision gated on fresh pane
   evidence from the current tick.
4. Add focused unit tests for one-probe behavior, continued rendering, stale
   evidence safety, recovery, and large Unicode pane contents.
5. Run focused tests, full repository verification, build, diff checks, and an
   isolated realistic tmux smoke. Record evidence in `runs/tmux-redraw-backpressure/`.
6. Obtain an independent exact-SHA review before installing or hot-swapping the
   binary. Coordinate any run-101 process recovery separately with its supervisor.
