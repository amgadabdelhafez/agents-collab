import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "bun";

const checker = resolve(
  import.meta.dir,
  "../../scripts/check-tmux-migration.ts"
);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const runSeed = (
  relativePath: string,
  source: string
): { exitCode: number; stderr: string } => {
  const root = mkdtempSync(resolve(tmpdir(), "loop-tmux-check-"));
  roots.push(root);
  const path = resolve(root, "src", relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  const result = spawnSync(["bun", checker, "--root", root], {
    stderr: "pipe",
    stdout: "pipe",
  });
  return { exitCode: result.exitCode, stderr: result.stderr.toString() };
};

test("seeded Bun-array invocation fails independently", () => {
  const result = runSeed(
    "bad.ts",
    'import { spawnSync } from "bun";\nspawnSync(["tmux", "list-sessions"]);\n'
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("DIRECT_TMUX_INVOCATION");
});

test("a seeded Bun-array invocation with a spread fails independently", () => {
  const result = runSeed(
    "bad.ts",
    'import { spawnSync } from "bun";\nconst args = ["list-sessions"];\nspawnSync(["tmux", ...args]);\n'
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("DIRECT_TMUX_INVOCATION");
});

test("seeded Node command and args invocation fails independently", () => {
  const result = runSeed(
    "bad.ts",
    'import { spawn } from "node:child_process";\nspawn("tmux", ["has-session"]);\n'
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("DIRECT_TMUX_INVOCATION");
});

test("the exact install probe is allowed", () => {
  const result = runSeed(
    "install.ts",
    'import { spawnSync } from "node:child_process";\nspawnSync("tmux", ["-V"]);\n'
  );
  expect(result.exitCode).toBe(0);
});

test("a second install invocation fails independently", () => {
  const result = runSeed(
    "install.ts",
    'import { spawnSync } from "node:child_process";\nspawnSync("tmux", ["-V"]);\nspawnSync("tmux", ["-V"]);\n'
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("DIRECT_TMUX_INVOCATION");
});

test("a file-local indirect tmux alias fails independently", () => {
  const result = runSeed(
    "bad.ts",
    'import { spawnSync as execute } from "bun";\nconst binary = "tmux";\nconst argv = [binary, "list-sessions"] as const;\nexecute(argv);\n'
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("DIRECT_TMUX_INVOCATION");
});

test("a function-local indirect tmux alias fails independently", () => {
  const result = runSeed(
    "bad.ts",
    'import { spawnSync } from "bun";\nexport const run = () => { const binary = "tmux"; const argv = [binary, "list-sessions"] as const; spawnSync(argv); };\n'
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("DIRECT_TMUX_INVOCATION");
});

test("a later same-named declaration cannot hide a lexical tmux alias", () => {
  const result = runSeed(
    "bad.ts",
    'import { spawnSync } from "bun";\nexport const run = () => { const argv = ["tmux", "list-sessions"] as const; spawnSync(argv); };\nconst argv = ["git", "status"] as const;\nvoid argv;\n'
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("DIRECT_TMUX_INVOCATION");
});

test("a spread-head tmux alias fails independently", () => {
  const result = runSeed(
    "bad.ts",
    'import { spawnSync } from "bun";\nconst prefix = ["tmux"] as const;\nspawnSync([...prefix, "list-sessions"]);\n'
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("DIRECT_TMUX_INVOCATION");
});

test("a namespace-imported Node runner fails independently", () => {
  const result = runSeed(
    "bad.ts",
    'import * as childProcess from "node:child_process";\nchildProcess.spawn("tmux", ["list-sessions"]);\n'
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("DIRECT_TMUX_INVOCATION");
});

test("a private tmuxArgv import fails independently", () => {
  const result = runSeed(
    "bad.ts",
    'import { tmuxArgv } from "./loop/tmux-socket";\nvoid tmuxArgv;\n'
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("PRIVATE_COMPOSER_IMPORT");
});

test("a private tmuxArgv barrel re-export fails independently", () => {
  const result = runSeed(
    "bad.ts",
    'export { tmuxArgv } from "./loop/tmux-socket";\n'
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("PRIVATE_COMPOSER_IMPORT");
});

test("a tmux authority namespace import fails independently", () => {
  const result = runSeed(
    "loop/bad.ts",
    'import * as authority from "./tmux-socket";\nvoid authority.createManifestHandle;\n'
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("ILLEGAL_AUTHORITY_IMPORT");
});

test("a tmux authority export-star barrel fails independently", () => {
  const result = runSeed("loop/bad.ts", 'export * from "./tmux-socket";\n');
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("ILLEGAL_AUTHORITY_IMPORT");
});

test("a tmux authority namespace-export barrel fails independently", () => {
  const result = runSeed(
    "loop/bad.ts",
    'export * as authority from "./tmux-socket";\n'
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("ILLEGAL_AUTHORITY_IMPORT");
});

test("a second manifest-handle producer import fails independently", () => {
  const result = runSeed(
    "loop/bad.ts",
    'import { createManifestHandle } from "./tmux-socket";\nvoid createManifestHandle;\n'
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("ILLEGAL_AUTHORITY_IMPORT");
});

test("a launch-only composer import from a consumer fails independently", () => {
  const result = runSeed(
    "loop/bad.ts",
    'import { pairedLaunchArgv } from "./tmux-socket";\nvoid pairedLaunchArgv;\n'
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("ILLEGAL_AUTHORITY_IMPORT");
});

test("a direct caller-supplied target flag fails independently", () => {
  const result = runSeed(
    "bad.ts",
    'import { spawnSync } from "bun";\nspawnSync(["tmux", "has-session", "-t", "wrong"]);\n'
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("TARGET_FLAG_LITERAL");
});

test("an exported pane effect accepting a bare string fails independently", () => {
  const result = runSeed(
    "bad.ts",
    "export const respawnPane = (paneId: string): void => { void paneId; };\n"
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("PANE_AUTHORITY_WIDENING");
});

test("an exported paste pane effect accepting a bare string fails independently", () => {
  const result = runSeed(
    "bad.ts",
    "export const pastePane = (paneId: string): void => { void paneId; };\n"
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("PANE_AUTHORITY_WIDENING");
});

test("an exported pane callback API accepting a bare string fails independently", () => {
  const result = runSeed(
    "bad.ts",
    "export interface Deps { respawnPane: (paneId: string) => void; }\n"
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("PANE_AUTHORITY_WIDENING");
});

test("a marked pane lookup compatibility surface is explicitly restricted", () => {
  const result = runSeed(
    "loop/governess.ts",
    "/** @tmux-pane-request-only */\nexport interface GovernessDeps { capturePane: (paneId: string) => string; }\n"
  );
  expect(result.exitCode).toBe(0);
});

test("a pane request marker outside the reviewed surface grants no exception", () => {
  const result = runSeed(
    "bad.ts",
    "/** @tmux-pane-request-only */\nexport interface Deps { capturePane: (paneId: string) => string; }\n"
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("PANE_AUTHORITY_WIDENING");
});

test("an unapproved Governess pane member is not covered by the marker", () => {
  const result = runSeed(
    "loop/governess.ts",
    "/** @tmux-pane-request-only */\nexport interface GovernessDeps { killPane: (paneId: string) => void; }\n"
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("PANE_AUTHORITY_WIDENING");
});

test("a bare session liveness call fails independently", () => {
  const result = runSeed(
    "bad.ts",
    'declare const tmuxSessionLiveness: (session: string) => string;\ntmuxSessionLiveness("loop");\n'
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("BARE_LIVENESS_CALL");
});

test("an unqualified attach formatter fails independently", () => {
  const result = runSeed(
    "bad.ts",
    'const hint = "tmux attach -t loop";\nvoid hint;\n'
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("BARE_ATTACH_FORMATTER");
});
