#!/usr/bin/env python3
"""Enforce the named baseline-failure allowlist for a run's eval.json.

Convention: a task may record known-failing tests only as an allowlist of exact
test NAMES under `baseline_failures`. Counts ("4 known failures"),
`"baseline_failures": true`, and the retired `pass_with_baseline_failures`
result are not accepted. The allowlist must be empty to release.

Usage: check-baseline-allowlist.py runs/<task-id>/eval.json
"""

import json
import sys

RETIRED_RESULT = "pass_with_baseline_failures"
KEY = "baseline_failures"


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


def find_results(node):
    """Yield every `result`/`verdict` string in the document."""
    if isinstance(node, dict):
        for key, value in node.items():
            if key in ("result", "verdict") and isinstance(value, str):
                yield value
            else:
                yield from find_results(value)
    elif isinstance(node, list):
        for value in node:
            yield from find_results(value)


def main(argv):
    if len(argv) != 2:
        print(f"usage: {argv[0]} <eval.json>", file=sys.stderr)
        return 2

    path = argv[1]
    with open(path, encoding="utf-8") as handle:
        eval_doc = json.load(handle)

    errors = []

    if RETIRED_RESULT in set(find_results(eval_doc)):
        errors.append(
            f'"{RETIRED_RESULT}" is retired: baseline failures no longer '
            "tolerate a pass. List the failing test names in "
            f'"{KEY}" and drive it to [].'
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
        print(f"BASELINE ALLOWLIST NOT EMPTY — {path}", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1

    print(f"baseline allowlist empty: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
