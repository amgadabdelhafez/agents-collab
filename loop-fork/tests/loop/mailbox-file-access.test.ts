// The orchestration server's mailbox reads and writes, bounded.
//
// 2026-10-11: under launchd the server never opened 127.0.0.1:7321. Its
// start-time reconcile read a mailbox under ~/Documents with readFileSync,
// macOS parked the open behind a privacy (TCC) prompt, and the event loop
// froze before serve(). MailboxFileAccess reads asynchronously under a
// deadline: a parked open costs one binding, never the server.

import { afterAll, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import {
  MAILBOX_FILE_ACCESS_DEADLINE_MS,
  MAILBOX_PRIVACY_HINT,
  MailboxFileAccess,
  type MailboxFileSystem,
  nodeMailboxFileSystem,
} from "../../src/loop/mailbox-file-access";
import { SupervisorMailboxConsumptionReconciler } from "../../src/loop/supervisor-mailbox-consumption";
import { mailboxCursorPathFor } from "../../src/loop/supervisor-mailbox-cursor";
import {
  type MailboxEnvelope,
  MailboxSupervisorMessageDeliveryPort,
} from "../../src/loop/supervisor-mailbox-delivery";
import {
  SupervisorWakeDriver,
  type WakeRequest,
} from "../../src/loop/supervisor-wake-driver";
import { makeFifo, releaseFifo } from "../support/fifo";

const roots: string[] = [];
const fifos: string[] = [];
afterAll(async () => {
  for (const fifo of fifos) {
    if (existsSync(fifo)) {
      await releaseFifo(fifo).catch(() => false);
    }
  }
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

const scratch = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mailbox-access-")));
  roots.push(root);
  return root;
};

const envelope = (key: string, target: string): MailboxEnvelope => ({
  artifactRefs: [],
  at: "2026-10-11T00:00:00.000Z",
  body: "hello",
  delivery: "mailbox",
  idempotencyKey: key,
  messageId: `message-${key}`,
  target,
  threadId: "thread-1",
  workflowId: `supervisor-message:${"a".repeat(64)}`,
});

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

/** A filesystem whose reads of `hung` wait until released; others answer. */
const hungReader = (hung: string, text: string) => {
  const calls: string[] = [];
  let release: (value: string) => void = () => undefined;
  const fs: MailboxFileSystem = {
    ...nodeMailboxFileSystem,
    readFile: (path) => {
      calls.push(path);
      // Only the first read of `hung` is parked, as a prompt parks one open.
      if (
        path === hung &&
        calls.filter((entry) => entry === hung).length === 1
      ) {
        return new Promise<string>((resolve) => {
          release = resolve;
        });
      }
      return Promise.resolve(text);
    },
  };
  return { calls, fs, release: (value: string) => release(value) };
};

const errno = (code: string) =>
  Object.assign(new Error(`${code}: operation refused`), { code });

test("the production deadline is five seconds", () => {
  expect(MAILBOX_FILE_ACCESS_DEADLINE_MS).toBe(5000);
});

test("a hung read times out, marks only its binding, and is never re-entered while it is unsettled", async () => {
  const lines: string[] = [];
  const hung = "/mailboxes/supervisor_a.jsonl";
  const reader = hungReader(hung, line(envelope("k1", "supervisor:b")));
  const access = new MailboxFileAccess({
    deadlineMs: 50,
    fs: reader.fs,
    log: (entry) => lines.push(entry),
  });
  const started = Date.now();
  const [a, b] = await Promise.all([
    access.readMailbox("supervisor:a", hung),
    access.readMailbox("supervisor:b", "/mailboxes/supervisor_b.jsonl"),
  ]);
  expect(Date.now() - started).toBeLessThan(1000);
  expect(a).toEqual({
    kind: "unavailable",
    reason: `${hung} did not answer within 50ms (${MAILBOX_PRIVACY_HINT})`,
  });
  expect(b).toMatchObject({ invalid: 0, kind: "read" });
  expect(access.unreadableBindingCount()).toBe(1);
  expect(lines).toEqual([
    `[loop] supervisor:a: ${hung} is unreadable: no answer within 50ms (${MAILBOX_PRIVACY_HINT})`,
  ]);

  // Still unsettled: refused at once, without entering the filesystem.
  const refusedAt = Date.now();
  const again = await access.readMailbox("supervisor:a", hung);
  expect(Date.now() - refusedAt).toBeLessThan(40);
  expect(again).toEqual({
    kind: "unavailable",
    reason: `an earlier access to ${hung} has not returned (${MAILBOX_PRIVACY_HINT})`,
  });
  expect(reader.calls.filter((path) => path === hung)).toHaveLength(1);
  expect(lines).toHaveLength(1);

  // The prompt is answered: the parked read returns, the next read enters
  // the filesystem again, and recovery is logged once.
  reader.release("");
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(await access.readMailbox("supervisor:a", hung)).toMatchObject({
    kind: "read",
  });
  expect(reader.calls.filter((path) => path === hung)).toHaveLength(2);
  expect(access.unreadableBindingCount()).toBe(0);
  await access.readMailbox("supervisor:a", hung);
  expect(lines).toEqual([
    `[loop] supervisor:a: ${hung} is unreadable: no answer within 50ms (${MAILBOX_PRIVACY_HINT})`,
    `[loop] supervisor:a: ${hung} is readable again`,
  ]);
});

test("EPERM and EACCES mark a binding unreadable, logged once; ENOENT is absent and not unreadable", async () => {
  const lines: string[] = [];
  const fs: MailboxFileSystem = {
    ...nodeMailboxFileSystem,
    readFile: (path) => {
      if (path.includes("/denied.")) {
        return Promise.reject(errno("EPERM"));
      }
      if (path.endsWith("forbidden.jsonl")) {
        return Promise.reject(errno("EACCES"));
      }
      if (path.endsWith("directory.jsonl")) {
        return Promise.reject(errno("EISDIR"));
      }
      return Promise.reject(errno("ENOENT"));
    },
  };
  const access = new MailboxFileAccess({
    fs,
    log: (entry) => lines.push(entry),
  });
  for (let pass = 0; pass < 3; pass += 1) {
    expect(await access.readMailbox("supervisor:a", "/m/denied.jsonl")).toEqual(
      {
        kind: "unavailable",
        reason: `EPERM (${MAILBOX_PRIVACY_HINT})`,
      }
    );
  }
  expect(
    await access.readMailbox("supervisor:c", "/m/forbidden.jsonl")
  ).toMatchObject({ kind: "unavailable" });
  expect(await access.readMailbox("supervisor:b", "/m/absent.jsonl")).toEqual({
    kind: "absent",
  });
  // Another failure is unavailable, as before, but not a privacy refusal.
  expect(
    await access.readMailbox("supervisor:d", "/m/directory.jsonl")
  ).toEqual({ kind: "unavailable", reason: "EISDIR" });
  expect(access.unreadableBindingCount()).toBe(2);
  expect(lines).toEqual([
    `[loop] supervisor:a: /m/denied.jsonl is unreadable: EPERM (${MAILBOX_PRIVACY_HINT})`,
    `[loop] supervisor:c: /m/forbidden.jsonl is unreadable: EACCES (${MAILBOX_PRIVACY_HINT})`,
  ]);
  // An unreadable cursor is unavailable, never an empty cursor (which would
  // read every message as unread).
  expect(
    await access.readCursor("supervisor:a", "/m/denied.cursor.json")
  ).toEqual({ kind: "unavailable", reason: `EPERM (${MAILBOX_PRIVACY_HINT})` });
  expect(
    await access.readCursor("supervisor:b", "/m/absent.cursor.json")
  ).toEqual({
    cursor: {
      consumedAt: null,
      consumedIdempotencyKeys: [],
      schema: "supervisor-mailbox-cursor.v1",
    },
    kind: "read",
  });
});

test("a real FIFO mailbox: the read waits off the event loop, times out, and recovers once the file is readable", async () => {
  const root = scratch();
  const mailbox = join(root, "supervisor_a.jsonl");
  makeFifo(mailbox);
  fifos.push(mailbox);
  const lines: string[] = [];
  const access = new MailboxFileAccess({
    deadlineMs: 200,
    log: (entry) => lines.push(entry),
  });
  let ticks = 0;
  const ticker = setInterval(() => {
    ticks += 1;
  }, 20);
  try {
    const outcome = await access.readMailbox("supervisor:a", mailbox);
    expect(outcome.kind).toBe("unavailable");
    // The event loop kept running while the open was parked.
    expect(ticks).toBeGreaterThanOrEqual(5);
  } finally {
    clearInterval(ticker);
  }
  expect(access.unreadableBindingCount()).toBe(1);
  expect(lines[0]).toContain(mailbox);
  expect(lines[0]).toContain(MAILBOX_PRIVACY_HINT);
  // Answer the prompt: the parked open returns, and the path now holds mail.
  expect(await releaseFifo(mailbox)).toBe(true);
  rmSync(mailbox);
  writeFileSync(mailbox, line(envelope("k1", "supervisor:a")));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(await access.readMailbox("supervisor:a", mailbox)).toMatchObject({
    entries: [{ idempotencyKey: "k1" }],
    kind: "read",
  });
  expect(access.unreadableBindingCount()).toBe(0);
});

test("the FIFO stand-in is faithful: readFileSync on it freezes the event loop", async () => {
  const root = scratch();
  const fifo = join(root, "parked.jsonl");
  makeFifo(fifo);
  fifos.push(fifo);
  const trace = join(root, "trace.log");
  const child = spawn(
    [
      process.execPath,
      "-e",
      `const fs = require("node:fs");
       const [fifo, trace] = process.argv.slice(-2);
       setInterval(() => fs.appendFileSync(trace, "tick\\n"), 10);
       setTimeout(() => {
         fs.appendFileSync(trace, "reading\\n");
         fs.readFileSync(fifo);
         fs.appendFileSync(trace, "read\\n");
         process.exit(0);
       }, 100);`,
      fifo,
      trace,
    ],
    { stderr: "ignore", stdout: "ignore" }
  );
  try {
    const deadline = Date.now() + 5000;
    while (
      !(existsSync(trace) && readFileSync(trace, "utf8").includes("reading"))
    ) {
      if (Date.now() > deadline) {
        throw new Error("the child never started its read");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    const during = readFileSync(trace, "utf8").split("reading\n")[1];
    // Not one tick in 400 ms: the event loop is frozen on the open.
    expect(during).toBe("");
  } finally {
    await releaseFifo(fifo);
    await child.exited;
  }
  expect(readFileSync(trace, "utf8")).toContain("reading\nread\n");
});

test("probes: a parked file is unavailable, a missing one absent, a directory readable", async () => {
  const root = scratch();
  const fifo = join(root, "manifest.json");
  makeFifo(fifo);
  fifos.push(fifo);
  const access = new MailboxFileAccess({ deadlineMs: 100 });
  expect(await access.probe("supervisor:a", fifo, "file")).toBe("unavailable");
  expect(await access.probe("supervisor:a", root, "directory")).toBe(
    "readable"
  );
  expect(
    await access.probe("supervisor:b", join(root, "missing.json"), "file")
  ).toBe("absent");
  expect(access.unreadableBindingCount()).toBe(1);
  await releaseFifo(fifo);
});

test("the mailbox delivery port: a hung append is a transient failure, and a redelivery after it lands is accepted once", async () => {
  const root = scratch();
  const mailbox = join(root, "mailbox", "supervisor_a.jsonl");
  let releaseAppend: () => void = () => undefined;
  let appends = 0;
  const fs: MailboxFileSystem = {
    ...nodeMailboxFileSystem,
    appendFile: async (path, data) => {
      appends += 1;
      if (appends === 1) {
        // The first append is parked; it lands when the prompt is answered.
        await new Promise<void>((resolve) => {
          releaseAppend = resolve;
        });
      }
      appendFileSync(path, data);
    },
  };
  const port = new MailboxSupervisorMessageDeliveryPort({
    access: new MailboxFileAccess({ deadlineMs: 50, fs }),
    directory: { resolveMailbox: () => mailbox },
  });
  const request = {
    artifactRefs: [],
    body: "hello",
    idempotencyKey: "wf:delivery:1",
    messageId: "message-1",
    target: "supervisor:a",
    threadId: "thread-1",
    workflowId: "wf",
  };
  const first = await port.deliver(request as never);
  expect(first.status).toBe("transient-failure");
  expect((first as { reason: string }).reason).toContain(MAILBOX_PRIVACY_HINT);
  // Still unsettled: refused without a second append.
  expect((await port.deliver(request as never)).status).toBe(
    "transient-failure"
  );
  expect(appends).toBe(1);
  releaseAppend();
  await new Promise((resolve) => setTimeout(resolve, 20));
  // The parked append landed; the redelivery finds it and adds nothing.
  expect(await port.deliver(request as never)).toEqual({ status: "accepted" });
  const written = readFileSync(mailbox, "utf8").trim().split("\n");
  expect(written).toHaveLength(1);
  expect(appends).toBe(1);
});

test("the wake driver reads every target concurrently: hung mailboxes are unreadable and another target is still woken", async () => {
  const root = scratch();
  mkdirSync(join(root, "a"));
  mkdirSync(join(root, "b"));
  mkdirSync(join(root, "c"));
  const hung = join(root, "a", "supervisor_a.jsonl");
  const alsoHung = join(root, "c", "supervisor_c.jsonl");
  const ready = join(root, "b", "supervisor_b.jsonl");
  writeFileSync(ready, line(envelope("k1", "supervisor:b")));
  writeFileSync(
    mailboxCursorPathFor(ready),
    JSON.stringify({
      consumedAt: null,
      consumedIdempotencyKeys: [],
      schema: "supervisor-mailbox-cursor.v1",
    })
  );
  const real = nodeMailboxFileSystem;
  const fs: MailboxFileSystem = {
    ...real,
    readFile: (path) =>
      path === hung || path === alsoHung
        ? new Promise<string>(() => undefined)
        : real.readFile(path),
  };
  const woken: WakeRequest[] = [];
  const driver = new SupervisorWakeDriver({
    access: new MailboxFileAccess({ deadlineMs: 300, fs }),
    port: {
      wake: (request) => {
        woken.push(request);
        return Promise.resolve("woken");
      },
    },
    targets: [
      { mailbox: hung, recipient: "supervisor:a", sessionName: "a" },
      { mailbox: ready, recipient: "supervisor:b", sessionName: "b" },
      { mailbox: alsoHung, recipient: "supervisor:c", sessionName: "c" },
    ],
  });
  const started = Date.now();
  const result = await driver.sweep();
  // Concurrent: both hung reads share one 300 ms deadline (in turn: 600 ms).
  expect(Date.now() - started).toBeLessThan(550);
  expect(result.unreadable).toEqual(["supervisor:a", "supervisor:c"]);
  expect(result.woken).toEqual(["supervisor:b"]);
  expect(woken.map((request) => request.unreadKey)).toEqual(["k1"]);
});

test("the mailbox reconciler reads every binding concurrently: hung mailboxes cost one deadline, not one each", async () => {
  const hung = new Set(["/m/a.jsonl", "/m/c.jsonl"]);
  const fs: MailboxFileSystem = {
    ...nodeMailboxFileSystem,
    readFile: (path) =>
      hung.has(path)
        ? new Promise<string>(() => undefined)
        : Promise.reject(errno("ENOENT")),
  };
  const lines: string[] = [];
  const reconciler = new SupervisorMailboxConsumptionReconciler({
    access: new MailboxFileAccess({ deadlineMs: 300, fs }),
    bindings: ["a", "b", "c"].map((name) => ({
      mailbox: `/m/${name}.jsonl`,
      principal: `principal:${name}`,
      supervisorId: `supervisor:${name}`,
    })),
    log: (entry) => lines.push(entry),
    runtime: {
      acknowledge: () => Promise.reject(new Error("not expected")),
      claim: () => Promise.reject(new Error("not expected")),
      threads: () => ({ threads: [] }),
    } as never,
  });
  const started = Date.now();
  const result = await reconciler.reconcile();
  expect(Date.now() - started).toBeLessThan(550);
  expect(result.unreadable).toBe(2);
  // The next pass refuses both at once and logs nothing new.
  const again = Date.now();
  expect((await reconciler.reconcile()).unreadable).toBe(2);
  expect(Date.now() - again).toBeLessThan(100);
  expect(
    lines.filter((entry) => entry.startsWith("[loop] mailbox for"))
  ).toEqual([
    `[loop] mailbox for supervisor:a is unreadable: /m/a.jsonl did not answer within 300ms (${MAILBOX_PRIVACY_HINT})`,
    `[loop] mailbox for supervisor:c is unreadable: /m/c.jsonl did not answer within 300ms (${MAILBOX_PRIVACY_HINT})`,
  ]);
});
