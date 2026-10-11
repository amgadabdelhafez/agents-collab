import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FROM_METADATA_KEY } from "../../src/loop/a2a-supervisor-adapter";
import {
  createConfiguredTokenService,
  createLoopOrchestrationFetchHandler,
  type OrchestrationGrantDecision,
  orchestrationA2AReceive,
  orchestrationAuthenticator,
  orchestrationAuthority,
  orchestrationGrantDecision,
  parseLoopOrchestrationConfig,
  staticTokensAccepted,
  validateConfiguredRuntimeEnvironment,
} from "../../src/loop/loop-orchestration-server";
import {
  OWNER_NOTIFICATION_PATH,
  OWNER_REPLY_ONLY,
  OwnerContextRegistry,
  type OwnerThreadQuery,
  ownerThreadsFromBoard,
} from "../../src/loop/orchestration-owner-messaging";
import {
  type OrchestrationTokenService,
  writeTokenSigningKey,
} from "../../src/loop/orchestration-token-service";
import { createA2AV2SupervisorIngressGate } from "../../src/loop/supervisor-a2a-v2-service";
import { SupervisorMessageGovernanceError } from "../../src/loop/supervisor-message-governance";
import { SupervisorMessageReadModel } from "../../src/loop/supervisor-message-read-model";
import type { SupervisorMessageProjection } from "../../src/loop/supervisor-message-workflow";
import { createSupervisorOrchestrationHttpHandler } from "../../src/loop/supervisor-orchestration-http";
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
  const asked: OwnerThreadQuery[] = [];
  const started = (threads: string[]) => ({
    ownerStarted: (query: OwnerThreadQuery) => {
      asked.push(query);
      return threads.includes(query.threadId);
    },
  });
  const decide = (
    from: string,
    to: string,
    options: {
      claimant?: string;
      index?: ReturnType<typeof started>;
      operation?: "acknowledge" | "cancel" | "claim" | "receive" | "tick";
      principal?: string;
      threadId?: string;
    } = {}
  ) =>
    orchestrationGrantDecision(
      parsed,
      {
        ...(options.claimant ? { claimant: options.claimant } : {}),
        from,
        operation: options.operation ?? "receive",
        principal: options.principal ?? principalOf(from),
        ...(options.threadId ? { threadId: options.threadId } : {}),
        to,
      },
      options.index
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

  test("a supervisor messages the owner only on a thread the owner started", () => {
    asked.length = 0;
    const index = started(["t-owner"]);
    expect(decide(SUP, OWNER)).toEqual(replyOnly);
    expect(decide(SUP, OWNER, { index })).toEqual(replyOnly);
    expect(decide(SUP, OWNER, { index, threadId: "t-other" })).toEqual(
      replyOnly
    );
    expect(decide(SUP, OWNER, { threadId: "t-owner" })).toEqual(replyOnly);
    expect(decide(SUP, OWNER, { index, threadId: "t-owner" })).toEqual(allowed);
    expect(asked).toEqual([
      { owner: OWNER, replier: SUP, threadId: "t-other" },
      { owner: OWNER, replier: SUP, threadId: "t-owner" },
    ]);
    // Even on an owner thread, only as itself.
    expect(
      decide(SUP, OWNER, {
        index,
        principal: principalOf(OTHER_SUP),
        threadId: "t-owner",
      })
    ).toEqual(denied);
  });

  test("a worker or an operator never messages the owner, thread or not", () => {
    const index = started(["t-owner"]);
    for (const from of [WORKER, OPERATOR]) {
      expect(decide(from, OWNER, { index, threadId: "t-owner" })).toEqual(
        denied
      );
    }
  });

  test("a sender without a role reaches the owner only by its grant and an owner thread", () => {
    const index = started(["t-owner"]);
    expect(decide(LEGACY, OWNER)).toEqual(replyOnly);
    expect(decide(LEGACY, OWNER, { index, threadId: "t-x" })).toEqual(
      replyOnly
    );
    expect(decide(LEGACY, OWNER, { index, threadId: "t-owner" })).toEqual(
      allowed
    );
    expect(
      decide(LEGACY_NO_GRANT, OWNER, { index, threadId: "t-owner" })
    ).toEqual(denied);
  });

  test("the other operations on a reply are not re-gated by the thread", () => {
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

  test("the V1 authority reports the owner-reply-only reason", () => {
    const authority = orchestrationAuthority(parsed, started(["t-owner"]));
    const request = {
      from: SUP,
      operation: "receive" as const,
      principal: principalOf(SUP),
      to: OWNER,
    };
    expect(authority.decide({ ...request, threadId: "t-new" })).toEqual({
      allowed: false,
      authorityRef: "authority:deny-default",
      reasonCode: OWNER_REPLY_ONLY,
    });
    expect(authority.decide({ ...request, threadId: "t-owner" })).toEqual({
      allowed: true,
      authorityRef: "authority:loop-orchestration-config",
      reasonCode: "configured-grant",
    });
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

describe("RA2 owner threads on the V1 board", () => {
  const boardStore = () => {
    const store = new JsonlSupervisorThreadStore(
      join(scratch(), "threads.jsonl")
    );
    const messages: Partial<SupervisorMessageProjection>[] = [
      { from: OWNER, threadId: "t-owner", to: SUP },
      { from: SUP, threadId: "t-sup", to: WORKER },
      {
        from: OWNER,
        receivedAt: "2026-10-11T07:05:00.000Z",
        threadId: "t-sup",
        to: SUP,
      },
      { from: OWNER, threadId: "t-aicur", to: OTHER_SUP },
    ];
    messages.forEach((overrides, index) => {
      const workflowId = `supervisor-message:${String(index + 1).repeat(64)}`;
      const model = new SupervisorMessageReadModel();
      model.upsert(
        workflowId,
        projection({ ...overrides, messageId: `m-${index}` })
      );
      store.append({
        item: model.board().items[0] as never,
        messageKind: "question",
        observedAt: "2026-10-11T07:10:00.000Z",
        requestId: `append-${index}`,
      });
    });
    return store;
  };

  test("only a thread the owner opened with the replier counts", async () => {
    const store = boardStore();
    const index = ownerThreadsFromBoard(() => store.read());
    const query = (replier: string, threadId: string) =>
      index.ownerStarted({ owner: OWNER, replier, threadId });
    expect(query(SUP, "t-owner")).toBe(true);
    expect(query(OTHER_SUP, "t-aicur")).toBe(true);
    // The supervisor started it; the owner joining later does not count.
    expect(query(SUP, "t-sup")).toBe(false);
    // The owner opened it with someone else.
    expect(query(SUP, "t-aicur")).toBe(false);
    expect(query(SUP, "t-none")).toBe(false);
    expect(
      index.ownerStarted({ owner: OPERATOR, replier: SUP, threadId: "t-owner" })
    ).toBe(false);
    // The authority reads the same board.
    const authority = orchestrationAuthority(
      parseLoopOrchestrationConfig(config()),
      index
    );
    const reply = async (threadId: string) =>
      (
        await authority.decide({
          from: SUP,
          operation: "receive",
          principal: principalOf(SUP),
          threadId,
          to: OWNER,
        })
      ).reasonCode;
    expect(await reply("t-owner")).toBe("configured-grant");
    expect(await reply("t-sup")).toBe(OWNER_REPLY_ONLY);
  });

  test("an unreadable board answers no", () => {
    const index = ownerThreadsFromBoard(() => {
      throw new Error("journal is corrupt");
    });
    expect(
      index.ownerStarted({ owner: OWNER, replier: SUP, threadId: "t-owner" })
    ).toBe(false);
  });
});

describe("RA2 owner contexts on the A2A plane", () => {
  const parsed = parseLoopOrchestrationConfig(config());

  test("only an allowed owner send opens a context, and only for its recipient", () => {
    const contexts = new OwnerContextRegistry();
    const send = (
      from: string,
      to: string,
      threadId?: string,
      principal?: string
    ) =>
      orchestrationA2AReceive(parsed, contexts, {
        from,
        principal: principal ?? principalOf(from),
        ...(threadId ? { threadId } : {}),
        to,
      });
    expect(send(SUP, OWNER, "ctx-1")).toBe(OWNER_REPLY_ONLY);
    expect(send(SUP, OWNER)).toBe(OWNER_REPLY_ONLY);
    expect(contexts.size).toBe(0);
    // Refused or context-less owner sends and other pairs record nothing.
    expect(send(OWNER, SUP, "ctx-1", principalOf(SUP))).toBe(false);
    expect(send(OWNER, SUP)).toBe(true);
    expect(send(SUP, WORKER, "ctx-9")).toBe(true);
    expect(contexts.size).toBe(0);
    expect(send(OWNER, SUP, "ctx-1")).toBe(true);
    expect(contexts.size).toBe(1);
    expect(send(SUP, OWNER, "ctx-1")).toBe(true);
    expect(send(SUP, OWNER, "ctx-2")).toBe(OWNER_REPLY_ONLY);
    expect(send(OTHER_SUP, OWNER, "ctx-1")).toBe(OWNER_REPLY_ONLY);
    expect(send(WORKER, OWNER, "ctx-1")).toBe(false);
    // A supervisor's own sends never open a context for it.
    expect(send(SUP, OPERATOR, "ctx-3")).toBe(true);
    expect(send(SUP, OWNER, "ctx-3")).toBe(OWNER_REPLY_ONLY);
  });

  test("the registry is bounded by count and age", () => {
    const clock = { now: 0 };
    const contexts = new OwnerContextRegistry({
      maxEntries: 2,
      now: () => clock.now,
      ttlMs: 1000,
    });
    const has = (threadId: string) =>
      contexts.ownerStarted({ owner: OWNER, replier: SUP, threadId });
    for (const threadId of ["a", "b", "c"]) {
      contexts.record({ owner: OWNER, recipient: SUP, threadId });
    }
    expect(contexts.size).toBe(2);
    expect([has("a"), has("b"), has("c")]).toEqual([false, true, true]);
    // Renewing moves a context to the newest.
    clock.now = 500;
    contexts.record({ owner: OWNER, recipient: SUP, threadId: "b" });
    contexts.record({ owner: OWNER, recipient: SUP, threadId: "d" });
    expect([has("b"), has("c"), has("d")]).toEqual([true, false, true]);
    clock.now = 1499;
    expect(has("b")).toBe(true);
    clock.now = 1500;
    expect(has("b")).toBe(false);
    expect(contexts.size).toBe(1);
  });
});

describe("RA2 refusal surfaces", () => {
  const ownerRefusal = {
    code: OWNER_REPLY_ONLY,
    message: expect.stringContaining(
      `attention-os interaction (${OWNER_NOTIFICATION_PATH}, delivered with ntfy)`
    ),
    notifyVia: OWNER_NOTIFICATION_PATH,
  };

  test("the A2A ingress names the attention-os path and passes the context id", async () => {
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
    const send = (to: string, contextId?: string) =>
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
                metadata: { [FROM_METADATA_KEY]: SUP },
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
    expect(asked).toEqual([
      { from: SUP, principal: principalOf(SUP), threadId: "ctx-1", to: OWNER },
      { from: SUP, principal: principalOf(SUP), to: OPERATOR },
      { from: SUP, principal: principalOf(SUP), to: OWNER },
    ]);
    expect(sdkCalls).toBe(0);
  });

  test("the V1 surface names the attention-os path for an owner-reply-only refusal", async () => {
    let reasonCode = OWNER_REPLY_ONLY;
    const handler = createSupervisorOrchestrationHttpHandler({
      authenticator: {
        authenticate: () => ({
          principal: principalOf(SUP),
          supervisorId: SUP,
        }),
      },
      messages: {
        receive: () =>
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
    const send = () =>
      handler(
        new Request(
          "http://127.0.0.1:7321/api/v1/supervisor-messages/receive",
          {
            body: JSON.stringify({
              input: { from: SUP, to: OWNER },
              messageKind: "informational",
              requestId: "request-1",
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
  });

  test("the fetch handler gives the token routes the peer address", async () => {
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
  });
});
