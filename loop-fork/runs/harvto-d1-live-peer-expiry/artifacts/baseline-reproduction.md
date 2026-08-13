# D1 Baseline Reproduction

Recorded: 2026-08-12 (America/Los_Angeles)

## Identity and evidence roots

- Branch: `codex/harvto-supervisor-defects`
- Worktree: `/Users/amgad/dev_projects/agents-collab-harvto-supervisor-defects`
- Base SHA: `52e244b8d49258ea1768580fba2042719030d884`
- `git rev-parse --verify 52e244b8d49258ea1768580fba2042719030d884^{commit}` resolved to the same SHA.
- Initial status had no staged or tracked edits. Existing untracked `PLAN.md` and `status.md` were the required session records.
- Canonical Harness task ID: `harvto-d1-live-peer-expiry`.
- Repo-root `runs/harvto-d1-live-peer-expiry/` is reserved for `scripts/verify.sh` eval evidence.
- `loop-fork/runs/harvto-d1-live-peer-expiry/` holds promoted Harness evidence, including this reproduction.

Promotion commands:

```text
cd loop-fork && ./harness promote harvto-d1-live-peer-expiry
cd loop-fork && ./harness status --json
```

First promotion attempt failed closed because `harvto-supervisor-defects` remained active. Its existing eval was passing. Required Harness transition:

```text
cd loop-fork && ./harness park harvto-supervisor-defects
cd loop-fork && ./harness promote harvto-d1-live-peer-expiry
cd loop-fork && ./harness status --json
```

Final status reported `active_task: harvto-d1-live-peer-expiry` and `run_dir: runs/harvto-d1-live-peer-expiry`.

## Source and liveness trace

- `readPendingBridgeMessages` at `src/loop/bridge-store.ts:363` appends `expired` solely when `expiresAt <= nowMs`.
- `enqueueBridgeMessage` at `src/loop/bridge-store.ts:599` is called only by `src/loop/bridge-dispatch.ts`; it appends the message, then appends `dead-letter` when target depth reaches `maxOutstanding`.
- Read callers exist in bridge store/dispatch/runtime, memory checkpoint, recon pane, and utility observability paths.
- Authoritative liveness vocabulary is `dead | live | unknown` from `src/loop/tmux-control.ts`. Bounded process/tmux probes and exact manifest-recorded pane topology are evidence. Notification, heartbeat, and pane prose are not delivery or liveness proof.
- Au Pair utility audits: source/call graph `3f09d4e9-c04c-4153-b3e7-daeee425de18`; tests/blast radius `8be3aed3-5934-42f5-9a2f-875c91dab9e6`; liveness trace `e2c9c453-2177-40cc-bd89-45e6b3a3bf94`. All completed zero-write.

## Baseline commands and result

Existing focused file before regression:

```text
cd loop-fork && bun run test:file -- tests/loop/governess-p0-runtime.test.ts
```

Result: 8 pass, 0 fail, 30 expectations.

Named D1 regression, added while production remained unchanged:

```text
cd loop-fork && bun run test:file -- tests/loop/governess-p0-runtime.test.ts --test-name-pattern 'D1 live liveness callback suppresses ttl expiry and queue-depth dead-letter terminalization'
```

Result: 0 pass, 8 filtered, 1 fail. Decisive failure:

```text
(fail) D1 live liveness callback suppresses ttl expiry and queue-depth dead-letter terminalization
Expected length: 1
Received length: 0
```

The fixture injected `t0`, `t0 + 2000ms`, and a callback returning positive live evidence. No sleep or real process/tmux probe ran. Both terminal paths executed before the first assertion.

TTL journal:

```json
{"at":"2026-07-25T10:00:00.000Z","expiresAt":"2026-07-25T10:00:01.000Z","id":"0c00eee2-ece4-4838-880b-eb83136f28ae","kind":"message","message":"ttl work","priority":"normal","signature":"93d791d553041acaa4ef54ee0a1a4c5b2c60664e9d943e19ae4a215293246172","source":"claude","target":"codex","type":"work_request"}
{"at":"2026-07-25T10:00:02.000Z","id":"0c00eee2-ece4-4838-880b-eb83136f28ae","kind":"expired","reason":"expired at 2026-07-25T10:00:01.000Z","signature":"93d791d553041acaa4ef54ee0a1a4c5b2c60664e9d943e19ae4a215293246172","source":"claude","target":"codex"}
```

Queue-depth journal:

```json
{"at":"2026-07-25T10:00:00.000Z","id":"3c56a202-d7b1-45dd-aa76-d23b9cbaa503","kind":"message","message":"first work","priority":"normal","signature":"f82d22b53bdc5c96cdbbe502ea8971bfaf93aa48a15377015ebef6724db08638","source":"claude","target":"codex","type":"work_request"}
{"at":"2026-07-25T10:00:00.000Z","id":"f372e9a6-e1b1-49b1-9d53-76febdf846e1","kind":"message","message":"overflow work","priority":"normal","signature":"56a611e386edff7a9bc7876ebc26655cac616fa92e8e04db87a5aeae54bca8cf","source":"claude","target":"codex","type":"work_request"}
{"at":"2026-07-25T10:00:00.000Z","id":"f372e9a6-e1b1-49b1-9d53-76febdf846e1","kind":"dead-letter","reason":"target queue limit 1 reached","signature":"56a611e386edff7a9bc7876ebc26655cac616fa92e8e04db87a5aeae54bca8cf","source":"claude","target":"codex"}
```

Verdict: D1 premise reproduced. Production patch is authorized; no refutation stop applies.

## Post-fix confirmation

The same named regression now supplies the typed tri-state resolver directly and keeps all seven
behavior assertions unchanged:

```text
cd loop-fork && bun run test:file -- tests/loop/governess-p0-runtime.test.ts --test-name-pattern 'D1 live liveness callback suppresses ttl expiry and queue-depth dead-letter terminalization'
```

Result: 1 pass, 15 filtered, 0 fail. Live-target TTL remains pending, live-target pressure retains
both accepted identities, and neither terminal event is journaled.
