# Harness v2 Kit

Phase 1 prototype for repo-native task identity, persistent memory, and
deterministic retrospective specs.

This kit is intentionally small: bash + python3 only, no hooks, no install
script, no runtime orchestration.

Machine-readable command outputs are documented in
[JSON-CONTRACTS.md](JSON-CONTRACTS.md).

## 5-Minute Setup

Copy or reference the scripts from your project root. The scripts operate on
the current working directory.

```bash
mkdir -p v2/kit
cp -R /Users/amgad/dev_projects/harness-engineering/v2/kit/scripts v2/kit/

./v2/kit/scripts/task.sh demo-feature --description "Add a small demo feature"
./v2/kit/scripts/checkpoint.sh demo-feature "picked the smallest phase 1 slice"
./v2/kit/scripts/checkpoint.sh demo-feature "implemented file marker task identity"
./v2/kit/scripts/resume.sh demo-feature
```

`task.sh` writes `.harness/current-task` so future hooks can find the active
task without relying on shell environment mutation.

If you still want `TASK_ID` in your shell:

```bash
eval "$(./v2/kit/scripts/task.sh demo-feature --emit-env)"
```

## Worked Example

```bash
./v2/kit/scripts/task.sh demo-feature --description "Add durable task identity and checkpoints"
./v2/kit/scripts/checkpoint.sh demo-feature "created task skeleton"
./v2/kit/scripts/checkpoint.sh demo-feature "added deterministic checkpoint log"
./v2/kit/scripts/checkpoint.sh demo-feature "ready to complete"
```

Edit `runs/demo-feature/task-log.md` as work happens:

```markdown
## What I changed

- Added the phase 1 task, checkpoint, resume, and done commands.

## Why

- The harness needs durable task identity and recovery before richer evals.
```

Then complete the task:

```bash
./v2/kit/scripts/resume.sh demo-feature
./v2/kit/scripts/done.sh demo-feature
```

`done.sh` generates `specs/demo-feature.md`:

```markdown
# demo-feature

Task completed 2026-04-21T10:42:00Z, mode emergent.

## What was built

- Added the phase 1 task, checkpoint, resume, and done commands.

## Decisions made

...

## Open items at completion

...

## Trajectory

- 001 - initial (...)
- 002 - created task skeleton (...)
- 003 - added deterministic checkpoint log (...)
- 004 - ready to complete (...)
```

## Commands

| Command | Purpose |
|---|---|
| `scripts/task.sh <id> [--mode ...] [--description ...] [--estimate-loc n] [--research-required] [--emit-env]` | Create `runs/<id>/`, first memory checkpoint, and `.harness/current-task`. |
| `scripts/checkpoint.sh <id> "<topic>"` | Append a numbered memory checkpoint. |
| `scripts/resume.sh <id>` | Print memory files in chronological order. |
| `scripts/done.sh <id>` | Verify gates, require `task-log.md` change content, generate `specs/<id>.md`, mark metadata done, clear current task. |
| `scripts/research.sh init\|save\|status\|gate <id>` | Create, persist, inspect, or enforce required reuse/web research artifacts. |
| `scripts/session-export.sh --source <path> [--file sessions/export.jsonl]` | Export matching user/assistant transcript messages into repo-local session JSONL. |
| `scripts/state-check.sh <id> <pre\|post>` | Run executable state invariants for one lifecycle stage. |
| `scripts/pre-task.sh <id>` | Run executable state invariants before task creation. |
| `scripts/post-task.sh <id>` | Run executable state invariants before task completion is finalized. |
| `scripts/debt-snapshot.sh <id>` | Capture a task-start LOC baseline for mechanical debt detection. |
| `scripts/debt-scan.sh <id>` | Append non-blocking debt signals to `debt/register.jsonl`. |
| `scripts/regression-harvest.sh <id>` | Draft regression evals from bug-fix task logs. |
| `scripts/coordination.sh write <id> --intent ...` | Append agent intent to `agents/coordination.jsonl`. |
| `scripts/tracker.sh ...` | Minimal create/comment/link interface for tracker plugins. |
| `scripts/plan-save.sh <id>` | Persist plan-mode output to `runs/<id>/plan.md`. |
| `scripts/loop-prompt.sh <id> <slug> --slice <text>` | Write a loop-safe prompt file under `runs/<id>/loop-slices/`. |
| `scripts/audit.sh <security\|accessibility\|performance>` | Run reusable audit passes and write findings artifacts. |
| `scripts/eval-dim.sh ...` | Initialize, update, and aggregate typed eval dimensions. |
| `scripts/verify.sh <id> <dim> -- <cmd>` | Run a verification command, capture output, and update one eval dimension. |
| `scripts/preflight.sh [id]` | Check run state, memory presence, pre-task artifacts, and eval schema without mutating work. |
| `scripts/stop-gate.sh [id]` | Fail unless every required eval dimension is `pass`, `skipped`, or `sign-off-granted`. |
| `scripts/tasks-index.sh list [--json] [--status ...] [--eval ...]` | Print the compact `.harness/tasks.json` task index. |
| `scripts/tasks-index.sh rebuild` | Rebuild the task index from existing `runs/*/meta.json` and `specs/*.md`. |
| `scripts/retrospect.sh [--repo ...] [--since ...] [--out ...] [--query-file ...] [--semantic] [--llm-cmd ...] [--session-dir ...] [--pickbrain-dump]` | Generate repo retrospective reports from harness, git, Pickbrain, local sessions, optional transcript adapters, and optional semantic LLM synthesis. |

