import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FROM_METADATA_KEY } from "../../src/loop/a2a-supervisor-adapter";
import { SupervisorA2AV2Adapter } from "../../src/loop/a2a-supervisor-v2-adapter";
import {
  createConfiguredTokenService,
  createLoopOrchestrationFetchHandler,
  createOwnerReplyLedger,
  enrollmentSource,
  forwardedRequest,
  type OrchestrationGrantDecision,
  orchestrationA2AReceive,
  orchestrationAuthenticator,
  orchestrationAuthority,
  orchestrationGrantDecision,
  parseLoopOrchestrationConfig,
  recordAcceptedOwnerMessage,
  staticTokensAccepted,
  validateConfiguredRuntimeEnvironment,
} from "../../src/loop/loop-orchestration-server";
import {
  IN_REPLY_TO_METADATA_KEY,
  OWNER_NOTIFICATION_PATH,
  OWNER_REPLY_DEFAULT_WINDOW_MS,
  OWNER_REPLY_ONLY,
  OwnerReplyLedger,
} from "../../src/loop/orchestration-owner-messaging";
import {
  type OrchestrationTokenService,
  writeTokenSigningKey,
} from "../../src/loop/orchestration-token-service";
import { createA2AV2SupervisorIngressGate } from "../../src/loop/supervisor-a2a-v2-service";
import { SupervisorMessageGovernanceError } from "../../src/loop/supervisor-message-governance";
import type { SupervisorMessageProjection } from "../../src/loop/supervisor-message-workflow";
import { createSupervisorOrchestrationHttpHandler } from "../../src/loop/supervisor-orchestration-http";
import { SupervisorOrchestrationRuntime } from "../../src/loop/supervisor-orchestration-runtime";
import { JsonlSupervisorThreadStore } from "../../src/loop/supervisor-thread-store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const scratch = (): string => {
  const root = mkdtempSync(join(tmpdir(), "ra2-server-"));
  roots.push(root);
  return root;
};

const OWNER = "supervisor:owner";
const OPERATOR = "supervisor:portfolio";
const SUP = "supervisor:harness";
const WORKER = "supervisor:harness-w1";
const OTHER_SUP = "supervisor:aicur";
const LEGACY = "supervisor:legacy";
const LEGACY_NO_GRANT = "supervisor:legacy-quiet";

const supervisor = (
  id: string,
  role?: { project: string; repoKey: string; role: string }
) => ({
  mailbox: `/private/tmp/ra2/${id.replace(":", "-")}.jsonl`,
  principal: `principal:${id.slice("supervisor:".length)}`,
  ...(role ? { role } : {}),
  supervisorId: id,
  tokenEnv: `LOOP_${id
    .slice("supervisor:".length)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_")}_TOKEN`,
});

const tree = { project: "loop", repoKey: "agents-collab" };

const config = (extra: Record<string, unknown> = {}) => ({
  address: "127.0.0.1:7233",
  buildId: "loop-orchestration.v1",
  grants: [
    // A legacy sender's grant to the owner still needs an owner thread.
    {
      from: LEGACY,
      operations: ["receive"],
      principal: "principal:legacy",
      to: OWNER,
    },
  ],
  hostname: "127.0.0.1",
  identity: "loop-orchestration@local",
  namespace: "default",
  port: 7321,
  schema: "loop-orchestration-server.v1",
  stateDir: "/private/tmp/ra2-state",
  supervisors: [
    supervisor(LEGACY),
    supervisor(LEGACY_NO_GRANT),
    supervisor(OWNER, { project: "all", repoKey: "estate", role: "owner" }),
    supervisor(OPERATOR, {
      project: "all",
      repoKey: "estate",
      role: "operator",
    }),
    supervisor(SUP, { ...tree, role: "supervisor" }),
    supervisor(WORKER, { ...tree, role: "worker" }),
    supervisor(OTHER_SUP, {
      project: "app",
      repoKey: "ai-cur",
      role: "supervisor",
    }),
  ],
  taskQueue: "loop-orchestration",
  ...extra,
});

const principalOf = (id: string) =>
  `principal:${id.slice("supervisor:".length)}`;

describe("RA2 static tokens", () => {
  const STATIC_ENV = { LOOP_LEGACY_TOKEN: "legacy-fixture-token" };
  const bearer = (token: string) =>
    new Request("http://127.0.0.1:7321/api/v1/supervisor-threads", {
      headers: { authorization: `Bearer ${token}` },
    });
  const exposed = (root: string, hostname: string) => {
    const signingKeyFile = join(root, "signing.pem");
    writeTokenSigningKey(signingKeyFile);
    return parseLoopOrchestrationConfig(
      config({
        hostname,
        origin: "https://loop.home.lab",
        stateDir: root,
        tokens: { signingKeyFile },
      })
    );
  };

  test("a static token works on a loopback listener only", () => {
    for (const hostname of ["127.0.0.1", "::1", "localhost"]) {
      expect(staticTokensAccepted({ hostname })).toBe(true);
    }
    for (const hostname of ["0.0.0.0", "100.64.0.5", "loop.home.lab", "::"]) {
      expect(staticTokensAccepted({ hostname })).toBe(false);
    }
  });

  test("beyond loopback a static token authenticates nobody; a session token does", () => {
    for (const hostname of ["0.0.0.0", "100.64.0.5"]) {
      const parsed = exposed(scratch(), hostname);
      const tokens = createConfiguredTokenService(
        parsed
      ) as OrchestrationTokenService;
      const authenticator = orchestrationAuthenticator(
        parsed,
        STATIC_ENV,
        tokens
      );
      expect(
        authenticator.authenticate(bearer("legacy-fixture-token"))
      ).toBeUndefined();
      const { code } = tokens.issueEnrollmentCode({ kind: "host" }, SUP);
      const session = tokens.enroll(code)?.token as string;
      expect(authenticator.authenticate(bearer(session))).toEqual({
        principal: principalOf(SUP),
        supervisorId: SUP,
      });
    }
    // The same key and env on a loopback listener keep the static token.
    const loopback = exposed(scratch(), "127.0.0.1");
    expect(
      orchestrationAuthenticator(loopback, STATIC_ENV).authenticate(
        bearer("legacy-fixture-token")
      )
    ).toEqual({ principal: "principal:legacy", supervisorId: LEGACY });
  });

  test("beyond loopback the static token variables are not required to start", () => {
    expect(() =>
      validateConfiguredRuntimeEnvironment(
        exposed(scratch(), "127.0.0.1"),
        {},
        {}
      )
    ).toThrow("missing orchestration token environment");
    expect(() =>
      validateConfiguredRuntimeEnvironment(
        exposed(scratch(), "0.0.0.0"),
        {},
        {}
      )
    ).not.toThrow();
  });
});

