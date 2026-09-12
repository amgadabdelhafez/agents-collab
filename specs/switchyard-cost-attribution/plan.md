# Plan

1. Extend `PiProviderSpec` with optional task identity.
2. Add the intake header only to non-OpenRouter models.
3. Pass the owning Loop run ID into provider construction.
4. Add gateway-present and direct-OpenRouter-absent tests.
5. Run two-direction mutation proof, focused certified tests, check, and full CI.
6. Obtain Claude review, write run eval, commit explicit paths, push branch, and open a
   draft PR.
