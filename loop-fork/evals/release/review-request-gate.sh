#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: review-request-gate.sh --required-tip <ref> [--candidate <ref>] --subject <text> --body-file <path>" >&2
  exit 2
}

required_tip=""
candidate="HEAD"
subject=""
body_file=""

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
    *) usage ;;
  esac
done

[[ -n "$required_tip" && -n "$subject" && -n "$body_file" ]] || usage
[[ -f "$body_file" ]] || {
  echo "review gate failed: body file is not a regular file: $body_file" >&2
  exit 1
}

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "review gate failed: not inside a Git worktree" >&2
  exit 1
}
required_sha="$(git -C "$repo_root" rev-parse --verify "$required_tip^{commit}" 2>/dev/null)" || {
  echo "review gate failed: required tip does not resolve: $required_tip" >&2
  exit 1
}
candidate_sha="$(git -C "$repo_root" rev-parse --verify "$candidate^{commit}" 2>/dev/null)" || {
  echo "review gate failed: candidate does not resolve: $candidate" >&2
  exit 1
}

if ! git -C "$repo_root" merge-base --is-ancestor "$required_sha" "$candidate_sha"; then
  echo "review gate failed: candidate $candidate_sha does not descend from required tip $required_sha" >&2
  exit 1
fi

symbols=(
  requestedShutdownDecision
  isExactNewWriteTarget
  PROXY_SHUTDOWN_CALLER_HEADER
)
counts=()
for symbol in "${symbols[@]}"; do
  count="$({
    git -C "$repo_root" grep -F -c "$symbol" "$candidate_sha" -- loop-fork/src 2>/dev/null || true
  } | awk -F: '{ total += $NF } END { print total + 0 }')"
  if ((count < 1)); then
    echo "review gate failed: required protection symbol absent: $symbol" >&2
    exit 1
  fi
  counts+=("$count")
done

body="$(<"$body_file")"
printf '%s\n\n' "$body"
printf '%s\n' "REVIEW_GATE_STAMP_V1"
printf 'subject=%s\n' "$subject"
printf 'candidate=%s\n' "$candidate_sha"
printf 'required_tip=%s\n' "$required_sha"
printf '%s\n' "lineage=PASS"
for index in "${!symbols[@]}"; do
  printf 'symbol.%s=%s\n' "${symbols[$index]}" "${counts[$index]}"
done
printf '%s\n' "status=PASS"
