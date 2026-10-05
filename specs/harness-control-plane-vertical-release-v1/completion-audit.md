# Objective completion audit, 2026-10-05

Scope: one attributable A2A/application PostgreSQL/existing Temporal test route,
one workspace, both seats. Acceptance owner: active Harness supervisor. No fleet
installation, merge or push. Activation was exercised and then retired under the
objective's required exact-cleanup boundary; this is not a permanently live service.

| Requirement | Evidence inspected | Result |
|---|---|---|
| Attributable release | Runtime commit928bd1db, treea93e26ac, compiled SHA d0a8aa8f; parent8a1cc88f full integration, two-file cleanup delta | Proven |
| Dedicated application PostgreSQL, existing Temporal | Run49 dedicated database profile, service config and restart evidence; shared namespace harness/isolated queue | Proven, now disposed |
| One workspace, both seats | Run49 manifest/thread/session and consumed claim/ACK receipts; Run50 live Sonnet5.5/Claude Max and Terra max | Proven |
| Supervisor submission and durable delivery | Task455c128b-58b2-4101-ac66-a4389bee8cce, workflow14f4b9b6...aab76d, bridgeab87de07...46d1 | Proven |
| ACK distinct from result | Peer receipt919ed320...b4ed reports claimed/acknowledged but not completed; driver receipt60a4bd32-ec61-4c9c-9977-a5a47d490c25 reports resultPublished=true | Proven |
| Git artifact result | Exact committed blob b1094f29:vertical-release-result.md, SHA96a127b8; sole changed path and explicit Sonnet artifact verdict443ae46a | Proven |
| Restart recovery/dedupe | Persisted database evidence:9 tables/24 rows equal digest6c9290ab; recorded fresh worker original-task snapshot6fb1a87c; contextless duplicate maps same canonical workflow, one provider effect | Proven within canonical effect contract |
| Fresh bounded slice, no duplicate launch | Run49 integration; Run50 only compiled cleanup delta, preserved on startup refusal and recovered in place | Proven |
| Exact cleanup | Released manifests49/50; absent sockets/PIDs/listener7337; zero owned Docker containers/volumes; private secret store absent; four exact Temporal histories currently TERMINATED | Proven |
| Preserve shared workers/unrelated state | Installed hashba3671b6 unchanged; shared78795/80663 remain live; workspace still only inherited PLAN.md/status.md dirty | Proven for checked identities/scope |

Current Temporal read-only describe reverified all three Run49 supervisor-message
workflows and task-graph:vertical-run49-result-v1 TERMINATED on
harness-vertical-control-plane-v1. Cleanup terminality is not used to infer work
completion; the earlier distinct recipient result receipt and Git blob prove that.

Coverage limits: PostgreSQL test data was intentionally removed, so historical
restart acceptance is retained body-free evidence, not a current SQL re-query.
Contextless duplicate SDK projection IDs are not promised to converge; canonical
workflow/effect identity and original-ID recovery are the tested contracts.
Generic domain/read-model tenant migration, persistent fleet activation and
production admission are separate work, not claims of this objective.

Lessons: use exact binary argv in charters, do not confuse provider acceptance
with recipient ACK/result, label audit/compatibility state, preserve one session
on startup ambiguity, and make cleanup prove exact live ownership. Keep final
release evidence committed while credentials and disposable runtime data vanish.
