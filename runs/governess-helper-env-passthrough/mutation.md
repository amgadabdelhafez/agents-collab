# Mutation proof: remove Governess helper passthrough

Mutation removed:

```ts
...GOVERNESS_HELPER_ENV_KEYS.flatMap((key) => passEnv(env, key)),
```

## Check 1 output

```text
$ LOOP_TEST_CERTIFICATION_MODE=single-file bun test tests/loop/tmux.test.ts -t 'governess env passes provided helper-tier settings and omits absent settings'
bun test v1.3.13-canary.1 (903015a2)

tests/loop/tmux.test.ts:
294 |       LOOP_UTILITY_ALLOWED_TIERS: "nanny,au-pair",
295 |     },
296 |     "/repo"
297 |   );
298 |
299 |   expect(environment).toContain(
                            ^
error: expect(received).toContain(expected)

Expected to contain: "LOOP_AU_PAIR_URL=http://switchyard.test/v1"
Received: [ "LOOP_CAVEMAN_MODE=lite", "LOOP_HELPER_CAVEMAN_MODE=full",
  "LOOP_NATIVE_SUBAGENT_MODE=utility-first", "LOOP_GOVERNESS_IDLE=undefined", "LOOP_GOVERNESS_COOLDOWN=undefined",
  "LOOP_GOVERNESS_MAX=undefined", "LOOP_GOVERNESS_URL=undefined", "LOOP_GOVERNESS_MODEL=undefined"
]

      at <anonymous> (/Users/amgad/dev_projects/agents-collab/.worktrees/governess-helper-env/loop-fork/tests/loop/tmux.test.ts:299:23)
(fail) governess env passes provided helper-tier settings and omits absent settings [2.12ms]

 0 pass
 111 filtered out
 1 fail
 1 expect() calls
Ran 1 test across 1 file. [70.00ms]
```

## Check 3 output

```text
$ LOOP_TEST_CERTIFICATION_MODE=single-file bun test tests/loop/tmux.test.ts -t 'governess helper env policy covers every helper-tier variable read by source'
bun test v1.3.13-canary.1 (903015a2)

tests/loop/tmux.test.ts:
356 |   );
357 |   const passedHelperNames = tmuxInternals
358 |     .governessEnv(makePairedOptions(), allHelperInputs, "/repo")
359 |     .map((entry) => entry.slice(0, entry.indexOf("=")))
360 |     .filter((name) => sourceNames.has(name));
361 |   expect(passedHelperNames.sort()).toEqual([
                                         ^
error: expect(received).toEqual(expected)

- [
-   "LOOP_AU_PAIR_API_KEY_FILE",
-   "LOOP_AU_PAIR_ENABLED",
-   "LOOP_AU_PAIR_MAX_CONCURRENCY",
-   "LOOP_AU_PAIR_MODEL",
-   "LOOP_AU_PAIR_PROVIDER_SORT",
-   "LOOP_AU_PAIR_URL",
-   "LOOP_NANNY_ENABLED",
-   "LOOP_NANNY_MAX_CONCURRENCY",
-   "LOOP_NANNY_MODEL",
-   "LOOP_NANNY_URL",
-   "LOOP_RECON_HEIGHT",
-   "LOOP_RECON_PANES",
-   "LOOP_UTILITY_ALLOWED_TIERS",
-   "LOOP_UTILITY_ALLOW_OVERRIDES",
-   "LOOP_UTILITY_API_KEY_FILE",
-   "LOOP_UTILITY_COST_QUALITY",
-   "LOOP_UTILITY_DELEGATION_MODE",
-   "LOOP_UTILITY_ENABLED",
-   "LOOP_UTILITY_FALLBACK_TIER",
-   "LOOP_UTILITY_HARNESS",
-   "LOOP_UTILITY_MAX_CLAIM_WAIT_MS",
-   "LOOP_UTILITY_MAX_CONCURRENCY",
-   "LOOP_UTILITY_MAX_RUNTIME_MS",
-   "LOOP_UTILITY_MAX_SIBLING_TOOL_CALLS",
-   "LOOP_UTILITY_MAX_TOOL_CALLS",
-   "LOOP_UTILITY_MODEL",
-   "LOOP_UTILITY_NANNY_ENABLED",
-   "LOOP_UTILITY_NANNY_MAX_CONCURRENCY",
-   "LOOP_UTILITY_NANNY_MODEL",
-   "LOOP_UTILITY_NANNY_URL",
-   "LOOP_UTILITY_PANE",
-   "LOOP_UTILITY_PANE_HEIGHT",
-   "LOOP_UTILITY_PANE_WIDTH",
-   "LOOP_UTILITY_PROVIDER_SORT",
-   "LOOP_UTILITY_URL",
- ]
+ []

- Expected  - 37
+ Received  + 1

      at <anonymous> (/Users/amgad/dev_projects/agents-collab/.worktrees/governess-helper-env/loop-fork/tests/loop/tmux.test.ts:361:36)
(fail) governess helper env policy covers every helper-tier variable read by source [16.60ms]

 0 pass
 111 filtered out
 1 fail
 2 expect() calls
Ran 1 test across 1 file. [85.00ms]
```

Production passthrough was restored after both negative checks.
