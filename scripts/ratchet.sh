#!/usr/bin/env bash
# scripts/ratchet.sh
#
# Deterministic quality ratchet for the vendored loop-fork TypeScript project.
#
# The repo carries a large standing debt of biome (ultracite) and tsc
# diagnostics. Driving that to zero is a separate project; the job of this gate
# is narrower and mechanical:
#
#     the counts may go DOWN or stay flat. They may never go UP.
#
# The ceilings live in scripts/ratchet-baseline.json and are the only mutable
# state. Nothing here is a judgement call: run it, compare two integers, exit.
#
# Usage:
#   scripts/ratchet.sh                 # check against the baseline (default)
#   scripts/ratchet.sh --print         # measure and print, never fail on counts
#   scripts/ratchet.sh --snapshot      # rewrite the baseline from current counts
#
# Environment:
#   RATCHET_PROJECT_DIR       project to measure (default: <repo>/loop-fork)
#   RATCHET_BASELINE          baseline file (default: <repo>/scripts/ratchet-baseline.json)
#   RATCHET_ALLOW_RAISE=1     --snapshot may RAISE a ceiling (loud, deliberate)
#   RATCHET_SKIP_WITHOUT_DEPS=1
#                             exit 0 with a SKIPPED notice when node_modules is
#                             absent instead of failing. Off by default: a merge
#                             gate that silently no-ops is not a gate.
#
# Exit codes: 0 pass, 1 a ceiling was exceeded, 2 the gate could not run.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_DIR="${RATCHET_PROJECT_DIR:-${REPO_ROOT}/loop-fork}"
BASELINE_FILE="${RATCHET_BASELINE:-${REPO_ROOT}/scripts/ratchet-baseline.json}"

# Scope is pinned to the two directories tsconfig.json includes. This is not
# cosmetic: `biome check ./` walks .claude/worktrees/ and dies on the nested
# biome.jsonc of any live agent worktree ("Found a nested root configuration"),
# which would make the gate's verdict depend on whether a loop happens to be
# running. Pinning the scope makes the measurement reproducible.
SCOPE=(src tests)

MODE="check"
case "${1:-}" in
  ""|--check) MODE="check" ;;
  --print) MODE="print" ;;
  --snapshot) MODE="snapshot" ;;
  -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
  *) echo "ratchet: unknown argument: $1" >&2; exit 2 ;;
esac

die() { echo "ratchet: $*" >&2; exit 2; }

BIN="${PROJECT_DIR}/node_modules/.bin"
if [ ! -x "${BIN}/biome" ] || [ ! -x "${BIN}/tsc" ]; then
  if [ "${RATCHET_SKIP_WITHOUT_DEPS:-0}" = "1" ]; then
    echo "ratchet: SKIPPED — ${PROJECT_DIR}/node_modules is not installed"
    echo "ratchet: (RATCHET_SKIP_WITHOUT_DEPS=1 was set; the gate did NOT run)"
    exit 0
  fi
  die "missing tools in ${BIN}. Run 'bun install' in ${PROJECT_DIR}, or set RATCHET_SKIP_WITHOUT_DEPS=1 to bypass."
fi

# ---------------------------------------------------------------- measurement

measure_biome() {
  local out status
  set +e
  out="$(cd "${PROJECT_DIR}" && "${BIN}/biome" check --no-errors-on-unmatched \
        --reporter=summary "${SCOPE[@]}" 2>&1)"
  status=$?
  set -e

  # biome exits 1 both for "diagnostics found" and for "config blew up".
  # A run that never reported how many files it checked did not measure
  # anything, so refuse to turn it into a count.
  if ! printf '%s\n' "${out}" | grep -qE '^Checked [0-9]+ files'; then
    printf '%s\n' "${out}" >&2
    die "biome did not complete a scan (exit ${status}); refusing to guess a count"
  fi

  BIOME_FILES="$(printf '%s\n' "${out}" | sed -n 's/^Checked \([0-9]*\) files.*/\1/p' | tail -1)"
  BIOME_ERRORS="$(printf '%s\n' "${out}" | sed -n 's/^Found \([0-9]*\) error.*/\1/p' | tail -1)"
  BIOME_WARNINGS="$(printf '%s\n' "${out}" | sed -n 's/^Found \([0-9]*\) warning.*/\1/p' | tail -1)"
  : "${BIOME_ERRORS:=0}"
  : "${BIOME_WARNINGS:=0}"
}

measure_tsc() {
  local out status
  set +e
  out="$(cd "${PROJECT_DIR}" && "${BIN}/tsc" --noEmit --pretty false 2>&1)"
  status=$?
  set -e

  # tsc: 0 = clean, 2 = compiled with diagnostics. Anything else (config error,
  # crash, OOM) is not a measurement.
  if [ "${status}" -ne 0 ] && [ "${status}" -ne 2 ]; then
    printf '%s\n' "${out}" >&2
    die "tsc exited ${status}; refusing to guess a count"
  fi

  # One diagnostic per unindented line; continuation lines are indented.
  TSC_ERRORS="$(printf '%s\n' "${out}" | grep -cE '^[^[:space:]].*error TS' || true)"
  TSC_SRC="$(printf '%s\n' "${out}" | grep -E '^src/.*error TS' -c || true)"
  TSC_TESTS="$(printf '%s\n' "${out}" | grep -E '^tests/.*error TS' -c || true)"
  : "${TSC_ERRORS:=0}"
}

