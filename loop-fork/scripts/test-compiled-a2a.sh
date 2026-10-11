#!/bin/sh
# Builds the `loop` binary into a fresh scratch directory (nothing is
# installed: scripts/build-loop.ts only writes LOOP_BUILD_OUTFILE and the
# generated workflow bundle) and runs tests/loop/compiled-binary-a2a.test.ts
# against that binary, under scripts/test-hermetic.sh. The test starts its own
# throwaway server (local Temporal dev server, Docker PostgreSQL, loopback
# ports); it never reaches a live service.
#
# LOOP_COMPILED_BINARY=<absolute path> skips the build and tests that binary.
set -eu
cd "$(dirname "$0")/.."
scratch=
cleanup() {
  if [ -n "$scratch" ]; then
    rm -rf "$scratch"
  fi
}
trap cleanup EXIT INT TERM
binary=${LOOP_COMPILED_BINARY:-}
if [ -z "$binary" ]; then
  base=${TMPDIR:-/tmp}
  scratch=$(mktemp -d "${base%/}/loop-compiled-a2a.XXXXXX")
  binary=$scratch/loop
  LOOP_BUILD_OUTFILE=$binary bun run build
fi
LOOP_COMPILED_BINARY=$binary LOOP_TEST_CERTIFICATION_MODE=single-file \
  sh scripts/test-hermetic.sh bun test tests/loop/compiled-binary-a2a.test.ts
