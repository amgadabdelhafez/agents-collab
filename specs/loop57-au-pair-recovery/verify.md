# Verification

## Automated

- A Codex request processed while Claude is driver delivers fallback output to
  Codex, not Claude.
- Explicit peer review still targets the other full agent.
- `read_file` missing-path errors suggest only in-scope candidates and never
  auto-read them.
- `list_files` accepts descendants inside a directory scope and still rejects
  paths outside scope.
- Pi rejection-round regressions remain green.
- Nanny and Au Pair pane transcript lines show `QWEN` or `GLM` while the
  tmux pane-border titles remain unchanged.
- Neither helper pane includes the Governess project-summary advisory.
- A job ID appears only on its request header, and the result body uses the real
  worker summary rather than only a tool-count pane summary.
- Full tests, build, Harness preflight, stop gate, and eval pass.

## Live Loop 57

- Claude pane `%0` PID `70452` and Codex pane `%1` PID `70454` remain unchanged.
- A new multi-file inspection is routed to Au Pair and completes.
- Its utility bridge result targets Codex, not Claude.
- Governess and Au Pair panes show the fresh success rather than only the stale
  `600877d3` failure.