describe("RA2 messaging policy", () => {
  const parsed = parseLoopOrchestrationConfig(config());
  const OWNER_MESSAGE = "owner-m-1";
  /** A ledger in which the owner sent OWNER_MESSAGE to each recipient. */
  const ledgerFor = (...recipients: string[]) => {
    const ledger = new OwnerReplyLedger({
      file: join(scratch(), "owner-replies.json"),
    });
    for (const recipient of recipients) {
      ledger.recordOwnerMessage({
        messageId: OWNER_MESSAGE,
        owner: OWNER,
        recipient,
      });
    }
    return ledger;
  };
  const decide = (
    from: string,
    to: string,
    options: {
      claimant?: string;
      inReplyTo?: string;
      ledger?: OwnerReplyLedger;
      operation?: "acknowledge" | "cancel" | "claim" | "receive" | "tick";
      principal?: string;
      replyKey?: string;
      threadId?: string;
    } = {}
  ) =>
    orchestrationGrantDecision(
      parsed,
      {
        ...(options.claimant ? { claimant: options.claimant } : {}),
        from,
        ...(options.inReplyTo ? { inReplyTo: options.inReplyTo } : {}),
        operation: options.operation ?? "receive",
        principal: options.principal ?? principalOf(from),
        ...(options.replyKey
          ? { replyKey: options.replyKey, replyPlane: "v1" as const }
          : {}),
        ...(options.threadId ? { threadId: options.threadId } : {}),
        to,
      },
      options.ledger
    );
  const allowed: OrchestrationGrantDecision = {
    allowed: true,
    reasonCode: "configured-grant",
  };
  const denied: OrchestrationGrantDecision = {
    allowed: false,
    reasonCode: "no-configured-grant",
  };
  const replyOnly: OrchestrationGrantDecision = {
    allowed: false,
    reasonCode: OWNER_REPLY_ONLY,
  };

  test("a supervisor messages an operator; a worker does not", () => {
    expect(decide(SUP, OPERATOR)).toEqual(allowed);
    expect(decide(OTHER_SUP, OPERATOR)).toEqual(allowed);
    expect(decide(WORKER, OPERATOR)).toEqual(denied);
    // Only as itself.
    expect(decide(SUP, OPERATOR, { principal: principalOf(WORKER) })).toEqual(
      denied
    );
  });

  test("a supervisor replies to the owner only to an owner message sent to it, once", () => {
    const ledger = ledgerFor(SUP);
    const reply = (
      replyKey: string,
      extra: Parameters<typeof decide>[2] = {}
    ) =>
      decide(SUP, OWNER, {
        inReplyTo: OWNER_MESSAGE,
        ledger,
        replyKey,
        ...extra,
      });
    // No owner message named, no ledger, or one never sent to this replier.
    expect(decide(SUP, OWNER, { ledger, replyKey: "r-1" })).toEqual(replyOnly);
    expect(decide(SUP, OWNER, { inReplyTo: OWNER_MESSAGE, ledger })).toEqual(
      replyOnly
    );
    expect(
      decide(SUP, OWNER, { inReplyTo: OWNER_MESSAGE, replyKey: "r-1" })
    ).toEqual(replyOnly);
    expect(reply("r-1", { inReplyTo: "owner-m-other" })).toEqual(replyOnly);
    expect(
      decide(OTHER_SUP, OWNER, {
        inReplyTo: OWNER_MESSAGE,
        ledger,
        replyKey: "r-1",
      })
    ).toEqual(replyOnly);
    // The thread a caller names grants nothing on its own.
    expect(decide(SUP, OWNER, { ledger, threadId: "t-owner" })).toEqual(
      replyOnly
    );
    // A refused reply (not as itself) spends nothing.
    expect(reply("r-0", { principal: principalOf(OTHER_SUP) })).toEqual(denied);
    // Not as itself and naming no live owner message: the owner path.
    expect(
      reply("r-0", {
        inReplyTo: "owner-m-other",
        principal: principalOf(OTHER_SUP),
      })
    ).toEqual(replyOnly);
    expect(reply("r-1")).toEqual(allowed);
    // A retry of the same reply is the same reply; another one is refused.
    expect(reply("r-1")).toEqual(allowed);
    expect(reply("r-2")).toEqual(replyOnly);
    expect(reply("r-2", { threadId: "t-owner" })).toEqual(replyOnly);
  });

  test("a worker or an operator gets the owner-reply-only refusal, reply or not", () => {
    const ledger = ledgerFor(WORKER, OPERATOR);
    for (const from of [WORKER, OPERATOR]) {
      expect(decide(from, OWNER)).toEqual(replyOnly);
      expect(
        decide(from, OWNER, {
          inReplyTo: OWNER_MESSAGE,
          ledger,
          replyKey: "r-1",
        })
      ).toEqual(replyOnly);
      // Only a send is told the owner path; the other operations stay denied.
      expect(decide(from, OWNER, { operation: "tick" })).toEqual(denied);
    }
  });

  test("a sender without a role reaches the owner only by its grant and an owner message", () => {
    const ledger = ledgerFor(LEGACY, LEGACY_NO_GRANT);
    expect(decide(LEGACY, OWNER)).toEqual(replyOnly);
    const query = (from: string) => ({
      inReplyTo: OWNER_MESSAGE,
      owner: OWNER,
      plane: "v1" as const,
      replier: from,
      replyKey: "r-other",
    });
    // No grant: denied, and the allowance is not spent.
    expect(
      decide(LEGACY_NO_GRANT, OWNER, {
        inReplyTo: OWNER_MESSAGE,
        ledger,
        replyKey: "r-1",
      })
    ).toEqual(denied);
    expect(ledger.replyAvailable(query(LEGACY_NO_GRANT))).toBe(true);
    // No grant and no live owner message: the owner path comes first.
    expect(
      decide(LEGACY_NO_GRANT, OWNER, {
        inReplyTo: "owner-m-404",
        ledger,
        replyKey: "r-1",
      })
    ).toEqual(replyOnly);
    expect(
      decide(LEGACY, OWNER, {
        inReplyTo: OWNER_MESSAGE,
        ledger,
        replyKey: "r-1",
      })
    ).toEqual(allowed);
    expect(
      decide(LEGACY, OWNER, {
        inReplyTo: OWNER_MESSAGE,
        ledger,
        replyKey: "r-2",
      })
    ).toEqual(replyOnly);
  });

  test("a reply whose allowance cannot be taken durably is refused", () => {
    const taken: unknown[] = [];
    const flaky = {
      replyAvailable: () => true,
      takeReply: (query: unknown) => {
        taken.push(query);
        return false;
      },
    };
    const request = {
      from: SUP,
      inReplyTo: OWNER_MESSAGE,
      operation: "receive" as const,
      principal: principalOf(SUP),
      replyKey: "r-1",
      replyPlane: "v1" as const,
      to: OWNER,
    };
    expect(orchestrationGrantDecision(parsed, request, flaky)).toEqual(
      replyOnly
    );
    // A refused request never reaches the take.
    expect(
      orchestrationGrantDecision(
        parsed,
        { ...request, principal: principalOf(OTHER_SUP) },
        flaky
      )
    ).toEqual(denied);
    expect(taken).toEqual([
      {
        inReplyTo: OWNER_MESSAGE,
        owner: OWNER,
        plane: "v1",
        replier: SUP,
        replyKey: "r-1",
      },
    ]);
    // A reply that names no plane names no reply identity.
    const { replyPlane: _plane, ...planeless } = request;
    expect(orchestrationGrantDecision(parsed, planeless, flaky)).toEqual(
      replyOnly
    );
    expect(taken.length).toBe(1);
  });

  test("the other operations on a reply are not re-gated by the ledger", () => {
    expect(
      decide(SUP, OWNER, {
        claimant: OWNER,
        operation: "claim",
        principal: principalOf(OWNER),
      })
    ).toEqual(allowed);
    for (const operation of ["cancel", "tick"] as const) {
      expect(decide(SUP, OWNER, { operation })).toEqual(allowed);
    }
    expect(decide(SUP, OWNER, { claimant: SUP, operation: "claim" })).toEqual(
      denied
    );
  });

  test("the V1 authority reports the owner-reply-only reason and spends one reply", () => {
    const authority = orchestrationAuthority(parsed, ledgerFor(SUP));
    const request = {
      from: SUP,
      operation: "receive" as const,
      principal: principalOf(SUP),
      threadId: "t-any",
      to: OWNER,
    };
    expect(authority.decide({ ...request, replyKey: "dedupe-1" })).toEqual({
      allowed: false,
      authorityRef: "authority:deny-default",
      reasonCode: OWNER_REPLY_ONLY,
    });
    const reply = (replyKey: string) =>
      authority.decide({ ...request, inReplyTo: OWNER_MESSAGE, replyKey });
    expect(reply("dedupe-1")).toEqual({
      allowed: true,
      authorityRef: "authority:loop-orchestration-config",
      reasonCode: "configured-grant",
    });
    expect(reply("dedupe-2")).toMatchObject({ reasonCode: OWNER_REPLY_ONLY });
  });
});

