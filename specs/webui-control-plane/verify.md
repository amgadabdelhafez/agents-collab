# Verify: Loop Web Control Surface

This is the evaluator contract. Each implementation task narrows this matrix to
its admitted scope, but Release 1 does not pass until every Release 1 criterion
is proven together on the exact candidate SHA.

## Design-slice checks

| Check | Pass condition |
|---|---|
| Spec completeness | `spec.md`, `plan.md`, `tasks.md`, and `verify.md` exist and contain no template placeholders |
| Acceptance mapping | AC-01 through AC-20 each map to one or more checks below |
| Architecture truth | Current docs label the Web UI planned, not installed |
| Dependency graph | Every planned source dependency and future mutation boundary is declared |
| Research gate | `cd loop-fork && ./harness research --gate --json webui-control-plane-spec` returns `status: pass`; `runs/webui-control-plane-spec/research.md` names the question, sources, candidates, and reuse decision |
| Diff hygiene | `git diff --check` exits 0 and changes remain documentation/Harness-only |

## Acceptance coverage map

This table is normative. Every referenced check ID must be present and pass.

| Acceptance | Required checks |
|---|---|
| AC-01 | F-01, S-01, S-02, P-01, R-01 |
| AC-02 | F-02, U-01, D-01, D-02, P-02, R-02 |
| AC-03 | F-02, U-01, D-05 |
| AC-04 | F-03, U-02, U-03, A-06, P-03 |
| AC-05 | F-03, U-02, U-04, U-12 |
| AC-06 | F-04, U-06, U-07, A-03, D-03, D-04, D-08, D-11, R-03 |
| AC-07 | F-05, D-10, R-04, R-05 |
| AC-08 | F-06, U-10, S-07, P-03, P-09 through P-12 |
| AC-09 | F-07, U-08, A-05, D-12, P-04, P-07, P-08 |
| AC-10 | F-04, U-06, U-07, D-01 through D-04, D-08 through D-11 |
| AC-11 | F-08, S-08, D-09, D-10, R-04 |
| AC-12 | F-09, D-05 through D-07, D-15, R-02 |
| AC-13 | F-10, S-06, S-07, D-13, E-03, E-04 |
| AC-14 | F-11, S-01 through S-07 |
| AC-15 | F-12, S-08 |
| AC-16 | F-13, U-11, A-04 |
| AC-17 | F-14, U-03, U-08, U-09, U-11, A-01 through A-07, P-07, P-11 |
| AC-18 | F-15, D-14 |
| AC-19 | F-17, U-01 through U-12, A-06 |
| AC-20 | F-16, A-07, all S checks, all D checks, all P checks, all R checks, all E checks |

## Release 1 automated checks

The final implementation task records these through Harness and the root verify
script. Exact test paths may be refined in the implementation plan, but the
claim and pass condition may not be weakened.

| ID | Maps | Claim | Pass condition |
|---|---|---|---|
| F-01 | AC-01 | Local launch and CLI compatibility | `loop web` uses stable default `127.0.0.1:46327`, fails clearly on conflict, uses the separate TTY-code bootstrap, and leaves current `dashboard` golden tests unchanged |
| F-02 | AC-02, AC-03 | Canonical fleet | Path-bound producer fixtures yield one run per repo/run key, one primary group by precedence, every secondary reason badge, and deterministic search/filter/sort |
| F-03 | AC-04, AC-05 | Required workspace data | Desktop and narrow DOM contain the persistent header, both seats, Governess, bounded worker, every available required field, and provider/window-aware quota ordering |
| F-04 | AC-06, AC-10 | Provenance and uncertainty | Every requirement/observation matrix cell and freshness threshold below/equal/above boundary produces the normative aggregate, contract ID, threshold, age basis, and provenance; no stricter condition reports healthy |
| F-05 | AC-07 | Worker/recon parity and authority | Direct/Nanny/Au Pair remain tiers under one worker; route/tool/result/failure/usage parity holds; no DTO/component can assign driver/reviewer authority |
| F-06 | AC-08 | Timeline determinism and bounds | Repeated cursor pages yield identical order/IDs; page/filter/cursor revision binding holds at 100 default/200 maximum; opaque evidence resolves to the same bounded record |
| F-07 | AC-09 | Stream recovery | Within one UUID stream epoch integer sequences increase by exactly one; old epoch/gap/compaction/overflow force snapshot and a slow client disconnects safely |
| F-08 | AC-11 | Read purity | Complete run-tree digest and file inventory, fixture PIDs/process tree, and tmux state/options are identical before/after all GETs; capability spies record zero write/migrate/rebuild/maintenance/spawn/tmux calls |
| F-09 | AC-12 | Diagnostic-only probes | Live, dead, timeout, malformed, two sockets with identical session names, and same-socket server reincarnation revalidate socket plus server instance and cannot mutate or override lifecycle |
| F-10 | AC-13 | Redacted public DTO | Secret corpus, ANSI/control bytes, raw paths, remote-control URLs, and hidden/provider payloads are absent from serialized responses |
| F-11 | AC-14 | HTTP security | Non-loopback configuration, bad Host/Origin/session/bootstrap code, code reuse/expiry/attempt limit, traversal, symlink escape, oversized request, and unsafe artifact IDs fail closed; the code appears in none of URL/argv/referrer/log/browser storage |
| F-12 | AC-15 | No runtime mutation surface | Bootstrap POST can create only an ephemeral Web session; every other POST and all PUT/PATCH/DELETE return typed 405; static/capability analysis finds no writer/key-sender/lifecycle mutator in projection modules |
| F-13 | AC-16 | Preference boundary | Round-trip/migration/reset covers display settings, survives restart on the stable default origin, documents explicit-port namespace isolation, rejects policy/runtime/secret keys, and cannot suppress immutable safety warnings |
| F-14 | AC-17 | Keyboard and live-update behavior | Full UI and layout presets/reset are keyboard reachable; focus/scroll persist; `N new`/Resume live and pause work; high-frequency regions are not assertive live regions |
| F-15 | AC-18 | Runtime isolation | Killing the browser/server leaves fixture agent, Governess, bridge worker, and manifest unchanged |
| F-16 | AC-20 | Release certification | F-01 through F-15 and F-17, all U/A/S/D/P/R/E checks, and the full named suite/build pass on the exact candidate SHA with `baseline_failures` empty |
| F-17 | AC-19 | Required visual evidence | U-01 through U-12 each contain both a screenshot and DOM snapshot with the named viewport and assertions |

