# Spec: Governess helper-tier environment passthrough

## Problem

`governessEnv()` writes an explicit environment allowlist to disk before the
Governess pane starts. Helper workers inherit that environment, but helper-tier
settings read under `loop-fork/src/` are omitted. Launch-shell Au Pair gateway
settings therefore disappear and routing can fall back to OpenRouter.

## Goal

Carry every non-secret Au Pair, Nanny, utility, and recon environment variable
read by source code into the Governess environment file while never copying raw
API keys.

## Non-goals

- No binary build or install.
- No Switchyard or `routes.toml` changes.
- No reordering or removal of existing Governess environment entries.

## Acceptance criteria

- [ ] Present `LOOP_AU_PAIR_URL`, `LOOP_AU_PAIR_MODEL`, `LOOP_NANNY_URL`, and
      `LOOP_UTILITY_ALLOWED_TIERS` inputs appear in Governess environment output;
      absent inputs produce no entries.
- [ ] `LOOP_AU_PAIR_API_KEY` and `LOOP_UTILITY_API_KEY` values never appear in
      Governess environment output.
- [ ] A source-derived test fails when any matching helper-tier variable read
      under `src/` is neither passed through nor explicitly denied as a secret.
- [ ] Removing helper passthrough makes named behavior and coverage tests fail.
- [ ] Required focused, static, CI, and whitespace checks pass.

## Out-of-scope risks

The environment is persisted on disk. Raw secret variables remain denied;
`*_API_KEY_FILE` path variables are safe to pass.

