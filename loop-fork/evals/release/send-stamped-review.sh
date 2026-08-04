#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: send-stamped-review.sh --required-tip <ref> [--candidate <ref>] --subject <text> --body-file <path> [--source <name>] [--target <name>] [--priority <level>]" >&2
  exit 2
}

required_tip=""
candidate="HEAD"
subject=""
body_file=""
source_name="codex"
target_name="claude"
priority="high"

while (($# > 0)); do
  case "$1" in
    --required-tip)
      (($# >= 2)) || usage
      required_tip="$2"
      shift 2
      ;;
    --candidate)
      (($# >= 2)) || usage
      candidate="$2"
      shift 2
      ;;
    --subject)
      (($# >= 2)) || usage
      subject="$2"
      shift 2
      ;;
    --body-file)
      (($# >= 2)) || usage
      body_file="$2"
      shift 2
      ;;
    --source)
      (($# >= 2)) || usage
      source_name="$2"
      shift 2
      ;;
    --target)
      (($# >= 2)) || usage
      target_name="$2"
      shift 2
      ;;
    --priority)
      (($# >= 2)) || usage
      priority="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

[[ -n "$required_tip" && -n "$subject" && -n "$body_file" ]] || usage

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
gate="$script_dir/review-request-gate.sh"
xchan="${LOOP_XCHAN_BIN:-$HOME/.loop/bin/xchan}"
[[ -x "$gate" ]] || {
  echo "stamped review sender failed: gate is not executable: $gate" >&2
  exit 1
}
[[ -x "$xchan" ]] || {
  echo "stamped review sender failed: channel sender is not executable: $xchan" >&2
  exit 1
}

stamp_file="$(mktemp "${TMPDIR:-/tmp}/loop-review-stamp.XXXXXX")"
trap 'rm -f "$stamp_file"' EXIT

"$gate" \
  --required-tip "$required_tip" \
  --candidate "$candidate" \
  --subject "$subject" \
  --body-file "$body_file" >"$stamp_file"

grep -Fxq "REVIEW_GATE_STAMP_V1" "$stamp_file" || {
  echo "stamped review sender failed: gate output has no provenance stamp" >&2
  exit 1
}
grep -Fxq "status=PASS" "$stamp_file" || {
  echo "stamped review sender failed: gate output has no PASS status" >&2
  exit 1
}

stamped_body="$(<"$stamp_file")"
"$xchan" send "$source_name" "$target_name" "$subject" "$stamped_body" "$priority"
