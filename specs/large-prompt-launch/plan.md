# Plan

1. Diff paired tmux startup between the last known-good runtime branch and
   `c78b35d`, then reproduce the failing transport in a focused test.
2. Replace the size-limited prompt handoff with a file/stdin-safe transport.
3. Make workspace creation failure observable and nonzero.
4. Add focused unit coverage and an at-least-8-KB lifecycle smoke case.
5. Run focused tests, full verification, and record an eval.
