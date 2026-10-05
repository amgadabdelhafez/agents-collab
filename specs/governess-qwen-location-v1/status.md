# Status, October 4, 2026

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
