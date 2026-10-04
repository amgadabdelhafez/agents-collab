# Acceptance

- npm run test:ci at base and candidate; npm run test:file <file> for all remaining files after the first failure. Candidate named failure set must be a subset of baseline.
- npm run check and git diff --check clean or unchanged named baseline findings.
- rg -n "session-pressure|sessionPressureMode|CONTEXT_HANDOFF|sessionPressurePrepared|contextHandoffTokens|prepare a fresh-loop handover" loop-fork/src loop-fork/tests loop-fork/docs yields only legacy ignored-key tests.
- High tokens (10 million), turns (1000), compactions (100) for both primary agents produce no agent message or handover; run state equals normal-usage control. Exercise outer run loop with injected dependencies and bounded exit.
- Legacy state containing valid or malformed removed keys loads preserved normal fields, strips retired fields on save.
- bun run build; copy output only to candidate path; report SHA-256. Installed binary and binary-of-record remain untouched.
- scripts/verify.sh remove-session-pressure remove-session-pressure must be attempted; its clean-baseline gate cannot supersede this charter's explicit named-baseline allowance. Record any pre-existing typecheck stop exactly.
- No web UI behavior changes; screenshot/DOM not applicable.
- One exact-SHA final review from Claude, explicitly without shell; no release/install authority.
