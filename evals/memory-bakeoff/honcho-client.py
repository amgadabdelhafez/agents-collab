#!/usr/bin/env python3
"""Run the frozen Honcho half of the memory bakeoff inside its API container."""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


BASE = "http://127.0.0.1:8000"
WORKSPACE = "loop_memory_bakeoff_v4"
PEER = "curated_memory"
SESSION = "frozen_corpus_v1"


def request(method: str, path: str, body: dict | None = None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: honcho-client.py FIXTURE OUTPUT")
    fixture = json.loads(Path(sys.argv[1]).read_text())
    request("POST", "/v3/workspaces", {"id": WORKSPACE, "metadata": {"fixture": "v1"}})
    request("POST", f"/v3/workspaces/{WORKSPACE}/peers", {"id": PEER})
    request(
        "POST",
        f"/v3/workspaces/{WORKSPACE}/sessions",
        {"id": SESSION, "peers": {PEER: {"observe_me": True}}},
    )
    messages = [
        {
            "content": f"[{doc['id']}] {doc['title']}\n{doc['body']}",
            "peer_id": PEER,
            "metadata": {
                "doc_id": doc["id"],
                "source": doc["source"],
                "source_sha256": doc["sha256"],
            },
        }
        for doc in fixture["corpus"]
    ]
    request(
        "POST",
        f"/v3/workspaces/{WORKSPACE}/sessions/{SESSION}/messages",
        {"messages": messages},
    )

    # Fresh-message embedding is asynchronous. Do not time search until every
    # document is retrievable; fail closed after a bounded wait.
    deadline = time.monotonic() + 90
    ready = False
    while time.monotonic() < deadline:
        probe = request(
            "POST",
            f"/v3/workspaces/{WORKSPACE}/search",
            {"query": "bridge memory checkpoint worker", "limit": 100},
        )
        if len({row.get("metadata", {}).get("doc_id") for row in probe}) == len(messages):
            ready = True
            break
        time.sleep(1)
    if not ready:
        raise RuntimeError("Honcho embeddings did not become fully searchable within 90 seconds")

    results = []
    for query in fixture["queries"]:
        started = time.perf_counter()
        rows = request(
            "POST",
            f"/v3/workspaces/{WORKSPACE}/search",
            {"query": query["text"], "limit": 5},
        )
        elapsed_ms = (time.perf_counter() - started) * 1000
        results.append(
            {
                "query": query["id"],
                "expected": query["expected"],
                "latencyMs": elapsed_ms,
                "results": [
                    {
                        "docId": row.get("metadata", {}).get("doc_id"),
                        "source": row.get("metadata", {}).get("source"),
                        "sourceSha256": row.get("metadata", {}).get("source_sha256"),
                    }
                    for row in rows
                ],
            }
        )
    Path(sys.argv[2]).write_text(json.dumps({"ready": ready, "results": results}, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
