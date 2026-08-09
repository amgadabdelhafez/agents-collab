#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "bun";

const root = resolve(import.meta.dir, "..");
const fixtureDir = resolve(root, "tests/fixtures/tmux-socket-normalization");
const newPath = join(fixtureDir, "manifest-new.json");
const legacyPath = join(fixtureDir, "manifest-legacy.json");
const indexPath = join(fixtureDir, "fixture-index.json");
const tmuxTracePath = join(fixtureDir, "tmux-argv.tsv");

const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");

const stableJson = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;

const legacyFrom = (
  manifest: Record<string, unknown>
): Record<string, unknown> => {
  const legacy = { ...manifest };
  Reflect.deleteProperty(legacy, "tmuxSocket");
  return legacy;
};

const verify = (): void => {
  const index = JSON.parse(readFileSync(indexPath, "utf8")) as {
    artifacts: Array<{ file: string; sha256: string }>;
    normalization: { scriptSha256: string };
  };
  for (const artifact of index.artifacts) {
    const bytes = readFileSync(join(fixtureDir, artifact.file));
    if (sha256(bytes) !== artifact.sha256) {
      throw new Error(`fixture hash mismatch: ${artifact.file}`);
    }
  }
  const current = JSON.parse(readFileSync(newPath, "utf8")) as Record<
    string,
    unknown
  >;
  const legacy = readFileSync(legacyPath, "utf8");
  if (stableJson(legacyFrom(current)) !== legacy) {
    throw new Error("legacy fixture is not new fixture minus only tmuxSocket");
  }
  if (
    sha256(readFileSync(import.meta.path)) !== index.normalization.scriptSha256
  ) {
    throw new Error("fixture normalizer script hash mismatch");
  }
  console.log("tmux manifest fixtures verified");
};

if (process.argv.includes("--verify")) {
  verify();
  process.exit(0);
}

