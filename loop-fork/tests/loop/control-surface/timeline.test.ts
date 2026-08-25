import { expect, test } from "bun:test";
import {
  buildTimeline,
  createEvidenceRef,
} from "../../../src/loop/control-surface/timeline";

test("timeline is deterministic, bounded, redacted, and path-free", () => {
  const rows = buildTimeline(
    { repoId: "repo-a", runId: "7" },
    [
      {
        at: "2026-01-01T00:00:00.000Z",
        message: "token=secret https://host/x /Users/me/private",
        source: "bridge",
      },
      { at: "2026-01-01T00:00:00.000Z", message: "second", source: "hooks" },
      { at: "invalid", message: "ignored", source: "transcript" },
    ],
    { limit: 1 }
  );
  expect(rows.items).toHaveLength(1);
  expect(rows.items[0]?.source).toBe("hooks");
  expect(rows.nextCursor).toBe(1);
  expect(JSON.stringify(rows)).not.toContain("secret");
  expect(JSON.stringify(rows)).not.toContain("https://");
  expect(JSON.stringify(rows)).not.toContain("/Users/");
});

test("opaque evidence references are stable and disclose no locator", () => {
  const first = createEvidenceRef(
    { repoId: "repo-a", runId: "7" },
    "bridge",
    "line:4"
  );
  expect(first).toBe(
    createEvidenceRef({ repoId: "repo-a", runId: "7" }, "bridge", "line:4")
  );
  expect(first).toMatch(/^ev_[a-f0-9]{24}$/);
  expect(first).not.toContain("line");
  expect(first).not.toContain("repo-a");
});
