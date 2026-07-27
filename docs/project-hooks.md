# Project hooks — lessons that enforce themselves

Two `PreToolUse` hooks are registered in [`.claude/settings.json`](../.claude/settings.json)
and implemented in `scripts/hooks/`. They are **enforcement, not advice**: Claude Code runs
them before the tool call, and exit code 2 stops the call and hands the reason back to the
agent.

## Why hooks and not another paragraph

The Feb–Jul 2026 retrospective across this workspace found that written lessons
demonstrably fail. The load-bearing datum: a bookmark-sweep incident **recurred one commit
after a note was written telling agents not to do it**. Prose is read, agreed with, and then
not followed under task pressure.

`~/.claude/settings.json` already carries `Bash(git add:*)` on the **allow** list, so the
permission layer says yes to `git add -A`. The hook is what says no.

## What is registered

| Hook | Matcher | Blocks |
|---|---|---|
| `scripts/hooks/block-bulk-git-add.py` | `Bash` | whole-tree staging: `git add -A`, `git add .`, `git add --all`, `git add :/`, `git stage -A`, and `git commit -a` / `-am` |
| `scripts/hooks/guard-protected-paths.py` | `Bash`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit` | writes to any path listed in `scripts/hooks/protected-paths.conf` |

Plain Python 3, stdlib only, no install step — they run before `bun` exists in the
environment and must not depend on it.

### 1. No bulk staging

A whole-tree stage sweeps unrelated local files into a commit whose message claims to be
about something else. In this repo that is a live hazard: the working copy routinely
carries `runs/`, untracked `loop-fork/.claude/worktrees/`, and other agents' in-flight
state.

`git commit -a` is blocked deliberately. It is the same sweep with a different spelling and
it is the first thing an agent reaches for once `git add -A` stops working.

Not blocked: `git add <path>…`, `git add -p`, `git add -u`, `git add -- <path>`.

**There is no environment-variable bypass.** If a bulk stage is genuinely correct, the
supervisor runs it in their own shell.

### 2. No writes to protected config

The path list lives in `scripts/hooks/protected-paths.conf` — versioned, greppable,
reviewable in a diff. It currently covers `.claude/settings.json`,
`.claude/settings.local.json`, `scripts/hooks/**`, `.gitignore`, and the user-level
`~/.claude` / `~/.codex` configuration the founder hardened on 2026-07-27.

Deliberately **not** protected, and recorded as such in the file itself:

- `specs/constitution.md` — it still contains the placeholder string
  `(Fill in your actual invariants)` while agents cite it as authority. It needs editing,
  not freezing.
- `loop-fork/**` — vendored source under active development.
- `.github/**` — this repo has no workflows. Add `.github/workflows/**` to the conf if that
  changes.

**Reads are never blocked.** Only writes that land on a protected path are denied.

## Running the tests

```bash
scripts/hooks/test-hooks.sh
```

Feeds each hook the exact JSON payload Claude Code writes to a `PreToolUse` hook's stdin
and asserts the exit code (0 = allow, 2 = deny), across 51 deny/allow cases.

## Relationship to the hooks CLAUDE.md used to claim

`CLAUDE.md` previously listed four hooks under "Hooks (deterministic — always run)":
post-edit lint/typecheck, pre-completion test run, on-exit task-log append, and
`scripts/capture-ui.sh` on UI tasks. **None of them were registered at this repo's project
level.** The only real one was `loop-fork/.claude/settings.json`'s `PostToolUse` →
`bun x ultracite fix`, which applies to sessions rooted in the vendored `loop-fork/`
subdirectory, not to this repo. That section now distinguishes registered hooks from
intended ones.

## Changing the rules

Both the hook scripts and `protected-paths.conf` are themselves protected, so an agent
cannot loosen them mid-task. State what you want changed and why, then stop; the supervisor
edits it on a reviewed branch.

## Adding a hook

1. Write it in `scripts/hooks/`, stdlib Python only, `exit 2` to deny with the reason on
   stderr. Name the recorded incident it exists to prevent, in the docstring.
2. Add deny **and allow** cases to `scripts/hooks/test-hooks.sh`. An over-blocking guard
   gets disabled, and then there is no guard.
3. Register it in `.claude/settings.json` under `hooks.PreToolUse`, using the
   `${CLAUDE_PROJECT_DIR:-$PWD}` form so it resolves inside every worktree.
4. Verify it fires in a real session, not only in the test harness:
   ```bash
   claude -p "Run exactly this with the Bash tool: <the thing that should be blocked>" \
     --allowedTools Bash --setting-sources project,user --max-turns 3
   ```
   A hook nobody watched block something is not done.
