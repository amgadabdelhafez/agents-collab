# Quality Scorecard
> Updated manually after significant changes.
> Grades: A (excellent) · B (acceptable) · C (needs attention) · D (risky) · F (must fix before shipping)
> A subsystem graded D or F blocks new features until a remediation spec exists.

Last updated: 2026-08-20

---

## Subsystem grades

| Subsystem | Grade | Test coverage | Observability | Docs | Debt notes | Owner |
|---|---|---|---|---|---|---|
| Bridge delivery | B | Named regression and integration suites | Durable JSONL, delivery and dead-letter state | ✅ | D9 complete; continue exact-SHA per-slice certification | Supervisor |
| Governess control | B | Unit, integration, and campaign evals | Governess journal, state, pane and process evidence | ✅ | D11 composer-safe recovery remains parked | Supervisor |
| Utility routing and patching | B | Router, runtime, scope and guarded-apply suites | Jobs, results, usage and validation artifacts | ✅ | D10 complete; preserve empty named baseline | Supervisor |
| Run lifecycle and tmux identity | C | Lifecycle, teardown, attach and handoff suites | Manifest, process records and tmux probes | ✅ | D12 manifest-backed socket discovery remains parked | Supervisor |

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
| D11 | Recovery | Preserve two non-empty composers and deduplicate recovery nudges | P1 | `loop-fork/specs/harvto-d11-composer-nudge.md` | parked |
| D12 | Tmux discovery | Discover socket and session from a valid run manifest | P1 | `loop-fork/specs/harvto-d12-socket-discovery.md` | parked |

---

## Background agent instructions

The `architecture-review` agent should:
1. Run test coverage report and update the Coverage column.
2. Query observability stack and update the Observability column.
3. Check for open P1/P2 issues and update Defects.
4. Recalculate grades using the rubric.
5. Open a PR with updated scorecard if any grade changed.
6. If any subsystem drops to D or F, open a separate issue and tag for human review.
