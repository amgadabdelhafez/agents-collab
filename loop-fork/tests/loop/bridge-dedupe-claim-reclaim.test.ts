import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Subprocess, spawn } from "bun";
import {
  acquireBridgeDedupeClaim,
  bridgeDedupeClaimPath,
  bridgeDedupeReclaimMarkerPath,
  enqueueBridgeMessage,
  releaseBridgeDedupeClaim,
} from "../../src/loop/bridge-store";
import type { PidOwnershipDeps } from "../../src/loop/pid-ownership";

// A bridge dedupe claim is a file holding its owner's `pid:uuid` token. A
// process killed inside the claimed critical section never releases it, and
// the claim has no expiry, so every later enqueue with that key was deferred
// forever. A claim is reclaimable only on the run-release evidence standard:
// its owner PID is not alive, or is alive but provably started after the
// claim was written (a reused PID). Anything else is a live owner.

const STORE = join(import.meta.dir, "../../src/loop/bridge-store.ts");
const KEY = "result:inbound-1";
const roots: string[] = [];
const children: Subprocess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const newRun = (): string => {
  const root = mkdtempSync(join(tmpdir(), "bridge-dedupe-reclaim-"));
  roots.push(root);
  return root;
};

const claimPath = (root: string): string =>
  bridgeDedupeClaimPath(root, "claude", "codex", KEY);

/** A child process that takes the claim through the real store code, says
 * what it got, then dies by SIGKILL or waits to be killed. */
const childClaim = async (
  root: string,
  after: "die" | "hold",
  startAtMs = 0
): Promise<{ child: Subprocess; result: string }> => {
  const script = join(root, `child-${randomUUID()}.ts`);
  writeFileSync(
    script,
    `import { acquireBridgeDedupeClaim } from ${JSON.stringify(STORE)};
while (Date.now() < ${startAtMs}) {}
const claim = acquireBridgeDedupeClaim(${JSON.stringify(root)}, "claude", "codex", ${JSON.stringify(KEY)});
process.stdout.write(claim ? "won\\n" : "busy\\n");
if (${JSON.stringify(after)} === "die") process.kill(process.pid, "SIGKILL");
setInterval(() => {}, 1000);
`
  );
  const child = spawn([process.execPath, script], { stdout: "pipe" });
  children.push(child);
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  return { child, result: new TextDecoder().decode(value).trim() };
};

const killedOwner = async (root: string): Promise<number> => {
  const { child, result } = await childClaim(root, "die");
  expect(result).toBe("won");
  await child.exited;
  expect(child.signalCode).toBe("SIGKILL");
  return child.pid;
};

/** A claim file as the store writes one, with a chosen owner and mtime. */
const plantClaim = (path: string, pid: number, writtenAtMs: number): string => {
  const token = `${pid}:${randomUUID()}\n`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token, { mode: 0o600 });
  utimesSync(path, writtenAtMs / 1000, writtenAtMs / 1000);
  return token;
};

const OWNER_PID = 424_242;
const WRITTEN_AT_MS = Date.parse("2026-10-09T10:00:00.000Z");

const deps = (
  alive: boolean,
  startedAt: number | undefined
): PidOwnershipDeps => ({
  isPidAlive: (pid) => alive && pid === OWNER_PID,
  pidStartedAt: (pid) => (pid === OWNER_PID ? startedAt : undefined),
});

const dedupeEnqueue = (root: string) =>
  enqueueBridgeMessage(root, "claude", "codex", "result", { dedupeKey: KEY });

test("a dedupe claim left by a SIGKILLed owner is reclaimed and the keyed enqueue proceeds", async () => {
  const root = newRun();
  await killedOwner(root);
  expect(existsSync(claimPath(root))).toBe(true);

  const result = dedupeEnqueue(root);
  expect(result.reason).toBeUndefined();
  expect(result.status).toBe("queued");
  // The enqueue released its own claim and left no reclaim litter behind.
  expect(readdirSync(dirname(claimPath(root)))).toEqual([]);
});

test("a dedupe claim held by a live owner is never reclaimed, and is reclaimable once that owner is killed", async () => {
  const root = newRun();
  const { child, result } = await childClaim(root, "hold");
  expect(result).toBe("won");
  const held = readFileSync(claimPath(root), "utf8");
  expect(held.startsWith(`${child.pid}:`)).toBe(true);

  expect(
    acquireBridgeDedupeClaim(root, "claude", "codex", KEY)
  ).toBeUndefined();
  expect(dedupeEnqueue(root).status).toBe("deferred");
  expect(readFileSync(claimPath(root), "utf8")).toBe(held);

  child.kill("SIGKILL");
  await child.exited;
  const claim = acquireBridgeDedupeClaim(root, "claude", "codex", KEY);
  expect(claim).toBeDefined();
  expect(readFileSync(claimPath(root), "utf8")).toBe(claim?.token ?? "");
  if (claim) {
    releaseBridgeDedupeClaim(claim);
  }
});

