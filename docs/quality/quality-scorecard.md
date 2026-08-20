# Quality Scorecard
> Updated by the architecture-review background agent or manually after significant changes.
> Grades: A (excellent) · B (acceptable) · C (needs attention) · D (risky) · F (must fix before shipping)
> A subsystem graded D or F blocks new features until a remediation spec exists.

Last updated: 2026-08-08

---

## Subsystem grades

| Subsystem | Grade | Test coverage | Observability | Docs | Debt notes | Owner |
|---|---|---|---|---|---|---|
| [e.g. Auth] | B | 78% | ✅ traces | ✅ | Token refresh logic is fragile | — |
| [e.g. Payments] | A | 92% | ✅ traces | ✅ | — | — |
| [e.g. Data pipeline] | C | 41% | ⚠️ logs only | ❌ | No integration tests; manual QA only | — |
| [e.g. Admin UI] | D | 18% | ❌ | ❌ | 3 known bugs deferred; no eval harness | — |

---

## Grading rubric

| Criterion | Weight | A | B | C | D | F |
|---|---|---|---|---|---|---|
| Test coverage | 30% | ≥90% | ≥70% | ≥50% | ≥25% | <25% |
| Observability | 20% | Traces+metrics+logs | Traces+logs | Logs only | Partial logs | None |
| Documentation | 15% | Full arch + API docs | Arch doc exists | README only | Stale/missing | None |
| Known defects | 20% | 0 open P1/P2 | 0 P1, ≤2 P2 | 0 P1, ≤5 P2 | 1+ P1 | Multiple P1 |
| Eval harness | 15% | Replay evals exist | Regression evals | Smoke only | Manual only | None |

---

## Debt register

| ID | Subsystem | Description | Severity | Spec | Status |
|---|---|---|---|---|---|
| D-001 | Governess handover | Replacement launch runs before the predecessor releases its workspace reservation, so a valid handover is rejected as a launch conflict. | P1 | [Defect record](defects/D-001-governess-handover-launch-order.md) | queued |
| D-002 | Governess handover | Pending peer work and review requests are not transferred or durably failed during succession, so the replacement can start without required next actions. | P1 | [Defect record](defects/D-002-governess-handover-action-continuity.md) | queued |
| D-003 | Governess usage display | Claude and GLM context values do not reflect the authoritative live context window and usage state. | P2 | [Defect record](defects/D-003-governess-claude-glm-context.md) | queued |
| D-004 | Governess helper identity | Nanny hides the configured Qwen version, and the GLM/Qwen rows do not show model size in the effort column. | P2 | [Defect record](defects/D-004-governess-helper-model-identity-size.md) | queued |
| D-005 | Supervisor channel | `xchan recv` returns the MCP initialize response instead of draining actionable mail. | P1 | [Defect record](defects/D-005-xchan-recv-initialize-response.md) | queued |
| D-006 | Governess summary | The live `Next` narrative remains stale after bridge delivery and invents likely message content instead of reflecting the durable ledger and current agent state. | P1 | [Defect record](defects/D-006-governess-summary-delivery-freshness.md) | queued |
| D-007 | Mid-run delivery | Runtime seat identity can diverge from the manifest and leave idle-seat traffic pending without a submitted delivery or a durable exact failure reason. | P1 | [Defect record](defects/D-007-mid-run-delivery-accountability.md) | shipped in v1.0.38 |
| D-008 | Utility task lifecycle | A claimed utility worker can die while its task remains `running`, leaving write reservations held indefinitely and no driver cancellation path. | P1 | [Defect record](defects/D-008-utility-orphan-lease-reaping.md) | queued |
| D-009 | Helper evidence | Null or rejected helper outcomes can be reported without producer proof, and helper evidence can contain false environment claims. | P1 | [Defect record](defects/D-009-helper-evidence-reliability.md) | queued |
| D-010 | Installer | `install.ts` can report or preserve a symlink output instead of proving the installed executable is a regular file with the expected bytes. | P1 | [Defect record](defects/D-010-install-symlink-output.md) | queued |
| D-011 | Reservation diagnostics | `route_task` write-conflict responses omit the holding task ID, age, and declared scopes, causing avoidable false stale-reservation escalations. | P2 | [Defect record](defects/D-011-write-conflict-holder-diagnostics.md) | queued |
| D-012 | Helper token utilization | Au Pair repeatedly replays expanding tool transcripts, allowing a small number of jobs to consume millions of cumulative tokens before producing corrupt artifacts or timing out. | P1 | [Defect record](defects/D-012-helper-token-utilization.md) | queued |
| D-013 | Governess preparation policy | A fixed assistant-turn threshold can force fresh-loop handover in the middle of a bounded atomic check, causing repeated setup/review churn without regard to elapsed time, context pressure, or current progress. | P1 | [Defect record](defects/D-013-governess-premature-preparation-threshold.md) | shipped in v1.0.37; present in v1.0.38 |
| D-014 | Paired launch cleanup | A failed paired launch requests proxy shutdown while its own manifest still declares an active tmux session, so cleanup receives HTTP 409 and can time out while obscuring the original startup failure. | P1 | [Defect record](defects/D-014-paired-launch-cleanup-order.md) | queued |
| D-015 | Paired tmux attach | A healthy detached paired launch is reported as failed when the initiating terminal cannot clear for tmux attach, prompting unsafe duplicate retries even though the run still owns the workspace. | P1 | [Defect record](defects/D-015-paired-attach-terminal-capability.md) | queued |

---

## Background agent instructions

The `architecture-review` agent should:
1. Run test coverage report and update the Coverage column.
2. Query observability stack and update the Observability column.
3. Check for open P1/P2 issues and update Defects.
4. Recalculate grades using the rubric.
5. Open a PR with updated scorecard if any grade changed.
6. If any subsystem drops to D or F, open a separate issue and tag for human review.
