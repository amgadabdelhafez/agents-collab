# Verification

- The committed `loop-fork/package.json` reports `1.0.33` and the compiled
  binary prints `loop v1.0.33`.
- The root release workflow triggers only for `v*` tags, reads the package
  version from `loop-fork/`, builds there, and uploads four binaries plus four
  checksum files.
- The World Model runtime test removes the manifest before producer-backed
  preparation, asserts the exact fail-closed error, and proves the run-scoped
  World Model directory contains no leaked artifacts.
- Both prior task index entries and their run metadata are `done` with passing
  evals and deployment provenance.
- `bun run test:file -- tests/loop/world-model-runtime.test.ts` passes.
- `bun run check`, repository typecheck, `bun run build`, and
  `bun run test:ci` pass.
- `scripts/verify.sh release-v1-0-33 release-v1-0-33` passes with an empty
  named baseline-failure list.
- The exact candidate SHA has supervisor concurrence before release.
- GitHub release `v1.0.33` targets that SHA and exposes all eight assets.
- An isolated `install.sh latest` install reports `loop v1.0.33` and matches
  the published macOS arm64 checksum.
- The first new real loop records existing World Model database/context paths,
  and repeated bridge-worker descriptor samples do not increase. Run 137
  remains on its original session and process lineage.
