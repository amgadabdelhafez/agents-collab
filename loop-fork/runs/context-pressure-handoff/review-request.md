PURPOSE

Request exact-SHA review of the context-first session-pressure handoff policy. This candidate is independent of the World Model branch and descends directly from the deployed cleared tip.

REQUESTED ACTION

Review the exact candidate SHA stamped by the governed sender. Reply CONCUR or provide blocking findings. No deployment clearance is requested.

LINEAGE

- Required parent and deployed cleared tip: `cca045a7ff7b925f4559732ae4968d851b3e6db6`
- Candidate: supplied and verified by `evals/release/send-stamped-review.sh`

POLICY

- Context pressure is evaluated before model-specific assistant turns.
- Preparation begins at 75% of the applicable threshold.
- First automatic compaction or a context/turn handoff threshold starts the existing two-phase handover in enforce mode.
- Two automatic compactions produce a hard-ceiling decision.
- Claude manual compactions are excluded when the provider labels the trigger. Codex currently records `provider-unspecified` because its producer exposes no trigger kind.
- `observe`, `off`, dry-run, unknown tmux control, stale lifecycle, and an already active exit lifecycle cannot start a handover.

SAFETY

- The candidate never injects the compact or rename slash commands.
- It never kills a working agent. Existing handover code owns atomic-step drain, validated bundles, guarded agent exits, and replacement launch.
- Pressure decisions are lifecycle evidence only and cannot authorize releases, deployments, permissions, routing, spending, or destructive mutations.
- No live process was restarted or modified and no candidate binary was deployed.

PROOF

- Focused: session-pressure 7 pass; Governess usage 22 pass; Governess 76 pass.
- Complete sequential `bun run test:ci`: exit 0.
- Harness-certified full suite: pass, with passing `eval.json` and empty baseline-failure contract.
- `bun run check`: pass across 793 files.
- Production build and targeted TypeScript check: pass.
- Harness preflight and stop-gate: pass.
- Producer-backed tests prove context-first precedence, per-model turns, manual/automatic distinction, unknown-context behavior, persisted dedupe, one governed handover, and zero lifecycle effects in observe/off/dry-run modes.

LIMITS

- Thresholds are provisional operating policy, not a proven quality optimum.
- Task/milestone quality is not inferred automatically; the existing handover request limits work to the current atomic step.
- The matched three-policy quality experiment remains future work.
