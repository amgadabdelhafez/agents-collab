# Plan

1. Capture the real Codex and Claude large-paste render markers from loop-62.
2. Add a bounded, agent-aware paste-ingestion wait around paired startup.
3. Use bracketed tmux paste and launch the two pane submissions concurrently.
4. Add a delayed-render regression test using a realistic 22 KB prompt.
5. Replace runtime bridge `send-keys -l` streaming with private-file-backed tmux
   buffers and add a delayed-render regression using the observed 9,279-byte
   review-request size.
6. Run focused, full, and compiled-binary smoke verification; record an eval.
