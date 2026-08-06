# Plan

1. Add a producer-backed regression that runs several wake cycles through one
   worker wake session and asserts one watcher is created and closed.
2. Move watcher and metadata-probe ownership from each wait to a worker-scoped
   wake session.
3. Keep the public one-shot wait helper by creating and closing a temporary
   session around one wait.
4. Verify the bridge suite, full suite, build, formatting, and committed diff.
