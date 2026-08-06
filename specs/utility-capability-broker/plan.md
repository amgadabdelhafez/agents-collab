# Plan: Utility Capability Broker

1. Preserve the seven loop-140 failure records and rejected tool calls as the
   producer-backed baseline.
2. Add red-first broker tests for file inspection, JSON Pointer lookup, and all
   scope/symlink/size/output negative cases.
3. Add red-first context and runtime tests for the versioned effective
   capability map, prompt guidance, and command-denial recovery text.
4. Implement the two in-process tools using the broker's existing canonical
   path and output boundaries.
5. Create the broker before the context capsule, derive a sanitized capability
   description from the effective broker, and persist it inside the capsule.
6. Run focused suites, full tests, static checks, build, diff validation, and
   the repository verification script; record evidence in the task run.
7. Commit the isolated branch, request exact-SHA supervisor review, and stop at
   the review/release gate.

