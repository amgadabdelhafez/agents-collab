# Verify: Explicit Utility Workspace Binding

## Automated checks

```bash
cd loop-fork
bun run test:file -- tests/loop/task-router.test.ts
bun run test:file -- tests/loop/utility-workspace.test.ts
bun run test:file -- tests/loop/bridge-guidance.test.ts
bun run test:file -- tests/loop/bridge.test.ts
bun run test:file -- tests/loop/utility-runtime.test.ts
bun run test:file -- tests/loop/utility-tools.test.ts
bun run check
bun run test:ci
bun run build
```

## Functional checks

| # | Check | Assertion | Pass condition |
|---|---|---|---|
| F-01 | Explicit linked root | Submit linked root plus relative read/write scopes | Decision root is canonical linked worktree; scopes remain relative |
| F-02 | New target | Include absent exact file in read and write scopes | Packet routes; null preimage is recorded; guarded apply creates only linked target |
| F-03 | Drift guard | Create target after proposal, before apply | Apply fails as patch drift and does not overwrite |
| F-04 | Root validation | Try unrelated, unregistered, symlink-alias roots | Every packet returns `workspace-unverified`; no worker starts |
| F-05 | Scope validation | Try absolute/mixed scopes with explicit root, directory write, symlink parent | Every packet fails closed |
| F-06 | Compatibility | Omit root and use existing relative/legacy absolute forms | Existing canonical and linked behavior remains unchanged |
| F-07 | Bridge contract | Inspect tool schema and persisted request | Field and guidance are present; root participates in identity |
| F-08 | Run-102 replay | Replay a relative edit packet against canonical and explicit linked root | Omission is actionable failure; explicit root routes |

## UI checks

Not applicable; no pane layout or user-interface rendering changes.

## Performance thresholds

No new subprocesses or scans may occur after workspace verification. Each route
may use only the existing bounded Git identity/worktree queries.

## Regression guards

- [ ] Existing relative scopes continue to bind to the canonical run root.
- [ ] Existing all-absolute registered-worktree packets continue to normalize.
- [ ] Protected paths remain `protected-scope` denials.
- [ ] Patch hashes and byte-preimage checks are unchanged.
- [ ] Full suite and lifecycle smoke pass with no baseline allowlist entries.

## Rollback conditions

Revert if an unregistered/aliased root is accepted, canonical files are changed by
a linked-worktree packet, or an omitted selector changes existing routing.

## Eval output format

Write `loop-fork/runs/utility-workspace-root-binding/eval.json` with named checks,
empty `baseline_failures`, and verdict `pass` only after independent review.
