// The suite runs only in an environment that cannot reach the operator's live
// state (`scripts/test-hermetic.sh`, enforced by `tests/setup.ts`). These
// tests pin what that environment gives a test and the children it spawns.

import { expect, test } from "bun:test";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "bun";
import { resolveStorageRoot } from "../../src/loop/run-state";
import { defaultStorageRoots } from "../../src/loop/shared-process-ownership";
import { hermeticEnvGap } from "../hermetic-env";

const CHILD_ENV =
  'printf "%s|%s|%s|%s" "$HOME" "$TMUX_TMPDIR" "$(printenv TMUX || echo unset)" "$(printenv TMUX_PANE || echo unset)"';

test("the launch environment gives HOME, os.homedir() and the default storage root (the other-run index) a scratch home, never the operator's", () => {
  const scratch = process.env.LOOP_TEST_HERMETIC_ENV ?? "";
  expect(scratch).not.toBe("");
  expect(process.env.HOME).toBe(join(scratch, "home"));
  expect(homedir()).toBe(join(scratch, "home"));
  const roots = defaultStorageRoots("/nowhere/repo/1");
  expect(roots).toEqual([resolveStorageRoot(join(scratch, "home"))]);
  for (const root of roots) {
    expect(root.startsWith(`${scratch}/`)).toBe(true);
  }
});

test("children spawned by Bun.spawn and node:child_process inherit the scratch HOME and TMUX_TMPDIR and no route to an ambient tmux server", () => {
  const scratch = process.env.LOOP_TEST_HERMETIC_ENV ?? "";
  const expected = `${join(scratch, "home")}|${join(scratch, "tmux")}|unset|unset`;
  const bun = spawnSync(["/bin/sh", "-c", CHILD_ENV], { stdout: "pipe" });
  expect(new TextDecoder().decode(bun.stdout)).toBe(expected);
  const node = nodeSpawnSync("/bin/sh", ["-c", CHILD_ENV], {
    encoding: "utf8",
  });
  expect(node.stdout).toBe(expected);
});

test("the preload's guard refuses every environment that could reach live state", () => {
  const scratch = "/tmp/loop-test-env.abc";
  const good = {
    HOME: `${scratch}/home`,
    LOOP_TEST_HERMETIC_ENV: scratch,
    TMUX_TMPDIR: `${scratch}/tmux`,
  };
  expect(hermeticEnvGap(good)).toBeUndefined();
  expect(hermeticEnvGap({ ...good, LOOP_TEST_HERMETIC_ENV: undefined })).toBe(
    "LOOP_TEST_HERMETIC_ENV is unset"
  );
  expect(hermeticEnvGap({ ...good, HOME: "/Users/someone" })).toContain(
    "HOME (/Users/someone) is not inside"
  );
  expect(hermeticEnvGap({ ...good, HOME: scratch })).toContain("HOME");
  expect(hermeticEnvGap({ ...good, HOME: `${scratch}-x/home` })).toContain(
    "HOME"
  );
  expect(hermeticEnvGap({ ...good, TMUX_TMPDIR: undefined })).toContain(
    "TMUX_TMPDIR (unset)"
  );
  expect(hermeticEnvGap({ ...good, TMUX_TMPDIR: "/tmp" })).toContain(
    "TMUX_TMPDIR"
  );
  expect(
    hermeticEnvGap({ ...good, TMUX: "/private/tmp/tmux-501/default,1,0" })
  ).toBe("TMUX is set");
  expect(hermeticEnvGap({ ...good, TMUX_PANE: "%1" })).toBe("TMUX_PANE is set");
  expect(hermeticEnvGap({ ...good, LOOP_TMUX_SOCKET: "/tmp/x" })).toBe(
    "LOOP_TMUX_SOCKET is set"
  );
});