describe("RA2 owner reply ledger", () => {
  const sent = { messageId: "owner-m-1", owner: OWNER, recipient: SUP };
  const query = (replyKey: string, inReplyTo = "owner-m-1") => ({
    inReplyTo,
    owner: OWNER,
    plane: "v1" as const,
    replier: SUP,
    replyKey,
  });

  test("it is a 0600 file a restart reads back, replies and all", () => {
    const file = join(scratch(), "state", "owner-replies.json");
    const clock = { now: 1000 };
    const open = () =>
      new OwnerReplyLedger({
        file,
        now: () => clock.now,
        policy: { maxReplies: 2, windowMs: 10_000 },
      });
    const ledger = open();
    expect(ledger.recordOwnerMessage(sent)).toBe(true);
    // biome-ignore lint/suspicious/noBitwiseOperators: file mode bits.
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(ledger.takeReply(query("r-1"))).toBe(true);
    const restarted = open();
    expect(restarted.broken).toBeUndefined();
    expect(restarted.size).toBe(1);
    expect(restarted.takeReply(query("r-1"))).toBe(true);
    expect(restarted.takeReply(query("r-2"))).toBe(true);
    expect(restarted.replyAvailable(query("r-3"))).toBe(false);
    expect(open().takeReply(query("r-3"))).toBe(false);
  });

  test("the allowance ends with its window, and a resend does not renew it", () => {
    const clock = { now: 0 };
    const ledger = new OwnerReplyLedger({
      file: join(scratch(), "owner-replies.json"),
      now: () => clock.now,
      policy: { windowMs: 1000 },
    });
    ledger.recordOwnerMessage(sent);
    clock.now = 600;
    // The owner resends the same message: same id, same window.
    ledger.recordOwnerMessage(sent);
    clock.now = 999;
    expect(ledger.replyAvailable(query("r-1"))).toBe(true);
    clock.now = 1000;
    expect(ledger.replyAvailable(query("r-1"))).toBe(false);
    expect(ledger.takeReply(query("r-1"))).toBe(false);
  });

  test("the default allows one reply within 24 hours", () => {
    const clock = { now: 0 };
    const ledger = new OwnerReplyLedger({
      file: join(scratch(), "owner-replies.json"),
      now: () => clock.now,
    });
    ledger.recordOwnerMessage(sent);
    clock.now = OWNER_REPLY_DEFAULT_WINDOW_MS - 1;
    expect(ledger.takeReply(query("r-1"))).toBe(true);
    expect(ledger.takeReply(query("r-2"))).toBe(false);
    ledger.recordOwnerMessage({ ...sent, messageId: "owner-m-2" });
    clock.now += OWNER_REPLY_DEFAULT_WINDOW_MS;
    expect(ledger.takeReply(query("r-3", "owner-m-2"))).toBe(false);
  });

  test("it is bounded by count: the oldest owner message is forgotten", () => {
    const ledger = new OwnerReplyLedger({
      file: join(scratch(), "owner-replies.json"),
      maxEntries: 2,
    });
    for (const messageId of ["a", "b", "c"]) {
      ledger.recordOwnerMessage({ ...sent, messageId });
    }
    expect(ledger.size).toBe(2);
    expect(
      ["a", "b", "c"].map((id) => ledger.replyAvailable(query("r", id)))
    ).toEqual([false, true, true]);
  });

  test("a ledger file that is not a valid 0600 regular file refuses everything and is kept", () => {
    const valid = (file: string) => {
      const ledger = new OwnerReplyLedger({ file });
      ledger.recordOwnerMessage(sent);
    };
    const cases: [string, (file: string) => void][] = [
      [
        "group readable",
        (file) => {
          valid(file);
          chmodSync(file, 0o640);
        },
      ],
      [
        "symlink",
        (file) => {
          const target = `${file}.target`;
          valid(target);
          symlinkSync(target, file);
        },
      ],
      ["not json", (file) => writeFileSync(file, "{not json", { mode: 0o600 })],
      [
        "wrong schema",
        (file) =>
          writeFileSync(
            file,
            JSON.stringify({ entries: [], schema: "other.v1" }),
            { mode: 0o600 }
          ),
      ],
      [
        "bad entry",
        (file) =>
          writeFileSync(
            file,
            JSON.stringify({
              entries: [{ ...sent, acceptedAt: "now", replies: [] }],
              schema: "loop-owner-replies.v1",
            }),
            { mode: 0o600 }
          ),
      ],
    ];
    for (const [label, make] of cases) {
      const file = join(scratch(), "owner-replies.json");
      make(file);
      const before = readFileSync(file, "utf8");
      const ledger = new OwnerReplyLedger({ file });
      expect([label, ledger.broken]).toEqual([label, expect.any(String)]);
      expect(ledger.recordOwnerMessage(sent)).toBe(false);
      expect(ledger.replyAvailable(query("r-1"))).toBe(false);
      expect(ledger.takeReply(query("r-1"))).toBe(false);
      expect(readFileSync(file, "utf8")).toBe(before);
    }
  });

  test("a ledger path that is not a regular file is refused as such, whatever its mode", () => {
    const file = join(scratch(), "owner-replies.json");
    mkdirSync(file, { mode: 0o700 });
    const ledger = new OwnerReplyLedger({ file });
    expect(ledger.broken).toContain("regular 0600 file");
    expect(ledger.recordOwnerMessage(sent)).toBe(false);
    expect(statSync(file).isDirectory()).toBe(true);
  });

  test("a write that fails is rolled back: nothing is recorded or spent", () => {
    const dir = join(scratch(), "state");
    const ledger = new OwnerReplyLedger({
      file: join(dir, "owner-replies.json"),
    });
    expect(ledger.recordOwnerMessage(sent)).toBe(true);
    chmodSync(dir, 0o500);
    try {
      expect(
        ledger.recordOwnerMessage({ ...sent, messageId: "owner-m-2" })
      ).toBe(false);
      expect(ledger.replyAvailable(query("r-1", "owner-m-2"))).toBe(false);
      expect(ledger.takeReply(query("r-1"))).toBe(false);
      expect(ledger.replyAvailable(query("r-1"))).toBe(true);
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(ledger.takeReply(query("r-1"))).toBe(true);
  });
});

describe("RA2 owner messages are recorded only once accepted", () => {
  const parsed = parseLoopOrchestrationConfig(config());
  const ledger = () =>
    createOwnerReplyLedger({ stateDir: join(scratch(), "state") });

  test("the A2A gate decides without recording; acceptance records an owner's message only", () => {
    const replies = ledger();
    const send = (
      from: string,
      to: string,
      extra: { inReplyTo?: string; messageId?: string; principal?: string } = {}
    ) =>
      orchestrationA2AReceive(parsed, replies, {
        from,
        principal: extra.principal ?? principalOf(from),
        to,
        ...(extra.inReplyTo ? { inReplyTo: extra.inReplyTo } : {}),
        ...(extra.messageId ? { messageId: extra.messageId } : {}),
      });
    expect(send(SUP, OWNER, { messageId: "r-0" })).toBe(OWNER_REPLY_ONLY);
    expect(send(OWNER, SUP, { messageId: "owner-m-1" })).toBe(true);
    expect(
      send(OWNER, SUP, { messageId: "owner-m-1", principal: principalOf(SUP) })
    ).toBe(false);
    // Allowed by the gate, not yet accepted: nothing to reply to.
    expect(replies.size).toBe(0);
    expect(send(SUP, OWNER, { inReplyTo: "owner-m-1", messageId: "r-1" })).toBe(
      OWNER_REPLY_ONLY
    );
    const logged: string[] = [];
    const accept = (from: string, to: string, messageId: string) =>
      recordAcceptedOwnerMessage(
        parsed,
        replies,
        { from, messageId, to },
        (line) => logged.push(line)
      );
    accept(SUP, OPERATOR, "sup-m-1");
    accept(LEGACY, OWNER, "legacy-m-1");
    expect(replies.size).toBe(0);
    accept(OWNER, SUP, "owner-m-1");
    expect(replies.size).toBe(1);
    expect(logged).toEqual([]);
    expect(send(SUP, OWNER, { inReplyTo: "owner-m-1", messageId: "r-1" })).toBe(
      true
    );
    expect(send(SUP, OWNER, { inReplyTo: "owner-m-1", messageId: "r-1" })).toBe(
      true
    );
    expect(send(SUP, OWNER, { inReplyTo: "owner-m-1", messageId: "r-2" })).toBe(
      OWNER_REPLY_ONLY
    );
    // A reply without its own message id names no reply identity.
    accept(OWNER, SUP, "owner-m-2");
    expect(send(SUP, OWNER, { inReplyTo: "owner-m-2" })).toBe(OWNER_REPLY_ONLY);
    expect(
      send(OTHER_SUP, OWNER, { inReplyTo: "owner-m-2", messageId: "r-9" })
    ).toBe(OWNER_REPLY_ONLY);
    expect(
      send(WORKER, OWNER, { inReplyTo: "owner-m-2", messageId: "r-9" })
    ).toBe(OWNER_REPLY_ONLY);
  });

  test("an owner message the ledger cannot record is logged and leaves no reply", () => {
    const logged: string[] = [];
    recordAcceptedOwnerMessage(
      parsed,
      {
        recordOwnerMessage: () => {
          throw new Error("disk full");
        },
      },
      { from: OWNER, messageId: "owner-m-1", to: SUP },
      (line) => logged.push(line)
    );
    recordAcceptedOwnerMessage(
      parsed,
      { recordOwnerMessage: () => false },
      { from: OWNER, messageId: "owner-m-1", to: SUP },
      (line) => logged.push(line)
    );
    expect(logged.length).toBe(2);
    expect(logged[0]).toContain("cannot reply");
  });

  test("the V1 runtime tells its hook only after the governed receive and the board append", async () => {
    const store = new JsonlSupervisorThreadStore(
      join(scratch(), "threads.jsonl")
    );
    const seen: unknown[] = [];
    const calls: unknown[] = [];
    let refuse = false;
    const workflowId = `supervisor-message:${"a".repeat(64)}`;
    const runtime = new SupervisorOrchestrationRuntime({
      governed: {
        receive: (...args: unknown[]) => {
          calls.push(args);
          return refuse
            ? Promise.reject(new Error("authority denied"))
            : Promise.resolve({
                created: true,
                projection: projection({
                  from: OWNER,
                  messageId: "owner-m-1",
                  to: SUP,
                }),
                workflowId,
              });
        },
      } as never,
      onReceived: (accepted) => {
        seen.push({ accepted, board: store.read().threads.length });
        throw new Error("a hook failure never fails the receive");
      },
      store,
    });
    const input = {
      from: OWNER,
      messageId: "owner-m-1",
      threadId: "t",
      to: SUP,
    };
    const command = {
      inReplyTo: "owner-m-0",
      input: input as never,
      messageKind: "question" as const,
      principal: principalOf(OWNER),
      requestId: "request-1",
    };
    await runtime.receive(command);
    expect(calls[0]).toEqual([
      principalOf(OWNER),
      input,
      "request-1",
      { inReplyTo: "owner-m-0" },
    ]);
    expect(seen).toEqual([
      {
        accepted: { from: OWNER, messageId: "owner-m-1", to: SUP },
        board: 1,
      },
    ]);
    refuse = true;
    await expect(runtime.receive(command)).rejects.toThrow("authority denied");
    expect(seen.length).toBe(1);
  });

  test("the A2A adapter tells its hook only once the V2 receive returned", async () => {
    const seen: unknown[] = [];
    let refuse = false;
    const adapter = new SupervisorA2AV2Adapter({
      coordinator: {
        receive: () =>
          refuse
            ? Promise.reject(new Error("start intent refused"))
            : Promise.resolve({
                created: true,
                projection: {
                  from: OWNER,
                  messageId: "owner-m-1",
                  phase: "routed",
                  to: SUP,
                },
                workflowId: "wf-1",
              }),
      } as never,
      now: () => "2026-10-11T07:00:00.000Z",
      onAccepted: (accepted) => {
        seen.push(accepted);
        throw new Error("a hook failure never fails the send");
      },
      policy: {
        claimTimeoutMs: 60_000,
        escalationTimeoutMs: 120_000,
        maxDeliveryAttempts: 3,
        retryDelayMs: 1000,
      },
      supervisorId: SUP,
    });
    const send = () =>
      adapter.sendMessage({
        message: {
          contextId: "ctx-1",
          messageId: "owner-m-1",
          metadata: { [FROM_METADATA_KEY]: OWNER },
          parts: [{ content: { $case: "text", value: "please review" } }],
        } as never,
        principal: principalOf(OWNER),
        tenant: "tenant-1",
      });
    expect((await send()).taskId).toBe("wf-1");
    expect(seen).toEqual([{ from: OWNER, messageId: "owner-m-1", to: SUP }]);
    refuse = true;
    await expect(send()).rejects.toThrow("start intent refused");
    expect(seen.length).toBe(1);
  });

  test("a reply key spent on one plane is not a retry on the other", () => {
    for (const first of ["v1", "a2a"] as const) {
      const replies = ledger();
      recordAcceptedOwnerMessage(parsed, replies, {
        from: OWNER,
        messageId: "owner-m-1",
        to: SUP,
      });
      const v1 = (replyKey: string) => {
        const decision = orchestrationAuthority(parsed, replies).decide({
          from: SUP,
          inReplyTo: "owner-m-1",
          operation: "receive",
          principal: principalOf(SUP),
          replyKey,
          threadId: "t-reply",
          to: OWNER,
        });
        return "allowed" in decision && decision.allowed;
      };
      const a2a = (messageId: string) =>
        orchestrationA2AReceive(parsed, replies, {
          from: SUP,
          inReplyTo: "owner-m-1",
          messageId,
          principal: principalOf(SUP),
          to: OWNER,
        }) === true;
      const [spend, other] = first === "v1" ? [v1, a2a] : [a2a, v1];
      expect(spend("r-1")).toBe(true);
      // A retry on the same plane is the same reply.
      expect(spend("r-1")).toBe(true);
      // The same key on the other plane is a second, distinct message.
      expect(other("r-1")).toBe(false);
    }
  });

  test("a V1 receive that dedupes onto another message writes no board item and reopens no owner message", async () => {
    const clock = { now: 0 };
    const replies = new OwnerReplyLedger({
      file: join(scratch(), "owner-replies.json"),
      now: () => clock.now,
      policy: { windowMs: 1000 },
    });
    const store = new JsonlSupervisorThreadStore(
      join(scratch(), "threads.jsonl")
    );
    const ownerMessage = projection({
      from: OWNER,
      messageId: "owner-m-1",
      threadId: "t-owner",
      to: SUP,
    });
    const seen: unknown[] = [];
    const runtime = new SupervisorOrchestrationRuntime({
      governed: {
        // The dedupe key names the owner's existing workflow: the
        // coordinator answers with that message, not the one sent.
        receive: () =>
          Promise.resolve({
            created: false,
            projection: ownerMessage,
            workflowId: `supervisor-message:${"b".repeat(64)}`,
          }),
      } as never,
      onReceived: (accepted) => {
        seen.push(accepted);
        recordAcceptedOwnerMessage(parsed, replies, accepted, () => undefined);
      },
      store,
    });
    const query = (replyKey: string) => ({
      inReplyTo: "owner-m-1",
      owner: OWNER,
      plane: "v1" as const,
      replier: SUP,
      replyKey,
    });
    replies.recordOwnerMessage({
      messageId: "owner-m-1",
      owner: OWNER,
      recipient: SUP,
    });
    expect(replies.takeReply(query("r-1"))).toBe(true);
    // The window ends; a later owner message prunes the spent one.
    clock.now = 1000;
    replies.recordOwnerMessage({
      messageId: "owner-m-2",
      owner: OWNER,
      recipient: SUP,
    });
    // The supervisor sends to an operator (allowed) under the owner
    // message's dedupe key.
    await expect(
      runtime.receive({
        input: {
          dedupeKey: "owner-dedupe-1",
          from: SUP,
          messageId: "sup-m-1",
          threadId: "t-sup",
          to: OPERATOR,
        } as never,
        messageKind: "question",
        principal: principalOf(SUP),
        requestId: "request-collide",
      })
    ).rejects.toThrow();
    expect(store.read().threads).toEqual([]);
    expect(seen).toEqual([]);
    expect(replies.replyAvailable(query("r-2"))).toBe(false);
    // The owner's own retry of its message is not a new acceptance either.
    await runtime.receive({
      input: {
        dedupeKey: "owner-dedupe-1",
        from: OWNER,
        messageId: "owner-m-1",
        threadId: "t-owner",
        to: SUP,
      } as never,
      messageKind: "question",
      principal: principalOf(OWNER),
      requestId: "request-retry",
    });
    expect(seen).toEqual([]);
    expect(replies.replyAvailable(query("r-2"))).toBe(false);
  });
});

describe("RA2 owner reply configuration", () => {
  test("ownerReplies is optional and bounded", () => {
    expect(parseLoopOrchestrationConfig(config()).ownerReplies).toBeUndefined();
    expect(
      parseLoopOrchestrationConfig(config({ ownerReplies: { maxReplies: 3 } }))
        .ownerReplies
    ).toEqual({ maxReplies: 3, windowMs: OWNER_REPLY_DEFAULT_WINDOW_MS });
    for (const ownerReplies of [
      { maxReplies: 0 },
      { maxReplies: 21 },
      { windowMs: 59_999 },
      { windowMs: 31 * 24 * 60 * 60 * 1000 },
      { maxReplies: 1.5 },
      { other: 1 },
      [],
    ]) {
      expect(() =>
        parseLoopOrchestrationConfig(config({ ownerReplies }))
      ).toThrow("ownerReplies");
    }
  });

  test("the server's ledger applies the configured policy", () => {
    const clock = { now: 0 };
    const stateDir = join(scratch(), "state");
    const ledger = createOwnerReplyLedger(
      parseLoopOrchestrationConfig(
        config({ ownerReplies: { maxReplies: 2, windowMs: 60_000 }, stateDir })
      ),
      () => clock.now
    );
    ledger.recordOwnerMessage({
      messageId: "owner-m-1",
      owner: OWNER,
      recipient: SUP,
    });
    const take = (replyKey: string) =>
      ledger.takeReply({
        inReplyTo: "owner-m-1",
        owner: OWNER,
        plane: "v1",
        replier: SUP,
        replyKey,
      });
    expect([take("r-1"), take("r-2"), take("r-3")]).toEqual([
      true,
      true,
      false,
    ]);
    ledger.recordOwnerMessage({
      messageId: "owner-m-2",
      owner: OWNER,
      recipient: SUP,
    });
    clock.now = 60_000;
    expect(
      ledger.replyAvailable({
        inReplyTo: "owner-m-2",
        owner: OWNER,
        plane: "v1",
        replier: SUP,
        replyKey: "r-4",
      })
    ).toBe(false);
  });
});

const projection = (
  overrides: Partial<SupervisorMessageProjection>
): SupervisorMessageProjection => ({
  acknowledgedAt: null,
  actionRequired: "claim",
  artifactRefs: [],
  claimedAt: null,
  claimedBy: null,
  deadLetteredAt: null,
  deliveredAt: "2026-10-11T07:00:00.000Z",
  deliveryAttempts: 1,
  escalatedAt: null,
  from: OWNER,
  messageId: "m",
  nextRetryAt: null,
  phase: "routed",
  receivedAt: "2026-10-11T07:00:00.000Z",
  schema: "supervisor-message-status.v1",
  threadId: "t",
  to: SUP,
  ...overrides,
});

describe("RA2 refusal surfaces", () => {
  const ownerRefusal = {
    code: OWNER_REPLY_ONLY,
    message: expect.stringContaining(
      `attention-os interaction (${OWNER_NOTIFICATION_PATH}, delivered with ntfy)`
    ),
    notifyVia: OWNER_NOTIFICATION_PATH,
  };

  test("the A2A ingress names the attention-os path and passes the context, message and reply ids", async () => {
    const asked: unknown[] = [];
    const gate = createA2AV2SupervisorIngressGate({
      authenticator: {
        authenticate: () => ({
          principal: principalOf(SUP),
          supervisorId: SUP,
        }),
      },
      mayReceive: (request) => {
        asked.push(request);
        return request.to === OWNER ? OWNER_REPLY_ONLY : false;
      },
    });
    let sdkCalls = 0;
    const sdk = () => {
      sdkCalls += 1;
      return Promise.resolve(new Response("sdk"));
    };
    const send = (to: string, contextId?: string, inReplyTo?: string) =>
      gate(
        new Request("http://127.0.0.1:7321/a2a/v2/supervisors/x", {
          body: JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            method: "SendMessage",
            params: {
              message: {
                ...(contextId === undefined ? {} : { contextId }),
                messageId: "m-1",
                metadata: {
                  [FROM_METADATA_KEY]: SUP,
                  ...(inReplyTo === undefined
                    ? {}
                    : { [IN_REPLY_TO_METADATA_KEY]: inReplyTo }),
                },
                parts: [{ text: "done" }],
                role: "ROLE_USER",
              },
            },
          }),
          headers: {
            authorization: "Bearer x",
            "content-type": "application/json",
          },
          method: "POST",
        }),
        to,
        sdk
      );
    const refused = await send(OWNER, "ctx-1");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: ownerRefusal });
    const other = await send(OPERATOR, "   ");
    expect(await other.json()).toEqual({
      error: { code: "identity-mismatch" },
    });
    await send(OWNER);
    await send(OWNER, undefined, "owner-m-1");
    await send(OWNER, undefined, "  ");
    const base = { from: SUP, messageId: "m-1", principal: principalOf(SUP) };
    expect(asked).toEqual([
      { ...base, threadId: "ctx-1", to: OWNER },
      { ...base, to: OPERATOR },
      { ...base, to: OWNER },
      { ...base, inReplyTo: "owner-m-1", to: OWNER },
      { ...base, to: OWNER },
    ]);
    expect(sdkCalls).toBe(0);
  });

  test("the V1 surface passes inReplyTo through and names the attention-os path for an owner-reply-only refusal", async () => {
    let reasonCode = OWNER_REPLY_ONLY;
    const received: unknown[] = [];
    const handler = createSupervisorOrchestrationHttpHandler({
      authenticator: {
        authenticate: () => ({
          principal: principalOf(SUP),
          supervisorId: SUP,
        }),
      },
      messages: {
        receive: (command: unknown) =>
          received.push(command) &&
          Promise.reject(
            new SupervisorMessageGovernanceError({
              allowed: false,
              authorityRef: "authority:deny-default",
              reasonCode,
            })
          ),
      } as never,
      tasks: {} as never,
    });
    const send = (extra: Record<string, unknown> = {}) =>
      handler(
        new Request(
          "http://127.0.0.1:7321/api/v1/supervisor-messages/receive",
          {
            body: JSON.stringify({
              input: { from: SUP, to: OWNER },
              messageKind: "informational",
              requestId: "request-1",
              ...extra,
            }),
            headers: {
              authorization: "Bearer x",
              "content-type": "application/json",
            },
            method: "POST",
          }
        )
      );
    const refused = await send();
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: ownerRefusal });
    reasonCode = "no-configured-grant";
    expect(await (await send()).json()).toEqual({
      error: { code: "authority-denied" },
    });
    expect((await send({ inReplyTo: "owner-m-1" })).status).toBe(403);
    expect(received.at(-1)).toMatchObject({ inReplyTo: "owner-m-1" });
    expect(received[0]).not.toHaveProperty("inReplyTo");
    const count = received.length;
    for (const extra of [
      { inReplyTo: "../x" },
      { inReplyTo: 7 },
      { other: "x" },
    ]) {
      expect((await send(extra)).status).toBe(400);
    }
    expect(received.length).toBe(count);
  });

  test("the fetch handler gives the token routes the peer address, or its enroll source", async () => {
    const sources: (string | undefined)[] = [];
    const handler = createLoopOrchestrationFetchHandler({
      authenticator: { authenticate: () => undefined },
      host: {
        httpHandler: () => () => Promise.resolve(new Response(null)),
        workerState: () => "RUNNING",
      } as never,
      reconciliationHealthy: () => true,
      tokenRoutes: (_request, _pathname, source) => {
        sources.push(source);
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });
    const request = () =>
      new Request("http://127.0.0.1:7321/api/v1/tokens/enroll", {
        method: "POST",
      });
    await handler(request(), {
      requestIP: () => ({ address: "203.0.113.9" }),
    });
    await handler(request(), { requestIP: () => null });
    await handler(request());
    expect(sources).toEqual(["203.0.113.9", undefined, undefined]);
    const keyed = createLoopOrchestrationFetchHandler({
      authenticator: { authenticate: () => undefined },
      enrollSource: (_request, peer) => `keyed:${peer}`,
      host: {
        httpHandler: () => () => Promise.resolve(new Response(null)),
        workerState: () => "RUNNING",
      } as never,
      reconciliationHealthy: () => true,
      tokenRoutes: (_request, _pathname, source) => {
        sources.push(source);
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });
    await keyed(request(), { requestIP: () => ({ address: "127.0.0.1" }) });
    expect(sources.at(-1)).toBe("keyed:127.0.0.1");
  });
});

