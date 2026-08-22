#!/bin/sh
set -eu

BASE_COMMIT="3ae56bd529dfd9db30d7db528231f620d825aaa8"
IMPLEMENTATION_COMMIT="bc99161301788fa2e46d19b2da21580050b336c9"
EXPECTED_DIFF_SHA="1b88b125b8f36627461bd8bc013cd07e41c33af4fc713e65341e97be27a77c9f"
EXPECTED_API_SHA="a573133761f544119a8d830caebc5855ffb9eca2531f4218ecee3e9051607fb1"

ACTUAL_DIFF_SHA="$(
  git diff --binary "$BASE_COMMIT" "$IMPLEMENTATION_COMMIT" -- \
    src/webui tests/webui vite.webui.config.ts \
    | shasum -a 256 \
    | awk '{ print $1 }'
)"
ACTUAL_API_SHA="$(
  git show "$IMPLEMENTATION_COMMIT:loop-fork/tests/webui/api-contract.test.ts" \
    | shasum -a 256 \
    | awk '{ print $1 }'
)"

test "$ACTUAL_DIFF_SHA" = "$EXPECTED_DIFF_SHA"
test "$ACTUAL_API_SHA" = "$EXPECTED_API_SHA"
git diff --exit-code "$IMPLEMENTATION_COMMIT" -- \
  src/webui tests/webui vite.webui.config.ts

printf 'full_diff_sha256=%s\n' "$ACTUAL_DIFF_SHA"
printf 'api_contract_blob_sha256=%s\n' "$ACTUAL_API_SHA"

bun run test:file -- tests/webui/api-contract.test.ts
