import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "bun";

const gate = join(process.cwd(), "evals", "release", "review-request-gate.sh");
const sender = join(
  process.cwd(),
  "evals",
  "release",
  "send-stamped-review.sh"
);

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync(["git", ...args], { cwd, stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trim();
};

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "loop-review-gate-"));
  mkdirSync(join(root, "loop-fork", "src"), { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.email", "gate@example.test");
  git(root, "config", "user.name", "Review Gate Test");
  writeFileSync(
    join(root, "loop-fork", "src", "protections.ts"),
    [
      "requestedShutdownDecision",
      "isExactNewWriteTarget",
      "PROXY_SHUTDOWN_CALLER_HEADER",
      "",
    ].join("\n")
  );
  writeFileSync(join(root, "body.txt"), "Purpose: review this exact SHA.\n");
  git(root, "add", "loop-fork/src/protections.ts", "body.txt");
  git(root, "commit", "-qm", "protected base");
  const requiredTip = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "candidate.txt"), "candidate\n");
  git(root, "add", "candidate.txt");
  git(root, "commit", "-qm", "candidate");
  return { requiredTip, root };
};

const runGate = (root: string, requiredTip: string, candidate = "HEAD") =>
  spawnSync(
    [
      "bash",
      gate,
      "--required-tip",
      requiredTip,
      "--candidate",
      candidate,
      "--subject",
      "REVIEW candidate",
      "--body-file",
      join(root, "body.txt"),
    ],
    { cwd: root, stderr: "pipe", stdout: "pipe" }
  );

const runSender = (
  root: string,
  requiredTip: string,
  candidate = "HEAD",
  senderPath = sender
) => {
  const fakeChannel = join(root, "fake-xchan.sh");
  const channelLog = join(root, "channel.log");
  writeFileSync(
    fakeChannel,
    '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$XCHAN_LOG"\n'
  );
  chmodSync(fakeChannel, 0o755);
  const result = spawnSync(
    [
      "bash",
      senderPath,
      "--required-tip",
      requiredTip,
      "--candidate",
      candidate,
      "--subject",
      "REVIEW candidate",
      "--body-file",
      join(root, "body.txt"),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        LOOP_XCHAN_BIN: fakeChannel,
        XCHAN_LOG: channelLog,
      },
      stderr: "pipe",
      stdout: "pipe",
    }
  );
  return { channelLog, result };
};

const senderWithGateOutput = (root: string, output: string): string => {
  const fixtureDir = join(root, "sender-fixture");
  mkdirSync(fixtureDir, { recursive: true });
  const fixtureSender = join(fixtureDir, "send-stamped-review.sh");
  const fixtureGate = join(fixtureDir, "review-request-gate.sh");
  const gateOutput = output
    .split("\n")
    .map((line) => `printf '%s\\n' ${JSON.stringify(line)}`)
    .join("\n");
  writeFileSync(fixtureSender, readFileSync(sender, "utf8"));
  writeFileSync(fixtureGate, `#!/bin/sh\n${gateOutput}\n`);
  chmodSync(fixtureSender, 0o755);
  chmodSync(fixtureGate, 0o755);
  return fixtureSender;
};

test("review request gate emits a provenance stamp only for protected lineage", () => {
  const { requiredTip, root } = fixture();
  const candidate = git(root, "rev-parse", "HEAD");
  const result = runGate(root, requiredTip);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe(
    [
      "Purpose: review this exact SHA.",
      "",
      "REVIEW_GATE_STAMP_V1",
      "subject=REVIEW candidate",
      `candidate=${candidate}`,
      `required_tip=${requiredTip}`,
      "lineage=PASS",
      "symbol.requestedShutdownDecision=1",
      "symbol.isExactNewWriteTarget=1",
      "symbol.PROXY_SHUTDOWN_CALLER_HEADER=1",
      "status=PASS",
      "",
    ].join("\n")
  );
});

