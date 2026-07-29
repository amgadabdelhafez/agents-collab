#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

bash "${REPO_ROOT}/evals/smoke/large-prompt-launch.sh"
bash "${REPO_ROOT}/evals/smoke/paste-submit-readiness.sh"

echo "constant-size transport smoke: launch-bootstrap=pass bridge-nudge=pass"