The repo-root `./harness` wrapper also provides `status --json` for
machine-readable active task state, `plan --init [task-id]` for creating a
non-overwriting `runs/<task-id>/plan.md` template, `plan --save [task-id]` for
persisting plan-mode output, `research --init|--save|--status|--gate
[task-id]` for reuse research artifacts, `session-export` for repo-local
session transcript export, and `preflight --json` / `stop-gate --json` for
machine-readable gate checks.

The root wrapper also provides `park [task-id]` and `activate <task-id>` for
pausing and restoring non-completed tasks. `./harness task` refuses to start a
new task while `.harness/current-task` already points at one; park or complete
the active task first. The lower-level `scripts/task.sh` remains unguarded for
direct kit use and tests.

For mid-flight idea capture, `./harness park "<idea>" --name <slug>` writes a
durable parking note to `specs/<slug>.md` without changing the active task.
`./harness park-idea` is the explicit, unambiguous form. Later,
`./harness promote <slug>` creates `runs/<slug>/`, copies the parked idea into
the run, and makes it the active task. If the first `park` argument names an
existing run, `park` keeps its task-parking behavior.

For parallel agent coordination, `./harness coordinate <intent> --file <path>`
appends an intent row for the active task, and `./harness coordination --tail
20` shows the recent shared log.

For research-before-build, start large implementation tasks with
`--estimate-loc <n>` or force the gate with `--research-required`:

```bash
./harness task import-cache --mode planned --estimate-loc 650 --description "Add cache import"
./harness plan --init
./harness research --init
```

The default research threshold is `500` estimated LOC. Repos can tune it in
`.harness/config.json` with `research_loc_threshold`. Required research is
complete only after `runs/<task-id>/research.md` records candidate libraries,
frameworks, open-source projects, tools, or implementation patterns; a
reuse/build decision; and at least two web source URLs. `preflight.sh` enforces
that artifact before the task can pass normal gates.

For tracker integration, `./harness tracker ...` reads `.harness/tracker.json`.
The default provider is `none`; the built-in `file` provider writes local
JSONL rows and artifact links without network calls.

For plan persistence, `./harness plan --save` reads plan text from stdin or
`--file` and writes `runs/<task-id>/plan.md`. `.harness/hooks/on-plan-exit.sh`
is the hook-facing entry point.

For loop-driven paired work, generate a file prompt inside the active run:

```bash
./harness loop-prompt 02-gap-classifier \
  --slice "Implement only Proposed Task 2: Backend gap classifier rewrite." \
  --test-command "pytest tests/test_gap_classifier.py tests/test_working_hours.py"
```

The command prints a ready-to-run `loop --prompt
runs/<task-id>/loop-slices/<slug>.md` invocation. Prefer this over inline
`loop --prompt "..."` text because inline prompt text can make loop create a
root `PLAN.md`; Harness keeps the canonical plan at `runs/<task-id>/plan.md`.
When a proof command starts with bare `pytest` and the repo has `venv/bin/python`
or `.venv/bin/python`, the prompt records the venv-backed
`python -m pytest` form. Prompts also include a cache/schema version review
check, with a specific `SESSION_DETAIL_VERSION` note when that symbol exists.

