# Plan

1. Extract a small atomic regular-file installation primitive that stages a
   copy or text payload beside the destination and renames it over the target.
2. Reject non-regular or symbolic-link source binaries before staging.
3. Route the primary binary and all generated aliases through the primitive.
4. Export only the bounded installer internals needed for filesystem regression
   tests in temporary directories.
5. Add focused tests for immutable installed bytes, regular-file targets,
   preserved targets on failure, alias behavior, and temporary cleanup.
6. Run focused tests, lint/type checks, build, Harness verification, and an
   independent review. Do not install or launch the real global binary.
