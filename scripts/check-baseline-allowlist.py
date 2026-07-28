#!/usr/bin/env python3
"""Require an empty, named baseline-failure allowlist in an eval document."""

import json
import sys

ALLOWLIST_KEY = "baseline_failures"
PASS_VALUE = "pass"


def walk(node, path="$"):
    if isinstance(node, dict):
        for key, value in node.items():
            child = f"{path}.{key}"
            yield child, key, value
            yield from walk(value, child)
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from walk(value, f"{path}[{index}]")


def is_inactive_allowance(value):
    return value is None or value is False or value == 0 or value == "" or value == []


def is_baseline_failure_label(value):
    if not isinstance(value, str):
        return False
    normalized = value.lower().replace("-", "_")
    return "baseline" in normalized and "fail" in normalized


def main(argv):
    if len(argv) != 2:
        print(f"usage: {argv[0]} <eval.json>", file=sys.stderr)
        return 2

    with open(argv[1], encoding="utf-8") as handle:
        document = json.load(handle)

    errors = []
    allowlists = []
    outcome = document.get("verdict", document.get("result"))
    if outcome != PASS_VALUE:
        errors.append(
            f"$.verdict/result: expected {PASS_VALUE!r}, got {outcome!r}"
        )
    for path, key, value in walk(document):
        normalized_key = key.lower().replace("-", "_")
        if key in ("result", "status", "verdict") and is_baseline_failure_label(
            value
        ):
            errors.append(f"{path}: baseline-failure status is not allowed: {value!r}")
        if key == ALLOWLIST_KEY:
            allowlists.append((path, value))
        elif (
            "baseline" in normalized_key
            and "fail" in normalized_key
            and not is_inactive_allowance(value)
        ):
            errors.append(f"{path}: count or flag allowance is not allowed: {value!r}")

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
