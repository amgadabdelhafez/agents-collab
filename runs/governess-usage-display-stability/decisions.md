# Decisions

- Cache quota in the governess process, not on disk.
- Retain Claude and Codex independently for at most 60 seconds.
- Treat `undefined` as disabled/auth failure and clear all retained quota.
- Always use pricing from the current reader result; never cache it here.
- Preserve all agent and worker panes; replace only the governess pane.
