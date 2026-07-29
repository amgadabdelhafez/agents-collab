# Large prompt launch task log

- Source evidence: prompts up to 2,800 bytes launch; prompts at 2,900 bytes and
  above silently exit 0 without a tmux workspace on deployed commit `c78b35d`.
- Regression proof: the unchanged 6,997-byte loop-61 charter launched on the
  prior runtime build and fails on `c78b35d`.
- Production blocker: the current Harvto charter is 10,257 bytes.
- Root cause: composed agent startup commands were 12.1-12.4 KB before the
  task. A 2.9 KB task pushed the tmux client/server command message to roughly
  15.3 KB, where workspace creation disappeared despite the client exit code.
- Fix: launch each agent with a short command, write its composed prompt to a
  mode-0600 temporary file, load it into a named tmux buffer, delete the file,
  paste into the stable pane, and submit. Every load/paste/submit step is
  checked and fails the launch on a nonzero tmux result.
- Focused result: `bun test -t 'realistic 10KB prompt' tests/loop/tmux.test.ts`
  passes and proves both complete composed prompts exceed 18 KB while both
  workspace command strings remain below 4 KB.
- Full result: `bun run test:ci` passes all test files with zero failures.
- Live result: compiled candidate SHA-256
  `712672750d0f1e1a09c7759312f45020bd6c8efd4141a54b2d73f94b8c6e891c`
  launched the unchanged 10,257-byte `harvto-loop62.md` as the isolated
  `agents-collab-loop-4` workspace with three live panes. The private tmux
  server was stopped and its run record moved into this task's artifacts.
- Outcome gate: the live session existed by name, both expected agent panes
  were present, and the manifest contained a non-empty `tmuxSession`. A
  compiled-binary negative smoke that simulated tmux returning success without
  creating a workspace exited nonzero with the expected error.
- Independent review: Claude re-ran 1,186 tests and the live smoke, recomputed
  the candidate hash, and issued CONCUR on exact commit
  `7df3202f69e77c8e00dce8c727864a0b9e74a3cb` in xchan message
  `177e8da9-946a-44d5-86ea-ce9221d28674`.
- Deployment: `/Users/amgad/.local/bin/loop` resolves to the reviewed candidate
  with SHA-256
  `712672750d0f1e1a09c7759312f45020bd6c8efd4141a54b2d73f94b8c6e891c`.
