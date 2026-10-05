# Run43 helper stress, October 4, 2026

Owner: Harness supervisor. Explicit user request to restart Governess and stress
helpers. Existing source/candidate retained; no agent seat replacement or fleet
route change. Restarted pane%60 from PID91005 to71673; then a bounded explicit
Nanny-route correction refreshed only that pane to89578. Original Claude34072,
Codex34075 and other panes preserved. Candidate f00d88d7 unchanged.

Initial five packets had incorrectly rooted paths (src/ instead of loop-fork/src/).
These are test-packet errors, not successful work and not deliberately negative
tests. Records remain: three context-insufficient escalations, one Nanny old-proxy
503 failure with two bounded admission retries, one driver route during cooldown.
Corrected V2 Au Pair jobs6a216c1d/3fe0f027 completed3542/3820ms respectively by usage
identity (6a216c1d3820ms,3fe0f0273542ms). Both returned the required literals; one
scope-prohibition citation incorrectly said78 rather than actual73. Helper output
is evidence, not an authority verdict. No patches were proposed or applied.

V2 Nanny jobs were routed-driver during the normal60s inference-failure cooldown.
Investigation found scheduler/worker disagreement: worker environment excludes
LOOP_GOVERNESS_* and defaulted to8082/Qwen3.6, despite Governess8084/pinned Qwen3.8.
Added explicit LOOP_NANNY_URL8084 and LOOP_NANNY_MODEL local model selector to the
same run's protected launch environment. Did not weaken environment minimization,
disable cooldown, modify journals, widen scopes or increase concurrency.

V3 Nanny jobs:0ba9086f-5ec0-4415-a082-ad8d206a9712,
1dddc063-aac6-45f6-a7d9-a2d6103b5adb,56bd4aa8-0cff-4d10-8039-cb46abd6a615.
First completed213572ms,3 model calls/3 tools,10818 input272 output,11090 total,
exact local model selector and correct5/6 line citations. Remaining two pending
postflight at this checkpoint. One running plus two queued respected slot1.
Same-key resubmission returned existing identities, not new jobs.

Infra read-only runtime evidence includes closed-stream warnings, but no request
correlation to these job IDs; it does not prove cause. First-job correctness PASS
does not establish latency/SLA suitability. Endpoint kept owned by Infra while
Run43 has active dependency. No model service restart or new capacity.
