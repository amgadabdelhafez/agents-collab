# Task d028-installed-forward-compat

## Objective

Replace the additive-field compatibility inference with observed behavior from
the currently installed binary, without installing or contacting a live run.

Regression: yes
Regression id: installed-manifest-additive-field-compatibility
Regression symptom: an older installed binary rejects a producer manifest after
the candidate adds `tmuxSocket`.
Regression guard: isolated copied-fixture `governess doctor` evidence

## Verification

- Installed binary: `loop v1.0.38`, SHA-256 `88dcfe2d…`, reverified at use.
- T-00 SHA `9ca9f74f…` recorded as a superseded snapshot.
- Producer fixture and isolated copy both SHA-256 `4a629cf9…` before execution.
- Closed-environment `governess doctor 1`: exit 0, `checks.manifest: true`,
  session `workspace-loop-1` observed.
- Task-local denying wrapper intercepted and rejected both exact-socket tmux
  attempts (`has-session` and `list-panes`), making live contact impossible.
- Copied fixture SHA remained `4a629cf9…`; it was the only isolated file.
- No installed binary, live run, product lane, or modernization file changed.

## Scope

T-15 evidence, authoritative tmux task/spec corrections, and D-028 run metadata
only. The installed binary and copied fixture were read-only.