echo "=== ratchet: measuring ${PROJECT_DIR} (scope: ${SCOPE[*]}) ==="
measure_biome
measure_tsc

echo "  biome errors   : ${BIOME_ERRORS}"
echo "  biome warnings : ${BIOME_WARNINGS}"
echo "  tsc errors     : ${TSC_ERRORS}   (src ${TSC_SRC}, tests ${TSC_TESTS})"
echo "  files scanned  : ${BIOME_FILES} (biome)"

if [ "${MODE}" = "print" ]; then
  exit 0
fi

# ------------------------------------------------------------------- baseline

export RATCHET_BASELINE_FILE="${BASELINE_FILE}"
export RATCHET_MODE="${MODE}"
export RATCHET_BIOME_ERRORS="${BIOME_ERRORS}"
export RATCHET_BIOME_WARNINGS="${BIOME_WARNINGS}"
export RATCHET_TSC_ERRORS="${TSC_ERRORS}"
export RATCHET_TSC_SRC="${TSC_SRC}"
export RATCHET_TSC_TESTS="${TSC_TESTS}"
export RATCHET_PROJECT_REL="${PROJECT_DIR#"${REPO_ROOT}"/}"
export RATCHET_SCOPE="${SCOPE[*]}"

python3 - <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

path = os.environ["RATCHET_BASELINE_FILE"]
mode = os.environ["RATCHET_MODE"]

measured = {
    "biome_errors": int(os.environ["RATCHET_BIOME_ERRORS"]),
    "biome_warnings": int(os.environ["RATCHET_BIOME_WARNINGS"]),
    "tsc_errors": int(os.environ["RATCHET_TSC_ERRORS"]),
}

def write_baseline(ceilings):
    doc = {
        "_comment": (
            "Ceilings for scripts/ratchet.sh. Counts may fall or stay flat; "
            "they may never rise. Regenerate with scripts/ratchet.sh --snapshot "
            "(RATCHET_ALLOW_RAISE=1 is required to move a ceiling upward)."
        ),
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "generated_by": "scripts/ratchet.sh --snapshot",
        "project_dir": os.environ["RATCHET_PROJECT_REL"],
        "scope": os.environ["RATCHET_SCOPE"].split(),
        "commands": {
            "biome": "biome check --no-errors-on-unmatched --reporter=summary src tests",
            "tsc": "tsc --noEmit --pretty false",
        },
        "ceilings": ceilings,
        "observed_breakdown": {
            "tsc_errors_src": int(os.environ["RATCHET_TSC_SRC"]),
            "tsc_errors_tests": int(os.environ["RATCHET_TSC_TESTS"]),
        },
    }
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(doc, handle, indent=2)
        handle.write("\n")

if mode == "snapshot":
    old = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as handle:
            old = json.load(handle).get("ceilings", {})
    raised = [k for k, v in measured.items() if k in old and v > old[k]]
    if raised and os.environ.get("RATCHET_ALLOW_RAISE") != "1":
        print("RATCHET SNAPSHOT REFUSED — this would raise a ceiling:", file=sys.stderr)
        for key in raised:
            print(f"  - {key}: {old[key]} -> {measured[key]}", file=sys.stderr)
        print(
            "Fix the regression, or re-run with RATCHET_ALLOW_RAISE=1 if the "
            "rise is deliberate and reviewed.",
            file=sys.stderr,
        )
        sys.exit(1)
    write_baseline(measured)
    print(f"ratchet: baseline written to {path}")
    for key, value in sorted(measured.items()):
        arrow = f" (was {old[key]})" if key in old and old[key] != value else ""
        print(f"  {key}: {value}{arrow}")
    sys.exit(0)

# check mode
if not os.path.exists(path):
    print(f"ratchet: no baseline at {path}", file=sys.stderr)
    print("ratchet: run 'scripts/ratchet.sh --snapshot' to create one.", file=sys.stderr)
    sys.exit(2)

with open(path, encoding="utf-8") as handle:
    ceilings = json.load(handle)["ceilings"]

failures, improvements = [], []
for key, value in sorted(measured.items()):
    ceiling = ceilings.get(key)
    if ceiling is None:
        print(f"ratchet: baseline has no ceiling for {key}", file=sys.stderr)
        sys.exit(2)
    if value > ceiling:
        failures.append(f"{key}: {value} > ceiling {ceiling} (+{value - ceiling})")
    elif value < ceiling:
        improvements.append(f"{key}: {value} < ceiling {ceiling} (-{ceiling - value})")

if improvements:
    print("--- ratchet: improvements available (tighten with --snapshot) ---")
    for line in improvements:
        print(f"  {line}")

if failures:
    print("RATCHET FAILED — diagnostics increased vs baseline", file=sys.stderr)
    for line in failures:
        print(f"  - {line}", file=sys.stderr)
    print(f"baseline: {path}", file=sys.stderr)
    sys.exit(1)

print("ratchet: PASS — no diagnostic count increased")
PY
