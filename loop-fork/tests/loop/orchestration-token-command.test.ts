import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createConfiguredTokenService,
  parseLoopOrchestrationConfig,
} from "../../src/loop/loop-orchestration-server";
import {
  parseOrchestrationCommand,
  runOrchestrationCommand,
} from "../../src/loop/orchestration-command";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const fixture = (withTokens = true) => {
  const root = mkdtempSync(join(tmpdir(), "ra1-cli-"));
  roots.push(root);
  const signingKeyFile = join(root, "signing.pem");
  const config = {
    address: "127.0.0.1:7233",
    buildId: "loop-orchestration.v1",
    grants: [
      {
        from: "supervisor:harness",
        operations: ["receive"],
        principal: "principal:harness",
        to: "supervisor:harness-w1",
      },
    ],
    hostname: "127.0.0.1",
    identity: "loop-orchestration@local",
    namespace: "default",
    port: 7321,
    schema: "loop-orchestration-server.v1",
    stateDir: join(root, "state"),
    supervisors: [
      {
        mailbox: join(root, "harness.jsonl"),
        principal: "principal:harness",
        role: { project: "loop", repoKey: "agents-collab", role: "supervisor" },
        supervisorId: "supervisor:harness",
        tokenEnv: "LOOP_HARNESS_TOKEN",
      },
      {
        mailbox: join(root, "w1.jsonl"),
        principal: "principal:harness-w1",
        role: { project: "loop", repoKey: "agents-collab", role: "worker" },
        supervisorId: "supervisor:harness-w1",
        tokenEnv: "LOOP_W1_TOKEN",
      },
    ],
    taskQueue: "loop-orchestration",
    ...(withTokens ? { tokens: { signingKeyFile } } : {}),
  };
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  return { config, configPath, root, signingKeyFile };
};

const run = async (argv: string[]) => {
  const lines: string[] = [];
  await runOrchestrationCommand(["orchestration", ...argv], undefined, {
    write: (text) => lines.push(text),
  });
  return lines.join("");
};

// biome-ignore lint/suspicious/noBitwiseOperators: permission bits are a bit mask.
const mode = (path: string) => statSync(path).mode & 0o777;

test("RA1 host commands: keygen, a code to a 0600 file (never the terminal), and revocation", async () => {
  const f = fixture();
  expect(await run(["token-keygen", f.configPath])).toContain(
    `token signing key written: ${f.signingKeyFile} (kid `
  );
  expect(mode(f.signingKeyFile)).toBe(0o600);
  await expect(run(["token-keygen", f.configPath])).rejects.toThrow();
  const out = join(f.root, "w1.code");
  const printed = await run([
    "token-code",
    f.configPath,
    "supervisor:harness-w1",
    "--out",
    out,
  ]);
  expect(mode(out)).toBe(0o600);
  const code = readFileSync(out, "utf8").trim();
  expect(printed).toContain(
    `enrollment code for supervisor:harness-w1 written to ${out}`
  );
  expect(printed).not.toContain(code);
  // The same store the server reads: the code enrolls exactly once.
  const service = createConfiguredTokenService(
    parseLoopOrchestrationConfig(f.config)
  );
  const issued = service?.enroll(code);
  expect(issued?.sessionId).toBeString();
  expect(service?.enroll(code)).toBeUndefined();
  // An existing file is never overwritten.
  await expect(
    run(["token-code", f.configPath, "supervisor:harness-w1", "--out", out])
  ).rejects.toThrow();
  expect(
    await run([
      "token-revoke",
      f.configPath,
      "--session",
      issued?.sessionId as string,
    ])
  ).toBe(`revoked sessionId ${issued?.sessionId}\n`);
  expect(service?.verify(issued?.token as string)).toBeUndefined();
  expect(
    await run(["token-revoke", f.configPath, "--epoch", "supervisor:harness"])
  ).toBe("revoked epochFor supervisor:harness\n");
});

test("RA1 host commands refuse a config without tokens, an address without a role and bad argv", async () => {
  const bare = fixture(false);
  await expect(run(["token-keygen", bare.configPath])).rejects.toThrow(
    "has no tokens section"
  );
  const f = fixture();
  await run(["token-keygen", f.configPath]);
  await expect(
    run([
      "token-code",
      f.configPath,
      "supervisor:nobody",
      "--out",
      join(f.root, "x.code"),
    ])
  ).rejects.toThrow("has no configured role");
  for (const argv of [
    ["token-keygen"],
    ["token-keygen", "/tmp/c.json", "extra"],
    ["token-code", "/tmp/c.json", "supervisor:x"],
    ["token-code", "/tmp/c.json", "supervisor:x", "--to", "/tmp/out"],
    ["token-revoke", "/tmp/c.json"],
    ["token-revoke", "/tmp/c.json", "--session"],
    ["token-revoke", "/tmp/c.json", "--all", "x"],
    ["token-revoke", "/tmp/c.json", "--jti", "a", "--session", "b"],
    ["token-other", "/tmp/c.json"],
  ]) {
    expect(() => parseOrchestrationCommand(["orchestration", ...argv])).toThrow(
      "loop orchestration token-revoke <config-path>"
    );
  }
});
