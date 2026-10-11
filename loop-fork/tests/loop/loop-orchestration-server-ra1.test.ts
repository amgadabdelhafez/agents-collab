import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createConfiguredTokenService,
  createLoopOrchestrationFetchHandler,
  orchestrationAuthenticator,
  orchestrationGrantAllows,
  parseLoopOrchestrationConfig,
} from "../../src/loop/loop-orchestration-server";
import {
  OrchestrationTokenService,
  writeTokenSigningKey,
} from "../../src/loop/orchestration-token-service";
import { createSupervisorOrchestrationHttpHandler } from "../../src/loop/supervisor-orchestration-http";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const scratch = (): string => {
  const root = mkdtempSync(join(tmpdir(), "ra1-server-"));
  roots.push(root);
  return root;
};

const supervisor = (
  id: string,
  role?: { project: string; repoKey: string; role: string }
) => ({
  mailbox: `/private/tmp/ra1/${id.replace(":", "-")}.jsonl`,
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
    {
      from: "supervisor:legacy",
      operations: ["receive"],
      principal: "principal:legacy",
      to: "supervisor:harness",
    },
    // A legacy recipient of an owner's message consumes by its grant.
    {
      from: "supervisor:owner",
      operations: ["acknowledge", "claim"],
      principal: "principal:legacy",
      to: "supervisor:legacy",
    },
    // A grant on a pair the sender's role does not allow is never used.
    {
      from: "supervisor:harness",
      operations: ["claim"],
      principal: "principal:legacy",
      to: "supervisor:legacy",
    },
    // A configured grant never widens a role-bound sender.
    {
      from: "supervisor:harness",
      operations: ["receive"],
      principal: "principal:harness",
      to: "supervisor:aicur",
    },
  ],
  hostname: "127.0.0.1",
  identity: "loop-orchestration@local",
  namespace: "default",
  port: 7321,
  schema: "loop-orchestration-server.v1",
  stateDir: "/private/tmp/ra1-state",
  supervisors: [
    supervisor("supervisor:legacy"),
    supervisor("supervisor:owner", {
      project: "all",
      repoKey: "estate",
      role: "owner",
    }),
    supervisor("supervisor:portfolio", {
      project: "all",
      repoKey: "estate",
      role: "operator",
    }),
    supervisor("supervisor:harness", { ...tree, role: "supervisor" }),
    supervisor("supervisor:harness-w1", { ...tree, role: "worker" }),
    supervisor("supervisor:aicur", {
      project: "app",
      repoKey: "ai-cur",
      role: "supervisor",
    }),
    supervisor("supervisor:aicur-w1", {
      project: "app",
      repoKey: "ai-cur",
      role: "worker",
    }),
  ],
  taskQueue: "loop-orchestration",
  ...extra,
});

