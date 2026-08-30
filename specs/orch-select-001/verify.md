# Verify: workflow engine selection

## Evidence checks

- Resolve all four cited closure commits locally.
- Confirm the Temporal closure records all six cases and aggregate digest
  `5f1bd79af5217d60339a50996d6f3bc04c6f745e9a0c2a832d09cfe0caf8abdd`.
- Confirm the DBOS closure records five exact matches followed by the distinct
  v1 `PENDING` / v2 bounded-timeout refusal.
- Confirm no source, test, fixture, lockfile, or dependency file changes.

## Static gates

```bash
cd loop-fork
bun run check
git diff --check
```

Then freeze one exact candidate and require independent zero-write review of
the exact commit and parent.
