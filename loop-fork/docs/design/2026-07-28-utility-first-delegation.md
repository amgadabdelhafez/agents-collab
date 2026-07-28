# Utility-first delegation with one governed native fallback

**Design spec v1 — 2026-07-28.** Supervisor-authored for implementation by a loop/session.
Goal: main agents (Claude driver/reviewer at max, Codex at xhigh/ultra) keep their reasoning
quality but lose their private subagent fleets. Nanny/Au Pair become the delegation backend;
at most ONE governed native subagent exists at a time, leased by the Governess, read-only,
unable to spawn descendants. This is routing-and-gating only — no new proxy layer.

## 1. Modes (config surface)

`LOOP_DELEGATION_MODE` = `utility-first` (target default) | `strict` | `open` (legacy).

| mode | Nanny/Au Pair | Claude `Agent`/`Task` | Codex threads | native fallback |
|---|---|---|---|---|
| `open` | available | unrestricted | codex defaults | n/a (today's behavior) |
| `utility-first` | primary backend | **hook-gated: denied without a live lease** | `max_concurrent_threads_per_session = 1` | 1 slot, leased, read-only |
| `strict` | only backend | **`--disallowedTools Agent Task`** (tools absent) | `[agents] enabled = false` | none |

Ship with default `open` (zero behavior change), flip to `utility-first` after one clean
supervised run. Per-run override via env at launch.

## 2. Enforcement matrix — honest about hard vs soft, startup vs live

| enforcement | agent | mechanism | hard? | when applied |
|---|---|---|---|---|
| strict: no native subagents | Claude | `--disallowedTools Agent Task` appended in `buildClaudeCommand` (`src/loop/tmux.ts:445`) — tools absent from the tool list, works under `--dangerously-skip-permissions` | HARD | startup |
| strict: no native subagents | Codex | `[agents] enabled=false` via per-run `codex-home/config.toml` (`src/loop/codex-home.ts:76`) AND `-c agents.enabled=false` in `buildCodexCommand` (`src/loop/tmux.ts:521`) — `-c` wins over file, set both | HARD | startup |
| utility-first: fleet cap | Codex | `agents.max_concurrent_threads_per_session=1` (same two sites) | HARD | startup |
| utility-first: lease gate | Claude | **PreToolUse hook** in the per-run `claude-hook-settings.json` (already exists per run): on `Agent`/`Task` calls, allow iff a valid lease file exists; else deny with a named reason | HARD, live-flippable | per call |
| utility-first: lease gate | Codex | **not natively interceptable mid-session.** The cap (=1) is the lease equivalent; prompt policy directs the slot's use; governess DETECTS spawns from pane/delegation events and journals violations | SOFT (cap is hard, purpose is policy) | per call (detection) |
| read-only fallback | Claude | the hook validates the call's `subagent_type` against an allowlist of read-only types (`Explore`, `Plan`); those types carry no `Edit`/`Write`/`Agent`, so no writes and **no descendants** by construction | HARD | per call |
| read-only fallback | Codex | prompt contract + governess detection; codex thread capabilities are not per-thread configurable today | SOFT | per call |

The asymmetry is real and stays in the doc: Claude gets call-level hard gating (hooks),
Codex gets startup-level hard caps plus detection. Do not paper over this — the governess
journal is the audit trail for the soft half.

## 3. The lease

- **Grant path:** an agent that believes it needs a native fallback asks on the bridge
  (`work_request` class `native-fallback`), OR the governess auto-offers after observing
  ≥2 utility rejections (`request-not-bounded` / `protected-scope`) for the same objective
  within 10 minutes. Decision by governess policy: rule check (mode, slot free, requester,
  read-only objective) then existing LLM judgment with confidence threshold.
- **Lease artifact:** `<runDir>/native-lease.json` — `{controlId, agent, objective,
  allowedTypes:["Explore","Plan"], grantedAt, ttlSeconds (default 900), slot:1}`. Validity =
  file exists AND unexpired AND a matching `native-fallback-lease` control entry exists in
  the governess journal (`src/loop/governess-journal.ts`) with the same `controlId`. A lease
  file without its journal entry is INVALID — the file is a pointer, the journal is the
  authority.
- **Revoke/expiry:** governess deletes the file at TTL or objective completion; the hook
  re-validates on every call, so expiry is effective immediately (no live process to kill —
  the leased subagent finishes its current run; new calls are denied).
- **Observability:** governess pane rows (extend `src/loop/utility-observability.ts`):
  `utility jobs: N active / M done`, `native lease: none | claude·Explore·7m left`,
  `blocked fleet attempts: N (last: <reason>)`. Every denial appends a
  `delegation.jsonl` event (`src/loop/delegation-policy.ts` `appendDelegationEvent`).

## 4. What the main agents keep

Architecture, ambiguous judgment, authority, final review, and all direct deterministic
tool execution stay with Claude/Codex at full reasoning effort (driver `--effort max`,
codex `xhigh` — unchanged constants). This design removes only the private-fleet pattern:
reasoning depth is not the same resource as delegation fan-out, and the July retro's spend
data says fan-out is where cost hides.

## 5. Named wrong implementations (executable controls, each must FAIL against its wrong build)

1. **FLEET-DESPITE-STRICT** — in `strict`, an `Agent` call must be impossible (tool absent),
   not merely denied. Control: enumerate the session tool list; presence = fail.
2. **LEASE-WITHOUT-JOURNAL** — a hand-written `native-lease.json` with no matching journal
   control must deny. Control: plant the file, call, expect denial + a `lease-forged` event.
3. **WRITE-CAPABLE-FALLBACK** — a leased call with `subagent_type` outside the read-only
   allowlist must deny. Control: request `general-purpose` under a valid lease, expect denial.
4. **LEASE-OUTLIVES-TTL** — a call one second after expiry must deny without governess help
   (hook-side clock check).
5. **SILENT-BLOCK** — a denial that emits no `delegation.jsonl` event and no pane row is a
   fail: blocked attempts must be visible, or the fleet pressure just moves underground.

## 6. Tests & rollout

- Unit: hook decision function (mode × lease × type matrix), lease validation, config
  emission per mode (both `-c` args and `config.toml` for codex), observability rows.
- Integration: governess replay over a journal containing grant → use → expiry → forged-file
  attempt; assert invariants via existing `governess replay`.
- Eval: follow the `runs/<name>/eval.json` pattern (as action-oriented-comms did), including
  the five controls above executed against deliberately wrong builds.
- Rollout: land default `open` → one supervised harvto loop on `utility-first` with the
  governess rows watched → flip default. `strict` stays opt-in per run.

## 7. Open questions (founder)

1. Lease TTL default 15 min — right order? (Shorter starves long explorations; longer
   holds the slot hostage.)
2. Should the governess auto-OFFER leases (proactive, after repeated utility rejections)
   or only respond to explicit requests? Auto-offer is smoother; request-only is stricter.
3. Codex soft-half tolerance: is detection+journal enough for the cap's *purpose*, or do we
   want `enabled=false` for codex even in `utility-first` (making Claude the only fallback
   path)? Simpler and fully hard, at the cost of codex never having a native slot.
