# Tasks

- [x] RED: four regression tests fail on the pre-fix code for the right reasons.
- [x] GREEN: ghost-text stripping + styled Claude captures.
- [x] GREEN: claim acquired only after readiness; pending + single-attempt
      readiness re-check under the claim.
- [x] Existing bridge suite green (75/75), full suite at 4-failure baseline,
      build + `git diff --check` + biome clean on touched files.
- [ ] Deploy to live loop 48 (bridge worker restart only) and verify the stuck
      verdict message delivers exactly once.
