# Verification (historical transport)

This feature's full-body terminal transport was superseded by
`constant-size-transport`. Its committed smoke now protects the successor
invariant: launch panes receive hash-bound bootstraps, runtime panes receive
only bounded inbox nudges, and the full bridge body is delivered exclusively by
`receive_messages`.

1. A realistic 22 KB Codex prompt does not receive Enter until its
   `[Pasted Content ...]` marker is captured.
2. A realistic 22 KB Claude prompt does not receive Enter until its fragmented
   `[Pasted text #N]` marker is captured.
3. Missing render evidence terminates at the configured poll bound.
4. The two pane waits begin before either pane is submitted.
5. `scripts/verify.sh paste-submit-readiness paste-submit-readiness` passes.
6. `runs/paste-submit-readiness/eval.json` records a separate-agent verdict.
7. A 9,279-byte runtime bridge body remains exclusively in the bridge ledger;
   the terminal receives one notification below 128 bytes with no identifier,
   subject, or body.
8. Notification evidence leaves the body pending until `receive_messages`
   returns it completely and appends exactly one delivered resolution.
