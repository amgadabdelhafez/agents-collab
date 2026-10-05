# Status, October 4, 2026

## Inline Nanny runtime identity

User supersedes standalone model/compute/host row: removed completely from board.
Nanny keeps its actual model in MODEL, and MISS/RUNTIME uses otherwise wasted
space for an attested compact device@Mac, e.g. GPU@sweetmac14. Unknown hardware
or host is omitted, not rendered as compute unknown/host unknown. Judge metadata
is reusable only when Nanny model AND endpoint match; explicit Nanny metadata
can be supplied separately. Au Pair/direct keep table alignment. No routing or
inference change. Existing84 Governess tests pass475 assertions, plus focused
inline identity/foreign-route refusal/narrow-board3 tests14 assertions pass.
Installed candidate ba3671b6a21b21159f5a639103c504a29251385eedcfac8b9932210666abf600,
previous e026b4b9 retained for rollback. No unrelated live pane refresh performed.

## Board cleanup source and release

Installed binary e026b4b906adf9ed396dad0921c1ba63f3fbf00c268d6fdbbaea67db2df872ea
from source2a6a3f3e; prior960ebf35 bytes retained in hash-named rollback.

Current cleanup aligns agent/helper model and spend cells, widens model to14
columns while retaining total board width, moves cost/rate beside model, and
removes repeated helper success/call/queue totals from aggregate rows. Bridge
pending and unattributed jobs remain visible. Routing reasons bounded to3 plus
overflow count. Single-judge usage no longer repeats model/path already shown
in the runtime identity row; multiple judges retain names. Low-level runtime
tuning opt-in via LOOP_GOVERNESS_BOARD_DETAILS=1, propagated on fresh launch.
No stored data, usage/cost calculations, routing policy or authority changed.
Focused Governess84 tests/475 assertions pass, including narrow viewports,
numeric/header alignment, provenance, missing price, and tuning visibility.
Run44 is stopped; no runtime refresh or new launch is claimed for this slice.

## Nanny row correction and completed helper execution

The Nanny row previously collapsed snapshot model identity to the judge family
qwen. Fixed source d5f0c2e6 preserves model version/size and uses explicit Nanny
configuration before the first usage event, unknown rather than invented model.
Focused label tests5/14 assertions, Biome/build/diff passed. Installed SHA-256
960ebf35e2035461fa02fd92e59f08334f3286ac92e5ffb47b2a50f26118eeb8;
previous297191d7 binary retained in hash-named rollback. Refreshed only Run44
Governess after both helpers terminalized; live capture shows Qwen3.8-27B in
Nanny model cell. Doctor now all checks true, journal no issues, epoch
1791172072129445. One supervisor-targeted bridge record remains pending.
Nanny and Au Pair each completed one test job with0 failures,2 model calls and
1 tool call each. All source/agent seats/model service preserved.

## Installed release and fresh test Run44

Explicit user activation completed. Installed binary SHA-256
297191d7f9aecefab5e5c1ee7edf0e474ddf1b7b483f1e2fb3b2ec45a52c7d62,
source c15dbc7b (compiled source change plus focused environment test).
Rollback is /Users/amgad/.local/bin/loop.rollback.9dac102944e1bca03aaa52823851078e13257f0a0c25c16d34b00c401f144ff7.
Fresh-launch forwarding now preserves explicit model/compute/host labels;
focused environment regression passed1 test/13 assertions.

Run43 was stopped through native Governess x/e teardown. Exact session and
app-server PID33934 absent, then supported stopped-run reconciliation released
workspace at2026-10-05T03:36:23.503Z. No agent composer input or runtime model stop.

Exactly one fresh Run44 started on /tmp/tmux-501/default, session
agents-collab-loop-44, epoch1791171506746411. Claude Opus high driver, Codex
gpt-6.1-sol high peer. All six panes live; new readable GPU/Mac row verified.
Both seats verified charters. Replay passes with no journal issues. Doctor
sessionReady/live true but transport false at startup; complete round-trip and
helper acceptance remain pending, not claimed healthy. No duplicate attempt.
Test packet: runs/governess-qwen-location-v1/fresh-test-loop.md. Original Qwen
service remains Infra-owned and untouched. Other project sessions untouched.

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
