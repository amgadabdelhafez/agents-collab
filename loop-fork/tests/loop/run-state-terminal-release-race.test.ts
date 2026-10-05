import { expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

// readReservationManifest reads the manifest bytes twice: once for ownership
// evidence and once for the normalized manifest. Another process can rewrite
// the file between those reads, so this file interposes on readFileSync to
// land a resume exactly there. Everything else passes through unchanged.
const realFs = { ...(await import("node:fs")) };
const realReadFileSync = realFs.readFileSync;
let beforeRead: ((path: unknown) => void) | undefined;
mock.module("node:fs", () => ({
  ...realFs,
  default: { ...realFs, readFileSync: interposedReadFileSync },
  readFileSync: interposedReadFileSync,
}));
function interposedReadFileSync(
  ...args: Parameters<typeof realReadFileSync>
): ReturnType<typeof realReadFileSync> {
  beforeRead?.(args[0]);
  return realReadFileSync(...args);
}

const {
  createRunManifest,
  readRunManifest,
  reconcileLegacyStoppedRun,
  writeRunManifest,
} = await import("../../src/loop/run-state");

test("terminal release refuses a resume that lands between the evidence and manifest reads", async () => {
  for (const terminalState of ["stopped", "failed"] as const) {
    const dir = realFs.mkdtempSync(join(tmpdir(), "loop-run-state-race-"));
    const manifestPath = join(dir, "manifest.json");
    const terminal = createRunManifest(
      {
        cwd: "/synthetic/repo",
        launchAttemptPid: 999_998,
        mode: "paired",
        pid: 999_999,
        repoId: "synthetic-repo",
        runId: "22",
        state: terminalState,
        tmuxSession: "synthetic-loop-22",
        tmuxSocket: "/synthetic/tmux.sock",
        workspaceBinding: {
          branchRef: "refs/heads/synthetic",
          repoId: "synthetic-repo",
          root: "/synthetic/repo",
        },
      },
      "2026-08-29T18:00:00.000Z"
    );
    writeRunManifest(manifestPath, terminal);
    let manifestReads = 0;
    beforeRead = (path) => {
      if (path !== manifestPath) {
        return;
      }
      manifestReads += 1;
      if (manifestReads === 2) {
        writeRunManifest(manifestPath, {
          ...terminal,
          state: "working",
          status: "running",
        });
      }
    };
    try {
      const result = await reconcileLegacyStoppedRun(manifestPath, "22", {
        now: () => "2026-08-29T19:00:00.000Z",
        pidCanStillOwnRun: () => false,
        runtimeAbsent: async () => true,
        terminalState,
      });
      expect(manifestReads, terminalState).toBeGreaterThanOrEqual(2);
      expect(result, terminalState).toEqual({
        reason: "manifest-changed-concurrently",
        runId: "22",
        status: "refused",
      });
      const after = readRunManifest(manifestPath);
      expect(after?.state, terminalState).toBe("working");
      expect(after?.status, terminalState).toBe("running");
      expect(after?.workspaceReleasedAt, terminalState).toBeUndefined();
    } finally {
      beforeRead = undefined;
      realFs.rmSync(dir, { force: true, recursive: true });
    }
  }
});
