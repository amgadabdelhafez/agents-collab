# Plan: Utility Search Empty Boundary

1. Reproduce loop 121's absent-directory call through the real broker.
2. Make only `search_repo` treat safely validated absence as empty.
3. Preserve the exact-new-file check before general absent-boundary handling.
4. Add mixed-boundary and fail-closed negative controls.
5. Verify from exact deployed lineage `36623abc7f3259affecb5b461d73cb5d6533f727`.
6. Commit and request exact-SHA supervisor review without deployment.
