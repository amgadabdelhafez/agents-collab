# D16 Exact-Base Red Reproduction

## Boundary

- Repository implementation base/HEAD:
  `ee559c4f75dfe36e2dd61c607d48a3aba4faa500`.
- Production diff under `loop-fork/src/`: empty.
- Test SHA-256 at red: `e0c784e7574b25483feaed118ab73cc40723fa78648921fef37a3c83e8a8eaf7`.
- No live helper route or provider spend occurred. The regression uses an in-process fake local
  provider and an isolated temporary Git repository.

## Command

```bash
cd loop-fork
bun run test:file -- tests/loop/utility-pi-harness.test.ts \
  --test-name-pattern "D16 utility scope audit preserves routing-hidden Git paths"
```

## Fixture and observed behavior

The fixture commits `.gitignore` and `src/tracked.ts`, then:

- modifies `src/tracked.ts` in the worktree;
- creates untracked `specs/d16-fixture/spec.md`;
- routes a `kind=review`, `reviewMode=utility-audit`, `executionProfile=git-status` request;
- lets the fake provider call the real `git_status` broker once and synthesize only what it sees.

Native Git before the worker reports:

```text
 M src/tracked.ts
?? specs/
```

The real broker's protected pathspec excludes `specs/d16-fixture/spec.md`, so the provider receives
only `src/tracked.ts` and responds:

```text
Audit complete: one modified path, src/tracked.ts; no other changed paths.
```

The durable utility journal records `state=completed`, `result.status=completed`, and the same
summary. It contains no `scopeAudit` field.

## Decisive failure

The regression requires a two-record authoritative manifest containing both paths plus count/hash.
It fails:

```text
Expected result.scopeAudit:
  clean: false
  count: 2
  records include specs/d16-fixture/spec.md and src/tracked.ts
  sha256: 64 lowercase hex characters

Received result:
  status: completed
  summary: Audit complete: one modified path, src/tracked.ts; no other changed paths.
  scopeAudit: absent

0 pass, 11 filtered out, 1 fail, 5 assertions
```

This reproduces the actual D16 failure boundary: helper-visible policy filtering can remove a real
Git path, and the persisted/consumed result has no independent evidence with which to reject the
false complete scope.

## Setup-only correction

The first invocation stopped before worker execution because the fixture expected Git to collapse
the untracked path as `?? specs/d16-fixture/`; Git correctly emitted `?? specs/`. The fixture
precondition was corrected only, then the unchanged D16 assertion produced the decisive failure
above.
