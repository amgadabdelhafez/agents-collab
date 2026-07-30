# Regression Eval: loop102-claude-bootstrap-readiness

Generated: 2026-07-30T21:41:29Z
Source task: `loop102-launch-hardening`
Status: executable

## Failure Symptom

- Claude's startup confirmation swallowed the launch bootstrap.
- Detached paired launch started at 80x24.

## Guard Evidence

- `bun test tests/loop/tmux.test.ts`
- `LOOP_SMOKE_PREBUILT=1 LOOP_SMOKE_EXPECTED_SHA256=<candidate-sha256> bash evals/smoke/large-prompt-launch.sh ./loop`

## Verification Artifacts

- `build`: `runs/loop102-launch-hardening/artifacts/build/verify.log` (pass)
- `focused`: `runs/loop102-launch-hardening/artifacts/focused/verify.log` (pass)
- `full`: `runs/loop102-launch-hardening/artifacts/full/verify.log` (pass)
- `independent-review`: `runs/loop102-launch-hardening/artifacts/independent-review/concur.txt` (pass)
- `isolated-smoke`: `runs/loop102-launch-hardening/artifacts/isolated-smoke/verify.log` (pass)
- `unit`: `runs/loop102-launch-hardening/artifacts/unit/verify.log` (pass)

## Source Task Notes

Regression: yes
Regression id: loop102-claude-bootstrap-readiness
Regression symptom: Claude's startup confirmation swallowed the launch bootstrap.
Regression guard: tests/loop/tmux.test.ts plus evals/smoke/large-prompt-launch.sh

Regression: yes
Regression id: loop102-detached-tmux-geometry
Regression symptom: Detached paired launch started at 80x24.
Regression guard: tests/loop/tmux.test.ts plus evals/smoke/large-prompt-launch.sh

## Next Step

Keep both executable guards in the focused and isolated-smoke Harness
dimensions for future launch and tmux changes.
