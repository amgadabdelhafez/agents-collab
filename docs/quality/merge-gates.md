# Merge gates (local, deterministic)

Two gates run before anything merges. Both are local — no GitHub Actions, no
remote runner, no billing. Both are pure mechanics: they compare things and exit.
Neither asks an agent to be careful.

Run both:

```bash
scripts/verify.sh          # runs protected-paths, then ratchet, then the rest
```

Run them individually:

```bash
scripts/check-protected-paths.sh
scripts/ratchet.sh
```

---

## 1. Ratchet — `scripts/ratchet.sh`

The vendored `loop-fork/` project carries a large standing debt of biome
(ultracite) and TypeScript diagnostics. Driving it to zero is a separate
project. The ratchet enforces the one thing that can be enforced today:

> counts may go **down** or stay flat. They may never go **up**.

Ceilings live in `scripts/ratchet-baseline.json`.

### Measured baseline (2026-07-27, at `main` = `aa74ee7`)

| metric | count |
|---|---|
| biome errors (`biome check src tests`) | **147** |
| biome warnings | **1** |
| `tsc --noEmit` errors | **150** (20 in `src/`, 130 in `tests/`) |

These are the real numbers. The figures that circulated before this gate
existed — "~16 biome, ~20 tsc" — were each a true count of a *subset*:

- **16** is the `assist/*` slice alone (`organizeImports` 10 +
  `useSortedInterfaceMembers` 6). Full split: lint 111, format 20, assist 16.
- **20** is the `src/`-only slice of tsc. The other 130 are in `tests/`.

Do not re-quote the old numbers. Run `scripts/ratchet.sh --print`.

### Scope is pinned on purpose

The gate measures `src` and `tests` — exactly what `loop-fork/tsconfig.json`
includes — and never `./`. This is not cosmetic. `biome check ./` walks
`loop-fork/.claude/worktrees/` and aborts on the nested `biome.jsonc` of any
live agent worktree:

```
× Found a nested root configuration, but there's already a root configuration.
```

which would make the gate's verdict depend on whether a loop happened to be
running at the time. Pinned scope, reproducible measurement.

`loop-fork`'s own `bun run check` (`ultracite check` with no path argument) has
this bug today and fails outright whenever a Claude worktree exists under
`loop-fork/.claude/worktrees/`. `ultracite` also shells out to a bare `biome`,
so it only works when `node_modules/.bin` is on `PATH`. The ratchet calls the
`biome` binary directly with the same `biome.jsonc` (which extends
`ultracite/biome/core`), so it is the same rule set without either failure mode.

### Commands

```bash
scripts/ratchet.sh              # check (default). Exit 1 if a count rose.
scripts/ratchet.sh --print      # measure and report, never fails on counts
scripts/ratchet.sh --snapshot   # rewrite the baseline from current counts
```

`--snapshot` **refuses to raise a ceiling**. Raising one is a deliberate,
reviewed act:

```bash
RATCHET_ALLOW_RAISE=1 scripts/ratchet.sh --snapshot
```

When counts fall, the gate passes and prints how much slack it found. Tighten it
with `--snapshot` — otherwise the debt can silently creep back in.

### Environment

| variable | effect |
|---|---|
| `RATCHET_PROJECT_DIR` | project to measure (default `loop-fork`) |
| `RATCHET_BASELINE` | baseline file path |
| `RATCHET_ALLOW_RAISE=1` | let `--snapshot` raise a ceiling |
| `RATCHET_SKIP_WITHOUT_DEPS=1` | exit 0 with a `SKIPPED` notice when `node_modules` is missing |

`RATCHET_SKIP_WITHOUT_DEPS` is **off by default**. A fresh worktree has no
`node_modules`, and the gate fails loudly there rather than passing green
without measuring anything. Run `bun install` in `loop-fork/`, or set the
variable and accept that nothing was checked.

### Exit codes

`0` pass · `1` a ceiling was exceeded · `2` the gate could not run
(missing tools, biome config error, tsc crash, no baseline). A `2` is never
silently a pass.

---

## 2. Protected paths — `scripts/check-protected-paths.sh`

An agent run may edit product code freely. It may not quietly rewrite the files
that govern how agents behave.

Denied at any depth:

```
**/.claude/settings.json          **/.claude/settings.local.json
**/.claude/hooks/**               **/.harness/hooks/**
**/CLAUDE.md                      **/AGENTS.md
**/.github/workflows/**
```

Explicitly **not** denied: `loop-fork/src/loop/hooks/*.ts` is product source
agents are supposed to edit. The patterns are anchored so it never matches.

```bash
scripts/check-protected-paths.sh                # working tree + index vs HEAD
scripts/check-protected-paths.sh --staged       # index only (pre-commit)
scripts/check-protected-paths.sh --range A..B   # a commit range (pre-push/CI)
```

Bypass, when a human decided on the change:

```bash
ALLOW_PROTECTED_PATHS=1 scripts/check-protected-paths.sh
```

The bypass is loud: it still prints every protected path that was touched.

### Prevention as well as detection

`.claude/settings.json` (project scope) registers a `PreToolUse` hook,
`.claude/hooks/deny-protected-paths.sh`, that blocks `Write`/`Edit`/`MultiEdit`/
`NotebookEdit` against the same list before the write lands. `ALLOW_PROTECTED_PATHS=1`
in the session environment disables it.

The hook is the convenient half; **the script is the gate**. A hook only sees
Write/Edit-shaped tool calls — it will never catch `bash -c "sed -i ... CLAUDE.md"`.
`check-protected-paths.sh` reads the diff, so it catches every route.

---

## What these gates do not do

- They do not run tests. `bun test` in `loop-fork/` is still yours to run.
- They do not check formatting *drift* beyond the count — 20 files are
  unformatted today and the ratchet only stops that becoming 21.
- They do not gate `main`. The supervisor merges; these run on the branch first.
