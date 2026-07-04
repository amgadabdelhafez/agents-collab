#!/usr/bin/env bash
# scripts/capture-ui.sh
# Capture screenshots and DOM snapshots for the running app instance.
# Requires the app to be running and APP_URL to be set, or uses default.
# Usage: scripts/capture-ui.sh [--route /path] [--out dir]
set -euo pipefail

ROUTE="${ROUTE:-/}"
OUT_DIR="${OUT_DIR:-runs/latest/screenshots}"
APP_URL="${APP_URL:-http://localhost:3000}"

while [[ $# -gt 0 ]]; do
  case $1 in
    --route) ROUTE="$2"; shift 2 ;;
    --out)   OUT_DIR="$2"; shift 2 ;;
    --url)   APP_URL="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

mkdir -p "${OUT_DIR}"
TARGET="${APP_URL}${ROUTE}"

echo "=== capture-ui.sh: ${TARGET} → ${OUT_DIR} ==="

# Option 1: Playwright (preferred)
if command -v npx &>/dev/null && npx playwright --version &>/dev/null 2>&1; then
  npx playwright screenshot \
    --browser chromium \
    "${TARGET}" \
    "${OUT_DIR}/$(echo "${ROUTE}" | tr '/' '_' | tr -d '^_').png"
  echo "Screenshot saved via Playwright."

# Option 2: Chrome headless (fallback)
elif command -v google-chrome &>/dev/null || command -v chromium-browser &>/dev/null; then
  CHROME=$(command -v google-chrome || command -v chromium-browser)
  "${CHROME}" --headless --disable-gpu \
    --screenshot="${OUT_DIR}/screenshot.png" \
    --window-size=1280,800 \
    "${TARGET}"
  echo "Screenshot saved via Chrome headless."

else
  echo "ERROR: No screenshot tool found. Install Playwright: npm install -g playwright"
  exit 1
fi

# DOM snapshot via curl (lightweight fallback for structure checks)
curl -s "${TARGET}" > "${OUT_DIR}/dom.html" && \
  echo "DOM snapshot saved to ${OUT_DIR}/dom.html" || \
  echo "WARNING: DOM snapshot failed (non-fatal)"

echo "=== capture-ui.sh complete ==="
