# Independent review: PASS

Reviewer: `evaluate_utility_context_capsules` (separate from the implementation agent)

Target: working tree on `codex/utility-context-capsules`, reviewed against base
`6e2ad813314319341fc049d04112b5af5f49434f` and the task spec, plan, tasks,
and verification contract.

## Findings

No open correctness or security findings remain.

During review, an adversarial fake-provider response proved that capsule text
could initially be echoed through a context-insufficient blocker into the
output-only worker pane. The implementation agent fixed that boundary by
persisting a runtime-owned `paneSummary` for capsule-backed completion,
context-insufficient, and failure results; observability now prefers that safe
summary while retaining legacy-result compatibility. The regression now makes
the provider echo `DO-NOT-PANE-CONTEXT-9987`, proves the raw blocker remains in
the durable result, and proves the marker is absent from `renderUtilityPane`.

The corrected implementation also passed review of:

- deterministic stable-JSON capsule hashing and exact persisted prompt reuse;
- root-only, regular, non-symlink project instructions with character bounds;
- normalized allowlisted context-reference shapes, six-reference limit,
  per-reference and aggregate limits, secret/traversal rejection, realpath
  containment, and rejection of symlink leaves and intermediate directories;
- hard-coded system authority preceding repository context, with route scopes,
  tools, execution plans, and side effects still enforced by router/broker;
- dynamic protection of the persisted context directory from worker tools and
  the existing governing-file protection for `UTILITY.instructions.md`;
- exact context metadata in compact result and usage records;
- a single terminal `escalated` context-insufficient result with no evidence
  retry, a bounded blocker, separate observability count, and no pane leak;
- optional `context_refs` bridge compatibility, normalization, durable JSONL
  storage, and idempotency differentiation.

## Verification evidence

- Focused corrected-diff run: `96 pass, 0 fail` across utility context,
  runtime, observability, and task-router tests.
- Bridge contract run: `75 pass, 0 fail`.
- Full suite after the leak fix: `1032 pass, 4 fail` across 51 files. The four
  failures are the pre-existing Codex runtime-config expectation failures in
  `paired-options.test.ts` and `runner.test.ts`; the same four fail on the exact
  base commit in the clean base worktree (`25 pass, 4 fail` for those files).
- `bun run build`: pass; compiled binary SHA-256
  `a7c88a635d36da549a2d8661792670f3ac0e56bbde18888f1c01f22d451a1a18`.
- `git diff --check 6e2ad81`: pass.
- Repository `scripts/verify.sh` was invoked as required; it currently contains
  configuration placeholders only, so the substantive evidence is the focused
  tests, full Bun suite, build, and diff check above.

Reviewed source hashes at verdict time:

- `utility-context.ts`: `feb67ef57e10fcb12c3d6293065cbf083bba97b43ade65054869fd91c9a85327`
- `utility-runtime.ts`: `3c69a982868f2502ef61d604cf14909bb7f6ac78b391893679c2fb256e395aef`
- `utility-observability.ts`: `595d22e92eacecd2446ce6521a7ece917ff1bbb0df55db0464717168e21724d7`
