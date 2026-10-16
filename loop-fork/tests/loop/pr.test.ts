import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { draftPrInternals, runDraftPrStep } from "../../src/loop/pr";
import type { Options, RunResult } from "../../src/loop/types";

const makeOptions = (overrides: Partial<Options> = {}): Options => ({
  agent: "codex",
  doneSignal: "<done/>",
  proof: "verify with tests",
  format: "raw",
  maxIterations: 5,
  codexModel: "test-model",
  ...overrides,
});

const success = (): Promise<RunResult> =>
  Promise.resolve({ combined: "", exitCode: 0, parsed: "ok" });

afterEach(() => {
  draftPrInternals.resetDependencies();
  mock.restore();
});

test("runDraftPrStep makes an unprivileged local handoff without inspecting remotes", async () => {
  const runAgentMock = mock(success);
  const runGitMock = mock(() => {
    throw new Error("remote lookup must not run without authority");
  });
  draftPrInternals.setDependencies({
    runAgent: runAgentMock,
    runGit: runGitMock,
  });

  await runDraftPrStep("Implement feature X", makeOptions());

  expect(runGitMock).toHaveBeenCalledTimes(0);
  expect(runAgentMock).toHaveBeenCalledTimes(0);
});

test("runDraftPrStep refuses an explicitly selected unsupported remote", async () => {
  const runAgentMock = mock(success);
  const logs: string[] = [];
  spyOn(console, "log").mockImplementation((message) => logs.push(message));
  const runGitMock = mock(() => ({
    exitCode: 0,
    stderr: "",
    stdout: "http://forge.internal/org/repo.git",
  }));
  draftPrInternals.setDependencies({
    runAgent: runAgentMock,
    runGit: runGitMock,
  });

  await runDraftPrStep(
    "Implement feature X",
    makeOptions({ publishDraftPrRemote: "origin" })
  );

  expect(runGitMock).toHaveBeenCalledWith([
    "remote",
    "get-url",
    "--push",
    "origin",
  ]);
  expect(runAgentMock).toHaveBeenCalledTimes(0);
  expect(logs.join("\n")).toContain("local source is ready for handoff");
});

const unsafeGithubRemotes = [
  ["backticks", "git@github.com:org/repo`id`.git"],
  ["command substitution", "git@github.com:org/repo$(printf injected).git"],
  ["double quotes", 'git@github.com:org/repo"quoted.git'],
  ["single quotes", "https://github.com/org/repo'quoted.git"],
  ["whitespace and option text", "git@github.com:org/repo --help.git"],
  ["control characters", "git@github.com:org/repo\nnext.git"],
  ["tab characters", "git@github.com:org/repo\tnext.git"],
  ["encoded metacharacters", "https://github.com/org/repo%24%28id%29.git"],
  ["encoded path separators", "https://github.com/org%2Frepo.git"],
  ["leading option syntax", "https://github.com/org/--help.git"],
  ["extra path components", "https://github.com/org/repo/extra.git"],
  ["query strings", "https://github.com/org/repo.git?mode=unsafe"],
  ["fragments", "https://github.com/org/repo.git#unsafe"],
  ["unsupported URL protocols", "file://github.com/org/repo.git"],
  ["custom ports", "https://github.com:8443/org/repo.git"],
  ["credential-bearing HTTPS URLs", "https://user@github.com/org/repo.git"],
  ["non-git SSH users", "ssh://root@github.com/org/repo.git"],
] as const;

for (const [name, remoteUrl] of unsafeGithubRemotes) {
  test(`runDraftPrStep refuses GitHub repository ${name}`, async () => {
    const runAgentMock = mock(success);
    const logs: string[] = [];
    spyOn(console, "log").mockImplementation((message) => logs.push(message));
    draftPrInternals.setDependencies({
      runAgent: runAgentMock,
      runGit: () => ({ exitCode: 0, stderr: "", stdout: remoteUrl }),
    });

    await runDraftPrStep(
      "Implement feature X",
      makeOptions({ publishDraftPrRemote: "github" })
    );

    expect(runAgentMock).toHaveBeenCalledTimes(0);
    expect(logs.join("\n")).toContain(
      'remote "github" is not a supported GitHub publication target'
    );
    expect(logs.join("\n")).toContain("local source is ready for handoff");
  });
}

