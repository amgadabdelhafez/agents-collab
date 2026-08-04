import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  promoteMemoryCheckpoint,
  redactMemoryText,
  writeMemoryCheckpoint,
} from "../../src/loop/memory-checkpoint";

const NOW = "2026-08-04T12:00:00.000Z";

const fixtureRun = (): { hookFile: string; runDir: string } => {
  const runDir = mkdtempSync(join(tmpdir(), "loop-memory-checkpoint-"));
  const hookFile = join(runDir, "hooks", "claude.jsonl");
  mkdirSync(join(runDir, "hooks"), { recursive: true });
  writeFileSync(hookFile, '{"event":"SessionStart"}\n', "utf8");
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      claudeSessionId: "claude-session",
      codexThreadId: "codex-thread",
      createdAt: NOW,
      cwd: process.cwd(),
      mode: "paired",
      pid: process.pid,
      repoId: "repo-fixture",
      runId: "42",
      state: "working",
      status: "running",
      updatedAt: NOW,
      workspaceBinding: {
        branchRef: "refs/heads/codex/harness-memory-checkpoints",
        repoId: "repo-fixture",
        root: process.cwd(),
      },
    })}\n`,
    "utf8"
  );
  return { hookFile, runDir };
};

describe("memory checkpoints", () => {
  test("writes one deterministic Claude pre-compaction checkpoint", () => {
    const { hookFile, runDir } = fixtureRun();
    const payload = {
      hook_event_name: "PreCompact",
      session_id: "claude-session",
      trigger: "auto",
    };
    const first = writeMemoryCheckpoint({
      agent: "claude",
      at: NOW,
      hookFile,
      payload,
    });
    const second = writeMemoryCheckpoint({
      agent: "claude",
      at: NOW,
      hookFile,
      payload,
    });

    expect(first?.trigger).toBe("pre-compact");
    expect(second?.checkpointId).toBe(first?.checkpointId);
    expect(first?.source).toMatchObject({ bytes: 25, rows: 1 });
    expect(
      readdirSync(join(runDir, "memory", "checkpoints", "claude"))
    ).toHaveLength(1);
    expect(existsSync(join(runDir, "memory", "latest-claude.json"))).toBe(true);
  });

  test("uses a redacted pre-turn fallback for Codex", () => {
    const { hookFile } = fixtureRun();
    const checkpoint = writeMemoryCheckpoint({
      agent: "codex",
      at: NOW,
      hookFile,
      payload: {
        hook_event_name: "UserPromptSubmit",
        prompt: "Inspect the retry path; token=super-secret-value",
        thread_id: "codex-thread",
        turn_id: "turn-7",
      },
    });

    expect(checkpoint).toMatchObject({
      agent: "codex",
      objective: "Inspect the retry path; token=[REDACTED]",
      trigger: "pre-turn",
    });
    expect(JSON.stringify(checkpoint)).not.toContain("super-secret-value");
  });

  test("does not checkpoint unrelated hook events", () => {
    const { hookFile } = fixtureRun();
    expect(
      writeMemoryCheckpoint({
        agent: "claude",
        at: NOW,
        hookFile,
        payload: { hook_event_name: "PostToolUse" },
      })
    ).toBeUndefined();
  });
});

describe("curated memory promotion", () => {
  test("promotes an allowlisted verified entry as Markdown plus provenance", () => {
    const { hookFile, runDir } = fixtureRun();
    const checkpoint = writeMemoryCheckpoint({
      agent: "claude",
      at: NOW,
      hookFile,
      payload: {
        compact_id: "compact-1",
        hook_event_name: "PreCompact",
        session_id: "claude-session",
      },
    });
    const checkpointPath = join(
      runDir,
      "memory",
      "checkpoints",
      "claude",
      `${checkpoint?.checkpointId}.json`
    );
    const outputDir = join(runDir, "memory", "promoted");
    const promotion = promoteMemoryCheckpoint({
      body: "Bridge notifications are hints; journal resolutions remain authoritative.",
      checkpointPath,
      class: "capability-boundary",
      curator: "codex",
      outputDir,
      title: "Bridge notification authority",
    });

    const markdown = readFileSync(promotion.markdownPath, "utf8");
    expect(markdown).toContain("class: capability-boundary");
    expect(markdown).toContain(`checkpointId: ${checkpoint?.checkpointId}`);
    expect(markdown).toContain("journal resolutions remain authoritative");
    expect(existsSync(join(outputDir, `${promotion.promotionId}.json`))).toBe(
      true
    );
  });

  test("fails closed for missing provenance and transient claims", () => {
    const { runDir } = fixtureRun();
    const invalidPath = join(runDir, "invalid.json");
    writeFileSync(invalidPath, '{"schemaVersion":1}\n', "utf8");
    expect(() =>
      promoteMemoryCheckpoint({
        body: "Stable rule.",
        checkpointPath: invalidPath,
        class: "stable-decision",
        curator: "codex",
        outputDir: join(runDir, "promoted"),
        title: "No provenance",
      })
    ).toThrow("valid, verified checkpoint");

    const valid = join(runDir, "valid.json");
    writeFileSync(
      valid,
      `${JSON.stringify({
        checkpointId: "checkpoint-1",
        commitSha: "a".repeat(40),
        repoId: "repo",
        schemaVersion: 1,
        source: { path: "/tmp/hooks.jsonl", sha256: "b".repeat(64) },
      })}\n`,
      "utf8"
    );
    expect(() =>
      promoteMemoryCheckpoint({
        body: "This is probably correct and pending review.",
        checkpointPath: valid,
        class: "stable-decision",
        curator: "codex",
        outputDir: join(runDir, "promoted"),
        title: "Transient claim",
      })
    ).toThrow("transient or unverified");
    expect(redactMemoryText("password=hunter2")).toBe("password=[REDACTED]");
  });
});
