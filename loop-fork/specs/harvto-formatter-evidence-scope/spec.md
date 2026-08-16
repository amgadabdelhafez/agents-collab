# Formatter Generated-Evidence Scope

## Problem

At inherited campaign state `254e1749ca67ad1d81cd434ef01db0aeabae5827`, repository formatting checks
inspect generated files under `loop-fork/runs/**`. Preserved run evidence is immutable and may
contain historical JSON formatting that current Biome rejects. `bun run check` is therefore red on
pristine evidence even though the failure predates D6 and is not a D6 implementation defect.

This task gives that root cause its own lifecycle. It must not alter active D6 state, rewrite
evidence, or weaken checks over source, tests, configuration, or specifications.

## Required behavior

1. `loop-fork/biome.jsonc` excludes the directory `runs/` beneath the Biome root `loop-fork/`.
   The directory-scoped on-disk excluded set is exactly `loop-fork/runs/`; its current
   Biome-supported contents are generated run evidence.
2. Biome layers local `files.includes` entries after entries supplied by `extends`. A local positive
   `"**"` would re-include paths excluded by the preset and triggers `noBiomeFirstException`.
   Therefore the local top-level value is exactly `"files": { "includes": ["!runs"] }`: one
   single-line negative folder entry, no local positive glob, and no copied preset entries. This
   preserves the preset's inherited positive and forced exclusions while adding only the `runs/`
   exclusion, keeps source/tests checked, avoids upstream-array drift, and makes `biome.jsonc`
   self-lint clean.
3. All four existing `overrides` blocks, their `includes` arrays, and every existing rule setting
   remain byte-identical. No global rule is disabled.
4. `loop-fork/src/**`, `loop-fork/tests/**`, `loop-fork/specs/**`, `loop-fork/biome.jsonc`, and
   repository-root `runs/**` remain outside the excluded generated-evidence set.
5. Representative source and test files remain visible to Biome. Deliberately invalid temporary
   fixtures at `loop-fork/src/__formatter_scope_control__.ts` and
   `loop-fork/tests/__formatter_scope_control__.test.ts` must each be created and removed entirely
   within the focused-controls step. Each is rejected, remains unstaged, and is proven absent with
   no status residue before the first mandatory gate and before any commit.
6. Checked-file accounting is bidirectional. The before/after `Files processed:` delta contains
   exactly zero additions. Every removal is under `loop-fork/runs/`, and the removal set equals the
   before-inventory intersection with Biome-supported files under that directory. No source, test,
   spec, config, preset-exclusion fixture, or other path disappears from or appears in checking.
7. A temporary preset-scope matrix maps representative Biome-supported paths for every inherited
   forced-exclusion class: framework/build output directories, generated-code directories,
   generated filename globs, and generated declarations/maps. Each representative remains absent
   from the post-edit verbose processed-file list. For inherited patterns whose native extension
   Biome does not process, record the installed parent entry and the exact local single-negative
   array; do not falsely attribute their processed-file absence to the glob. The matrix is removed
   residue-free inside focused controls.
8. Every Biome invocation is read-only. `bun run fix`, `--write`, `--fix`, `--unsafe`, and any
   formatting or lint write command are prohibited.

## Evidence and lifecycle integrity

- Complete SHA-256 and byte-size inventories for D6 and D15 evidence are frozen before any
  lifecycle attempt and compared after every phase and check. D6 `artifacts/red/**` is never
  edited or regenerated. D15 close evidence remains byte-identical.
- Frozen D6 contract hashes and implementation object
  `254e1749ca67ad1d81cd434ef01db0aeabae5827` remain unchanged. D6 stays active and unclosed until
  this task has its own exact-SHA `PASS` or the supervisor explicitly ratifies another path.
- Root `.loop/` remains untracked with 60 files. Utility remains exactly `0/off/0`; no helper route
  or provider spend is permitted.
- Production scope is exactly `loop-fork/biome.jsonc`. Contracts, run evidence, evals, lifecycle
  records, `PLAN.md`, and `status.md` are bookkeeping scope and never enter the one-file production
  commit.

## Harness refusal handling

Attempt concurrent promotion exactly once while D6 remains active. Hash
`loop-fork/.harness/tasks.json` and `loop-fork/.harness/current-task` immediately before and after,
and capture command, stdout, stderr, exit status, active-task identity, HEAD, and index.

- A rejection with any Harness mutation is a hard stop. Preserve the changed state as evidence;
  do not retry, revert, hand-edit, park, or repair it.
- A clean no-mutation rejection requires completion of the standalone spec/run/root-run structure,
  exact refusal evidence, and an immediate stop for supervisor ratification. It authorizes no red,
  config edit, stage, commit, D6 review, or D6 lifecycle action.
- Concurrent acceptance must preserve D6 unchanged and provide an isolated formatter task identity
  before plan review or implementation continues.

## Review and commit gates

1. Claude must return literal zero-write `PLAN PASS` for exact hashes of `spec.md`, `plan.md`,
   `tasks.md`, `verify.md`, and the run `plan.md` before red or production work.
2. At plan freeze, force-add those five files one by one, prove the cached set equals the reviewed
   set, and create a dedicated contract commit. No directory or broad staging is allowed.
3. After exact-base red and all controls pass, the production commit contains exactly
   `loop-fork/biome.jsonc` and receives Claude literal zero-write exact-SHA `PASS`.
4. Harness did not admit this task, so `harness done` is prohibited for the formatter lifecycle.
   After exact-SHA `PASS`, record exactly one standalone terminal `PASS` in formatter task-log,
   meta, and both evals; prove before and after that D6 remains sole active/eval-pending; and make a
   separate explicit bookkeeping commit.

## Acceptance

- Pristine generated run evidence is no longer checked by Biome and remains byte-identical.
- Source/test fail-open controls, exact local single-negative array, representative inherited
  exclusion controls, config self-lint, and bidirectional checked-file accounting pass.
- Focused checks, `bun run check`, canonical TypeScript, build, complete certified serial suite,
  dual passing evals with empty `baseline_failures`, Harness gates when represented, and the root
  verifier pass.
- The plan-freeze contract commit, one-file production commit, Claude verdicts, and standalone
  terminal/bookkeeping boundary are distinct and exact.
