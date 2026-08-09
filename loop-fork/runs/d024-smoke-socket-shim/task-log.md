# Task d024-smoke-socket-shim

## Objective

Make every tmux smoke use the same exact absolute socket authority as the
product and prove the recorded manifest socket matches it.

Regression: yes
Regression id: smoke-label-routing
Regression symptom: Smoke uses `-L` label routing and can miss or contact the wrong tmux server.
Regression guard: repository sweep plus changed-smoke syntax and runtime assertions

## Verification

- Replaced label-valued smoke routing with absolute `LOOP_TMUX_SOCKET` paths.
- The canonical shim is a validator, not an authority producer: it permits the
  singleton `-V` probe or requires product argv to begin with exact
  `-S "$LOOP_TMUX_SOCKET"` before passing argv through unchanged.
- Real inspection and cleanup commands use `tmux -S` with the same case socket.
- Large-prompt, active-launch, paste-submit, and redraw manifests assert their
  recorded socket equals the smoke-created path. Recovery output is also
  asserted with its socket-qualified attach command.
- Socket pathname budget is measured with `wc -c` bytes.
- Paste and redraw canonicalize temporary roots before deriving socket paths;
  all three wrapper copies reject missing or relative socket values.
- Bash syntax checks and repository old-shim sweep passed.
- Real private-socket redraw/backpressure smoke passed twice.
- Independent zero-write review: PASS.

## Isolated operational backlog

The three older launch smokes still use retired Gemini/Cursor producer fakes.
Substituting current seats requires separate Claude kickoff and Codex
app-server fixture protocols, so that work is parked as
`d025-current-agent-smoke-fixtures` rather than mixed into socket authority.
