# Task d031-governess-tmux-skip-records

## Objective

Close the remaining T-10/verify-10 observability gap without changing the
already fail-closed Governess effect boundary.

Regression: yes
Regression id: governess-unobservable-tmux-skip
Regression symptom: an unavailable manifest target suppresses a Governess tmux
effect but emits no structured skip record.
Regression guard: exact degraded consumer record assertions

## Scope

Governess default tmux adapters, pane-liveness helper, owning tests, D-031
metadata, and operational defect backlog only. No product lane, installed
binary, historical run evidence, or modernization file.

## Result

- Governess default runtime: 89 tests, 0 failures, 510 assertions.
- Governess pane liveness: 32 tests, 0 failures, 115 assertions.
- Tmux migration checker, 205-file static check, documented TypeScript check,
  and diff check passed.
- Independent zero-write review passed after verifying every degraded effect
  boundary, compound-action revalidation, and structured record field.
