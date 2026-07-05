#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "${SCRATCH}" "${EXTERNAL_ROOT:-}"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "PASS: $*"
}

assert_file() {
  [[ -f "$1" ]] || fail "missing file: $1"
}

assert_contains() {
  local file="$1"
  local needle="$2"
  if ! grep -Fq -- "$needle" "$file"; then
    echo "---- ${file} ----" >&2
    cat "$file" >&2
    fail "expected ${file} to contain: ${needle}"
  fi
}

assert_not_contains() {
  local file="$1"
  local needle="$2"
  if grep -Fq -- "$needle" "$file"; then
    echo "---- ${file} ----" >&2
    cat "$file" >&2
    fail "expected ${file} not to contain: ${needle}"
  fi
}

mkdir -p "${SCRATCH}/v2/kit"
ln -s "${REPO_DIR}/v2/kit/scripts" "${SCRATCH}/v2/kit/scripts"
ln -s "${REPO_DIR}/harness" "${SCRATCH}/harness"
cd "${SCRATCH}"

./v2/kit/scripts/task.sh alpha-feature --mode planned --description "Ship the alpha retrospective feature" > /dev/null
cat > runs/alpha-feature/plan.md <<'PLAN'
# alpha-feature Plan

Exercise retrospective collection.
PLAN

if ./v2/kit/scripts/verify.sh alpha-feature unit -- sh -c 'echo failing check; exit 2' > verify-fail.out 2> verify-fail.err; then
  fail "failing verification unexpectedly passed"
fi
./v2/kit/scripts/verify.sh alpha-feature unit -- sh -c 'echo passing check' > /dev/null

python3 - <<'PY'
from pathlib import Path

Path("runs/alpha-feature/task-log.md").write_text("""# Task alpha-feature

## What I changed

- Built a fixture feature for retrospective analysis.

## Why

- Retrospect needs historical harness artifacts to summarize.

## Notes
""", encoding="utf-8")

memory = Path("runs/alpha-feature/memory/001-initial.md")
memory.write_text(memory.read_text(encoding="utf-8").replace(
    "## Still open\n\n## Where we are",
    "## Still open\n\n- Convert repeated failures into roadmap tasks.\n\n## Where we are",
), encoding="utf-8")
PY

./v2/kit/scripts/done.sh alpha-feature > /dev/null

mkdir -p sessions bin
cat > sessions/session.jsonl <<'JSONL'
{"session_id":"s1","created_at":"2026-04-20T10:00:00Z","tool_name":"exec_command","message":"Ran python3 tests and fixed failure in v2/kit/scripts/retrospect.sh"}
{"session_id":"s1","created_at":"2026-04-20T10:30:00Z","message":"Error and blocked roadmap backlog signals should be counted."}
{"session_id":"s1","created_at":"2026-04-20T10:40:00Z","type":"user","message":{"role":"user","content":[{"type":"text","text":"I need deep understanding of human messages, persistent memory, and don't force spec-first workflows."}]}}
{"session_id":"s1","created_at":"2026-04-20T10:45:00Z","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"We should add an opt-in semantic analysis layer."}]}}
JSONL

cat > bin/pickbrain <<'SH'
#!/usr/bin/env bash
if [[ "${1:-}" == "--dump" ]]; then
  echo "Dumped context for session ${2:-missing} turns ${4:-missing}"
  echo '{"role":"user","content":"Pickbrain dump says the human repeatedly needs analysis across compactions and real session history."}'
  exit 0
fi
echo "Fake pickbrain result for $*"
echo "Session ID: pb-session-1"
echo "Turn number: 7"
echo "Worked on alpha feature; failures informed roadmap backlog."
SH
chmod +x bin/pickbrain

cat > bin/fake-llm <<'SH'
#!/usr/bin/env bash
prompt="$(cat)"
case "${prompt}" in
  *"don't force spec-first workflows"*) ;;
  *) echo "missing expected human evidence" >&2; exit 4 ;;
esac
cat <<'REPORT'
# Semantic Session Analysis

## Human Intent And Requests

- The human asked for deep understanding of actual chat content and human messages [human-001].

## Human Priorities And Preferences

- The human wants durable memory and deep analysis of human messages [human-001].

