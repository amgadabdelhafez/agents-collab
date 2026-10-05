# Status, October 4, 2026

## Current readable runtime row

User-requested replacement is live: `Qwen3.8 27B 4-bit · GPU (Apple M5 Pro / Metal) · sweetmac14`.
No judge-cfg prefix, endpoint, client label or artifact hash in this row.
Metadata is explicitly operator-attested, not inferred from a proxy address.
MLX default device reports GPU0, Metal available; server generation uses the
default device with no CPU override in the live command. This is configuration
provenance, not a measured GPU-utilization claim. Unknown routes remain unknown.

Run43 Governess PID36705, epoch1791171107758705, binary SHA-256
dd9222e87902b4dfa5d28a47a094bf5b11983655ac91fbc0b1b891a90fba94d4.
All six panes live; original agent PIDs34072/34075 unchanged. Doctor all checks
true, no journal issues; bridge has16 pending records, so queue-drained acceptance
is not claimed. Global installed binary is unchanged. Label tests4/11 pass;
scoped Biome and build pass. Helper stress is complete in stress-report.md.

## Historical accepted live Run43 postimage

Run43 Governess pane%60 now uses compiled source9ec940a4c52ca3021398e3c14124f83a0b334528,
tree e4dcc0a261999f54765f02811329375c3bc7c091, binary SHA-256
f00d88d75b186c8be8f59bf5a902a08144072aa6f3f06647f3672b53cc5c0150.
Exact refresh preserved the original Claude34072 and Codex34075 PIDs and all
other panes. New Governess PID91005, epoch1791167569288005; doctor/replay PASS,
all six panes live. Actual115x17 viewport shows model-directory pin, endpoint
http://127.0.0.1:8084 and client sweetmac14.local. The secure launch envelope
was consumed by the existing __governess-secure boundary; no composer input
or manual manifest/journal edit. The exact maintenance script refuses drift or
active helper work. It is task-bound and one-shot, not a fleet lifecycle API.

Real Harness Pi completion returned QWEN_RUN43_OK, exact local model selector,
33 input/8 output tokens. Actual judgeAgent working7022ms and waiting-human8716ms
both ok=true, confidence0.95, valid JSON within original30s deadline. Probe exit0.
No synthetic result is represented as an observed judgment of actual agent work.

Infra owns the runtime PID80663 on sweetmac14, MLX-VLM0.7.4/MLX0.32.3/Python3.12.15.
All pinned weight hashes verified by Infra; model revision
10c35caafbb80f7dc6a7a432cdd11af10a6d4818. Infra's raw completion reported the exact
served selector and no reasoning content. The model selector is
/Users/amgad/.local/share/loop/qwen38-27b/model-10c35caa.
Run43's judge route alone changed; Nanny and other project routes did not.
The global installed binary remains9dac1029. This candidate is loaded by Run43
Governess only, not an installed/fleet binary upgrade claim.

Rollback preserves global9dac bytes and previous configured8082/default Qwen3.6
route; restoring that old configuration does not prove the previously failing
proxy healthy. Infra preserved the exact launchd plist hash
ebb4a597cfadb60021b4ca36766e724ab0cbc538b19d2512556c3c401712c962 and owns coordinated
server-stop/bootstrap rollback. Do not stop8084 while Run43 depends on it.
Long-context, concurrent load, cancellation, unattended reboot durability and
fleet promotion are unverified. Infra was sent the live dependency handoff.

Final source checks: label3/9 assertions; Governess83/477 before final host
assertion, then exact host-row test1/5. Build exit0. No broad suite or cold review.

## Historical implementation checkpoint

Source writer: Harness supervisor. Runtime/artifact writer: Infra Eng.
Base: f9077478, accepted installed helper-observability feature lineage. Retained
feature dependencies are required; old remote main lacks these accepted fixes.

Implemented persistent judge configured-model/credential-free endpoint/client
row. It stays above optional metrics, preserving core agent/helper rows in tiny
viewports. Tests: route label2/8 assertions; Governess83/477 assertions passed
before the final client-host rendering assertion. Scoped formatting/build passed.
Initial direct bun-test invocation was refused by project certification policy;
supported test:file then ran. Four initial display-test failures were investigated:
two broad qwen-negative assertions matched the worktree path, header-order and
tiny-view helper priority were corrected. No fixture bypass.

Live adoption pending Infra's pinned Qwen weights and isolated runtime verification.
Requested artifact mlx-community/Qwen3.8-27B-4bit revision
10c35caafbb80f7dc6a7a432cdd11af10a6d4818. No endpoint or actual served-model
success is claimed yet; Run43 route and panes remain unchanged.
