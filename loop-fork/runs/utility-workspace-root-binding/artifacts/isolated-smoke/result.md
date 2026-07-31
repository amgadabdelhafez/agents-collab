# Exact-prebuilt isolated live-launch smoke

Status: PASS

Binary SHA-256:
`e98d1edd2c9394b8cdb5bd3d6f4a09a8911d0a51d9d5a322838b6927764503a8`

The realistic charter smoke used the prebuilt candidate and verified its hash
before and after execution. It positively observed the named tmux session,
Gemini and Cursor panes, isolated manifest binding, hash-bound bootstrap,
delayed Claude readiness, and the detached 220x60 eight-pane layout. A Claude
readiness timeout and a missing workspace both exited 1 and persisted failed
manifests. No host run or global binary was mutated.