describe("RA2 requests through the trusted proxy", () => {
  const proxied = config({
    origin: "https://loop.home.lab",
    trustedProxies: ["127.0.0.1", "::1"],
  });
  const request = (headers: Record<string, string> = {}) =>
    new Request("http://127.0.0.1:7321/api/v1/tokens/enroll", {
      headers,
      method: "POST",
    });

  test("trustedProxies are IP literals and need an https origin", () => {
    expect(parseLoopOrchestrationConfig(proxied).trustedProxies).toEqual([
      "127.0.0.1",
      "::1",
    ]);
    expect(
      parseLoopOrchestrationConfig(
        config({
          origin: "https://loop.home.lab",
          trustedProxies: ["::ffff:127.0.0.1", "127.0.0.1"],
        })
      ).trustedProxies
    ).toEqual(["127.0.0.1"]);
    expect(() =>
      parseLoopOrchestrationConfig(config({ trustedProxies: ["127.0.0.1"] }))
    ).toThrow("https origin");
    for (const trustedProxies of [[], ["caddy"], ["10.0.0.0/8"], "127.0.0.1"]) {
      expect(() =>
        parseLoopOrchestrationConfig(
          config({ origin: "https://loop.home.lab", trustedProxies })
        )
      ).toThrow("trustedProxies");
    }
  });

  test("the enroll source is the right-most untrusted forwarded hop, only from a trusted proxy", () => {
    const parsed = parseLoopOrchestrationConfig(proxied);
    const source = (peer: string | undefined, xff?: string) =>
      enrollmentSource(
        parsed,
        request(xff === undefined ? {} : { "x-forwarded-for": xff }),
        peer
      );
    expect(source("127.0.0.1", "198.51.100.7")).toBe("198.51.100.7");
    expect(source("::ffff:127.0.0.1", "198.51.100.7")).toBe("198.51.100.7");
    // A client-supplied left part never decides the key.
    expect(source("127.0.0.1", "10.9.9.9, 198.51.100.7")).toBe("198.51.100.7");
    // Trusted hops are skipped from the right.
    expect(source("127.0.0.1", "198.51.100.7, ::1, 127.0.0.1")).toBe(
      "198.51.100.7"
    );
    // Nothing usable: the proxy is keyed as itself.
    expect(source("127.0.0.1")).toBe("127.0.0.1");
    expect(source("127.0.0.1", "127.0.0.1")).toBe("127.0.0.1");
    expect(source("127.0.0.1", "198.51.100.7, garbage")).toBe("127.0.0.1");
    // Any other peer: its own address, headers ignored.
    expect(source("203.0.113.5", "198.51.100.7")).toBe("203.0.113.5");
    expect(source(undefined, "198.51.100.7")).toBeUndefined();
    // Without an https origin (or trusted proxies) nothing is forwarded.
    for (const plain of [
      parseLoopOrchestrationConfig(config()),
      { ...parsed, origin: "http://127.0.0.1:7321" },
    ]) {
      expect(
        enrollmentSource(
          plain,
          request({ "x-forwarded-for": "198.51.100.7" }),
          "127.0.0.1"
        )
      ).toBe("127.0.0.1");
    }
  });

  test("a static token is refused on any request that carries forwarding headers", () => {
    const env = { LOOP_LEGACY_TOKEN: "legacy-fixture-token" };
    const authenticator = orchestrationAuthenticator(
      parseLoopOrchestrationConfig(config()),
      env
    );
    const bearer = { authorization: "Bearer legacy-fixture-token" };
    expect(authenticator.authenticate(request(bearer))).toEqual({
      principal: "principal:legacy",
      supervisorId: LEGACY,
    });
    for (const header of [
      "forwarded",
      "via",
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
      "x-real-ip",
    ]) {
      const forwarded = request({ ...bearer, [header]: "198.51.100.7" });
      expect([header, forwardedRequest(forwarded)]).toEqual([header, true]);
      expect([header, authenticator.authenticate(forwarded)]).toEqual([
        header,
        undefined,
      ]);
    }
    expect(forwardedRequest(request(bearer))).toBe(false);
  });
});