## Repeated Pain Or Friction

- Spec-first workflow should not be forced when work is emergent [human-001].

## Decisions And Follow-through

- The session decided to keep semantic retrospective analysis opt-in and evidence-backed.

## Agent Response Patterns

- The assistant responded by proposing an opt-in semantic analysis layer [assistant-001].

## Roadmap Implications

- Keep semantic retrospective analysis opt-in and evidence-backed.
REPORT
SH
chmod +x bin/fake-llm

EXTERNAL_ROOT="$(mktemp -d)"
EXTERNAL_SESSIONS="${EXTERNAL_ROOT}/external-sessions"
mkdir -p "${EXTERNAL_SESSIONS}"
cat > "${EXTERNAL_SESSIONS}/matching.jsonl" <<JSONL
{"cwd":"${SCRATCH}","role":"user","content":"External Claude transcript says compare historical sessions and preserve emergent workflow signals."}
{"cwd":"${SCRATCH}","role":"assistant","content":"External assistant response for matching repo."}
JSONL
cat > "${EXTERNAL_SESSIONS}/other.jsonl" <<'JSONL'
{"cwd":"/tmp/not-this-repo","role":"user","content":"SHOULD_NOT_APPEAR other repo content"}
JSONL

cat > queries.txt <<'QUERIES'
# comments are ignored
what worked
what failed
QUERIES

python3 - <<'PY'
import json
from pathlib import Path

fixtures = {
    "old-feature": {
        "created_at": "2026-04-20T10:00:00Z",
        "ended_at": "2026-04-20T10:05:00Z",
        "description": "OLD_SCOPE_TOKEN should not appear in since-filtered reports",
        "changed": "OLD_SCOPE_TOKEN old task summary leak",
        "open": "OLD_OPEN_TOKEN old open item leak",
    },
    "new-feature": {
        "created_at": "2026-04-20T10:30:00Z",
        "ended_at": "2026-04-20T10:40:00Z",
        "description": "NEW_SCOPE_TOKEN should appear in since-filtered reports",
        "changed": "NEW_SCOPE_TOKEN new task summary included",
        "open": "NEW_OPEN_TOKEN new open item included",
    },
}

for task_id, data in fixtures.items():
    run = Path("runs") / task_id
    (run / "memory").mkdir(parents=True, exist_ok=True)
    (run / "meta.json").write_text(json.dumps({
        "id": task_id,
        "mode": "planned",
        "created_at": data["created_at"],
        "status": "done",
        "description": data["description"],
        "ended_at": data["ended_at"],
    }, indent=2) + "\n", encoding="utf-8")
    (run / "eval.json").write_text(json.dumps({
        "task_id": task_id,
        "status": "pass",
        "required": ["unit"],
        "dimensions": {"unit": {"status": "pass"}},
    }, indent=2) + "\n", encoding="utf-8")
    (run / "task-log.md").write_text(f"""# Task {task_id}

## What I changed

- {data["changed"]}

## Why

- Exercise retrospective since filtering.

## Notes
""", encoding="utf-8")
    (run / "memory" / "001-initial.md").write_text(f"""---
seq: 001
date: {data["ended_at"]}
trigger: manual
topic: fixture
---

## Decided

## Still open

- {data["open"]}

## Where we are
""", encoding="utf-8")
    Path("specs").mkdir(exist_ok=True)
    (Path("specs") / f"{task_id}.md").write_text(f"""# {task_id}

Task completed {data["ended_at"]}, mode planned.

## What was built

- {data["changed"]}

## Decisions made

## Open items at completion

- {data["open"]}

## Trajectory

- 001 - fixture ({data["ended_at"]})
""", encoding="utf-8")
PY

PATH="${SCRATCH}/bin:${PATH}" ./harness retrospect --out reports/retrospect/test-run --query-file queries.txt > retrospect.out
assert_contains "retrospect.out" "${SCRATCH}/reports/retrospect/test-run"
assert_file "reports/retrospect/test-run/metrics.json"
assert_file "reports/retrospect/test-run/analysis.md"
assert_file "reports/retrospect/test-run/roadmap.md"
assert_file "reports/retrospect/test-run/backlog.json"
assert_file "reports/retrospect/test-run/inputs/pickbrain/query-001.txt"
assert_file "reports/retrospect/test-run/inputs/sessions/summary.json"

