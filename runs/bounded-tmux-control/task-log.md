# Bounded tmux control task log

- Live run-98 evidence at 2026-07-29T14:50Z: app-server PID 56946 listened
  on port 4505 and proxy PID 64202 listened on 4600, while bounded
  `has-session` and `list-panes` probes each timed out after two seconds.
- Multiple `has-session`, `capture-pane`, and `send-keys` clients accumulated;
  the supervisor teardown shell was blocked behind tmux.
- Codex terminated only its own diagnostic PIDs 5151 and 5166. It did not
  mutate run-98 or signal the ChatGPT Desktop app-server.
- Cumulative commit `8a3746561a00f8bd711a04a846b9c902e5b75147`
  was independently reviewed and deployed before this separate slice opened.
- Added one two-second, SIGKILL-bounded tmux control policy. Liveness is now
  `live`, `dead`, or `unknown`; only confirmed death permits stale-state
  clearing or fallback delivery.
- Bridge requests remain queued on timeout, paired launch/resume exits
  nonzero, the Codex proxy stays alive, and Governess pauses recovery and
  preserves initializing or unobservable replacements without relaunching.
- A first draft of the Governess timeout regression used an immediately
  resolved sleep and starved its already-resolved key input in `Promise.race`,
  leaving three test processes spinning. Codex killed only those exact test
  PIDs, changed the test sleep to a five-millisecond timer, verified no test
  processes remained, and reran the file successfully (64 pass, 0 fail).
- Verification at 2026-07-29T16:12:04Z: focused boundary set 80 pass, 0 fail;
  full lint, source typecheck, compiled build, and sequential repository suite
  passed. The first project-verifier invocation stopped only at the expected
  pending eval verdict; the eval was then promoted with an empty baseline.
