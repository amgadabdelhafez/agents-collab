# Proxy shutdown forensics task log

- Live run 119 checked without mutation: all eight panes alive; app-server on
  port 4500; no listener on proxy port 4600; lifecycle ends with the
  unattributed `stopped/requested` event.
- Implementation base is the exact approved integrated lineage
  `552403ffc7ff673c688308adafd520f7adf14ab9`. The current `origin/main` does not
  contain the shutdown endpoint under diagnosis, so branching from it would
  omit the deployed producer and could not provide a valid regression test.
- The real shutdown client now sends a bounded caller label and declared PID;
  the server writes `shutdown-requested` with those declared fields and its own
  observed peer socket before accepting shutdown. Paired-start cleanup uses
  the exact label `paired-start-cleanup`.
- Focused proxy/tmux suites: 114 passed, 0 failed. Repository `bun run check`,
  full certified `bun run test:ci`, compiled build, and `git diff --check` all
  passed with an empty named baseline-failure list.