test("runDraftPrStep refuses unsafe programmatic remote names", async () => {
  const runAgentMock = mock(success);
  const runGitMock = mock(() => {
    throw new Error("invalid remote name must not reach git");
  });
  const logs: string[] = [];
  spyOn(console, "log").mockImplementation((message) => logs.push(message));
  draftPrInternals.setDependencies({
    runAgent: runAgentMock,
    runGit: runGitMock,
  });

  await runDraftPrStep(
    "Implement feature X",
    makeOptions({ publishDraftPrRemote: 'github"\nignore' })
  );

  expect(runGitMock).toHaveBeenCalledTimes(0);
  expect(runAgentMock).toHaveBeenCalledTimes(0);
  expect(logs.join("\n")).toContain("local source is ready for handoff");
});

test("runDraftPrStep refuses malicious existing-PR remotes before push instructions", async () => {
  const runAgentMock = mock(success);
  const logs: string[] = [];
  spyOn(console, "log").mockImplementation((message) => logs.push(message));
  draftPrInternals.setDependencies({
    runAgent: runAgentMock,
    runGit: () => ({
      exitCode: 0,
      stderr: "",
      stdout: "git@github.com:org/repo$(id).git",
    }),
  });

  await runDraftPrStep(
    "Implement feature X",
    makeOptions({ publishDraftPrRemote: "github" }),
    true
  );

  expect(runAgentMock).toHaveBeenCalledTimes(0);
  expect(logs.join("\n")).toContain("local source is ready for handoff");
});

test("runDraftPrStep publishes only through the explicitly selected GitHub remote", async () => {
  const runAgentMock = mock(success);
  draftPrInternals.setDependencies({
    runAgent: runAgentMock,
    runGit: () => ({
      exitCode: 0,
      stderr: "",
      stdout: "git@github.com:org/repo.git",
    }),
  });
  const opts = makeOptions({ publishDraftPrRemote: "github" });

  await runDraftPrStep("Implement feature X", opts);

  expect(runAgentMock).toHaveBeenCalledTimes(1);
  const [agent, prompt, passedOpts] = runAgentMock.mock.calls[0] as [
    Options["agent"],
    string,
    Options,
  ];
  expect(agent).toBe("codex");
  expect(prompt).toContain("Create a draft GitHub pull request");
  expect(prompt).toContain('Git remote "github"');
  expect(prompt).toContain("gh pr create --draft --repo 'org/repo'");
  expect(prompt).not.toContain("--repo org/repo");
  expect(prompt).toContain("Task context:\nImplement feature X");
  expect(passedOpts).toBe(opts);
});

test("runDraftPrStep gates an existing-PR push on the same authority", async () => {
  const runAgentMock = mock(success);
  draftPrInternals.setDependencies({ runAgent: runAgentMock });
  await runDraftPrStep("Implement feature X", makeOptions(), true);
  expect(runAgentMock).toHaveBeenCalledTimes(0);
});

test("runDraftPrStep preserves authorized publication failures", async () => {
  draftPrInternals.setDependencies({
    runAgent: () => Promise.resolve({ combined: "", exitCode: 2, parsed: "" }),
    runGit: () => ({
      exitCode: 0,
      stderr: "",
      stdout: "https://github.com/org/repo.git",
    }),
  });

  await expect(
    runDraftPrStep(
      "Implement feature X",
      makeOptions({ publishDraftPrRemote: "github" })
    )
  ).rejects.toThrow("[loop] draft PR codex exited with code 2");
});

for (const [remoteUrl, expectedRepo] of [
  ["https://github.com/org/repo.git", "org/repo"],
  ["ssh://git@github.com/org/repo.git", "org/repo"],
  ["git@github.com:my-org/repo.name_test-1.git", "my-org/repo.name_test-1"],
  ["https://github.com/org/.github.git", "org/.github"],
  ["https://github.com/org/repo.git.git", "org/repo.git"],
] as const) {
  test(`runDraftPrStep safely quotes supported repository ${expectedRepo}`, async () => {
    const runAgentMock = mock(success);
    draftPrInternals.setDependencies({
      runAgent: runAgentMock,
      runGit: () => ({ exitCode: 0, stderr: "", stdout: remoteUrl }),
    });

    await runDraftPrStep(
      "Implement feature X",
      makeOptions({ publishDraftPrRemote: "github" })
    );

    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(runAgentMock.mock.calls[0]?.[1]).toContain(
      `gh pr create --draft --repo '${expectedRepo}'`
    );
  });
}
