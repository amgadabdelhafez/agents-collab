# Plan

1. Add the exact upstream Caveman dependency and MIT attribution.
2. Add a small adapter that loads the upstream skill text, filters it to the
   selected intensity, and appends loop-specific exactness boundaries.
3. Add CLI/environment parsing and persist main/helper modes in paired manifests.
4. Apply full upstream guidance to new main-agent launch prompts and the upstream
   compact reinforcement to helper system prompts.
5. Show the active modes and upstream pin in Governess.
6. Add parser, prompt, manifest, helper, and display tests.
7. Run focused tests, full CI tests, build, verify wrapper, and an independent
   exact-commit review. Record `runs/caveman-integration/eval.json`.

## Rollout

Install the verified binary globally after review. Do not restart Loop-60; new
paired runs pick up the integration.