const scratch = mkdtempSync(join(tmpdir(), "loop-tmux-fixture-"));
const realScratch = realpathSync(scratch);
try {
  const systemPath = "/usr/bin:/bin:/usr/sbin:/sbin";
  const candidate = join(scratch, "loop-candidate");
  const build = spawnSync(
    ["bun", "build", "--compile", "--outfile", candidate, "src/cli.ts"],
    { cwd: root, stderr: "inherit", stdout: "inherit" }
  );
  if (build.exitCode !== 0) {
    throw new Error(`candidate build failed: ${build.exitCode}`);
  }

  const bin = join(scratch, "bin");
  const home = join(scratch, "home");
  const workspace = join(scratch, "workspace");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const tmux = join(bin, "tmux");
  const tmuxTrace = join(scratch, "tmux-argv.tsv");
  writeFileSync(
    tmux,
    `#!/bin/sh
{
  first=1
  for argument in "$@"; do
    if [ "$first" -eq 0 ]; then printf '\t'; fi
    printf '%s' "$argument"
    first=0
  done
  printf '\n'
} >> "\${LOOP_FIXTURE_TMUX_TRACE:?}"
if [ "\${1:-}" = "-V" ] && [ "$#" -eq 1 ]; then echo "tmux 3.7b"; exit 0; fi
if [ "\${1:-}" != "-S" ] || [ "\${2:-}" != "\${LOOP_TMUX_SOCKET}" ]; then exit 92; fi
case "\${3:-}" in
  has-session) echo "can't find session: fixture" >&2; exit 1 ;;
  new-session) echo "fixture stops after manifest binding" >&2; exit 71 ;;
esac
exit 0
`
  );
  for (const command of ["opencode", "claude"]) {
    writeFileSync(
      join(bin, command),
      `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then echo "fixture 1.0"; exit 0; fi
if [ "\${1:-}" = "mcp" ]; then exit 0; fi
exit 1
`
    );
  }
  for (const command of [tmux, join(bin, "opencode"), join(bin, "claude")]) {
    chmodSync(command, 0o755);
  }

  const gitEnv = {
    GIT_AUTHOR_DATE: "2026-08-09T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-08-09T00:00:00Z",
    HOME: home,
    LANG: "C",
    PATH: systemPath,
  };
  for (const argv of [
    ["git", "init", "-q", workspace],
    ["git", "-C", workspace, "config", "user.name", "Fixture"],
    ["git", "-C", workspace, "config", "user.email", "fixture@example.invalid"],
  ]) {
    const result = spawnSync(argv, { env: gitEnv });
    if (result.exitCode !== 0) {
      throw new Error(`fixture setup failed: ${argv.join(" ")}`);
    }
  }
  writeFileSync(join(workspace, "README.md"), "tmux fixture producer\n");
  for (const argv of [
    ["git", "-C", workspace, "add", "README.md"],
    ["git", "-C", workspace, "commit", "-q", "-m", "fixture"],
  ]) {
    const result = spawnSync(argv, { env: gitEnv });
    if (result.exitCode !== 0) {
      throw new Error(`fixture setup failed: ${argv.join(" ")}`);
    }
  }
  const prompt = join(scratch, "prompt.md");
  writeFileSync(prompt, "capture the manifest socket binding\n");
  const socket = join(scratch, "producer.sock");
  const captureTmp = join(scratch, "tmp");
  mkdirSync(captureTmp, { recursive: true });
  const captureArgv = [
    candidate,
    "--tmux",
    "--agent",
    "oss",
    "--pair-with",
    "claude",
    "--workspace",
    workspace,
    "-p",
    prompt,
  ];
  const capture = spawnSync(captureArgv, {
    cwd: workspace,
    env: {
      CLAUDE_CONFIG_DIR: join(scratch, "claude-config"),
      CODEX_HOME: join(scratch, "codex-home"),
      HOME: home,
      LANG: "C",
      LOGNAME: "fixture",
      LOOP_AU_PAIR_ENABLED: "0",
      LOOP_CAVEMAN_MODE: "off",
      LOOP_HELPER_CAVEMAN_MODE: "off",
      LOOP_NANNY_ENABLED: "0",
      LOOP_RECON_PANES: "0",
      LOOP_FIXTURE_TMUX_TRACE: tmuxTrace,
      LOOP_RUN_ID: "1",
      LOOP_TMUX_SOCKET: socket,
      LOOP_UTILITY_PANE: "0",
      PATH: `${bin}:${systemPath}`,
      SHELL: "/bin/sh",
      TERM: "xterm-256color",
      TMPDIR: captureTmp,
      USER: "fixture",
      XDG_CACHE_HOME: join(scratch, "xdg-cache"),
      XDG_CONFIG_HOME: join(scratch, "xdg-config"),
      XDG_DATA_HOME: join(scratch, "xdg-data"),
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  if (capture.exitCode === 0) {
    throw new Error("fixture capture unexpectedly completed the fake launch");
  }
  const tracedArgv = readFileSync(tmuxTrace, "utf8")
    .trim()
    .split("\n")
    .map((line) => line.split("\t"));
  const versionCalls = tracedArgv.filter(
    (argv) => argv.length === 1 && argv[0] === "-V"
  );
  const targetCalls = tracedArgv.filter(
    (argv) => argv[0] === "-S" && argv[1] === socket
  );
  if (
    versionCalls.length !== 1 ||
    versionCalls.length + targetCalls.length !== tracedArgv.length
  ) {
    throw new Error("fixture observed unexpected or non-exact tmux argv");
  }
  const hasSessionCalls = targetCalls.filter(
    (argv) => argv[2] === "has-session"
  );
  const newSessionCalls = targetCalls.filter(
    (argv) => argv[2] === "new-session"
  );
  if (hasSessionCalls.length < 1 || newSessionCalls.length !== 1) {
    throw new Error(
      `fixture did not reach the bounded has-session/new-session seam: ${JSON.stringify(tracedArgv)}`
    );
  }
  const commandKinds = tracedArgv.map((argv) => argv[2] ?? argv[0]);
  if (
    JSON.stringify(commandKinds) !==
    JSON.stringify(["-V", "has-session", "new-session", "has-session"])
  ) {
    throw new Error(
      `fixture tmux command sequence changed: ${JSON.stringify(commandKinds)}`
    );
  }
  if (
    targetCalls.some(
      (argv) => argv[2] !== "has-session" && argv[2] !== "new-session"
    )
  ) {
    throw new Error(
      "fixture contacted an unexpected exact-socket tmux command"
    );
  }
  const firstHasSession = tracedArgv.indexOf(hasSessionCalls[0]);
  const newSessionIndex = tracedArgv.indexOf(newSessionCalls[0]);
  if (firstHasSession < 1 || newSessionIndex <= firstHasSession) {
    throw new Error(
      "fixture tmux command order is not version/has-session/new-session"
    );
  }

  const manifests: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name === "manifest.json") {
        manifests.push(path);
      }
    }
  };
  walk(join(home, ".loop", "runs"));
  if (manifests.length !== 1) {
    throw new Error(
      `expected one captured manifest, found ${manifests.length}`
    );
  }
  const rawBytes = readFileSync(manifests[0]);
  const raw = JSON.parse(rawBytes.toString("utf8")) as Record<string, unknown>;
  if (
    raw.tmuxSocket !== socket ||
    typeof raw.tmuxSession !== "string" ||
    raw.tmuxSession.length === 0 ||
    typeof raw.claudeSessionId !== "string" ||
    raw.claudeSessionId.length === 0
  ) {
    throw new Error(
      "compiled candidate did not persist the requested socket target"
    );
  }
  const sessionOf = (argv: string[]): string | undefined => {
    const targetIndex = argv.indexOf("-t");
    const sessionIndex = argv.indexOf("-s");
    const index = targetIndex >= 0 ? targetIndex : sessionIndex;
    return index >= 0 ? argv[index + 1] : undefined;
  };
  if (
    hasSessionCalls.some((argv) => sessionOf(argv) !== raw.tmuxSession) ||
    sessionOf(newSessionCalls[0]) !== raw.tmuxSession
  ) {
    throw new Error(
      "fixture tmux argv session does not match captured manifest"
    );
  }
  const normalized: Record<string, unknown> = {
    claudeSessionId: "00000000-0000-4000-8000-000000000001",
    codexThreadId: raw.codexThreadId,
    createdAt: "2026-08-09T00:00:00.000Z",
    cwd: "/tmp/loop-fixture/workspace",
    mode: raw.mode,
    ossSessionId: raw.ossSessionId,
    pid: 1,
    repoId: "repo-fixture",
    runId: raw.runId,
    state: raw.state,
    status: raw.status,
    tmuxSession: raw.tmuxSession,
    tmuxSocket: "/tmp/loop-fixture/producer.sock",
    updatedAt: "2026-08-09T00:00:00.000Z",
  };
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(newPath, stableJson(normalized));
  writeFileSync(legacyPath, stableJson(legacyFrom(normalized)));
  writeFileSync(
    tmuxTracePath,
    `${tracedArgv
      .map((argv) =>
        argv
          .map((argument) =>
            argument === socket
              ? "<SOCKET>"
              : argument
                  .replaceAll(realScratch, "<SCRATCH>")
                  .replaceAll(scratch, "<SCRATCH>")
                  .replaceAll(
                    String(raw.claudeSessionId),
                    "<CLAUDE_SESSION_ID>"
                  )
                  .replaceAll(/workspace-[0-9a-f]{12}/g, "workspace-<REPO_ID>")
                  .replaceAll(
                    /bootstrap-[0-9a-f]{64}/g,
                    "bootstrap-<CONTEXT_SHA>"
                  )
          )
          .join("\t")
      )
      .join("\n")}\n`
  );
  const candidateBytes = readFileSync(candidate);
  const sourceCommitResult = spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: root,
    env: { HOME: home, LANG: "C", PATH: systemPath },
    stderr: "pipe",
    stdout: "pipe",
  });
  if (sourceCommitResult.exitCode !== 0) {
    throw new Error("could not resolve fixture producer source commit");
  }
  const sourceCommit = sourceCommitResult.stdout.toString().trim();
  const newBytes = readFileSync(newPath);
  const legacyBytes = readFileSync(legacyPath);
  const tmuxTraceBytes = readFileSync(tmuxTracePath);
  const index = {
    producer: {
      binary: "compiled loop candidate",
      binarySha256: sha256(candidateBytes),
      capturedAtUtc: new Date().toISOString(),
      sourceCommit,
      tmuxVersion: "tmux 3.7b (isolated fake-control producer)",
    },
    capture: {
      argv: [
        "<candidate>",
        "--tmux",
        "--agent",
        "oss",
        "--pair-with",
        "claude",
        "--workspace",
        "<workspace>",
        "-p",
        "<prompt>",
      ],
      environment: {
        HOME: "<scratch>/home",
        LOOP_TMUX_SOCKET: "<scratch>/producer.sock",
        PATH: "<scratch>/bin:<system>",
      },
      exitCode: capture.exitCode,
      rawManifestSha256: sha256(rawBytes),
      stderrSha256: sha256(capture.stderr),
      tmuxArgvSha256: sha256(readFileSync(tmuxTrace)),
      tmuxCommandKinds: [
        "version-probe:-V",
        "prelaunch:has-session",
        "launch:new-session",
        "cleanup-reprobe:has-session",
      ],
    },
    normalization: {
      method: "project producer fields into the stable compatibility seam",
      retainedProducerFields: [
        "codexThreadId",
        "mode",
        "ossSessionId",
        "runId",
        "state",
        "status",
      ],
      normalizedFields: [
        "createdAt",
        "claudeSessionId",
        "cwd",
        "pid",
        "repoId",
        "tmuxSession",
        "tmuxSocket",
        "updatedAt",
      ],
      legacyDerivation: "remove only tmuxSocket from manifest-new.json",
      reproduce: "bun scripts/capture-tmux-manifest-fixture.ts --verify",
      script: "scripts/capture-tmux-manifest-fixture.ts",
      scriptSha256: sha256(readFileSync(import.meta.path)),
    },
    artifacts: [
      { file: "manifest-new.json", sha256: sha256(newBytes) },
      { file: "manifest-legacy.json", sha256: sha256(legacyBytes) },
      { file: "tmux-argv.tsv", sha256: sha256(tmuxTraceBytes) },
    ],
  };
  writeFileSync(indexPath, stableJson(index));
  verify();
  console.log(`captured ${indexPath}`);
} finally {
  rmSync(scratch, { force: true, recursive: true });
}