## UI evidence matrix

Capture both screenshot and DOM for:

| ID | Maps | View | Width | Required assertions |
|---|---|---|---:|---|
| U-01 | AC-02, AC-03, AC-19 | Fleet, mixed states | 1440 | four exclusive groups, compact rows, search/filter/sort, reason badges, contextual terminal guidance, adapter disclosure, live indicator |
| U-02 | AC-04, AC-05, AC-19 | Run, desktop | 1440 | persistent identity/authority header; two agent seats over Governess and bounded worker |
| U-03 | AC-04, AC-17, AC-19 | Run, narrow | 390 | Overview/Agents/Activity/Timeline navigation, persistent header, no nested tabs or horizontal page overflow |
| U-04 | AC-05, AC-19 | Dense mode | 1440 | more rows without clipped labels or lost source/quota badges |
| U-05 | AC-19 | Empty fleet | 1440 | useful empty state and launch guidance, no error styling |
| U-06 | AC-06, AC-10, AC-19 | Stale/conflict | 1440 | visible non-green quality banner and non-interactive read-only policy card |
| U-07 | AC-06, AC-10, AC-19 | Corrupt source | 1440 | unaffected regions remain visible and affected evidence names source kind |
| U-08 | AC-09, AC-17, AC-19 | Reconnecting/paused/history | 1440 | focus/scroll preserved, `N new`, Resume live, queued-update count and resync path |
| U-09 | AC-17, AC-19 | Dark/light | 1440 | semantic status remains distinguishable without color alone |
| U-10 | AC-08, AC-19 | Timeline and evidence | 1440 | bounded Older/Newer pages, filter/cursor URL state, expanded provenance, opaque evidence drawer, deterministic ordering |
| U-11 | AC-16, AC-17, AC-19 | Preferences and layout | 1440 | display-only controls, keyboard sizing presets, Reset layout, immutable warnings remain |
| U-12 | AC-05, AC-19 | Provider quota variants | 1440 | session-before-weekly, unsupported omission, unknown/stale reset states |

Store evidence under `runs/{task-id}/artifacts/ui/` with route, viewport,
candidate SHA, browser version, timestamp, console errors, and DOM snapshot.

## Accessibility checks

| ID | Maps | Pass condition |
|---|---|---|
| A-01 | AC-17, AC-19 | Page landmarks, headings, lists/tables, page sections, dialogs, and buttons use native semantics before ARIA |
| A-02 | AC-17 | Keyboard-only traversal reaches every interactive element and layout preset/reset with visible focus and no trap |
| A-03 | AC-06, AC-17 | Status is conveyed by text/icon as well as color |
| A-04 | AC-16, AC-17 | Reduced-motion preference suppresses nonessential animation |
| A-05 | AC-09, AC-17 | Live telemetry preserves focus/scroll and does not continuously announce; only a small polite connection/action region is live |
| A-06 | AC-04, AC-17, AC-19 | Zoom at 200% and 400% remains usable; narrow layout has no page-level horizontal scroll |
| A-07 | AC-17, AC-20 | Automated scan has no serious/critical findings; every lower finding is named and adjudicated, never silently baselined |

