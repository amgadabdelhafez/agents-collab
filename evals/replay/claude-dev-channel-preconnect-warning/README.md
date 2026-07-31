# Claude development-channel pre-connect warning replay

This replay preserves the actual Claude Code 2.1.220 startup sequence observed
with a valid strict MCP config: bypass confirmation, development-channel
confirmation, then a ready composer carrying the transient `no MCP server
configured with that name` line.

The producer capture also exercises the no-raw-pipe activity probe. After the
ready state crosses an activity-second boundary, ordered `End,C-l` advances
tmux `window_activity` while the empty composer stays at cursor column 2. The
same probe moves the exact unsent draft
`Try "do not overwrite this human draft"` to column 41; ordered `Home,C-l`
after its own activity-second boundary advances `window_activity` again and
restores column 2. The draft is then cleared without Enter or a model request.
Styled pane bytes and numeric cursor, activity, attached-client, pipe, and
geometry values are emitted by one tmux client command queue for the same pane.
All selected states are detached and have `pane_pipe=0`; the capture never
invokes `pipe-pane`.

The full raw capture is intentionally private because its ready frame contains
account-identifying UI. `provenance.json` binds the private reference and the
selected raw hashes plus the state/action/environment manifests.
`selected-states.tsv` is the deterministic selection authority; normalization
selects state names, never hardcoded polling-frame numbers. `normalize.mjs`
performs the checked-in deterministic redaction; `check.mjs` verifies hashes,
state and action order, numeric pane binding, both activity advances, draft
preservation/restoration/clearing, and privacy. The public provenance replaces
the producer's machine-specific executable path but retains its exact version
and executable SHA-256; the exact captured path remains only in the private
environment record.

Run:

```bash
node evals/replay/claude-dev-channel-preconnect-warning/check.mjs
```
