# Tasks

- [x] RED: four regression tests fail on the pre-fix code for the right reasons.
- [x] GREEN: ghost-text stripping + styled Claude captures.
- [x] GREEN: claim acquired only after readiness; pending + single-attempt
      readiness re-check under the claim.
- [x] Existing bridge suite green (75/75), full suite at 4-failure baseline,
      build + `git diff --check` + biome clean on touched files.
- [ ] Deploy to live loop 48 (bridge worker restart only) and verify the stuck
      verdict message delivers exactly once.
- [x] RED/GREEN: add the run-132 recurrence fixture for Claude Code 2.1.221
      suggestion-color ghost text, plus a non-suggestion colored-draft control.
- [x] Re-run focused bridge tests and required broader checks.
- [ ] After committing the isolated branch, request exact-SHA supervisor
      review. Do not install or deploy.
