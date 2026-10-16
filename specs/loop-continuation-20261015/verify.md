# Verification

## Ownership and lifecycle controls

- Foreign listener before connection: no connection is attempted; only the
  exact launch child is cleaned up.
- Listener replacement or ownership loss during connection: the exact returned
  socket is closed, initialization is not sent, and only the exact launch child
  is signalled.
- ABA control: child listener, foreign socket acceptor, child listener again
  must be refused by exact established-connection ownership proof.
- Positive control: the unchanged exact child owns both the listener and the
  accepted connection; initialization and publication succeed.
- Stale child/socket/close callbacks cannot clear, close, or signal a newer
  launch generation.
- Normal close closes the exact socket and signals the exact child. Detached
  release closes the exact local socket without signalling the child.

## Focused commands

Publication controls must exercise both SCP and URL-form GitHub remotes through
the same positive owner/repository grammar. Backticks, `$()` text, single and
double quotes, whitespace/option-bearing names, control characters, encoded
metacharacters, unsupported protocols, query strings, and fragments must fail
closed. Every refusal must prove `runAgent` was not called and that the local
no-publication handoff was returned. A valid repository must be rendered as a
shell-safe quoted `gh --repo` argument.

Run these from `loop-fork` and preserve per-command counts:

```bash
bun run test:file -- tests/loop/codex-app-server.test.ts
bun run test:file -- tests/loop/ws-client.test.ts
bun run test:file -- tests/loop/pr.test.ts
bun run test:file -- tests/loop/args.test.ts
bun run test:file -- tests/loop/tmux.test.ts
bun run test:file -- tests/loop/single-loop.test.ts
bun run test:file -- tests/loop/review.test.ts
bun run test:file -- tests/loop/paired-loop.test.ts
bun run test:file -- tests/loop/00-paired-loop.integration.test.ts
bun run test:file -- tests/loop/codex-render.test.ts
bun run test:file -- tests/loop/utils.test.ts
bun run test:file -- tests/loop/review-run.test.ts
bun run test:file -- tests/loop/runner.test.ts
bun run check
```

Run scoped candidate `git diff --check` with the exact excluded verbatim or
review-log artifacts named in the result. Do not run broad suites, heavyweight
builds, or later `scripts/verify.sh` stages while free swap is below 4 GiB.

## Final review

The independent reviewer must inspect the complete landing-base-to-final
snapshot, including retained dependencies, surrounding attribution/lifecycle/
completion/review/publication/tmux consumers, every changed source/test/doc/run
artifact, and the frozen canonical handoff. Preserve only bounded final review
evidence, not hidden reasoning or a complete transcript. No candidate file may
change after PASS; exact final object and reviewer identifiers belong in the
external no-publication handoff because an in-tree file cannot contain its own
final object ID.
