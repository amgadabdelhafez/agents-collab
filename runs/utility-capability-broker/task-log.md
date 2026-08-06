# Utility Capability Broker Task Log

## Baseline

- Live run: `harvto-b1e274e66299/140`
- Failed Au Pair jobs: 7
- Shared outcome: failed closed after 3 consecutive broker-rejected model
  rounds.
- Shared missing capability: exact SHA-256 verification for declared files.
- Rejected substitutes observed: `sha256sum`, `shasum`, `openssl`, raw `git`,
  raw `node`, and shell syntax.
- Existing default command prefixes: `bun test`, `node --check`, and
  `npx vitest run` with a repository-local Vitest binary.
- Interpretation: broker capability mismatch. The provider and later Au Pair
  jobs remained healthy.

## Implementation

- Added in-process `inspect_files` and `read_json` tools.
- Added schema-v3 capability maps with exact tools, scopes, command prefixes,
  and dedicated safe alternatives.
- Added recovery guidance for denied commands and explicit prompt guidance
  against executable probing.

## Verification

- Focused utility tools: 49 passed, 0 failed.
- Focused utility context: 6 passed, 0 failed.
- Focused utility runtime: 53 passed, 0 failed.
- Focused Pi harness: 11 passed, 0 failed.
- Complete sequential suite: every sorted test file passed.
- Lint/format, TypeScript, compiled build, and diff checks passed.