python3 - <<'PY'
import json
from pathlib import Path

base = Path("reports/retrospect/test-run")
metrics = json.loads((base / "metrics.json").read_text(encoding="utf-8"))
assert metrics["schema_version"] == 1
assert metrics["tasks"]["total"] >= 1
assert metrics["tasks"]["by_status"]["done"] >= 1
assert metrics["tasks"]["task_log_summaries"][0]["changed"]
assert metrics["evidence"]["attempts"] == 2
assert metrics["evidence"]["failed_attempts"] == 1
assert metrics["pickbrain"]["available"] is True
assert metrics["pickbrain"]["queries"] == 2
assert metrics["sessions"]["files"] == 1
assert metrics["sessions"]["records"] == 4
assert metrics["sessions"]["time_span"]["start"] == "2026-04-20T10:00:00Z"
assert metrics["sessions"]["time_span"]["end"] == "2026-04-20T10:45:00Z"
assert metrics["sessions"]["tool_mentions"] == 1
assert metrics["content"]["requested"] is False

backlog = json.loads((base / "backlog.json").read_text(encoding="utf-8"))
ids = {item["id"] for item in backlog["items"]}
assert "retro-regression-harvest" in ids
assert "retro-open-items" in ids
assert "retro-roadmap-review" in ids
PY
assert_contains "reports/retrospect/test-run/analysis.md" "## What was worked on"
assert_contains "reports/retrospect/test-run/analysis.md" "## Confidence/coverage notes"
assert_contains "reports/retrospect/test-run/roadmap.md" "## Near"
pass "retrospect writes deterministic reports with Pickbrain and session coverage"

PATH="${SCRATCH}/bin:${PATH}" ./harness retrospect --since "2026-04-20T10:20:00Z" --out reports/retrospect/since-run > since.out
assert_contains "since.out" "${SCRATCH}/reports/retrospect/since-run"
assert_contains "reports/retrospect/since-run/analysis.md" "NEW_SCOPE_TOKEN"
assert_contains "reports/retrospect/since-run/analysis.md" "NEW_OPEN_TOKEN"
assert_not_contains "reports/retrospect/since-run/analysis.md" "OLD_SCOPE_TOKEN"
assert_not_contains "reports/retrospect/since-run/analysis.md" "OLD_OPEN_TOKEN"
assert_not_contains "reports/retrospect/since-run/metrics.json" "OLD_SCOPE_TOKEN"
python3 - <<'PY'
import json
from pathlib import Path

base = Path("reports/retrospect/since-run")
metrics = json.loads((base / "metrics.json").read_text(encoding="utf-8"))
assert metrics["since"] == "2026-04-20T10:20:00Z"
assert metrics["since_cutoff"] == "2026-04-20T10:20:00Z"
descriptions = "\n".join(metrics["tasks"]["descriptions"])
assert "NEW_SCOPE_TOKEN" in descriptions
assert "OLD_SCOPE_TOKEN" not in descriptions
open_items = "\n".join(metrics["open_items"])
assert "NEW_OPEN_TOKEN" in open_items
assert "OLD_OPEN_TOKEN" not in open_items
PY
pass "retrospect --since filters harness task summaries and spec open items"

