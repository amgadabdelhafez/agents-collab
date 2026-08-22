# Task webui-all-active-loops

Created: 2026-08-21T22:43:48Z
Mode: planned
Description: Discover and project every valid non-terminal loop across the shared run registry with per-run failure isolation and collision-safe routes.

## What I changed

- Replaced the single-run adapter with bounded, symlink-safe discovery across
  direct repository directories and direct numeric run directories in the
  shared loop registry.
- Projected each valid active run independently, with manifest-only degraded
  rows for unreadable optional evidence and fleet-level partial quality for
  omitted invalid manifests.
- Added collision-safe `repositoryId:runId` routes, derived repository labels,
  repository filters, generic fleet copy, correct working counts, and an
  explicit no-longer-active detail state.
- Made lifecycle arbitration timestamp-aware across Governess and hook
  evidence. Losing evidence is marked stale and stale tool-start hooks cannot
  claim a tool remains in flight.
- Tightened the client DTO boundary so synthetic/fixture provenance,
  contradictory fleet/detail summaries, and malformed worker completion
  metrics fail closed.

## Why

The first Web UI slice followed one configured Harvto run. Operators need one
read-only view of every current loop, including equal numeric run IDs in
different repositories, without exposing raw paths, tmux data, prompts, or
credentials and without one corrupt lane suppressing healthy peers.

## Notes

- Final live security verification at 2026-08-22T00:06Z discovered the two
  current routes: `ai-cur-458d3aca27ff:55` and
  `harvto-b1e274e66299:242`.
- The redaction instrument inspected 306 candidate sensitive source values and
  found zero leaked values, zero absolute paths, and zero raw runtime fields.
- Focused verification passed 48 tests with 270 assertions: adapter 30/175,
  API contract 7/25, rendering 4/49, and selectors 7/21.
- The supported full sequential suite passed 1,579 tests across 80 files with
  zero failures. Web UI build, project build, Web UI and task-server typechecks,
  scoped style checks for all 14 changed code/test files, and diff check pass.
- The repository-wide style command still fails on machine-generated Harness
  JSON formatting: the clean base has 25 pre-existing diagnostics and this run
  has 29. The four added diagnostics are current Harness command-array JSON,
  not source/test files; those evidence records were preserved rather than
  rewritten. The complete changed source/test allowlist is clean.
- Current desktop and exact 390-by-844 browser evidence covers both live lanes,
  including a newly rotated AI Cur run and the Harvto lane. The mobile viewport
  has `scrollWidth` 390, so no horizontal overflow is hidden by the capture.
- Earlier exploratory files named `fleet-final-mobile-390*` measured 300 by 649
  after browser chrome was applied. They are preserved as non-certifying
  evidence; the `fleet-release-390x844*` captures are the exact mobile proof.
- An independent zero-write reviewer returned literal `PASS` for exact current
  source/test diff SHA-256
  `27a22e75a5065c08036559e66169e2ae89349e51fd71a67485c91cf494205ad3`.
- The repository capture wrapper could not complete because its local
  Playwright package was unavailable. The already-installed browser runtime
  captured DOM and screenshots instead; no dependency or network mutation was
  made.
- A deliberately unsupported multi-file Bun invocation failed closed before
  any tests ran. The supported single-file focused commands and sequential
  full-suite command are the accepted evidence.
- A broad exploratory `tsconfig.json` typecheck remains non-certifying because
  that repository-wide configuration already reports unrelated source/test
  debt and does not enable the `.ts` import mode used by the Web UI server.
  The production Web UI typecheck and an explicit task-server typecheck pass.