## Security and privacy checks

| ID | Maps | Pass condition |
|---|---|---|
| S-01 | AC-01, AC-14 | Server binds stable default `127.0.0.1:46327`, fails on conflict unless an explicit port is supplied, and cannot silently widen |
| S-02 | AC-01, AC-14 | Bootstrap code has >=128 random bits, 60-second TTL, five-attempt maximum, single use, and no URL/argv/referrer/log/browser-storage occurrence |
| S-03 | AC-14 | Auth cookie has >=256 random bits, is HttpOnly, SameSite=Strict, path-scoped, and expires with the server session |
| S-04 | AC-14 | Exact Host is always required; bootstrap POST/future non-safe requests require exact Origin; authenticated GET/HEAD/SSE pass with absent Origin and reject a mismatching present Origin; initial bootstrap GET returns no run data/session; no wildcard CORS |
| S-05 | AC-14 | CSP denies object/embed and framing and needs no unsafe inline script |
| S-06 | AC-13, AC-14 | DTO allowlists reject credential, environment, provider URL, local path, ANSI, HTML/script, hidden-provider, and symlink-escape corpus |
| S-07 | AC-08, AC-13, AC-14 | Evidence is bounded by opaque ID, containment, symlink, size, MIME, and redaction rules |
| S-08 | AC-11, AC-15 | Apart from the session-only bootstrap POST, Release 1 has no non-safe handler, generic proxy, or mutating runtime dependency capability |

## Data-quality and fault matrix

| ID | Maps | Fault | Expected UI/API behavior | Forbidden behavior |
|---|---|---|---|---|
| D-01 | AC-02, AC-10 | Manifest missing | omit from canonical fleet and report an unbound-storage anomaly in health | infer a run from pane/process/directory name |
| D-02 | AC-02, AC-10 | Manifest internal IDs mismatch selected run-root | reject as corrupt and report the opaque source anomaly | key the run by either unverified identity |
| D-03 | AC-06, AC-10 | Optional source disabled/not applicable | source labeled disabled/not-applicable; aggregate may remain healthy | mark partial merely because feature is absent |
| D-04 | AC-06, AC-10 | Manifest current but transcript audit lags/malformed | preserve manifest lifecycle; audit partial/stale | declare lifecycle conflict automatically |
| D-05 | AC-03, AC-12 | Active manifest, dead positive adapter probe | identity/lifecycle preserved; reason badge shown under exclusive primary group | auto-stop, delete, or duplicate the run |
| D-06 | AC-12 | Tmux timeout or legacy unknown socket | adapter unknown | declare dead, use default socket, inject, or clear routing |
| D-07 | AC-12 | Identical session names on two tmux sockets | inspect only persisted socket context | join/probe the default or other socket |
| D-08 | AC-06, AC-10 | Governess state stale | read-only details remain; authority stale | enable future controls |
| D-09 | AC-10, AC-11 | Bridge line truncated | bridge section corrupt/partial | consume, expire, or acknowledge |
| D-10 | AC-07, AC-10, AC-11 | Utility journal malformed | worker section corrupt; rest of run visible | route/retry a job or rebuild an index |
| D-11 | AC-06, AC-10 | Source changes mid-read twice | one retry, then partial with both revisions | mix revisions and report healthy |
| D-12 | AC-09 | SSE epoch/cursor invalid or compacted | full resync | replay guessed deltas |
| D-13 | AC-13 | Browser text contains HTML/control bytes | escaped/redacted text | execute markup or terminal controls |
| D-14 | AC-18 | Web process killed | runtime unchanged | agent/Governess termination |
| D-15 | AC-12 | Tmux server reincarnates at same socket and session name | server-instance mismatch, adapter unknown, later control blocked | accept path/session match as the same server |

## Performance thresholds

Measure committed blobs only using a committed `performance-v1.json` and runner.
Record candidate SHA, fixture SHA, runner SHA, OS, CPU, memory, power mode, Bun
version, compression-library version, and Chrome stable major. Use a versioned
deterministic `fleet-100-v1` corpus with 25 runs per primary group and a
`run-heavy-v1` corpus with 10,000 normalized cross-source timeline events.
Record producer/capture metadata. Except P-01, run five uncounted warm-ups then
the named independent samples; repeat the complete measurement twice and fail
if either repetition exceeds threshold. Calculate p95 with the nearest-rank
method. The implementation may strengthen but not silently shrink the corpus or
workload.

