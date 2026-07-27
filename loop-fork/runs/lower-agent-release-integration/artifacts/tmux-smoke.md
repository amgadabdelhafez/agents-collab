# Disposable tmux smoke

The smoke used a disposable 160x44 tmux session and inert `sleep` placeholders
for the paid main-agent slots.

Default layout:

- left main: 32x80
- top-right utility observer: 8x79
- lower-right main: 23x79
- bottom governess row: 11x160

The observer rendered `LOWER AGENT z-ai/glm-5.2 READY` with zero active,
queued, completed, or failed jobs. A second disposable session with
`LOOP_UTILITY_PANE=0` produced the intended three-pane layout. Both disposable
sessions were removed after capture.

No pane, key, message, signal, process, or persisted state in `harvto-loop-40`
was used by this smoke test.
