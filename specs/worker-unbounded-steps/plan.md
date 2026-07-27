# Plan

1. RED: assert resolved config has no `maxSteps` property.
2. Remove `DEFAULT_MAX_STEPS`, the `maxSteps` config field, and the
   `LOOP_UTILITY_MAX_STEPS` resolution.
3. Replace the bounded step loop with an unbounded loop guarded by the
   existing `maxJobRuntimeMs` elapsed-time check; drop the step-limit throw.
4. Full verification per verify.md; deploy by merge + rebuild only.
