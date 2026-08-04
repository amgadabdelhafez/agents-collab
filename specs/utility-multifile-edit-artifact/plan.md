# Plan: Atomic Multi-file Au Pair Edits

1. Add a producer-backed two-patch worker regression.
2. Consolidate multiple diff artifacts through the existing patch broker.
3. Expose only the validated aggregate artifact and retain fail-closed apply.
4. Run focused and full verification, commit, and request exact-SHA review.
