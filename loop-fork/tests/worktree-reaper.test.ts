import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "../../scripts/reap-worktrees.py");
const temporaryRoots: string[] = [];

interface CommandResult {
  status: number | null;
  stderr: string;
  stdout: string;
}

function command(
  argv: string[],
  cwd: string,
  env: Record<string, string> = {}
): CommandResult {
  const executable = argv[0];
  if (!executable) {
    throw new Error("command requires an executable");
  }
  const result = spawnSync(executable, argv.slice(1), {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function git(repo: string, ...args: string[]): string {
  const result = command(["git", ...args], repo);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function newRepository(): string {
  const repo = mkdtempSync(join(tmpdir(), "worktree-reaper-test-"));
  temporaryRoots.push(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Reaper Test");
  git(repo, "config", "user.email", "reaper@example.invalid");
  writeFileSync(join(repo, "README.md"), "initial\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "initial");
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  return repo;
}

function addWorktree(repo: string, name: string, path?: string): string {
  const target = path ?? `${repo}-${name}`;
  temporaryRoots.push(target);
  git(repo, "worktree", "add", "-b", name, target, "main");
  return target;
}

function runReaper(
  repo: string,
  args: string[] = [],
  env: Record<string, string> = {}
): CommandResult {
  return command(["python3", script, ...args], repo, env);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0).reverse()) {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("worktree reaper", () => {
  test("dry-run is display-only and apply removes an eligible worktree without deleting its branch", () => {
    const repo = newRepository();
    const linked = addWorktree(repo, "eligible");

    const dryRun = runReaper(repo);
    expect(dryRun.status).toBe(0);
    expect(dryRun.stdout).toContain("WOULD_REAP");
    expect(existsSync(linked)).toBe(true);

    const applied = runReaper(repo, ["--apply"]);
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain("REAPED");
    expect(existsSync(linked)).toBe(false);
    expect(git(repo, "show-ref", "--verify", "refs/heads/eligible")).not.toBe(
      ""
    );
  });

  test("tracked and untracked dirt both fail closed", () => {
    const repo = newRepository();
    const tracked = addWorktree(repo, "dirty-tracked");
    const untracked = addWorktree(repo, "dirty-untracked");
    writeFileSync(join(tracked, "README.md"), "modified\n");
    writeFileSync(join(untracked, "new.txt"), "untracked\n");

    const result = runReaper(repo, ["--apply"]);
    expect(result.status).toBe(0);
    expect(result.stdout.match(/KEEP_DIRTY/g)?.length).toBe(2);
    expect(existsSync(tracked)).toBe(true);
    expect(existsSync(untracked)).toBe(true);
  });

  test("an unmerged exact HEAD and a locked worktree remain", () => {
    const repo = newRepository();
    const unmerged = addWorktree(repo, "unmerged");
    writeFileSync(join(unmerged, "feature.txt"), "not merged\n");
    git(unmerged, "add", "feature.txt");
    git(unmerged, "commit", "-m", "unmerged");
    const locked = addWorktree(repo, "locked");
    git(repo, "worktree", "lock", "--reason", "test lock", locked);

    const result = runReaper(repo, ["--apply"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("KEEP_UNMERGED");
    expect(result.stdout).toContain("KEEP_LOCKED");
    expect(existsSync(unmerged)).toBe(true);
    expect(existsSync(locked)).toBe(true);
  });

  test("a detached merged worktree with spaces is discovered and removed", () => {
    const repo = newRepository();
    const detached = `${repo}-detached path with spaces`;
    temporaryRoots.push(detached);
    git(repo, "worktree", "add", "--detach", detached, "HEAD");

    const result = runReaper(repo, ["--apply"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('label="detached"');
    expect(result.stdout).toContain("REAPED");
    expect(existsSync(detached)).toBe(false);
  });

  test("a live process rooted below the worktree keeps it", async () => {
    const repo = newRepository();
    const linked = addWorktree(repo, "in-use");
    const nested = join(linked, "nested", "cwd");
    mkdirSync(nested, { recursive: true });
    const sleeper = spawn("sleep", ["30"], { cwd: nested, stdio: "ignore" });
    await new Promise((resolveReady) => setTimeout(resolveReady, 100));
    try {
      const result = runReaper(repo, ["--apply"]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("KEEP_IN_USE");
      expect(result.stdout).toContain(`pid(s)=${sleeper.pid}`);
      expect(existsSync(linked)).toBe(true);
    } finally {
      sleeper.kill("SIGTERM");
    }
  });

  test("an unresolved base and a missing process instrument remove nothing", () => {
    const repo = newRepository();
    const linked = addWorktree(repo, "preflight-failure");

    const badBase = runReaper(repo, ["--apply", "--base", "missing/ref"]);
    expect(badBase.status).toBe(2);
    expect(badBase.stderr).toContain("base does not resolve");
    expect(existsSync(linked)).toBe(true);

    const badLsof = runReaper(repo, ["--apply"], {
      WORKTREE_REAPER_LSOF: join(repo, "missing-lsof"),
    });
    expect(badLsof.status).toBe(2);
    expect(badLsof.stderr).toContain("process cwd inventory failed");
    expect(existsSync(linked)).toBe(true);
  });

  test("apply-time process-inventory failure is caught by revalidation", () => {
    const repo = newRepository();
    const linked = addWorktree(repo, "revalidate");
    const fakeLsof = join(repo, "fake-lsof.sh");
    const state = join(repo, "fake-lsof-state");
    writeFileSync(
      fakeLsof,
      `#!/bin/sh\ncount=0\n[ -f "$FAKE_LSOF_STATE" ] && count=$(cat "$FAKE_LSOF_STATE")\ncount=$((count + 1))\nprintf '%s\\n' "$count" > "$FAKE_LSOF_STATE"\n[ "$count" -eq 1 ]\n`
    );
    chmodSync(fakeLsof, 0o755);

    const result = runReaper(repo, ["--apply"], {
      WORKTREE_REAPER_LSOF: fakeLsof,
      FAKE_LSOF_STATE: state,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("FAILED_REVALIDATION");
    expect(existsSync(linked)).toBe(true);
  });

  test("stale registrations are reported in dry-run and pruned only on apply", () => {
    const repo = newRepository();
    const stale = addWorktree(repo, "stale");
    rmSync(stale, { recursive: true, force: true });

    const dryRun = runReaper(repo);
    expect(dryRun.status).toBe(0);
    expect(dryRun.stdout).toContain("STALE_REGISTRATION");
    expect(git(repo, "worktree", "list", "--porcelain")).toContain(stale);

    const applied = runReaper(repo, ["--apply"]);
    expect(applied.status).toBe(0);
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(stale);
  });
});
