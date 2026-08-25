# T-00 evidence summary

## Outcome

The bounded implementation persists a versioned tmux socket/PID/process-birth
identity after server liveness, persists a frozen redacted resolved-config
snapshot, derives `manifestRevision` from exact strictly decoded and validated
bytes, preserves legacy unknowns, and exposes only exact-socket adapter
diagnostics.

## Named verification

- Focused unit: 25 run-state, 13 paired-options, 7 tmux-control, and 103 tmux
  tests pass. Harness unit attempt 005 is the final green aggregate; attempts
  001-003 preserve the pre-implementation RED failures.
- Regression: `bun run test:ci` passes in final Harness regression attempt 002.
- Build: `bun run build` passes in Harness build attempt 001.
- Integration: the isolated tmux smoke starts two sockets with the identical
  session name, proves both exact contexts live, reincarnates one server at the
  same socket, then proves the old identity unknown and the new identity live.
- Scoped static check: all four source files, four tests, and the smoke artifact
  pass Ultracite in final Harness check attempt 002.
- Diff: `git diff --check` passes in Harness diff attempt 001 for the authored
  working-tree diff. The committed staged check covers source, tests, specs,
  Markdown, TypeScript, and structured JSON. Raw RED `.log` output is excluded
  because Bun's literal source excerpts include trailing spaces after line
  numbers; those evidence bytes are preserved rather than rewritten.

## Boundaries

- Product source changes are exactly `run-state.ts`, `paired-options.ts`,
  `tmux-control.ts`, and `tmux.ts`; tests are exactly their four approved test
  files.
- The resolved-config schema is an exact key allowlist. Tests prove raw prompt,
  proof, session, workspace, MCP, and home/path values do not serialize.
- Adapter diagnostic tests assert every new diagnostic command begins with
  `tmux -S <persisted socket>` and reject socket, PID/birth, timeout, and
  malformed-output mismatches.
- No Web route, mutation, provider/model/dependency, launch-admission, resume-
  admission, or control-authority path changed.

## Baseline

`baseline_failures` for task-scoped code is `[]`. The repository-wide
`bun run check` also reports 85 formatting diagnostics in pre-existing
historical `runs/*` JSON artifacts that are unchanged by this branch. Those
unrelated evidence files were preserved; the scoped static gate is clean.

## Remaining gate

Commit the exact scope, rerun the committed diff check, and record a zero-write
exact-SHA review before Harness completion.
