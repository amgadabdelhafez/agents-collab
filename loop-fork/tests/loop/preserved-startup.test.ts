import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunManifest } from "../../src/loop/run-state";
import { tmuxInternals } from "../../src/loop/tmux";

test("preserved startup admission refuses work, control history and ambiguous panes", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-preserved-startup-"));
  try {
    const manifest = {
      ...createRunManifest({
        cwd: "/test",
        mode: "paired",
        pid: 1,
        repoId: "test",
        runId: "1",
      }),
      state: "input-required" as const,
      tmuxPaneLeft: "%1",
      tmuxPaneRight: "%2",
    };
    const admits = tmuxInternals.preservedStartupEligible;
    expect(admits(manifest, root)).toBe(true);
    expect(admits({ ...manifest, state: "working" }, root)).toBe(false);
    expect(admits({ ...manifest, tmuxPaneRight: "%1" }, root)).toBe(false);
    expect(admits({ ...manifest, tmuxPaneLeft: "session:0.0" }, root)).toBe(
      false
    );
    expect(admits({ ...manifest, tmuxPaneLeft: undefined }, root)).toBe(false);
    writeFileSync(join(root, "transcript.jsonl"), "work already started\n");
    expect(admits(manifest, root)).toBe(false);
    writeFileSync(join(root, "transcript.jsonl"), "");
    writeFileSync(join(root, "governess-control.jsonl"), "");
    expect(admits(manifest, root)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
