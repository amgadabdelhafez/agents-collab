# Remove Governess context pressure

Founder authorization (2026-10-04): remove context-pressure logic; each agent auto-compacts itself.

Remove the module, model thresholds, mode/env setting, state fields/readers/writers, preparation messages, transition events, and automatic context handover initiation. Quota/rate-limit pressure, explicit handover machinery, role balance, idle recovery, exit control, beat close and bridge delivery retain existing behavior. Old JSON state keys must load safely and be ignored.

Local only on branch claude/remove-governess-session-pressure from 4439b2e7. No dependency/version changes, push, PR, merge or install. Build only a candidate at /Users/amgad/.loop/bin/candidates/loop-no-session-pressure. One final exact-commit Claude review; no plan gate.
