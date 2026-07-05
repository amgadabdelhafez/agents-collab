# Skill: ui-evaluator
> Invoke this skill to evaluate any task that touched UI.
> Reads verify.md, runs capture-ui.sh, checks screenshots and DOM, writes eval.json.

## When to use

Any task where files under `[ui-path]` were modified, or where verify.md has a "UI checks" section.

## Steps

1. Read `specs/<feature>/verify.md` — extract the UI checks table.
2. Confirm the app is running at `$APP_URL`. If not, boot it per `docs/testing/commands.md`.
3. Run `scripts/capture-ui.sh` for each route in the UI checks table.
4. For each check:
   - Verify the element/text is present in `dom.html`.
   - Verify the screenshot was created and is non-empty.
   - Check `errors.json` is empty (if generated).
5. Record pass/fail per check.
6. Write results into `runs/<task-id>/eval.json` under the `"ui"` key.
7. If any check fails: do NOT update verdict to "pass". Describe the failure in `notes`.

## Output contract

```json
{
  "ui": {
    "passed": <N>,
    "failed": <N>,
    "screenshots": ["runs/<task-id>/screenshots/<file>.png"],
    "details": [
      {"check": "U-01", "route": "/path", "assertion": "...", "result": "pass|fail", "note": ""}
    ]
  }
}
```

## Failure handling

If capture-ui.sh fails entirely (app not running, tool missing):
- Mark all UI checks as failed.
- Set notes: "UI capture unavailable: [reason]"
- Do NOT skip — a missing screenshot is a failed check, not a skipped one.
