# Task d029-immutable-run-static-scope

## Objective

Make the repository static gate compatible with verify 18's immutable Harness
evidence rule without weakening checks over source, tests, scripts, or config.

Regression: yes
Regression id: static-check-mutates-harness-evidence
Regression symptom: repository check fails unless historical `runs/**` JSON is
reformatted, invalidating recorded hashes and mtimes.
Regression guard: exact Biome exclusion plus source-positive/run-negative probes

## Scope

Biome file scope, D-029 Harness metadata, and installed-harness defect backlog
only. No production source, historical run evidence, product lane, or
modernization file is changed.

## Verification

- `bun run check`: PASS, 205 source-owned files checked.
- `bunx biome check --verbose src/cli.ts`: PASS, exactly one source file
  processed.
- Direct historical-run probe: expected exit 1, zero files processed, exact
  path reported ignored by configuration.
- No preexisting `runs/**` record changed; T16 will capture its release baseline
  after this prerequisite task and D-030 are committed.
- Independent evaluation: PASS.
