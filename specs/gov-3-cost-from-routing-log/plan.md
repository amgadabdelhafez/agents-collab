# Plan

1. Read prior budget_routing.py from harness-engineering origin/main and existing subscription readers.
2. Add a strict routing-cost reader with cached public rates, then a source-labelled run report and CLI dispatch.
3. Extend existing governess-usage.test.ts to retain the 116-file certification set. Pin derivation, cache and ownership failures, source preservation, CLI output, and a real run.
4. Mutate derivation, record failed and restored outputs; run check, typecheck, each touched test, and all 116 test files.
5. Obtain Claude review, write eval and explicit-path commit, push branch, open draft PR. Supervisor owns merge/build/install.

The charter's build prohibition overrides scripts/verify.sh because that script unconditionally runs bun run build. Run its non-build checks individually and document this exception.