describe("RA1 config", () => {
  test("origin, tokens and role bindings parse; a loopback listener needs neither", () => {
    const parsed = parseLoopOrchestrationConfig(
      config({
        origin: "https://loop.home.lab",
        tokens: { signingKeyFile: "/private/tmp/ra1/signing.pem" },
      })
    );
    expect(parsed.origin).toBe("https://loop.home.lab");
    expect(parsed.tokens).toEqual({
      signingKeyFile: "/private/tmp/ra1/signing.pem",
    });
    expect(
      parsed.supervisors.find(
        (entry) => entry.supervisorId === "supervisor:harness"
      )?.role
    ).toEqual({ ...tree, role: "supervisor" });
    expect(parseLoopOrchestrationConfig(config()).hostname).toBe("127.0.0.1");
  });

  test("a listener beyond loopback needs an https origin and a tokens section", () => {
    const tokens = { signingKeyFile: "/private/tmp/ra1/signing.pem" };
    expect(
      parseLoopOrchestrationConfig(
        config({ hostname: "0.0.0.0", origin: "https://loop.home.lab", tokens })
      ).hostname
    ).toBe("0.0.0.0");
    for (const extra of [
      { hostname: "0.0.0.0" },
      { hostname: "0.0.0.0", tokens },
      { hostname: "0.0.0.0", origin: "https://loop.home.lab" },
      { hostname: "100.64.0.7", origin: "http://127.0.0.1:7321", tokens },
    ]) {
      expect(() => parseLoopOrchestrationConfig(config(extra))).toThrow(
        "hostname is invalid"
      );
    }
    expect(() =>
      parseLoopOrchestrationConfig(config({ origin: "http://loop.home.lab" }))
    ).toThrow("must be https, or http on 127.0.0.1 or [::1]");
  });

  test("the signing key is a file path, never inline", () => {
    for (const tokens of [
      { signingKeyFile: "relative.pem" },
      { signingKey: "-----BEGIN PRIVATE KEY-----" },
      { signingKeyFile: "/private/tmp/ra1/signing.pem", inline: "x" },
      "/private/tmp/ra1/signing.pem",
    ]) {
      expect(() => parseLoopOrchestrationConfig(config({ tokens }))).toThrow(
        "orchestration tokens"
      );
    }
  });

  test("a role-bound address has its own principal and a subtree one supervisor", () => {
    const shared = config();
    const harness = shared.supervisors.find(
      (entry) => entry.supervisorId === "supervisor:harness-w1"
    );
    if (!harness) {
      throw new Error("fixture is missing");
    }
    harness.principal = "principal:harness";
    expect(() => parseLoopOrchestrationConfig(shared)).toThrow(
      "has a role and shares its principal"
    );
    const twice = config();
    twice.supervisors.push(
      supervisor("supervisor:harness-two", { ...tree, role: "supervisor" })
    );
    expect(() => parseLoopOrchestrationConfig(twice)).toThrow(
      "is bound to more than one address"
    );
    const bad = config();
    bad.supervisors.push(
      supervisor("supervisor:bad", { ...tree, role: "admin" })
    );
    expect(() => parseLoopOrchestrationConfig(bad)).toThrow(
      "orchestration supervisor role is invalid"
    );
  });
});

