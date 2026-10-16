# Startup repair status, October 15, 2026

User reaffirmed standing approval; no further implementation approval is needed for this bounded continuation.

## Source change
Isolated branch codex/startup-receipts-20261015 from verified remote main cca256376bcd7d89eda935618b86ebe28be2d1f1. Add one bounded post-confirmation observation window when Claude development-channel modal disappears. Preserve existing 240-poll hard cap, composer/draft guards and confirmation retry suppression. Recovery admission is unchanged.

## Evidence
33 focused Claude tests pass after tightening timeout to exactly41000ms; preserved-startup admission test passes23 assertions. Whole tmux file:131 pass,5 fail; the same five identities fail with base source. The two new tests fail with base source. Full scripts/verify.sh invoked and stopped at10 lint diagnostics in existing scripts/vertical-cleanup-health.ts and scripts/vertical-cleanup-launch.ts; later gates did not execute. Not release certified.

Independent foreground harness reviewer session e29792b2-b164-4d97-b767-1a771037ca91 found no source defect and requested an exact timeout assertion, now applied. The completion-review stage d5355d9a-e573-4c15-8e76-238a48a76ae8 expanded beyond the read-only/no-delegation brief, announcing subreviewers and temporary instrumentation. The run reached its one-iteration cap and exited before supervisor intervention. Final diff inspection showed only the intended source/test additions, no instrumentation left in this checkout. Its expanded activity is not counted as authorized acceptance. No final independent re-review of the tightened assertion has occurred.

## Remaining paired-launch blocker
Read-only hooks/list on run30 app-server ws://127.0.0.1:4502 reports every generated hook enabled but untrusted (including SessionStart). The launcher passes hook-trust CLI flag to attached TUI, while persistent session originates in app-server. An isolated no-inference probe reproduces successful thread/start with an untrusted hook and absent receipt. No hook trust/policy was changed and no receipt fabricated. Paired recovery remains blocked on authentic startup evidence.

Official hook behavior reference: https://developers.openai.com/codex/hooks . Non-managed hooks need exact-definition review/trust.

## Continuation
Core implementation launched through supported foreground harness mode in /Users/amgad/dev_projects/ai-cur-core-delete-entry-20261015 with Codex driver and Claude completion review. Its output acknowledges task scope and source ancestry. Product task is running, not complete. Existing paired run30, Apple and agents-collab sessions preserved. No installation/merge/push/deploy performed.
