# Live 10 KB launch smoke

Candidate binary SHA-256:

`712672750d0f1e1a09c7759312f45020bd6c8efd4141a54b2d73f94b8c6e891c`

Input:

`/Users/amgad/.loop/prompts/harvto-loop62.md` — 10,257 bytes.

Isolation:

- Fake Gemini and Cursor executables under this artifact directory.
- Tmux wrapper uses private socket `loop-large-prompt-smoke`.
- Recon and utility panes disabled for the smoke only.

Observed output:

```text
[loop] starting paired tmux workspace...
[loop] started tmux session "agents-collab-loop-4"
[loop] attach with: tmux attach -t agents-collab-loop-4
agents-collab-loop-4 1 0
agents-collab-loop-4 %0 sh 0
agents-collab-loop-4 %1 sh 0
agents-collab-loop-4 %2 loop 0
```

Positive outcome assertions:

- `tmux has-session -t agents-collab-loop-4` returned success on the private
  server.
- The session exposed agent panes `%0` and `%1` plus Governess pane `%2`.
- The archived manifest records `tmuxSession: "agents-collab-loop-4"`,
  `tmuxPaneLeftAgent: "gemini"`, and `tmuxPaneRightAgent: "cursor"`.
- A compiled-binary negative smoke using a tmux shim that returned success for
  workspace creation but never created a session exited nonzero with
  `tmux session ... exited before attach`.

Cleanup:

- Killed only the private tmux server.
- Moved the generated run directory from active `~/.loop` storage to
  `runs/large-prompt-launch/artifacts/live-run-4/` for evidence.
