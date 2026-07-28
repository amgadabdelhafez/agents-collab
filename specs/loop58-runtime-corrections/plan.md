# Plan

1. Port the config-GC commit into the active Pi branch with conflicts resolved
   in favor of the newer routing and pane topology.
2. Add prompt tests that prove a reviewer waits for a primary request before
   reading, delegating, or doing task work; then make utility guidance
   role-aware.
3. Add red broker/runtime tests for a native one-to-eight-file line-count tool,
   including traversal, directory, protected-path, duplicate, oversized, and
   out-of-scope failures; then implement it.
4. Run focused tests, full tests, build, diff check, and Harness gates.
5. Install the verified binary and hot-swap only the Loop-58 surfaces required
   to load the new code and prompt, preserving Codex and task worktrees.
6. Run a requestor-bound line-count canary and verify the real Claude registry
   contains no loop bridge.
