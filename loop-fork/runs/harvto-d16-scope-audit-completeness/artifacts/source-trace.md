# D16 Scope-Audit Source Trace

Exact base: `ee559c4f75dfe36e2dd61c607d48a3aba4faa500`.

## Producer

- `src/loop/utility-tools.ts` owns `git_status` and `git_diff`.
- `git_status` currently returns bounded porcelain-v1 text with
  `--untracked-files=normal` and routing/protected path exclusions. The exclusions include
  `specs/*/{spec,plan,tasks,verify}.md`, which explains the observed D5 bundle omission: every file
  under that untracked directory was removed before synthesis. It does not emit a separate
  consumer-visible canonical record schema, exact count, or hash.
- `git_diff` returns text and can select unstaged, staged, or literal SHA range output, but does not
  combine those surfaces or classify untracked/rename/copy/hidden tracked records into one manifest.

## Synthesis and persistence

- `src/loop/utility-runtime.ts` sends successful broker results to the model and records only tool
  success metadata in `utility/tool-events.jsonl`.
- `assertConversationEvidence` accepts any successful repository tool for an inspect/review task.
  It does not compare helper-visible broker evidence with a complete Git set that retains
  routing-hidden path metadata.
- `UtilityConversationResult` retains free-form `summary`, artifacts, and checks, but not scope
  records. `UtilityCompactResult` in `src/loop/task-router.ts` likewise has no scope-evidence field.
- The worker therefore persists `state=completed` when synthesis omits a path, exactly as run 60
  demonstrated.

## Consumer

- `src/loop/utility-store.ts` validates terminal state/result status consistency but has no scope
  record count/hash invariant.
- `src/loop/bridge-utility.ts` returns `job.result` directly from `get_task_result`; it does not
  validate scope evidence before a caller sees completed output.
- Bridge notifications interpolate the free-form summary. There is no deterministic scope manifest
  for a full agent to compare.

## Reproduction seam and bounded fix surface

The closest actual-boundary red belongs in `tests/loop/utility-pi-harness.test.ts`: initialize a
temporary Git repository with one ordinary modified path and one routing-protected untracked spec
path, route an explicit `utility-audit`/`git-status` request, have the fake provider call the real
broker and summarize the incomplete helper-visible set, then require a complete deterministic scope
manifest in the durable result. Current production will complete without it.

The likely narrow production surface is:

- canonical scope record/hash types in `src/loop/task-router.ts`;
- Git inventory production in `src/loop/utility-tools.ts`;
- broker-evidence retention in `src/loop/utility-runtime.ts`;
- replay validation in `src/loop/utility-store.ts`;
- consumer fail-closed validation in `src/loop/bridge-utility.ts`;
- execution-profile/tool guidance only if reproduction proves it necessary.

Final source scope remains subordinate to the exact red. Production stays frozen until that test
fails decisively and its evidence is saved.
