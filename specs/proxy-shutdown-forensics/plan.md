# Plan

1. Extend the shutdown client with bounded caller metadata.
2. Record both declared metadata and server-observed peer socket data before the
   proxy accepts the shutdown.
3. Reject shutdown while the manifest still binds an active live tmux session.
4. Label the paired-start cleanup producer.
5. Exercise accepted and rejected real HTTP requests plus the tmux cleanup seam.
6. Run repository gates, commit, and request exact-SHA review.
