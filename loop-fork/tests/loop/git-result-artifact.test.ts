import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createGitResultArtifactVerifier } from "../../src/loop/git-result-artifact";

test("result artifacts verify exact committed bytes and refuse arbitrary refs and mutable paths", async () => {
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const git = (args: string[]) =>
    execFileSync("git", [
      "--no-replace-objects",
      "-C",
      repositoryRoot,
      ...args,
    ]);
  const commit = git(["rev-parse", "HEAD"]).toString().trim();
  const path = "loop-fork/src/loop/workflow-port.ts";
  const bytes = git(["show", `${commit}:${path}`]);
  const artifactRef = `artifact://sha256/${createHash("sha256").update(bytes).digest("hex")}`;
  const binding = { repositoryRoot, commit, path, artifactRef };
  expect(await createGitResultArtifactVerifier([binding])(artifactRef)).toBe(
    true
  );
  expect(
    await createGitResultArtifactVerifier([binding])(
      `artifact://sha256/${"0".repeat(64)}`
    )
  ).toBe(false);
  const wrong = `artifact://sha256/${"1".repeat(64)}`;
  expect(
    await createGitResultArtifactVerifier([{ ...binding, artifactRef: wrong }])(
      wrong
    )
  ).toBe(false);
  expect(
    await createGitResultArtifactVerifier([
      { ...binding, commit: "0".repeat(40) },
    ])(artifactRef)
  ).toBe(false);
  expect(() =>
    createGitResultArtifactVerifier([{ ...binding, commit: "HEAD" }])
  ).toThrow();
  expect(() =>
    createGitResultArtifactVerifier([{ ...binding, path: "../secret" }])
  ).toThrow();
  expect(() => createGitResultArtifactVerifier([binding, binding])).toThrow();
});