For reusable audits, `./harness audit security --path src` writes findings
artifacts, appends debt rows, and files tracker issues when a tracker provider
is configured.

The root wrapper also provides `retrospect`:

```bash
./harness retrospect --repo . --since "30 days ago"
```

By default it writes to `reports/retrospect/<YYYYMMDD-HHMMSS>/`.

## State Invariants

`task.sh` runs `scripts/pre-task.sh` before creating `runs/<id>/`. `done.sh`
runs `scripts/post-task.sh` after the stop gate passes and before
`specs/<id>.md` is generated. Both wrappers delegate to
`scripts/state-check.sh`.

The runner loads `.harness/config.json` when present and executes each
executable file in configured invariant directories. The default directory is
`state/invariants`. Config can use one shared directory list or stage-specific
lists:

```json
{
  "state_invariant_dirs": ["state/invariants"],
  "pre_state_invariant_dirs": ["state/invariants/pre"],
  "post_state_invariant_dirs": ["state/invariants/post"]
}
```

Stage-specific keys override `state_invariant_dirs` for that stage. Invariant
scripts receive `HARNESS_TASK_ID`, `HARNESS_STAGE`, and
`HARNESS_ARTIFACT_DIR`.

Invariant output is written under `runs/<id>/artifacts/pre-task/` after a
successful task start. If an invariant fails, task creation stops before the
run directory is created and the staged logs remain under
`.harness/pre-task-artifacts/<id>/`.

Post-task invariant output is written under `runs/<id>/artifacts/post-task/`.
If a post-task invariant fails, `done.sh` stops before retrospective spec
generation and leaves the task active for repair.

## Eval Dimensions

`eval-dim.sh` manages the Phase 2 `eval.json` shape:

```bash
./v2/kit/scripts/eval-dim.sh init demo-feature --required unit,live,human
./v2/kit/scripts/eval-dim.sh set demo-feature unit pass --artifact artifacts/unit.log
./v2/kit/scripts/eval-dim.sh set demo-feature live skipped --reason "no live rig"
./v2/kit/scripts/eval-dim.sh set demo-feature human sign-off-granted --method sign-off --signed-off-by amgad
./v2/kit/scripts/eval-dim.sh aggregate demo-feature
```

Required dimensions aggregate to `pass` when each required dimension is
`pass`, `skipped`, or `sign-off-granted`; any `fail` makes the task fail;
unresolved dimensions keep the task `pending`.

## Verification Wrapper

`verify.sh` is the script-level bridge between command output and eval
dimensions:

```bash
./v2/kit/scripts/verify.sh demo-feature unit -- ./v2/kit/tests/smoke.sh
```

It writes:

- `runs/demo-feature/artifacts/unit/verify.log`
- `runs/demo-feature/artifacts/unit/verify.json`
- `runs/demo-feature/artifacts/unit/attempt-001.log`
- `runs/demo-feature/artifacts/unit/attempt-001.json`

Then it updates `runs/demo-feature/eval.json` by setting the dimension to
`pass` when the command exits 0, or `fail` when the command exits nonzero. The
script exits with the wrapped command's status so callers can still fail fast.

Each run gets a numbered attempt artifact. `verify.log` and `verify.json` are
kept as compatibility files for the latest attempt, while `eval.json` records
the latest attempt number and attempt artifact paths.

## Hook-Facing Preflight

The first hook-facing scripts are still repo-local and tool-agnostic:

```bash
./v2/kit/scripts/preflight.sh demo-feature
./v2/kit/scripts/stop-gate.sh demo-feature
```

In this repo, `.harness/hooks/pre-task.sh`, `.harness/hooks/preflight.sh`,
`.harness/hooks/research-gate.sh`, `.harness/hooks/stop-gate.sh`,
`.harness/hooks/post-task.sh`, and `.harness/hooks/on-plan-exit.sh` are thin
wrappers around those kit scripts. They are intended as stable entry points for
future editor or agent hook wiring.

`preflight.sh` is read-only. It checks that the run directory, metadata,
memory, pre-task artifacts, and eval schema are coherent. For `mode:
planned`, it also requires a non-empty `runs/<task-id>/plan.md`. For tasks
with `research_required: true`, it also requires completed reuse research.