test("review request gate emits nothing for a sibling lineage", () => {
  const { requiredTip, root } = fixture();
  git(root, "checkout", "-q", "--orphan", "stale-main");
  git(root, "rm", "-qrf", ".");
  mkdirSync(join(root, "loop-fork", "src"), { recursive: true });
  writeFileSync(
    join(root, "loop-fork", "src", "protections.ts"),
    "requestedShutdownDecision\nisExactNewWriteTarget\nPROXY_SHUTDOWN_CALLER_HEADER\n"
  );
  writeFileSync(join(root, "body.txt"), "stale\n");
  git(root, "add", "loop-fork/src/protections.ts", "body.txt");
  git(root, "commit", "-qm", "stale sibling");
  const result = runGate(root, requiredTip);
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toContain(
    "does not descend from required tip"
  );
});

test("review request gate emits nothing when a protection symbol is absent", () => {
  const { requiredTip, root } = fixture();
  writeFileSync(
    join(root, "loop-fork", "src", "protections.ts"),
    "requestedShutdownDecision\nPROXY_SHUTDOWN_CALLER_HEADER\n"
  );
  git(root, "add", "loop-fork/src/protections.ts");
  git(root, "commit", "-qm", "remove protection");
  const result = runGate(root, requiredTip);
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toContain(
    "required protection symbol absent: isExactNewWriteTarget"
  );
});

test("stamped sender calls the channel once with gate-certified output", () => {
  const { requiredTip, root } = fixture();
  const candidate = git(root, "rev-parse", "HEAD");
  const { channelLog, result } = runSender(root, requiredTip);
  expect(result.exitCode).toBe(0);
  const sent = readFileSync(channelLog, "utf8");
  expect(sent).toContain("send\ncodex\nclaude\nREVIEW candidate\n");
  expect(sent).toContain("REVIEW_GATE_STAMP_V1");
  expect(sent).toContain(`candidate=${candidate}`);
  expect(sent).toContain(`required_tip=${requiredTip}`);
  expect(sent).toContain("status=PASS\nhigh\n");
});

test("stamped sender makes zero channel calls when the gate refuses lineage", () => {
  const { requiredTip, root } = fixture();
  git(root, "checkout", "-q", "--orphan", "stale-sender");
  git(root, "rm", "-qrf", ".");
  mkdirSync(join(root, "loop-fork", "src"), { recursive: true });
  writeFileSync(
    join(root, "loop-fork", "src", "protections.ts"),
    "requestedShutdownDecision\nisExactNewWriteTarget\nPROXY_SHUTDOWN_CALLER_HEADER\n"
  );
  writeFileSync(join(root, "body.txt"), "stale\n");
  git(root, "add", "loop-fork/src/protections.ts", "body.txt");
  git(root, "commit", "-qm", "stale sender sibling");

  const { channelLog, result } = runSender(root, requiredTip);
  expect(result.exitCode).toBe(1);
  expect(existsSync(channelLog)).toBe(false);
  expect(result.stderr.toString()).toContain(
    "does not descend from required tip"
  );
});

test("stamped sender refuses exit-zero gate output without a provenance stamp", () => {
  const { requiredTip, root } = fixture();
  const fixtureSender = senderWithGateOutput(root, "status=PASS");

  const { channelLog, result } = runSender(
    root,
    requiredTip,
    "HEAD",
    fixtureSender
  );

  expect(result.exitCode).toBe(1);
  expect(existsSync(channelLog)).toBe(false);
  expect(result.stderr.toString()).toContain(
    "gate output has no provenance stamp"
  );
});

test("stamped sender refuses exit-zero gate output without PASS status", () => {
  const { requiredTip, root } = fixture();
  const fixtureSender = senderWithGateOutput(
    root,
    "REVIEW_GATE_STAMP_V1\nstatus=FAIL"
  );

  const { channelLog, result } = runSender(
    root,
    requiredTip,
    "HEAD",
    fixtureSender
  );

  expect(result.exitCode).toBe(1);
  expect(existsSync(channelLog)).toBe(false);
  expect(result.stderr.toString()).toContain("gate output has no PASS status");
});
