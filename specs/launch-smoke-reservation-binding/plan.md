# Plan

1. Add a fail-closed helper that resolves exactly one producer manifest.
2. Discover each launch manifest after the command returns.
3. Bind existing assertions to the manifest's persisted run ID.
4. Add a bounded self-test for zero, one, and multiple candidates.
5. Re-run the exact-prebuilt 10 KiB full-layout smoke and mandatory suites.
