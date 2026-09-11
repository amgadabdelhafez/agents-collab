# Plan: Governess helper-tier environment passthrough

## Approach

Define one explicit helper-tier passthrough list beside `governessEnv()` and add
it additively to the existing output. Keep a separate explicit raw-secret
denylist. Expose both through `tmuxInternals` so tests can compare them with a
source-derived inventory and prevent future silent omissions.

## Sequence

1. Derive helper-tier names from `loop-fork/src/`.
2. Add all non-secret names to the Governess allowlist without changing existing entries.
3. Add behavior, secret-exclusion, and derived-coverage tests.
4. Capture mutation failures, then run focused, static, CI, and whitespace checks.
5. Obtain Claude peer review, write eval evidence, commit explicit paths, and open a draft PR.

## Key decisions

- Raw `LOOP_AU_PAIR_API_KEY` and `LOOP_UTILITY_API_KEY` names belong only to the denylist.
- `*_API_KEY_FILE` names belong to the passthrough list because they contain paths, not secret values.
- Source-derived coverage scans TypeScript source, independent from production constants.

## Affected subsystems

- CLI and tmux: Governess environment-file composition.
- Utility runtime: inherited helper routing configuration.

## Risks

- Future helper variables could leak secrets. Mitigation: explicit denylist review and derived coverage.
- Empty values could create unwanted entries. Mitigation: preserve existing `passEnv()` semantics.

## Not doing

No runtime routing, provider, binary, installation, or route configuration changes.