`stop-gate.sh` calls preflight and then fails unless every required dimension is
resolved. `pass`, `skipped`, and `sign-off-granted` are accepted; `pending` and
`fail` block completion.

## Task Index

`task.sh`, `verify.sh`, and `done.sh` maintain a compact coordination index at
`.harness/tasks.json`. It records task id, mode, lifecycle status, run/spec
paths, timestamps, and latest eval status without copying memory or task-log
contents.

```bash
./v2/kit/scripts/tasks-index.sh list
./v2/kit/scripts/tasks-index.sh list --json
./v2/kit/scripts/tasks-index.sh list --status active
./v2/kit/scripts/tasks-index.sh list --eval pass
./v2/kit/scripts/tasks-index.sh rebuild
```

## Retrospective Analysis

`retrospect.sh` builds an auditable repo-local report. The default path uses no
network calls and no LLM/API calls. It combines deterministic signals from:

- `.harness/tasks.json`
- `runs/*/meta.json`, `eval.json`, `task-log.md`, and `memory/*.md`
- `specs/*.md`
- recent git history and dirty status, when the target is a git repo
- local Pickbrain query results, when the `pickbrain` CLI is available
- obvious repo-local JSON/JSONL session files under `sessions/`, `.sessions/`,
  `logs/`, `.harness/sessions/`, or `reports/sessions/`

Outputs are:

- `metrics.json`
- `analysis.md`
- `roadmap.md`
- `backlog.json`
- `inputs/`, containing captured raw inputs and warnings
- `semantic-analysis.md`, when `--llm-cmd` is supplied and succeeds

Use `--query-file` to provide Pickbrain queries. Blank lines and `#` comments
are ignored. Set `HARNESS_RETROSPECT_PICKBRAIN_BIN` to point at a specific
Pickbrain executable; if Pickbrain is unavailable, the command still completes
and records reduced coverage in `metrics.json`.

Use `--semantic` when the retrospective needs content-level understanding of
session history, especially human messages:

```bash
./harness retrospect --semantic
./harness retrospect --semantic --llm-cmd "claude -p"
./harness retrospect --semantic --session-dir ~/.claude/projects --pickbrain-dump --llm-cmd "claude -p"
```

Semantic mode extracts human/user and assistant/agent messages from obvious
repo-local JSON/JSONL session files and writes:

- `inputs/content/human-messages.jsonl`
- `inputs/content/assistant-messages.jsonl`
- `inputs/content/session-corpus.txt`
- `inputs/content/llm-prompt.md`
- `inputs/content/summary.json`
- `inputs/content/llm-status.json`

`--llm-cmd` is explicit: the command is run locally with `llm-prompt.md` on
stdin, stdout is saved as `semantic-analysis.md`, and stderr/status are saved
under `inputs/content/`. `HARNESS_RETROSPECT_LLM_CMD` can provide the same
command from the environment. Use `--content-max-chars <n>` to bound prompt
size.

Use `--session-dir <path>` to add external transcript directories. The flag is
repeatable. `HARNESS_RETROSPECT_SESSION_DIRS` can provide a colon-separated
list of additional directories. External session files are filtered to the
target repo before they are copied or analyzed, using repo path fingerprints in
the file path or file content. The selected and skipped source counts are saved
in `inputs/sessions/sources.json`.

Use `session-export.sh` or the root wrapper to materialize matching transcript
messages into repo-local `sessions/*.jsonl` first:

```bash
./harness session-export --source ~/.codex/sessions --file sessions/latest-codex.jsonl
./harness session-export --source ~/.claude/projects --out sessions
```

The exporter keeps only files that match the target repo by path or content
unless `--no-filter` is supplied. It extracts user/human and assistant/agent
messages into a simple JSONL format that `retrospect --semantic` already
understands.

Use `--include-global-sessions` to opt into common global Claude/Codex session
stores such as `~/.claude/projects` and `~/.codex/sessions`. This is not on by
default because transcript stores can contain unrelated project history.

Use `--pickbrain-dump` to expand Pickbrain retrieval hits. The script parses
session id and turn metadata from `inputs/pickbrain/query-*.txt`, then runs:

```bash
pickbrain --dump <session-id> --turns <start>-<end>
```

