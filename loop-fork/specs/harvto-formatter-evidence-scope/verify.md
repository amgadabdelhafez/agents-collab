# Formatter Evidence Scope Verification

## Admission and plan gate

Before red or implementation:

- prove exact HEAD `254e1749ca67ad1d81cd434ef01db0aeabae5827`, parent
  `ee1e7736d876d4b387f13580ec25ddf1c606e873`, empty index, D6 sole-active/eval-pending, utility
  `0/off/0`, 60 untracked root `.loop/` files, and frozen D6 contract hashes;
- preserve complete D6/D15 SHA-256 and byte-size inventories;
- attempt formatter promotion once with exact pre/post Harness hashes and output;
- require Claude literal zero-write `PLAN PASS` for exact hashes of the four canonical files and run
  plan before plan-freeze staging, red, or config work.

A rejected promotion that mutates Harness state stops without repair. A clean rejection completes
standalone evidence and stops for supervisor ratification.

## Exact-base red

After an authorized plan-freeze contract commit, record the exact implementation base and run only
read-only Biome checks from `loop-fork/`. Use `bunx biome check --verbose .` to capture the complete
`Files processed:` inventory and count, plus representative generated, source, test, and config
results. Summary-only output cannot discharge enumeration. The reproduction must show pristine
`loop-fork/runs/**` generated evidence is inspected and rejected by the unchanged config.

Every invocation is bracketed by complete D6/D15 inventory comparison. Prohibited commands include
`bun run fix`, any `--write`, `--fix`, or `--unsafe` option, and every format/lint write command.

## Focused controls

The post-change controls must prove:

- verbose checked-file output under exact local `files.includes: ["!runs"]` contains no
  `loop-fork/runs/**` path;
- parsed JSONC proves the local `files.includes` array is exactly one entry, `"!runs"`, with no
  local positive glob and no copied preset entry; record the installed parent array separately so
  evidence shows inherited scope without pinning or duplicating it;
- the before/after `Files processed:` delta has exactly zero additions; every removal is under
  `loop-fork/runs/`; the removal set equals the before-inventory intersection with supported files
  under that directory; and every removed file remains byte-identical;
- representative existing `src/**` and `tests/**` files remain selected;
- temporary `src/__formatter_scope_control__.ts` and
  `tests/__formatter_scope_control__.test.ts` invalid fixtures are each created, rejected, and
  removed entirely within this focused-controls step; they are never staged and leave no porcelain,
  cached, or commit-tree residue;
- a temporary `__formatter_preset_controls__/` matrix records one Biome-supported representative
  path for every inherited forced-exclusion class: framework/build output directories,
  generated-code directories, generated filename globs, and generated declarations/maps. Every
  representative is absent from the post-edit `Files processed:` list. For patterns whose native
  extension is unsupported, record the installed parent entry plus the exact local single-negative
  array and do not claim processed-file absence as causal. The complete matrix is removed inside
  focused controls with no porcelain, cached, or commit-tree residue;
- `specs/**`, `biome.jsonc`, and other non-run paths remain selected as applicable;
- repository-root `runs/**` is outside the `loop-fork/` Biome root and receives no new exclusion;
- `bunx biome check --verbose biome.jsonc` checks exactly the config file and exits clean after the
  edit; all four original override blocks, includes arrays, and rules remain byte-identical; and
  the named local-array plus representative-class assertions independently prove the local entry did
  not re-include inherited preset exclusions;
- frozen D6 contract hashes, D6/D15 inventories, D15 close hashes, D6 active identity, implementation
  object, root `.loop/`, and utility `0/off/0` remain unchanged.

## Mandatory gates

Before the first mandatory command, assert and record that
`src/__formatter_scope_control__.ts`, `tests/__formatter_scope_control__.test.ts`, and the complete
`__formatter_preset_controls__/` matrix are absent; `git status --porcelain` contains no control
residue; and no control path is cached. Then run from `loop-fork/` with utility positively fixed at
`0/off/0`:

```bash
bun run check
bunx tsc --noEmit --skipLibCheck --types bun-types --moduleResolution bundler --module preserve --target esnext src/cli.ts src/loop/caveman-skill.d.ts
bun run build
LOOP_TEST_CERTIFICATION_MODE=single-file bun run test:ci
```

When Harness represents this task, also run:

```bash
./harness preflight --json harvto-formatter-evidence-scope
./harness stop-gate --json harvto-formatter-evidence-scope
```

Create both `loop-fork/runs/harvto-formatter-evidence-scope/eval.json` and
`runs/harvto-formatter-evidence-scope/eval.json` with passing verdicts, empty
`baseline_failures`, and no tolerated test-name allowlist. Then run from repository root:

```bash
./scripts/verify.sh harvto-formatter-evidence-scope harvto-formatter-evidence-scope
```

No UI capture is required because rendered behavior does not change.

## Scope, review, and standalone terminal

The plan-freeze commit contains exactly the five reviewed contract files. The production commit
contains exactly `loop-fork/biome.jsonc`; its normal and ignore-all-space numstats match, cached diff
check passes, and no contract, fixture, evidence, lifecycle, `PLAN.md`, `status.md`, or `.loop/` path
is present.

Claude must independently return literal zero-write exact-SHA `PASS` for the production commit,
including directory-scoped generated-evidence exclusion, source/test fail-open controls,
checked-file accounting, mandatory gates, and evidence byte identity. Harness did not admit this
task, so `harness done` is prohibited. After exact-SHA `PASS`, capture pre-state proving D6 remains
sole active/eval-pending, record exactly one standalone terminal `PASS` in formatter task-log, meta,
and both evals, capture matching D6 post-state, and commit that bookkeeping separately.
