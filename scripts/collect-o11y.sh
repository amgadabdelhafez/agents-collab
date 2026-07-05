#!/usr/bin/env bash
# scripts/collect-o11y.sh
# Collect logs, metrics, and traces from the current worktree's app instance.
# Outputs to runs/<task-id>/logs|metrics|traces/ directories.
# Usage: scripts/collect-o11y.sh [--task-id <id>] [--since 5m]
set -euo pipefail

TASK_ID="${TASK_ID:-unknown}"
SINCE="${SINCE:-5m}"
OUT_BASE="runs/${TASK_ID}"

while [[ $# -gt 0 ]]; do
  case $1 in
    --task-id) TASK_ID="$2"; OUT_BASE="runs/${TASK_ID}"; shift 2 ;;
    --since)   SINCE="$2"; shift 2 ;;
    --metric)  METRIC="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

mkdir -p "${OUT_BASE}/logs" "${OUT_BASE}/metrics" "${OUT_BASE}/traces"

echo "=== collect-o11y.sh: task=${TASK_ID} since=${SINCE} ==="

# --- LOGS ---
# Replace with your log source (file tailing, Loki LogQL, CloudWatch, etc.)
# Example: Loki
# if command -v logcli &>/dev/null; then
#   logcli query '{app="myapp"}' --since="${SINCE}" \
#     > "${OUT_BASE}/logs/app.log"
# fi
echo "[CONFIGURE: add log collection command]"

# --- METRICS ---
# Replace with your metrics source (Prometheus PromQL, Datadog, etc.)
# Example: Prometheus
# curl -s "http://localhost:9090/api/v1/query?query=http_requests_total" \
#   > "${OUT_BASE}/metrics/http_requests.json"
echo "[CONFIGURE: add metrics collection command]"

# --- TRACES ---
# Replace with your trace source (Tempo TraceQL, Jaeger, Datadog APM, etc.)
# Example: Tempo
# curl -s "http://localhost:3200/api/search?tags=service.name%3Dmyapp&limit=20" \
#   > "${OUT_BASE}/traces/recent.json"
echo "[CONFIGURE: add trace collection command]"

echo "Observability artifacts → ${OUT_BASE}/"
echo "=== collect-o11y.sh complete ==="
