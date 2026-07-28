# Baseline cleanup plan

1. Reproduce and isolate the dangling resources in the bridge and Governess-exit
   tests; fix ownership/cleanup at the narrowest lifecycle boundary.
2. Apply safe formatter and lint fixes, then resolve remaining diagnostics with
   behavior-preserving source changes or tightly scoped, justified suppressions
   only where the rule conflicts with protocol-level code.
3. Prove historical JSON semantic equality across mechanical formatting.
4. Run focused lifecycle tests, the full sequential suite, repository check,
   build, diff validation, project verification, and independent review.
5. Record all evidence in `runs/baseline-cleanup/eval.json`.

