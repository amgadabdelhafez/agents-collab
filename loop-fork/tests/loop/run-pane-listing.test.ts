// The production pane listing the teardown records agent panes from
// (`defaultListRunPanes`), against a real tmux server.
//
// The server is private: it runs on an absolute socket in a fresh temporary
// directory (never the ambient server, never `$TMUX`), started with no config
// file, and is killed at the end of the test.

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, which } from "bun";
import {
  panesOfSession,
  runProcessCleanupInternals,
} from "../../src/loop/run-process-cleanup";
import { createRunManifest } from "../../src/loop/run-state";

test("pane listing keeps exactly the named session's panes, never a session whose name extends it", () => {
  const stdout = [
    "%1 501 loop-91",
    "%2 502 loop-91",
    "%3 503 loop-91 x",
    "%4 504 loop-9",
    "%5 505 xloop-91",
    "%6 notapid loop-91",
    "",
  ].join("\n");
  expect(panesOfSession(stdout, "loop-91")).toEqual([
    { paneId: "%1", pid: 501 },
    { paneId: "%2", pid: 502 },
  ]);
  expect(panesOfSession(stdout, "loop-91 x")).toEqual([
    { paneId: "%3", pid: 503 },
  ]);
  expect(panesOfSession(stdout, "loop-9")).toEqual([
    { paneId: "%4", pid: 504 },
  ]);
});

const tmuxBinary = which("tmux");

test.skipIf(!tmuxBinary)(
  "real: the teardown's pane listing reads the run's own session on its recorded socket",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-"));
    const socket = join(dir, "s");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !["TMUX", "TMUX_PANE", "TMUX_TMPDIR"].includes(name)
      )
    );
    const tmux = (args: string[]) => {
      const result = spawnSync([tmuxBinary as string, "-S", socket, ...args], {
        env,
        stderr: "pipe",
        stdout: "pipe",
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `tmux ${args.join(" ")}: ${new TextDecoder().decode(result.stderr)}`
        );
      }
      return new TextDecoder().decode(result.stdout);
    };
    try {
      tmux([
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        "loop-91",
        "-x",
        "80",
        "-y",
        "24",
        "sleep 120",
      ]);
      tmux(["split-window", "-t", "=loop-91:", "sleep 120"]);
      // Sessions whose names share a prefix with the run's.
      tmux(["new-session", "-d", "-s", "loop-91 x", "sleep 120"]);
      tmux(["new-session", "-d", "-s", "loop-9", "sleep 120"]);
      const runDir = join(dir, "run");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, "manifest.json"),
        `${JSON.stringify({
          ...createRunManifest({
            cwd: dir,
            mode: "paired",
            pid: 4_000_001,
            repoId: "repo-listing",
            runId: "91",
          }),
          tmuxSession: "loop-91",
          tmuxSocket: socket,
        })}\n`
      );
      const expected = tmux([
        "list-panes",
        "-s",
        "-t",
        "=loop-91",
        "-F",
        "#{pane_id} #{pane_pid}",
      ])
        .trim()
        .split("\n")
        .map((line) => {
          const [paneId, pid] = line.split(" ");
          return { paneId, pid: Number(pid) };
        });
      expect(expected).toHaveLength(2);
      expect(runProcessCleanupInternals.listRunPanes(runDir)).toEqual(expected);
      // A session the server does not hold cannot be listed: nothing of
      // another session is ever taken for the run's.
      writeFileSync(
        join(runDir, "manifest.json"),
        `${JSON.stringify({
          ...createRunManifest({
            cwd: dir,
            mode: "paired",
            pid: 4_000_001,
            repoId: "repo-listing",
            runId: "91",
          }),
          tmuxSession: "other-run",
          tmuxSocket: socket,
        })}\n`
      );
      expect(runProcessCleanupInternals.listRunPanes(runDir)).toBeUndefined();
    } finally {
      try {
        tmux(["kill-server"]);
      } catch {
        // Already gone.
      }
      rmSync(dir, { force: true, recursive: true });
    }
  }
);
