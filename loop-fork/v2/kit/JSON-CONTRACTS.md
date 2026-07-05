# JSON Output Contracts

These contracts describe the repo-root `./harness` JSON outputs. They are
intended for local scripts and hooks that should not parse human-readable
tables or status text.

The shapes are versioned by command behavior, not by a separate schema file.
Fields may be added in later phases; existing fields should remain stable.

## `./harness status --json`

Returns the active task marker and key active-run paths.

```json
{
  "active_task": "example-task",
  "run_dir": "runs/example-task",
  "meta": {
    "id": "example-task",
    "mode": "planned",
    "created_at": "2026-04-21T00:00:00Z",
    "status": "active"
  },
  "plan": "runs/example-task/plan.md",
  "latest_memory": "runs/example-task/memory/001-initial.md",
  "eval_status": "pending"
}
```

`plan`, `latest_memory`, and `eval_status` may be `null` when the files are not
present.

When no active task marker exists, `./harness status --json` exits 0 and emits
an idle shape:

```json
{
  "active_task": null,
  "run_dir": null,
  "meta": null,
  "plan": null,
  "latest_memory": null,
  "eval_status": null
}
```

## `./harness list --json`

Returns the compact task index from `.harness/tasks.json`. Filters apply before
output:

```bash
./harness list --json --status active
./harness list --json --eval pass
```

```json
{
  "version": 1,
  "tasks": [
    {
      "id": "example-task",
      "mode": "planned",
      "status": "active",
      "created_at": "2026-04-21T00:00:00Z",
      "run_dir": "runs/example-task",
      "eval_status": "pending"
    }
  ]
}
```

Done tasks may include `ended_at` and `spec_path`.

Known task lifecycle statuses are `active`, `parked`, and `done`.

## `./harness preflight --json`

Returns a read-only preflight result.

Passing:

```json
{
  "task_id": "example-task",
  "status": "pass",
  "run_dir": "runs/example-task",
  "eval_status": "pending",
  "required": ["unit"]
}
```

Failing:

```json
{
  "task_id": "example-task",
  "status": "fail",
  "error": "missing eval file: runs/example-task/eval.json"
}
```

The command exits nonzero on failure.

## `./harness stop-gate --json`

Returns whether required dimensions allow completion.

Passing:

```json
{
  "task_id": "example-task",
  "status": "pass",
  "required": ["unit"]
}
```

Blocked:

```json
{
  "task_id": "example-task",
  "status": "blocked",
  "blocked": [
    {
      "dimension": "unit",
      "status": "pending"
    }
  ]
}
```

Blocked output exits nonzero. Accepted required-dimension statuses are `pass`,
`skipped`, and `sign-off-granted`.