| ID | Maps | Metric | Threshold |
|---|---|---|---:|
| P-01 | AC-01, AC-20 | Process-cold spawn-to-auth-bootstrap-health-ready on `fleet-100-v1`; 20 fresh processes, free default port, fresh temp session/config, no warm-up; OS cache state recorded | p95 under 2.0 seconds |
| P-02 | AC-02, AC-20 | Fleet snapshot, p95 over 30 independent reads | under 300 ms |
| P-03 | AC-04, AC-08, AC-20 | `run-heavy-v1` snapshot, p95 over 50 independent reads | under 150 ms |
| P-04 | AC-09, AC-20 | Durable event to visible update, 50 events at 5 events/second with 2 KiB public payload | p95 under 2.0 seconds |
| P-05 | AC-20 | Sum of candidate `.js`/`.css` excluding source maps, each compressed by committed runner with Brotli quality 11 | at most 250 KiB |
| P-06 | AC-20 | Idle server RSS after `fleet-100-v1`: wait 60 seconds, then sample once/second for 60 seconds | p95 at most 200 MiB |
| P-07 | AC-09, AC-17, AC-20 | Chrome long tasks during 60 seconds at 20 events/second, 2 KiB/event, with filter toggle and Older/Newer navigation every 5 seconds | zero tasks over 50 ms after first render |
| P-08 | AC-09, AC-20 | Per-subscriber SSE queue bound | at most 256 events or 1 MiB, whichever is reached first; overflow disconnects and requires resnapshot |
| P-09 | AC-08, AC-20 | Initial 100-row timeline render from `run-heavy-v1`, p95 over 20 navigations | under 500 ms |
| P-10 | AC-08, AC-20 | Server-filter change to visible result on `run-heavy-v1`, p95 over 20 filters | under 500 ms |
| P-11 | AC-08, AC-17, AC-20 | Older/Newer page navigation with focus/scroll restoration, p95 over 20 transitions | under 500 ms |
| P-12 | AC-08, AC-20 | Timeline row to evidence drawer ready, p95 over 20 records | under 300 ms |

## Regression guards

| ID | Maps | Pass condition |
|---|---|---|
| R-01 | AC-01, AC-20 | Current `loop dashboard` output and process discovery tests pass |
| R-02 | AC-02, AC-12, AC-20 | Paired tmux launch, resume, attach, manifest identity, multi-socket, server-reincarnation, and bounded control tests pass |
| R-03 | AC-06, AC-20 | Governess render, policy, control journal, replay, doctor, handover, and teardown tests pass |
| R-04 | AC-07, AC-11, AC-20 | Bridge enqueue, dedupe, delivery, non-empty composer, explicit expiry maintenance, and dead-letter tests pass |
| R-05 | AC-07, AC-20 | Utility routing, one-owner claims, observability, usage, redaction, and worker pane tests pass |
| R-06 | AC-20 | Full `bun run test:ci`, `bun run check`, TypeScript check, and compiled build pass with no swapped failure identities |

## Producer-derived fixture requirements

| ID | Maps | Pass condition |
|---|---|---|
| E-01 | AC-20 | Each cross-process fixture records producer, exact version/SHA, capture command, UTC time, and protocol/environment details |
| E-02 | AC-20 | Raw bytes or a durable SHA-256 reference are retained |
| E-03 | AC-13, AC-20 | Sanitization is deterministic and records the normalized SHA-256 |
| E-04 | AC-13, AC-20 | Secrets and personal data are removed before Git |
| E-05 | AC-20 | Synthetic fixtures are labeled and do not alone certify integration |
| E-06 | AC-20 | Independent evaluator verifies exact candidate SHA, fixture SHA, committed bundle sizes, complete coverage IDs, and `baseline_failures: []` |

## Eval output

`runs/{task-id}/eval.json` must include:

```json
{
  "task_id": "webui-readonly-mvp",
  "candidate_sha": "exact commit SHA",
  "baseline_failures": [],
  "checks": {
    "functional": { "passed": 0, "failed": 0, "details": [] },
    "ui": { "passed": 0, "failed": 0, "artifacts": [] },
    "accessibility": { "passed": 0, "failed": 0, "details": [] },
    "security": { "passed": 0, "failed": 0, "details": [] },
    "data_quality": { "passed": 0, "failed": 0, "details": [] },
    "performance": { "passed": 0, "failed": 0, "details": [] },
    "regression": { "passed": 0, "failed": 0, "details": [] }
  },
  "verdict": "pass | fail",
  "notes": ""
}
```

The evaluator must be independent of the implementation agent and must verify
the candidate SHA and committed asset sizes directly.

## Rollback conditions

Rollback or disable `loop web` if any of these occurs:

- Web launch changes or blocks current tmux/dashboard behavior;
- any GET mutates a durable source;
- a DTO leaks a secret, unsafe path, remote-control URL, hidden reasoning, or
  unredacted provider/terminal payload;
- stale/conflicting evidence renders as healthy;
- server/browser termination affects a run process or manifest;
- the server binds beyond loopback;
- stream recovery duplicates, omits without resync, or grows unbounded;
- serious/critical accessibility or security findings remain;
- a named existing test fails or the baseline failure set is non-empty.
