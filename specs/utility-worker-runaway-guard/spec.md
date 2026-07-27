# Utility worker runaway guard

## Problem

Loop 53 proved that a runtime-only worker boundary is too weak. One bounded
file-read job retried a broker-denied command 737 times over 868 seconds,
consumed 18,869,682 tokens, cost $3.99, and exhausted the OpenRouter key's
monthly limit. A second job made 326 denied calls before termination.

Healthy loop-53 jobs peaked at 12 model calls, 16 tool calls, 48,699 tokens,
$0.022, and 101 seconds. The defect is repeated no-progress behavior, not the
size of legitimate multi-document work.

## Requirements

- Fail a worker after three consecutive broker rejections without a successful
  broker result between them. Include the threshold and last safe error code in
  the persisted blocker and requester escalation.
- Fail before executing a third consecutive identical tool call. The
  fingerprint includes tool name and raw argument JSON, so legitimate paging
  with different arguments remains allowed.
- Add a non-configurable emergency ceiling of 64 provider/model calls per job;
  fail before making call 65 even if tool calls have succeeded.
- Preserve the 15-minute external runtime reaper as a final process boundary.
- Preserve the intentional no-token-cap and no-dollar-cap policy. Usage remains
  observable but is not itself a routing or completion budget.
- Preserve successful-tool evidence rules, guarded patch behavior, workspace
  boundaries, and exact utility usage/progress recording.
- Add the breaker rules to the worker system prompt so the model is told not to
  retry denied or identical calls.

## Acceptance

- A local replay that always requests a denied tool call stops after exactly
  three model calls and three denied tool events, not hundreds.
- A successful broker result resets the consecutive-rejection count.
- A third identical call is rejected before its broker execution.
- A local replay with varying successful calls stops after 64 model calls and
  never sends call 65.
- Existing healthy multi-step, high-token, and high-cost fixture tests remain
  green, proving the guard is about progress rather than token or dollar size.
- Focused utility tests, full tests, build, diff check, independent evaluation,
  installed-binary verification, and loop-53 pane preservation all pass.
