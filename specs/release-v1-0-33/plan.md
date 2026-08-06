# Plan

1. Add a root tag-only release workflow that builds inside `loop-fork/` and
   validates tag/package-version identity.
2. Bump the package and lockfile version to `1.0.33`.
3. Make failed World Model manifest binding clean both temporary and finalized
   run artifacts, with a real Git producer fixture.
4. Close the two deployed Harness task records and correct their deployment
   evidence.
5. Run focused tests, static checks, typecheck, build, the sorted full suite,
   and the task verifier; commit the exact candidate.
6. Request exact-SHA supervisor review, then advance both remote main branches,
   create and push `v1.0.33`, verify the Actions run and release assets, and run
   `install.sh latest` in an isolated directory.
7. Validate the first new post-release loop manifest and sample its bridge
   worker descriptors without touching run 137.
