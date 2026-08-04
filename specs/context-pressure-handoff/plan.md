# Plan

1. Add a pure, model-profiled pressure evaluator with context-first reasons.
2. Persist per-agent decisions in Governess state with backward-compatible
   loading and transition-only logs.
3. Send a one-time preparation request and connect due decisions to the existing
   two-phase handover in enforce mode.
4. Add producer-backed tests for thresholds, precedence, persistence, dedupe,
   observe/off/dry-run behavior, and lifecycle activation.
5. Run focused tests, repository checks, sequential tests, Harness gates, then
   commit and request exact-SHA supervisor review.