Dumps are saved under `inputs/pickbrain/dumps/` and included in the semantic
prompt. `--pickbrain-dump-window <n>` controls the number of turns before and
after each hit; the default is `2`.

## Parallel Guards

Checkpoint creation and verification attempt creation use atomic lock
directories under `.harness/locks/`:

- `.harness/locks/checkpoint-<task-id>.lock`
- `.harness/locks/verify-<task-id>-<dimension>.lock`

If a lock exists, the command fails before allocating a sequence or attempt
number and prints the lock path. Remove the lock only after confirming it is
stale.

## Task Modes

Most modes start with a pending `unit` eval dimension. `--mode investigation`
is lighter: it creates `notes.md` and initializes `eval.json` with no required
dimensions, so preflight and stop-gate can pass without unit evidence for a
read-only investigation. On completion, investigation tasks use the
`## Findings` section from `notes.md` as the retrospective source and fail if
that section is empty.

## Research Before Build

Use this gate when a task is large enough that an agent should look for
existing libraries, frameworks, open-source projects, tools, or known
implementation patterns before coding. The gate is intentionally artifact-based
and shell-only: the harness does not make web requests itself, but it requires
agents to save what they found.

```bash
./harness task feature-x --mode planned --estimate-loc 500 --description "..."
./harness plan --init
./harness research --init
# Do web/open-source research with the tools available in the agent session.
./harness research --save --file /tmp/feature-x-research.md
./harness research --gate
./harness preflight
```

Use `--research-required` for smaller tasks that still need explicit reuse
research. Use `.harness/config.json` to adjust the automatic LOC threshold:

```json
{
  "research_loc_threshold": 300
}
```

The required `research.md` sections are `## Candidates Reviewed`, `## Reuse
Decision`, and `## Sources`. Template placeholders or fewer than two source
URLs fail the gate.

## Mid-Flight Idea Capture

Use idea capture when a new feature or follow-up appears during an active task
but should not interrupt the current run:

```bash
./harness park "palette jitters when switching directions" --name palette-jitter
```

The command writes `specs/palette-jitter.md` and appends
`.harness/parked-ideas.jsonl`. It does not change `.harness/current-task`.

When ready to work on the idea:

```bash
./harness promote palette-jitter --mode emergent
```

Promotion creates `runs/palette-jitter/`, copies the parked note to
`runs/palette-jitter/parked-idea.md`, records `promoted_from` in metadata, and
sets the promoted task as current.

## Mechanical Debt Detection

`task.sh` captures a lightweight LOC baseline at task start. `post-task.sh`
runs a non-blocking debt scan after state invariants. If a file grows by the
configured threshold, the scan appends one JSON line to `debt/register.jsonl`
and writes task-local artifacts under `runs/<task-id>/artifacts/debt/`.

Default LOC growth threshold is `100`. If `debt_scan_paths` is omitted, the
scanner prefers common source roots that exist in the repo, such as `src`,
`app`, `lib`, `scripts`, `packages`, `server`, `client`, `cmd`, `internal`,
and `v2/kit/scripts`. If none exist, it falls back to `.` while still applying
default excludes for generated, vendored, build, report, harness, and dependency
directories.

Repos can tune scanning in `.harness/config.json`:

```json
{
  "debt_loc_growth_threshold": 100,
  "debt_scan_paths": ["src", "scripts"],
  "debt_file_extensions": [".py", ".sh", ".ts"]
}
```

Debt rows are indicators only. They do not block `done`.

## Regression Harvest

`post-task.sh` also runs `regression-harvest.sh`. When the task log clearly
records a bug fix, the harvest writes a draft regression eval to
`evals/regression/<bug-id>.md` and task-local audit artifacts under
`runs/<task-id>/artifacts/regression-harvest/`.

The draft is intentionally not treated as a runnable test. It captures the
failure symptom, guard/test hints from `task-log.md`, and the eval artifacts
that were present at completion so a later task can turn the draft into an
executable regression check.

Task logs can opt into or out of harvest with structured markers:

```markdown
Regression: yes
Regression id: dwell-repeat
Regression symptom: Dwell blink repeated after one gaze event.
Regression guard: tests/test_blink.py::test_blink_once_per_dwell
```

Use `Regression: no` to suppress heuristic bug-fix wording in meta tasks or
documentation-only work.

