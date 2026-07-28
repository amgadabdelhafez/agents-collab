#!/usr/bin/env python3
"""Require an empty, named baseline-failure allowlist in an eval document."""

import json
import sys

ALLOWLIST_KEY = "baseline_failures"
RETIRED_VERDICT = "pass_with_baseline_failures"


def walk(node, path="$"):
    if isinstance(node, dict):
        for key, value in node.items():
            child = f"{path}.{key}"
            yield child, key, value
            yield from walk(value, child)
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from walk(value, f"{path}[{index}]")


def main(argv):
    if len(argv) != 2:
        print(f"usage: {argv[0]} <eval.json>", file=sys.stderr)
        return 2

    with open(argv[1], encoding="utf-8") as handle:
        document = json.load(handle)

    errors = []
    allowlists = []
    for path, key, value in walk(document):
        if key in ("result", "verdict") and value == RETIRED_VERDICT:
            errors.append(f"{path}: retired verdict {RETIRED_VERDICT!r}")
        if key == ALLOWLIST_KEY:
            allowlists.append((path, value))

    if not allowlists:
        errors.append(f"missing required {ALLOWLIST_KEY!r} list")
    for path, value in allowlists:
        if not isinstance(value, list):
            errors.append(f"{path}: must be a list of exact test names")
        elif value:
            errors.append(f"{path}: baseline failures remain: {value!r}")

    if errors:
        print(f"baseline gate failed: {argv[1]}", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1

    print(f"baseline allowlist empty: {argv[1]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
