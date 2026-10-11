import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isSupervisorRoleId,
  LEGACY_SUPERVISOR_ALIASES,
  normalizeRemoteRepoKey,
  PROJECT_FILE,
  parseProjectFile,
  parseSupervisorRoleId,
  readProjectFile,
  resolveRepoIdentity,
  resolveSupervisorIdentity,
  resolveSupervisorRole,
  supervisorRoleId,
} from "../../src/loop/project-identity";
import { resolveCheckoutId, resolveRepoId } from "../../src/loop/run-state";

const tempPaths: string[] = [];
// Each CLI spawn loads the whole launcher module graph (about a second).
const CLI_TIMEOUT_MS = 60_000;

const tempDir = (label: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `loop-ra1-${label}-`)));
  tempPaths.push(dir);
  return dir;
};

const git = (cwd: string, args: string[]): string => {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-10-10T10:00:00Z",
      GIT_COMMITTER_DATE: "2026-10-10T10:00:00Z",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
};

const initRepo = (dir: string): void => {
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "fixture@example.test"]);
  git(dir, ["config", "user.name", "Fixture"]);
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-qm", "fixture"]);
};

const writeProject = (root: string, text: string): void => {
  mkdirSync(join(root, ".harness"), { recursive: true });
  writeFileSync(join(root, PROJECT_FILE), text);
};

const runCli = (args: string[], cwd: string) =>
  spawnSync(process.execPath, [join(process.cwd(), "src", "cli.ts"), ...args], {
    cwd,
    encoding: "utf8",
  });