## Agent Coordination

Task start and completion append rows to `agents/coordination.jsonl`. Agents can
also advertise current intent before risky or overlapping work:

```bash
./harness coordinate editing --file src/tts-common.sh
./harness coordination --tail 10
./harness coordination --json --file src/tts-common.sh
```

Rows are append-only JSON objects with `ts`, `agent`, `task`, `intent`, and
`file`. Set `HARNESS_AGENT_ID` to control the agent identifier; otherwise the
script uses the local user and process id. Coordination is informational, not a
hard edit lock.

## Tracker Plugin

Tracker integration is intentionally behind a small provider interface:

```bash
./harness tracker status
./harness tracker create --title "Security finding" --body "..." --artifact runs/task/artifacts/security.md --task task-id
./harness tracker comment LOCAL-1 --body "Added reproduction notes"
./harness tracker link --artifact runs/task/artifacts/live.log --url https://gitea.example.test/repo/issues/99
```

Default behavior is provider `none`, which skips create/comment operations. A
repo can enable local file-backed tracking with:

```json
{
  "provider": "file",
  "id_prefix": "LOCAL",
  "url_prefix": "https://gitea.example.test/repo/issues",
  "issues_path": ".harness/issues.jsonl",
  "comments_path": ".harness/comments.jsonl",
  "links_path": ".harness/links.jsonl"
}
```

The same harness code can therefore record artifact links to Gitea-style URLs
or do nothing when the tracker provider is `none`.

## Plan Persistence

Agents can persist plan-mode output on exit through the root wrapper, the kit
script, or the hook-facing entry point:

```bash
printf '%s\n' "## Objective" "" "Saved from plan mode." | ./harness plan --save
./harness plan --save --file /tmp/latest-plan.md
./.harness/hooks/on-plan-exit.sh --file /tmp/latest-plan.md
```

`plan-save.sh` accepts content from `--file`, `HARNESS_PLAN_TEXT`, or stdin and
writes `runs/<task-id>/plan.md`.

## Reusable Audits

The shell kit includes deterministic audit passes for `security`,
`accessibility`, and `performance`:

```bash
./harness audit security --path src
./harness audit accessibility --path public
./harness audit performance --path src
```

Audits write Markdown and JSON under `runs/<task-id>/artifacts/audits/` when a
task is active, otherwise under `reports/audits/`. Findings append
`audit_<kind>` rows to `debt/register.jsonl`. If `.harness/tracker.json`
enables a provider, each finding is also sent through `tracker.sh create`.

These audits are intentionally mechanical. They are reusable guardrails and
handoff artifacts, not substitutes for project-specific review.

## Current Limitations

- The kit now includes early R5/R4 script behavior plus hook-facing lifecycle
  wrappers, but no external hook config is installed.
- No editor or agent hook wiring.
- No worktree automation.
- Only one active task marker exists at `.harness/current-task`.

## Verification

Run:

```bash
./v2/kit/tests/all.sh
```

Or run individual tests:

```bash
./v2/kit/tests/smoke.sh
./v2/kit/tests/state-invariants.sh
./v2/kit/tests/eval-dimensions.sh
./v2/kit/tests/done-gate.sh
./v2/kit/tests/park-activate.sh
./v2/kit/tests/idea-capture.sh
./v2/kit/tests/debt-scan.sh
./v2/kit/tests/regression-harvest.sh
./v2/kit/tests/verify-wrapper.sh
./v2/kit/tests/hook-preflight.sh
./v2/kit/tests/hook-wrappers.sh
./v2/kit/tests/coordination-lite.sh
./v2/kit/tests/agent-coordination.sh
./v2/kit/tests/tracker-plugin.sh
./v2/kit/tests/audit-runner.sh
./v2/kit/tests/parallel-guards.sh
./v2/kit/tests/status-json.sh
./v2/kit/tests/gate-json.sh
./v2/kit/tests/plan-init.sh
./v2/kit/tests/plan-save.sh
./v2/kit/tests/research-gate.sh
./v2/kit/tests/session-export.sh
./v2/kit/tests/retrospect.sh
./v2/kit/tests/cli-help.sh
```

The smoke test runs in a temporary directory and verifies task creation,
checkpoint ordering, resume ordering, retrospective generation, JSON parsing,
and current-task cleanup.
