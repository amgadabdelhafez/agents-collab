# Design: LLM-named tmux panes

**Date:** 2026-07-05
**Feature:** Have the local LLM label each agent pane with the context it figured out, so the tmux pane border reads e.g. `⏸ claude · auth refactor`.

## Goal

Each agent pane's border should show, at a glance, **what state the agent is in and what task it's working on**. The state half updates live every tick; the task half is a short LLM-derived label refreshed on a slow cadence.

## Background / constraints (from the existing code)

- The tmux workspace has three fixed panes: `:0.0` (left agent), `:0.1` (right agent), `:0.2` (babysitter). No pane borders/titles are configured today.
- Each agent's `state` is already computed **every tick** (`babysitter.ts:928`: `row.verdict?.state ?? (row.thinking ? "thinking" : "idle")`). Composing the state glyph is therefore free.
- The per-tick **judge** (`judgeWithLocalJudges`) only runs when an agent is `suspect` and its turn hasn't ended (`babysitter.ts:2514`). A healthy working agent is never judged — so we cannot rely on the judge for a per-tick task label.
- The **session summary** (`summarizeWithLocalJudges`) runs on a slow cadence (`SUMMARY_REFRESH_TICKS = 20`) but produces one combined `project/objective/progress/next` block, not per-agent labels.
- mlx serves one request at a time; extra LLM calls contend on that single server.
- `BabysitAgentInfo.pane` already holds the exact pane target per agent (e.g. `session:0.0`).

## Decisions (locked with user)

1. **Border content:** `⟨glyph⟩ ⟨agent⟩ · ⟨task label⟩`. Glyph+agent composed live each tick from `state`; task label from the LLM, held stable between refreshes. Babysitter pane gets a fixed `● babysitter`.
2. **Label source:** a **dedicated `pane-label` LLM purpose** (new function beside `judge`/`summary`/`waiting`/`role-balance`), run on the summary cadence. *Not* folded into the summary call — keeps the summary's parsed contract intact, matches the one-purpose-per-function pattern.
3. **Fallback:** when there is no confident label (startup, malformed, timeout, offline), the border shows just `⟨glyph⟩ ⟨agent⟩` with no `· task`.

## Architecture

### Component 1 — `pane-label` LLM call (`babysitter-llm.ts`)

New exported `labelPanes` (or `labelAgentPane`) mirroring `judgeAgent`'s discipline:

- **Input:** per-agent `paneText` (tail) + recent action labels — the same `SummaryAgentContext` material already assembled each tick as `summaryCtx`.
- **Prompt:** system prompt instructs a JSON reply mapping each agent to a **2–4 word task noun phrase** describing what it's doing (not its state — state is composed separately). Example output: `{"claude": "auth refactor", "codex": "writing tests"}`.
- **Output/parse:** validate JSON; coerce each label to a trimmed string, truncated to a small max (e.g. `PANE_LABEL_MAX = 24` chars). Malformed/timeout/unreachable → return no labels (empty map), same fallback shape as the judge.
- **Trace purpose:** add `"pane-label"` to `LlmTracePurpose`.
- Runs against `localJudgesForTick` like the other calls; single-request-safe.

### Component 2 — cadence + wiring (`babysitter.ts` tick loop)

- Reuse the summary-refresh cadence: when `summaryDue(...)` fires (or first tick), also fire the `pane-label` call. Store the returned per-agent labels in run-state so they persist across ticks and resume.
- Every tick, for each agent, compose the title:
  `title = label ? `${glyph(state)} ${agent} · ${label}` : `${glyph(state)} ${agent}``
- Only apply to tmux when `title` differs from the last-applied value for that pane (tracked per pane). State changes push immediately; label changes push on the next tick after a refresh.

### Component 3 — glyph map (`babysitter.ts`)

Small pure `stateGlyph(state)` mapping, consistent with existing `stateColor`/`stateLabel`:

| state | glyph |
|---|---|
| working | ▶ |
| thinking | … |
| waiting-human | ⏸ |
| waiting-peer | ⧗ |
| stuck | ⚠ |
| limited | ⛔ |
| crashed | ✖ |
| idle | · |

(Exact glyphs finalizable in implementation; the map is the unit under test.)

### Component 4 — tmux plumbing

Titles are driven by a **per-pane user option**, not `pane_title` — because the claude/codex TUIs emit their own OSC title escape sequences that would overwrite a `select-pane -T`.

- **Once at workspace setup** (`tmux.ts`, session name known): enable
  `set -t <session> pane-border-status top` and
  `set -t <session> pane-border-format "#{@loop_label}"`.
  Babysitter pane's `@loop_label` set once to `● babysitter`.
- **Each tick** the babysitter sets per-agent:
  `tmux set -p -t <info.pane> @loop_label "<title>"`
  via the existing spawn dep — immune to whatever the agent program writes to `pane_title`.

## Data flow

```
tick:
  state (already computed) ─┐
                            ├─► compose title ─► (changed?) ─► tmux set -p @loop_label
  run-state paneLabels ─────┘
     ▲
     │ (every SUMMARY_REFRESH_TICKS)
  labelPanes(summaryCtxs) ── local LLM ──► {agent: "task label"}
```

## Run-state changes

Add to the persisted babysitter run-state:
- `paneLabels: Record<Agent, string>` — last LLM task labels (survives resume so the border isn't blank after a restart).
- `paneLabelTick: number` — mirrors `summaryTick` for the label refresh cadence (or reuse `summaryTick` if the two always fire together — decide in the plan).
- Last-applied title per pane may be kept in-memory only (tmux is re-set on resume anyway), avoiding schema churn — decide in the plan.

## Error handling

- LLM malformed/timeout/unreachable → keep previous `paneLabels` (or empty at startup); border degrades to glyph+agent. Never blocks the tick.
- tmux `set -p` failures are non-fatal (best-effort, `stderr: "ignore"` like existing send-keys).
- Unknown/new state → glyph falls back to `·`.

## Testing

- **Pure units:** `stateGlyph` map; title composition (with/without label); "apply only on change" gate.
- **`pane-label` parse:** valid JSON → per-agent labels; malformed/empty → empty map; truncation at `PANE_LABEL_MAX`.
- **tmux deps:** assert `set -p @loop_label` fires with the expected pane target and composed value using the existing spawn mock; assert border-status/border-format set once at session setup.
- **Cadence:** label call fires on `summaryDue`, not every tick.

## Out of scope (YAGNI)

- Renaming the tmux window itself.
- User-configurable border format / glyph theme.
- LLM naming of the babysitter pane (fixed label only).
- Historical/animated labels.
