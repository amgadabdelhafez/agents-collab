# Plan

1. Extend the shutdown client with bounded caller metadata.
2. Record both declared metadata and server-observed peer socket data before the
   proxy accepts the shutdown.
3. Label the paired-start cleanup producer.
4. Exercise the real HTTP endpoint and the tmux cleanup seam in tests.
5. Run repository gates, commit, and request exact-SHA review.