PATH="${SCRATCH}/bin:${PATH}" ./harness retrospect --semantic --session-dir "${EXTERNAL_SESSIONS}" --pickbrain-dump --llm-cmd "${SCRATCH}/bin/fake-llm" --out reports/retrospect/semantic-run > semantic.out
assert_file "reports/retrospect/semantic-run/semantic-analysis.md"
assert_file "reports/retrospect/semantic-run/inputs/content/human-messages.jsonl"
assert_file "reports/retrospect/semantic-run/inputs/content/assistant-messages.jsonl"
assert_file "reports/retrospect/semantic-run/inputs/content/session-corpus.txt"
assert_file "reports/retrospect/semantic-run/inputs/content/llm-prompt.md"
assert_file "reports/retrospect/semantic-run/inputs/sessions/sources.json"
assert_file "reports/retrospect/semantic-run/inputs/pickbrain/dumps/dump-001.txt"
assert_contains "reports/retrospect/semantic-run/inputs/content/llm-prompt.md" "don't force spec-first workflows"
assert_contains "reports/retrospect/semantic-run/inputs/content/llm-prompt.md" "External Claude transcript says compare historical sessions"
assert_contains "reports/retrospect/semantic-run/inputs/content/llm-prompt.md" "Pickbrain dump says the human repeatedly needs analysis"
assert_contains "reports/retrospect/semantic-run/inputs/content/llm-prompt.md" "## Agent Response Patterns"
assert_not_contains "reports/retrospect/semantic-run/inputs/content/llm-prompt.md" "SHOULD_NOT_APPEAR"
assert_contains "reports/retrospect/semantic-run/semantic-analysis.md" "Human Priorities And Preferences"
assert_contains "reports/retrospect/semantic-run/semantic-analysis.md" "Agent Response Patterns"
python3 - <<'PY'
import json
from pathlib import Path

base = Path("reports/retrospect/semantic-run")
metrics = json.loads((base / "metrics.json").read_text(encoding="utf-8"))
assert metrics["content"]["requested"] is True
assert metrics["content"]["human_messages"] == 2
assert metrics["content"]["assistant_messages"] == 2
assert metrics["content"]["pickbrain_dump_outputs"] == 1
assert metrics["llm"]["requested"] is True
assert metrics["llm"]["status"] == "pass"
assert metrics["coverage"]["semantic_content"] is True
assert metrics["coverage"]["semantic_llm"] is True
assert metrics["pickbrain"]["dump_outputs"] == 1
assert metrics["sessions"]["sources"]["by_kind"]["repo-local"] == 1
assert metrics["sessions"]["sources"]["by_kind"]["explicit"] == 1
sources = json.loads((base / "inputs/sessions/sources.json").read_text(encoding="utf-8"))
selected = [item["path"] for item in sources["selected_files"]]
assert any(path.endswith("matching.jsonl") for path in selected)
assert not any(path.endswith("other.jsonl") for path in selected)
analysis = (base / "analysis.md").read_text(encoding="utf-8")
assert "## Semantic content analysis" in analysis
assert "Semantic Session Analysis" in analysis
PY
pass "retrospect runs semantic synthesis with explicit transcripts and Pickbrain dumps"

PATH="${SCRATCH}/bin:${PATH}" ./harness retrospect --semantic --out reports/retrospect/semantic-no-llm > semantic-no-llm.out
assert_file "reports/retrospect/semantic-no-llm/inputs/content/llm-prompt.md"
python3 - <<'PY'
import json
from pathlib import Path

base = Path("reports/retrospect/semantic-no-llm")
metrics = json.loads((base / "metrics.json").read_text(encoding="utf-8"))
assert metrics["content"]["requested"] is True
assert metrics["content"]["human_messages"] == 1
assert metrics["llm"]["requested"] is False
assert metrics["llm"]["status"] == "not-requested"
assert metrics["coverage"]["semantic_content"] is True
assert metrics["coverage"]["semantic_llm"] is False
backlog = json.loads((base / "backlog.json").read_text(encoding="utf-8"))
ids = {item["id"] for item in backlog["items"]}
assert "retro-run-semantic-llm" in ids
PY
pass "retrospect semantic mode degrades clearly without an LLM command"

HARNESS_RETROSPECT_PICKBRAIN_BIN="${SCRATCH}/missing-pickbrain" ./harness retrospect --out reports/retrospect/no-pickbrain > no-pickbrain.out
python3 - <<'PY'
import json
from pathlib import Path

base = Path("reports/retrospect/no-pickbrain")
metrics = json.loads((base / "metrics.json").read_text(encoding="utf-8"))
assert metrics["pickbrain"]["available"] is False
assert any("pickbrain unavailable" in item for item in metrics["warnings"])
backlog = json.loads((base / "backlog.json").read_text(encoding="utf-8"))
ids = {item["id"] for item in backlog["items"]}
assert "retro-pickbrain-coverage" in ids
PY
assert_contains "reports/retrospect/no-pickbrain/inputs/warnings.txt" "pickbrain unavailable"
pass "retrospect degrades cleanly without Pickbrain"

echo "retrospect: all checks passed"