describe("RA1 grants by role subtree", () => {
  const parsed = parseLoopOrchestrationConfig(config());
  const allows = (
    principal: string,
    from: string,
    to: string,
    operation: "acknowledge" | "cancel" | "claim" | "receive" | "tick",
    claimant?: string
  ) =>
    orchestrationGrantAllows(parsed, {
      ...(claimant ? { claimant } : {}),
      from,
      operation,
      principal,
      to,
    });

  test("a sender without a role keeps its configured grants exactly", () => {
    expect(
      allows(
        "principal:legacy",
        "supervisor:legacy",
        "supervisor:harness",
        "receive"
      )
    ).toBe(true);
    expect(
      allows(
        "principal:legacy",
        "supervisor:legacy",
        "supervisor:harness",
        "claim"
      )
    ).toBe(false);
  });

  test("a supervisor messages and controls its own workers; the worker consumes", () => {
    const sup = "supervisor:harness";
    const worker = "supervisor:harness-w1";
    expect(allows("principal:harness", sup, worker, "receive")).toBe(true);
    expect(allows("principal:harness", sup, worker, "cancel")).toBe(true);
    expect(allows("principal:harness", sup, worker, "tick")).toBe(true);
    expect(allows("principal:harness-w1", sup, worker, "claim", worker)).toBe(
      true
    );
    expect(allows("principal:harness-w1", sup, worker, "acknowledge")).toBe(
      true
    );
    // The sender does not consume its own message, and the recipient does
    // not send as the supervisor.
    expect(allows("principal:harness", sup, worker, "claim")).toBe(false);
    expect(allows("principal:harness-w1", sup, worker, "receive")).toBe(false);
    expect(allows("principal:harness-w1", sup, worker, "cancel")).toBe(false);
  });

  test("a claimant other than the actor is refused (no confused deputy)", () => {
    expect(
      allows(
        "principal:harness-w1",
        "supervisor:harness",
        "supervisor:harness-w1",
        "claim",
        "supervisor:aicur-w1"
      )
    ).toBe(false);
  });

  test("subtrees do not cross, and a configured grant does not widen a role", () => {
    expect(
      allows(
        "principal:harness",
        "supervisor:harness",
        "supervisor:aicur-w1",
        "receive"
      )
    ).toBe(false);
    expect(
      allows(
        "principal:harness",
        "supervisor:harness",
        "supervisor:aicur",
        "receive"
      )
    ).toBe(false);
    expect(
      allows(
        "principal:harness-w1",
        "supervisor:harness-w1",
        "supervisor:aicur",
        "receive"
      )
    ).toBe(false);
    expect(
      allows(
        "principal:harness-w1",
        "supervisor:harness-w1",
        "supervisor:harness",
        "receive"
      )
    ).toBe(true);
    expect(
      allows(
        "principal:harness-w1",
        "supervisor:harness-w1",
        "supervisor:legacy",
        "receive"
      )
    ).toBe(false);
  });

  test("an operator messages supervisors only; an owner may do anything", () => {
    expect(
      allows(
        "principal:portfolio",
        "supervisor:portfolio",
        "supervisor:aicur",
        "receive"
      )
    ).toBe(true);
    expect(
      allows(
        "principal:portfolio",
        "supervisor:portfolio",
        "supervisor:aicur-w1",
        "receive"
      )
    ).toBe(false);
    expect(
      allows(
        "principal:owner",
        "supervisor:owner",
        "supervisor:aicur-w1",
        "receive"
      )
    ).toBe(true);
    expect(
      allows(
        "principal:owner",
        "supervisor:harness",
        "supervisor:harness-w1",
        "cancel"
      )
    ).toBe(true);
    expect(
      allows(
        "principal:owner",
        "supervisor:owner",
        "supervisor:legacy",
        "receive"
      )
    ).toBe(true);
  });

  test("a legacy recipient of an owner's message consumes only by its configured grant", () => {
    const owner = "supervisor:owner";
    const legacy = "supervisor:legacy";
    expect(allows("principal:legacy", owner, legacy, "claim", legacy)).toBe(
      true
    );
    expect(allows("principal:legacy", owner, legacy, "tick")).toBe(false);
    expect(
      allows("principal:legacy", "supervisor:harness", legacy, "claim")
    ).toBe(false);
    // An owner acts only as itself.
    expect(
      allows("principal:owner", owner, legacy, "claim", "supervisor:harness")
    ).toBe(false);
    expect(allows("principal:owner", owner, legacy, "claim", owner)).toBe(true);
  });

  test("an unknown principal acting on a role-bound pair is refused", () => {
    expect(
      allows(
        "principal:legacy",
        "supervisor:harness",
        "supervisor:harness-w1",
        "receive"
      )
    ).toBe(false);
    expect(
      allows(
        "principal:nobody",
        "supervisor:harness",
        "supervisor:harness-w1",
        "tick"
      )
    ).toBe(false);
  });
});

