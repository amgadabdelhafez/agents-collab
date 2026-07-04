# Quality Scorecard
> Updated by the architecture-review background agent or manually after significant changes.
> Grades: A (excellent) · B (acceptable) · C (needs attention) · D (risky) · F (must fix before shipping)
> A subsystem graded D or F blocks new features until a remediation spec exists.

Last updated: <!-- YYYY-MM-DD -->

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
| D-001 | [Subsystem] | [What is wrong] | P2 | — | open |

---

## Background agent instructions

The `architecture-review` agent should:
1. Run test coverage report and update the Coverage column.
2. Query observability stack and update the Observability column.
3. Check for open P1/P2 issues and update Defects.
4. Recalculate grades using the rubric.
5. Open a PR with updated scorecard if any grade changed.
6. If any subsystem drops to D or F, open a separate issue and tag for human review.