afterEach(() => {
  for (const path of tempPaths.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

test("the same repository in two checkout paths has one repoKey and role, two checkoutIds", () => {
  const source = tempDir("source");
  initRepo(source);
  writeProject(
    source,
    `${JSON.stringify({ repo: "amgad/harness-engineering", projects: ["harness"] })}\n`
  );
  git(source, ["add", PROJECT_FILE]);
  git(source, ["commit", "-qm", "project identity"]);

  const parent = tempDir("clones");
  const first = join(parent, "first");
  const second = join(parent, "elsewhere", "second");
  mkdirSync(join(parent, "elsewhere"));
  git(parent, ["clone", "-q", source, first]);
  git(parent, ["clone", "-q", source, second]);
  // A worktree of the first clone: a third path, the first clone's checkout id.
  const worktree = join(parent, "first-wt");
  git(first, ["worktree", "add", "-q", "-b", "wt", worktree]);

  const a = resolveRepoIdentity(first);
  const b = resolveRepoIdentity(join(second, ".harness"));
  const c = resolveRepoIdentity(worktree);

  for (const identity of [a, b, c]) {
    expect(identity.source).toBe("project-file");
    expect(identity.repoKey).toBe("amgad/harness-engineering");
    expect(identity.projects).toEqual(["harness"]);
    expect(resolveSupervisorRole(identity)).toBe(
      "supervisor:amgad/harness-engineering/harness"
    );
  }
  expect(a.checkoutId).not.toBe(b.checkoutId);
  expect(c.checkoutId).toBe(a.checkoutId);
  // The checkout id is exactly today's path-hash repoId: run storage keeps
  // its directory for an existing local checkout.
  expect(a.checkoutId).toBe(resolveRepoId(first));
  expect(b.checkoutId).toBe(resolveCheckoutId(second));
  expect(a.checkoutId).toMatch(/^first-[0-9a-f]{12}$/);
  expect(b.repoRoot).toBe(second);
});

test("without project.json the origin remote path is the repoKey, the same for two clones", () => {
  const parent = tempDir("remote");
  const first = join(parent, "one");
  const second = join(parent, "two");
  mkdirSync(first);
  mkdirSync(second);
  initRepo(first);
  initRepo(second);
  git(first, [
    "remote",
    "add",
    "origin",
    "http://amgad@192.168.1.18:3100/Amgad/Agents-Collab.git",
  ]);
  git(second, [
    "remote",
    "add",
    "origin",
    "git@github.com:amgad/agents-collab",
  ]);

  const a = resolveRepoIdentity(first);
  const b = resolveRepoIdentity(second);
  expect(a).toMatchObject({
    projects: [],
    repoKey: "amgad/agents-collab",
    source: "origin-remote",
  });
  expect(b.repoKey).toBe("amgad/agents-collab");
  expect(a.checkoutId).not.toBe(b.checkoutId);
  expect(() => resolveSupervisorRole(a, "harness")).toThrow(
    "no .harness/project.json in this repository: a supervisor role needs a declared project (run `loop project init`)"
  );
});

test("a local-path origin and a directory outside git name no repository; checkoutId keeps its local behaviour", () => {
  const parent = tempDir("local");
  const repo = join(parent, "repo");
  mkdirSync(repo);
  initRepo(repo);
  git(repo, ["remote", "add", "origin", "/srv/git/agents-collab.git"]);
  const inGit = resolveRepoIdentity(repo);
  expect(inGit.source).toBe("none");
  expect(inGit.repoKey).toBeUndefined();
  expect(inGit.checkoutId).toBe(resolveRepoId(repo));

  const plain = join(parent, "plain");
  mkdirSync(plain);
  const outside = resolveRepoIdentity(plain, {
    runGit: () => ({ exitCode: 128, stderr: "", stdout: "" }),
  });
  expect(outside).toEqual({
    checkoutId: resolveRepoId(plain, {
      runGit: () => ({ exitCode: 128, stderr: "", stdout: "" }),
    }),
    projects: [],
    source: "none",
  });
});

test("normalizeRemoteRepoKey strips scheme, credentials, host, port and .git", () => {
  const cases: [string, string | undefined][] = [
    ["https://github.com/Owner/Repo.git", "owner/repo"],
    ["https://github.com/owner/repo/", "owner/repo"],
    [
      "http://amgad@192.168.1.18:3100/amgad/agents-collab.git",
      "amgad/agents-collab",
    ],
    ["https://user:token@forgejo.home.lab/amgad/loop", "amgad/loop"],
    ["ssh://git@forgejo.home.lab:2222/amgad/loop.git", "amgad/loop"],
    ["git@github.com:owner/repo.git", "owner/repo"],
    ["github.com:owner/repo", "owner/repo"],
    ["/srv/git/owner/repo.git", undefined],
    ["file:///srv/git/owner/repo.git", undefined],
    ["../repo", undefined],
    ["https://host/group/sub/repo.git", undefined],
    ["https://host/repo.git", undefined],
    ["https://host/owner/repo?x=1", undefined],
    ["https://host/owner/%2e%2e", undefined],
    ["https://host/owner/.hidden", undefined],
    ["https://host/owner/re po", undefined],
    ["", undefined],
  ];
  for (const [remote, expected] of cases) {
    expect([remote, normalizeRemoteRepoKey(remote)]).toEqual([
      remote,
      expected,
    ]);
  }
});

test("role ids follow RECIPIENT_RE's character rules extended for '/'", () => {
  expect(supervisorRoleId("amgad/harvto", "harvto")).toBe(
    "supervisor:amgad/harvto/harvto"
  );
  expect(isSupervisorRoleId("supervisor:a/b/c")).toBe(true);
  expect(isSupervisorRoleId("supervisor:a.b/c_d/e-f")).toBe(true);
  for (const bad of [
    "supervisor:harness",
    "supervisor:a/b",
    "supervisor:a/b/c/d",
    "supervisor:A/b/c",
    "supervisor:a//c",
    "supervisor:a/../c",
    "supervisor:a/b/.c",
    "supervisor:/a/b",
    "supervisor:a/b/c/",
    "supervisor:a/b/c\n",
    "principal:a/b/c",
    `supervisor:a/b/${"c".repeat(125)}`,
  ]) {
    expect([bad, isSupervisorRoleId(bad)]).toEqual([bad, false]);
  }
  // 128 characters after the prefix is the bound, as for RECIPIENT_RE.
  expect(isSupervisorRoleId(`supervisor:a/b/${"c".repeat(124)}`)).toBe(true);
  expect(() => supervisorRoleId("a/b", "c".repeat(125))).toThrow(
    `role id "supervisor:a/b/${"c".repeat(125)}" exceeds 128 characters after "supervisor:"`
  );
  expect(() => supervisorRoleId("Amgad/x", "p")).toThrow(
    `repo key must be "<owner>/<name>": lowercase letters, digits, '.', '_' or '-', starting with a letter or digit in each part (got "Amgad/x")`
  );
  expect(() => supervisorRoleId("a/b", "p/q")).toThrow(
    `project must be a name of lowercase letters, digits, '.', '_' or '-', starting with a letter or digit (got "p/q")`
  );
  expect(parseSupervisorRoleId("supervisor:amgad/harvto/web")).toEqual({
    project: "web",
    repoKey: "amgad/harvto",
  });
  expect(parseSupervisorRoleId("supervisor:harvto")).toBeUndefined();
});

test("a malformed project.json is refused with an exact error", () => {
  const cases: [string, string][] = [
    ["{", ".harness/project.json: not valid JSON"],
    ["[]", ".harness/project.json: must be a JSON object"],
    [
      '{"repo":"a/b","projects":["p"],"owner":"x"}',
      '.harness/project.json: unknown key "owner" (allowed: "repo", "projects")',
    ],
    [
      '{"projects":["p"]}',
      '.harness/project.json: "repo" must be a string "<owner>/<name>"',
    ],
    [
      '{"repo":"Amgad/Loop","projects":["p"]}',
      `.harness/project.json: "repo" must be "<owner>/<name>": lowercase letters, digits, '.', '_' or '-', starting with a letter or digit in each part, no ".git" suffix (got "Amgad/Loop")`,
    ],
    [
      '{"repo":"loop","projects":["p"]}',
      `.harness/project.json: "repo" must be "<owner>/<name>": lowercase letters, digits, '.', '_' or '-', starting with a letter or digit in each part, no ".git" suffix (got "loop")`,
    ],
    [
      '{"repo":"a/loop.git","projects":["p"]}',
      `.harness/project.json: "repo" must be "<owner>/<name>": lowercase letters, digits, '.', '_' or '-', starting with a letter or digit in each part, no ".git" suffix (got "a/loop.git")`,
    ],
    [
      '{"repo":"a/b","projects":[]}',
      '.harness/project.json: "projects" must be a non-empty array of project names',
    ],
    [
      '{"repo":"a/b","projects":"p"}',
      '.harness/project.json: "projects" must be a non-empty array of project names',
    ],
    [
      '{"repo":"a/b","projects":["p","../q"]}',
      `.harness/project.json: "projects"[1] must be a project name of lowercase letters, digits, '.', '_' or '-', starting with a letter or digit (got "../q")`,
    ],
    [
      '{"repo":"a/b","projects":[7]}',
      `.harness/project.json: "projects"[0] must be a project name of lowercase letters, digits, '.', '_' or '-', starting with a letter or digit (got 7)`,
    ],
    [
      '{"repo":"a/b","projects":["p","p"]}',
      '.harness/project.json: "projects" lists "p" more than once',
    ],
    [
      `{"repo":"a/b","projects":["${"c".repeat(125)}"]}`,
      `.harness/project.json: role id "supervisor:a/b/${"c".repeat(125)}" exceeds 128 characters after "supervisor:"`,
    ],
  ];
  for (const [text, message] of cases) {
    let thrown: unknown;
    try {
      parseProjectFile(text);
    } catch (error) {
      thrown = error;
    }
    expect([text, (thrown as Error | undefined)?.message]).toEqual([
      text,
      message,
    ]);
  }
  expect(
    parseProjectFile('{"projects":["web","api"],"repo":"amgad/harvto"}')
  ).toEqual({
    projects: ["web", "api"],
    repo: "amgad/harvto",
  });
});

test("a malformed project.json in a checkout refuses identity rather than falling back to origin", () => {
  const repo = tempDir("malformed");
  initRepo(repo);
  git(repo, ["remote", "add", "origin", "https://github.com/amgad/loop.git"]);
  writeProject(repo, '{"repo":"amgad/loop","projects":["Loop"]}');
  expect(() => resolveRepoIdentity(repo)).toThrow(
    `.harness/project.json: "projects"[0] must be a project name of lowercase letters, digits, '.', '_' or '-', starting with a letter or digit (got "Loop")`
  );

  rmSync(join(repo, PROJECT_FILE));
  const elsewhere = join(repo, "elsewhere.json");
  writeFileSync(elsewhere, '{"repo":"evil/other","projects":["x"]}');
  symlinkSync(elsewhere, join(repo, PROJECT_FILE));
  expect(() => readProjectFile(repo)).toThrow(
    ".harness/project.json: must be a regular file, not a symlink"
  );

  rmSync(join(repo, ".harness"), { force: true, recursive: true });
  writeFileSync(join(repo, ".harness"), "not a directory");
  expect(() => resolveRepoIdentity(repo)).toThrow(
    ".harness/project.json: .harness must be a directory, not a symlink or file"
  );
});

test("resolveSupervisorRole names only a declared project", () => {
  const identity = {
    checkoutId: "x-000000000000",
    projects: ["web", "api"],
    repoKey: "amgad/harvto",
    source: "project-file" as const,
  };
  expect(resolveSupervisorRole(identity, "api")).toBe(
    "supervisor:amgad/harvto/api"
  );
  expect(() => resolveSupervisorRole(identity)).toThrow(
    '.harness/project.json declares 2 projects: name one of "web", "api"'
  );
  expect(() => resolveSupervisorRole(identity, "ios")).toThrow(
    'project "ios" is not declared in .harness/project.json (declared: "web", "api")'
  );
});

test("the five legacy supervisor ids alias to a role, a session and an operator principal", () => {
  expect([...LEGACY_SUPERVISOR_ALIASES.keys()].sort()).toEqual([
    "supervisor:ai-cur",
    "supervisor:harness",
    "supervisor:harness-desktop",
    "supervisor:harvto",
    "supervisor:portfolio-coordinator",
  ]);
  const keys = {
    "supervisor:ai-cur": "amgad/ai-cur",
    "supervisor:harness": "amgad/harness-engineering",
    "supervisor:harvto": "amgad/harvto",
  };
  expect(resolveSupervisorIdentity("supervisor:harness", keys)).toEqual({
    kind: "role",
    legacyId: "supervisor:harness",
    roleId: "supervisor:amgad/harness-engineering/harness",
  });
  expect(resolveSupervisorIdentity("supervisor:harvto", keys)).toMatchObject({
    roleId: "supervisor:amgad/harvto/harvto",
  });
  expect(resolveSupervisorIdentity("supervisor:ai-cur", keys)).toMatchObject({
    roleId: "supervisor:amgad/ai-cur/ai-cur",
  });
  expect(resolveSupervisorIdentity("supervisor:harness-desktop", keys)).toEqual(
    {
      kind: "session",
      legacyId: "supervisor:harness-desktop",
      mayHoldRoleId: "supervisor:amgad/harness-engineering/harness",
      sessionId: "session:harness-desktop",
    }
  );
  expect(resolveSupervisorIdentity("supervisor:portfolio-coordinator")).toEqual(
    {
      kind: "operator",
      legacyId: "supervisor:portfolio-coordinator",
      principal: "operator:portfolio-coordinator",
    }
  );
  // A role id passes through; an alias never shadows one.
  expect(resolveSupervisorIdentity("supervisor:amgad/harvto/web")).toEqual({
    kind: "role",
    roleId: "supervisor:amgad/harvto/web",
  });
  // A legacy role needs its configured repo key; nothing is guessed.
  expect(() => resolveSupervisorIdentity("supervisor:harvto")).toThrow(
    'legacy supervisor:harvto has no repo key: bind it to "<owner>/<name>"'
  );
  expect(() =>
    resolveSupervisorIdentity("supervisor:harness-desktop", {})
  ).toThrow(
    'legacy supervisor:harness has no repo key: bind it to "<owner>/<name>"'
  );
  expect(() =>
    resolveSupervisorIdentity("supervisor:harvto", {
      "supervisor:harvto": "Not A Key",
    })
  ).toThrow('repo key must be "<owner>/<name>"');
  expect(() => resolveSupervisorIdentity("supervisor:other")).toThrow(
    '"supervisor:other" is neither a role id "supervisor:<owner>/<name>/<project>" nor a legacy supervisor id'
  );
});

test(
  "loop project init writes project.json, refuses to overwrite, and --force replaces it",
  () => {
    const repo = tempDir("init");
    initRepo(repo);
    git(repo, ["remote", "add", "origin", "git@github.com:Amgad/Harvto.git"]);
    mkdirSync(join(repo, "sub"));

    const missing = runCli(["project", "init"], join(repo, "sub"));
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(
      "[loop] error: loop project init needs at least one --project <name>"
    );

    const first = runCli(
      ["project", "init", "--project", "web", "--project", "api"],
      join(repo, "sub")
    );
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual({
      overwritten: false,
      path: join(repo, PROJECT_FILE),
      projects: ["web", "api"],
      repo: "amgad/harvto",
      repoSource: "origin-remote",
    });
    const written = readFileSync(join(repo, PROJECT_FILE), "utf8");
    expect(written).toBe(
      '{\n  "repo": "amgad/harvto",\n  "projects": [\n    "web",\n    "api"\n  ]\n}\n'
    );

    const again = runCli(
      ["project", "init", "--project", "other", "--repo", "x/y"],
      repo
    );
    expect(again.status).toBe(1);
    expect(again.stderr).toContain(
      "[loop] error: .harness/project.json: already exists; pass --force to overwrite"
    );
    expect(readFileSync(join(repo, PROJECT_FILE), "utf8")).toBe(written);

    const bad = runCli(
      ["project", "init", "--project", "Web", "--force"],
      repo
    );
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain(`"projects"[0] must be a project name`);
    expect(readFileSync(join(repo, PROJECT_FILE), "utf8")).toBe(written);

    const forced = runCli(
      ["project", "init", "--project", "other", "--repo", "x/y", "--force"],
      repo
    );
    expect(forced.status).toBe(0);
    expect(JSON.parse(forced.stdout)).toMatchObject({
      overwritten: true,
      repo: "x/y",
      repoSource: "flag",
    });

    const show = runCli(["project", "show"], repo);
    expect(show.status).toBe(0);
    expect(JSON.parse(show.stdout)).toEqual({
      checkoutId: resolveRepoId(repo),
      originRepoKey: "amgad/harvto",
      projects: ["other"],
      repoKey: "x/y",
      repoRoot: repo,
      roles: ["supervisor:x/y/other"],
      source: "project-file",
    });
  },
  CLI_TIMEOUT_MS
);

test(
  "loop project init without --repo needs an origin that names a repository",
  () => {
    const repo = tempDir("init-local");
    initRepo(repo);
    const result = runCli(["project", "init", "--project", "p"], repo);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '[loop] error: loop project init needs --repo <owner>/<name>: the origin remote names no "<owner>/<name>"'
    );
    const outside = tempDir("not-git");
    const notGit = runCli(
      ["project", "init", "--project", "p", "--repo", "a/b"],
      outside
    );
    expect(notGit.status).toBe(1);
    expect(notGit.stderr).toContain(
      "[loop] error: loop project init must run inside a git work tree"
    );
  },
  CLI_TIMEOUT_MS
);
