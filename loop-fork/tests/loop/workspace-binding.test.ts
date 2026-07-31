import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "bun";
import { resolveWorkspaceBinding } from "../../src/loop/workspace-binding";

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { force: true, recursive: true });
  }
});

const decode = (value: Uint8Array | null | undefined): string =>
  value ? new TextDecoder().decode(value).trim() : "";

const git = (cwd: string, args: string[]): string => {
  const result = spawnSync(["git", ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${decode(result.stderr)}`);
  }
  return decode(result.stdout);
};

interface GitFixture {
  detached: string;
  linked: string;
  linkedTwo: string;
  main: string;
  parent: string;
}

const createGitFixture = (): GitFixture => {
  const parent = mkdtempSync(join(tmpdir(), "loop workspace-binding-"));
  fixtures.push(parent);
  const main = join(parent, "main repo");
  const linked = join(parent, "linked one");
  const linkedTwo = join(parent, "linked two");
  const detached = join(parent, "detached head");
  mkdirSync(main);
  git(main, ["init", "-b", "main"]);
  writeFileSync(join(main, "README.md"), "fixture\n", "utf8");
  git(main, ["add", "README.md"]);
  git(main, [
    "-c",
    "user.name=Loop Test",
    "-c",
    "user.email=loop@example.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  git(main, ["branch", "feature/one"]);
  git(main, ["branch", "feature/two"]);
  git(main, ["worktree", "add", linked, "feature/one"]);
  git(main, ["worktree", "add", linkedTwo, "feature/two"]);
  git(main, ["worktree", "add", "--detach", detached, "HEAD"]);
  return { detached, linked, linkedTwo, main, parent };
};

test("resolves a linked worktree to its canonical root and full branch ref", () => {
  const fixture = createGitFixture();
  const binding = resolveWorkspaceBinding(fixture.linked, fixture.main);
  const mainBinding = resolveWorkspaceBinding(undefined, fixture.main);

  expect(binding).toEqual({
    branchRef: "refs/heads/feature/one",
    repoId: mainBinding.repoId,
    root: realpathSync(fixture.linked),
  });
  expect(mainBinding.branchRef).toBe("refs/heads/main");
});

test("resolves explicit worktree subdirectories and symlinks to one binding", () => {
  const fixture = createGitFixture();
  const subdir = join(fixture.linked, "docs", "nested");
  const symlink = join(fixture.parent, "linked alias");
  mkdirSync(subdir, { recursive: true });
  symlinkSync(fixture.linked, symlink, "dir");

  const fromSubdir = resolveWorkspaceBinding(subdir, fixture.main);
  const fromSymlink = resolveWorkspaceBinding(symlink, fixture.main);

  expect(fromSubdir).toEqual(fromSymlink);
  expect(fromSubdir.root).toBe(realpathSync(fixture.linked));
});

test("rejects missing and explicit non-Git workspace paths", () => {
  const fixture = createGitFixture();
  const unrelated = join(fixture.parent, "unrelated");
  mkdirSync(unrelated);

  expect(() =>
    resolveWorkspaceBinding(join(fixture.parent, "missing"), fixture.main)
  ).toThrow("workspace path does not exist");
  expect(() => resolveWorkspaceBinding(unrelated, fixture.main)).toThrow(
    "not a registered Git worktree"
  );
});

test("rejects a Git-looking path absent from the worktree registry", () => {
  const calls: string[] = [];
  const path = "/workspace/unregistered";

  expect(() =>
    resolveWorkspaceBinding(path, "/invocation", {
      isDirectory: () => true,
      pathExists: () => true,
      realpath: (value) => value,
      runGit: (_cwd, args) => {
        calls.push(args.join(" "));
        if (
          args.join(" ") === "rev-parse --path-format=absolute --show-toplevel"
        ) {
          return { exitCode: 0, stderr: "", stdout: `${path}\n` };
        }
        if (args.join(" ") === "worktree list --porcelain -z") {
          return {
            exitCode: 0,
            stderr: "",
            stdout: "worktree /workspace/other\0HEAD abc\0\0",
          };
        }
        throw new Error(`unexpected git call: ${args.join(" ")}`);
      },
    })
  ).toThrow("resolves to unregistered Git worktree");
  expect(calls).toEqual([
    "rev-parse --path-format=absolute --show-toplevel",
    "worktree list --porcelain -z",
  ]);
});

test("accepts a detached registered worktree without inventing a branch", () => {
  const fixture = createGitFixture();
  const binding = resolveWorkspaceBinding(fixture.detached, fixture.main);

  expect(binding.root).toBe(realpathSync(fixture.detached));
  expect(binding.branchRef).toBeUndefined();
  expect(binding.repoId).toBe(
    resolveWorkspaceBinding(undefined, fixture.main).repoId
  );
});

test("distinct linked worktrees produce distinct bindings in one repo", () => {
  const fixture = createGitFixture();
  const first = resolveWorkspaceBinding(fixture.linked, fixture.main);
  const second = resolveWorkspaceBinding(fixture.linkedTwo, fixture.main);

  expect(first.repoId).toBe(second.repoId);
  expect(first.root).not.toBe(second.root);
  expect(first.branchRef).toBe("refs/heads/feature/one");
  expect(second.branchRef).toBe("refs/heads/feature/two");
});

test("default non-Git cwd falls back to a stable canonical binding", () => {
  const parent = mkdtempSync(join(tmpdir(), "loop workspace-nongit-"));
  fixtures.push(parent);
  const cwd = join(parent, "project");
  const symlink = join(parent, "project alias");
  mkdirSync(cwd);
  symlinkSync(cwd, symlink, "dir");

  const direct = resolveWorkspaceBinding(undefined, cwd);
  const aliased = resolveWorkspaceBinding(undefined, symlink);

  expect(direct).toEqual(aliased);
  expect(direct.root).toBe(realpathSync(cwd));
  expect(direct.branchRef).toBeUndefined();
  expect(direct.repoId).toMatch(/^project-[a-f0-9]{12}$/);
});
