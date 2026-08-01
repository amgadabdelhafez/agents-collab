#!/usr/bin/env python3
"""Enforce the named baseline-failure allowlist for a run's eval.json.

Convention: a task may record known-failing tests only as an allowlist of exact
test NAMES under `baseline_failures`. Counts ("4 known failures"),
`"baseline_failures": true`, the retired `pass_with_baseline_failures` result,
and tolerated-baseline vocabulary in any status/result/verdict value (e.g.
`baseline_failures_only`, `pass_with_known_limitations`) are not accepted.
The allowlist must be empty to release.

Fail closed: a missing or unreadable eval is a failing gate, and an eval that
records known failures in ANY vocabulary fails even when `baseline_failures`
is absent or empty. Absence of evidence is a failure, not a pass.

Usage: check-baseline-allowlist.py runs/<task-id>/eval.json
Exit codes: 0 clean · 1 gate failure · 2 usage error
"""

import json
import re
import sys

KEY = "baseline_failures"
RETIRED_RESULT = "pass_with_baseline_failures"
STATUS_KEYS = ("result", "status", "verdict")
# Any status/result/verdict VALUE speaking tolerated-baseline vocabulary:
# "baseline_failures_only", "pass_with_known_limitations",
# "pass_with_baseline_failures", "known_failure", ... Matched by pattern so a
# renamed cousin cannot slip through an enumerated blacklist.
TOLERATED_BASELINE_RE = re.compile(
    r"(?:baseline|known)[_\s-]*(?:failure|limitation)", re.IGNORECASE
)


def find_allowlists(node, path="$"):
    """Yield every (json-path, value) pair recorded under `baseline_failures`."""
    if isinstance(node, dict):
        for key, value in node.items():
            child = f"{path}.{key}"
            if key == KEY:
                yield child, value
            else:
                yield from find_allowlists(value, child)
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from find_allowlists(value, f"{path}[{index}]")


def find_status_values(node, path="$"):
    """Yield every (json-path, value) string under a result/status/verdict key."""
    if isinstance(node, dict):
        for key, value in node.items():
            child = f"{path}.{key}"
            if key in STATUS_KEYS and isinstance(value, str):
                yield child, value
            else:
                yield from find_status_values(value, child)
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from find_status_values(value, f"{path}[{index}]")


def main(argv):
    if len(argv) != 2:
        print(f"usage: {argv[0]} <eval.json>", file=sys.stderr)
        return 2

    path = argv[1]
    try:
        with open(path, encoding="utf-8") as handle:
            eval_doc = json.load(handle)
    except OSError as error:
        print(
            f"BASELINE GATE CANNOT PASS — cannot read {path} ({error}). "
            "The gate needs the task's eval.json; absence of evidence is a "
            "failure, not a pass.",
            file=sys.stderr,
        )
        return 1
    except json.JSONDecodeError as error:
        print(
            f"BASELINE GATE CANNOT PASS — {path} is not valid JSON: {error}",
            file=sys.stderr,
        )
        return 1

    errors = []

    for json_path, value in find_status_values(eval_doc):
        if value == RETIRED_RESULT:
            errors.append(
                f'{json_path} is "{RETIRED_RESULT}": retired — baseline '
                "failures no longer tolerate a pass. List the failing test "
                f'names in "{KEY}" and drive it to [].'
            )
        elif TOLERATED_BASELINE_RE.search(value):
            errors.append(
                f'{json_path} is "{value}": tolerated-baseline vocabulary is '
                f'rejected. Record each failing test name in "{KEY}" and '
                "drive it to []."
            )

    named = []
    for json_path, value in find_allowlists(eval_doc):
        if not isinstance(value, list):
            errors.append(
                f'{json_path} is {json.dumps(value)}: "{KEY}" must be a list '
                "of exact test names, not a count or a flag."
            )
            continue
        named.extend((json_path, str(name)) for name in value)

    for json_path, name in named:
        errors.append(f"{json_path}: baseline failure still allowlisted: {name}")

    if errors:
        print(f"BASELINE GATE FAILED — {path}", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1

    print(f"baseline allowlist empty: {path} (no tolerated-baseline vocabulary)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