test("concurrent reclaimers of one dead owner's claim produce exactly one owner", async () => {
  const root = newRun();
  await killedOwner(root);
  const startAtMs = Date.now() + 400;
  const results = await Promise.all(
    Array.from({ length: 8 }, () => childClaim(root, "hold", startAtMs))
  );
  const winners = results.filter(({ result }) => result === "won");
  expect(results.map(({ result }) => result).sort()).toEqual([
    "busy",
    "busy",
    "busy",
    "busy",
    "busy",
    "busy",
    "busy",
    "won",
  ]);
  const winner = winners[0]?.child.pid;
  expect(readFileSync(claimPath(root), "utf8").startsWith(`${winner}:`)).toBe(
    true
  );
  expect(readdirSync(dirname(claimPath(root)))).toEqual([
    `${claimPath(root).split("/").at(-1)}`,
  ]);
});

test("ownership evidence: a dead PID, or a live PID that started after the claim was written, releases the claim", () => {
  for (const evidence of [
    deps(false, undefined),
    deps(true, WRITTEN_AT_MS + 1000),
  ]) {
    const root = newRun();
    plantClaim(claimPath(root), OWNER_PID, WRITTEN_AT_MS);
    const claim = acquireBridgeDedupeClaim(
      root,
      "claude",
      "codex",
      KEY,
      evidence
    );
    expect(claim).toBeDefined();
    expect(readFileSync(claimPath(root), "utf8")).toBe(claim?.token ?? "");
  }
});

test("ownership evidence: a live PID with an unknown, equal or earlier start time keeps the claim", () => {
  for (const evidence of [
    deps(true, undefined),
    deps(true, WRITTEN_AT_MS),
    deps(true, WRITTEN_AT_MS - 60_000),
  ]) {
    const root = newRun();
    const token = plantClaim(claimPath(root), OWNER_PID, WRITTEN_AT_MS);
    expect(
      acquireBridgeDedupeClaim(root, "claude", "codex", KEY, evidence)
    ).toBeUndefined();
    expect(readFileSync(claimPath(root), "utf8")).toBe(token);
  }
});

test("a claim without a parsable owner token is never reclaimed", () => {
  for (const body of ["", "not-a-token\n", "0:abc\n", `${OWNER_PID}\n`]) {
    const root = newRun();
    mkdirSync(dirname(claimPath(root)), { recursive: true });
    writeFileSync(claimPath(root), body);
    expect(
      acquireBridgeDedupeClaim(
        root,
        "claude",
        "codex",
        KEY,
        deps(false, undefined)
      )
    ).toBeUndefined();
    expect(readFileSync(claimPath(root), "utf8")).toBe(body);
  }
});

test("a reclaim is serialized: a live reclaimer's marker blocks a second reclaim of the same dead claim", () => {
  const root = newRun();
  const token = plantClaim(claimPath(root), OWNER_PID, WRITTEN_AT_MS);
  const marker = bridgeDedupeReclaimMarkerPath(claimPath(root), token);
  plantClaim(marker, process.pid, Date.now());
  // The claim's owner is dead; the marker's owner (this process) is live.
  const evidence: PidOwnershipDeps = {
    isPidAlive: (pid) => pid === process.pid,
    pidStartedAt: () => undefined,
  };
  expect(
    acquireBridgeDedupeClaim(root, "claude", "codex", KEY, evidence)
  ).toBeUndefined();
  expect(readFileSync(marker, "utf8").startsWith(`${process.pid}:`)).toBe(true);
  expect(readFileSync(claimPath(root), "utf8")).toBe(token);
});

test("a reclaim marker left by a killed reclaimer is itself reclaimed", () => {
  const root = newRun();
  const token = plantClaim(claimPath(root), OWNER_PID, WRITTEN_AT_MS);
  const marker = bridgeDedupeReclaimMarkerPath(claimPath(root), token);
  plantClaim(marker, OWNER_PID, WRITTEN_AT_MS + 1);
  const claim = acquireBridgeDedupeClaim(
    root,
    "claude",
    "codex",
    KEY,
    deps(false, undefined)
  );
  expect(claim).toBeDefined();
  if (claim) {
    releaseBridgeDedupeClaim(claim);
  }
  expect(readdirSync(dirname(claimPath(root)))).toEqual([]);
});

test("a reclaimer that judged a claim dead never removes the live successor that replaced it meanwhile", () => {
  const root = newRun();
  plantClaim(claimPath(root), OWNER_PID, WRITTEN_AT_MS);
  let successor = "";
  // Between this reclaimer's read and its reclaim, another reclaimer finished:
  // the dead claim is gone and a live owner (this process) holds the slot.
  const evidence: PidOwnershipDeps = {
    isPidAlive: (pid) => {
      if (pid === OWNER_PID && !successor) {
        rmSync(claimPath(root));
        successor = plantClaim(claimPath(root), process.pid, Date.now());
      }
      return pid === process.pid;
    },
    pidStartedAt: () => undefined,
  };
  expect(
    acquireBridgeDedupeClaim(root, "claude", "codex", KEY, evidence)
  ).toBeUndefined();
  expect(readFileSync(claimPath(root), "utf8")).toBe(successor);
  expect(readdirSync(dirname(claimPath(root)))).toEqual([
    `${claimPath(root).split("/").at(-1)}`,
  ]);
});
