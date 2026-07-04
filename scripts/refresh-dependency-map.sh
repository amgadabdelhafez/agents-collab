#!/usr/bin/env bash
# scripts/refresh-dependency-map.sh
# Refreshes docs/dependency-map.md after build-graph or interface changes.
# Run this whenever: a new service is added, a public interface changes,
# or a cross-service dependency is added or removed.
# Usage: scripts/refresh-dependency-map.sh
set -euo pipefail

MAP_FILE="docs/dependency-map.md"
TIMESTAMP=$(date -u +%Y-%m-%d)

echo "=== refresh-dependency-map.sh ==="

# --- Step 1: Parse import graphs (customise for your stack) ---
# Example: TypeScript
# npx ts-morph-graph --out /tmp/import-graph.json
# Example: Python
# pydeps . --output /tmp/import-graph.json
echo "[CONFIGURE: add import graph generation command]"

# --- Step 2: Parse OpenAPI specs for declared interfaces ---
# find . -name 'openapi.yaml' -o -name 'swagger.json' | while read spec; do
#   echo "Parsing: $spec"
# done
echo "[CONFIGURE: add OpenAPI parsing if applicable]"

# --- Step 3: Update the 'Last updated' header in the map ---
# Uses sed to replace the datestamp line
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' "s/Last updated: .*/Last updated: <!-- ${TIMESTAMP} by refresh-dependency-map.sh -->/" "${MAP_FILE}"
else
  sed -i "s/Last updated: .*/Last updated: <!-- ${TIMESTAMP} by refresh-dependency-map.sh -->/" "${MAP_FILE}"
fi

echo "Dependency map timestamp updated: ${TIMESTAMP}"

# --- Step 4: Optionally commit the updated map ---
# git add "${MAP_FILE}"
# git commit -m "chore: refresh dependency map [skip ci]
#
# Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"

echo "=== refresh-dependency-map.sh complete ==="
echo "Review ${MAP_FILE} and fill in any new services or changed interfaces."
