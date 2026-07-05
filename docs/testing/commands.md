# Test Commands
> Authoritative list of how to run every test type. Agents and hooks use this.

## Unit tests

```bash
# Run all unit tests
cd loop-fork && bun run test:ci

# Run tests for a single module
cd loop-fork && bun test tests/loop/babysitter.test.ts
```

## Integration tests

```bash
cd loop-fork && bun test tests/loop/codex-tmux-proxy.integration.test.ts
```

## End-to-end / browser tests

```bash
# No browser E2E suite is currently configured.
```

## Snapshot / golden tests

```bash
# No snapshot suite is currently configured.
```

## Full verify suite (used by hooks and CI)

```bash
scripts/verify.sh
# Runs loop-fork dependency install, tests, and build.
```

## Coverage report

```bash
# No coverage command is currently configured.
```

## Notes

- Integration tests are self-contained unless the test filename says `manual`.
- Manual tmux/Codex checks are documented under `loop-fork/README.md`.
- Flaky tests are tracked in `docs/quality/quality-scorecard.md` → Debt register.