describe("RA1 authentication", () => {
  const setup = () => {
    const root = scratch();
    const signingKeyFile = join(root, "signing.pem");
    writeTokenSigningKey(signingKeyFile);
    const parsed = parseLoopOrchestrationConfig(
      config({ stateDir: root, tokens: { signingKeyFile } })
    );
    const tokens = createConfiguredTokenService(
      parsed
    ) as OrchestrationTokenService;
    expect(tokens).toBeInstanceOf(OrchestrationTokenService);
    const enroll = (address: string) => {
      const { code } = tokens.issueEnrollmentCode({ kind: "host" }, address);
      return tokens.enroll(code)?.token as string;
    };
    const env = { LOOP_LEGACY_TOKEN: "legacy-fixture-token" };
    return {
      authenticator: orchestrationAuthenticator(parsed, env, tokens),
      enroll,
      parsed,
      tokens,
    };
  };
  const bearer = (token: string) =>
    new Request("http://127.0.0.1:7321/api/v1/supervisor-threads", {
      headers: { authorization: `Bearer ${token}` },
    });

  test("a static token keeps working as legacy", () => {
    const { authenticator } = setup();
    expect(authenticator.authenticate(bearer("legacy-fixture-token"))).toEqual({
      principal: "principal:legacy",
      supervisorId: "supervisor:legacy",
    });
  });

  test("a session token acts as its enrolled address, with that address's principal", () => {
    const { authenticator, enroll } = setup();
    expect(
      authenticator.authenticate(bearer(enroll("supervisor:harness-w1")))
    ).toEqual({
      principal: "principal:harness-w1",
      supervisorId: "supervisor:harness-w1",
    });
  });

  test("a revoked, unknown or malformed token authenticates nobody", () => {
    const { authenticator, enroll, tokens } = setup();
    const token = enroll("supervisor:harness");
    tokens.revoke(
      { kind: "host" },
      {
        sessionId: JSON.parse(
          Buffer.from(token.split(".")[1] as string, "base64url").toString()
        ).sub,
      }
    );
    expect(authenticator.authenticate(bearer(token))).toBeUndefined();
    expect(authenticator.authenticate(bearer("nonsense"))).toBeUndefined();
    expect(
      authenticator.authenticate(
        new Request("http://127.0.0.1:7321/", {
          headers: { authorization: "Basic abc" },
        })
      )
    ).toBeUndefined();
  });

  test("without a tokens section a session token is not accepted", () => {
    const { enroll, parsed } = setup();
    const withoutTokens = orchestrationAuthenticator(parsed, {});
    expect(
      withoutTokens.authenticate(bearer(enroll("supervisor:harness")))
    ).toBeUndefined();
  });

  test("the V1 surface takes the sender from the token subject, never the body", async () => {
    const { authenticator, enroll, tokens } = setup();
    const received: unknown[] = [];
    const v1 = (auth: typeof authenticator) =>
      createSupervisorOrchestrationHttpHandler({
        authenticator: auth,
        messages: {
          receive: (command: unknown) => {
            received.push(command);
            return Promise.resolve({ accepted: true });
          },
        } as never,
        tasks: {} as never,
      });
    const handler = createLoopOrchestrationFetchHandler({
      authenticator,
      host: { httpHandler: v1, workerState: () => "RUNNING" } as never,
      reconciliationHealthy: () => true,
      tokenRoutes: async () => undefined,
    });
    const token = enroll("supervisor:harness-w1");
    const send = (from: string) =>
      handler(
        new Request(
          "http://127.0.0.1:7321/api/v1/supervisor-messages/receive",
          {
            body: JSON.stringify({
              input: { from, to: "supervisor:harness" },
              messageKind: "question",
              requestId: "request-1",
            }),
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            method: "POST",
          }
        )
      );
    expect((await send("supervisor:harness")).status).toBe(400);
    expect(received).toEqual([]);
    expect((await send("supervisor:harness-w1")).status).toBe(200);
    expect(received).toMatchObject([{ principal: "principal:harness-w1" }]);
    expect(tokens).toBeDefined();
  });

  test("the fetch handler serves the token routes before V1", async () => {
    const { authenticator, tokens } = setup();
    const { createTokenRoutes } = await import(
      "../../src/loop/orchestration-token-service"
    );
    let v1Calls = 0;
    const handler = createLoopOrchestrationFetchHandler({
      authenticator,
      host: {
        httpHandler: () => () => {
          v1Calls += 1;
          return Promise.resolve(new Response(null, { status: 418 }));
        },
        workerState: () => "RUNNING",
      } as never,
      reconciliationHealthy: () => true,
      tokenRoutes: createTokenRoutes(tokens),
    });
    const { code } = tokens.issueEnrollmentCode(
      { kind: "host" },
      "supervisor:harness"
    );
    const response = await handler(
      new Request("http://127.0.0.1:7321/api/v1/tokens/enroll", {
        body: JSON.stringify({ code }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    );
    expect(response.status).toBe(200);
    expect(
      (await handler(new Request("http://127.0.0.1:7321/api/v1/other"))).status
    ).toBe(418);
    expect(v1Calls).toBe(1);
  });

  test("a configured key that cannot be loaded refuses the service", () => {
    const root = scratch();
    const parsed = parseLoopOrchestrationConfig(
      config({
        stateDir: root,
        tokens: { signingKeyFile: join(root, "missing.pem") },
      })
    );
    expect(() => createConfiguredTokenService(parsed)).toThrow(
      "orchestration token signing key is not readable"
    );
    expect(
      createConfiguredTokenService(parseLoopOrchestrationConfig(config()))
    ).toBeUndefined();
  });
});
