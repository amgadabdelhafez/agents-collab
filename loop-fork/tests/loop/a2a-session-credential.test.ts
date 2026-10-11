// ra2: a session's own credential for a non-local orchestration server. The
// token service and its routes are the production ones (a real Ed25519 key
// and store under a scratch directory) behind a loopback listener; the
// client is the production resolver, credential file and refresh.

import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { serve, sleep } from "bun";
import {
  a2aMessageStatus,
  resolveA2AClientEndpoint,
} from "../../src/loop/a2a-session-client";
import { runA2ACommand } from "../../src/loop/a2a-session-command";
import {
  A2A_SESSION_CREDENTIAL_SCHEMA,
  A2ASessionCredentialError,
  A2ASessionTokenSource,
  a2aSessionCredentialPath,
  enrollA2ASession,
  readA2ASessionCredential,
  writeA2ASessionCredential,
} from "../../src/loop/a2a-session-credential";
import {
  A2A_V2_MESSAGE_STATUS_SCHEMA,
  a2aV2MessageStatusPath,
} from "../../src/loop/a2a-v2-routes-contract";
import { parseConnectArgs } from "../../src/loop/connect-command";
import {
  createTokenRoutes,
  loadTokenSigningKey,
  OrchestrationTokenService,
  type RoleBinding,
  TOKEN_TTL_SECONDS,
  TokenStore,
  writeOwnerOnlyFile,
  writeTokenSigningKey,
} from "../../src/loop/orchestration-token-service";

const ROUTE = "/a2a/v2";
const PHONE = "supervisor:ra2-phone";
const DESK = "supervisor:ra2-desk";
const TREE = { project: "loop", repoKey: "agents-collab" };
const ROLES: Record<string, RoleBinding> = {
  [DESK]: { ...TREE, role: "supervisor" },
  [PHONE]: { ...TREE, role: "worker" },
};
const STATIC_TOKEN = "static-phone-token-never-remote";

const roots: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const scratch = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ra2-cred-")));
  roots.push(root);
  return root;
};

/**
 * The server side: the production token service and routes, and one
 * authenticated route (message status) that answers only a verified
 * session token, recording every bearer it was sent.
 */
const tokenServer = (root: string, clock: { offsetMs: number }) => {
  const keyFile = join(root, "signing.pem");
  writeTokenSigningKey(keyFile);
  const service = new OrchestrationTokenService({
    bindings: new Map(Object.entries(ROLES)),
    key: loadTokenSigningKey(keyFile),
    now: () => Date.now() + clock.offsetMs,
    store: new TokenStore(join(root, "tokens")),
  });
  const routes = createTokenRoutes(service);
  const seen: { authorization: null | string; path: string }[] = [];
  const counts = { refresh: 0 };
  const server = serve({
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      seen.push({ authorization: request.headers.get("authorization"), path });
      if (path.endsWith("/refresh")) {
        counts.refresh += 1;
      }
      const tokenResponse = await routes(request, path);
      if (tokenResponse) {
        return tokenResponse;
      }
      const bearer = (request.headers.get("authorization") ?? "").replace(
        "Bearer ",
        ""
      );
      const session = service.verify(bearer);
      if (!session) {
        return Response.json(
          { error: { code: "unauthenticated" } },
          { status: 401 }
        );
      }
      return Response.json({
        acknowledgedAt: null,
        deliveredAt: null,
        messageId: decodeURIComponent(path.split("/").at(-1) ?? ""),
        phase: "routed",
        schema: A2A_V2_MESSAGE_STATUS_SCHEMA,
        taskState: null,
        to: session.address,
        workResultCompleted: false,
      });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  cleanups.push(() => server.stop(true));
  const code = (supervisorId: string, path: string): string => {
    writeOwnerOnlyFile(
      path,
      `${service.issueEnrollmentCode({ kind: "host" }, supervisorId).code}\n`
    );
    return path;
  };
  return { code, counts, seen, server, service };
};

/** A session's machine: its own HOME and a client-only config. */
const sessionMachine = (input: {
  origin: string;
  supervisors?: Record<string, unknown>[];
}) => {
  const home = scratch();
  const configPath = join(home, "orchestration.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      a2aV2: { routePath: ROUTE },
      origin: input.origin,
      supervisors: input.supervisors ?? [
        { role: ROLES[PHONE], supervisorId: PHONE, tokenEnv: "PHONE_TOKEN" },
        { role: ROLES[DESK], supervisorId: DESK, tokenEnv: "DESK_TOKEN" },
      ],
    }),
    { mode: 0o600 }
  );
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    LOOP_ORCHESTRATION_CONFIG: configPath,
    PHONE_TOKEN: STATIC_TOKEN,
  };
  return { configPath, env, home };
};

const loopbackOrigin = (port: number | undefined) => `http://127.0.0.1:${port}`;

describe("ra2 enrollment", () => {
  test("a code read from a 0600 file becomes a 0600 credential; the token is never rendered", async () => {
    const root = scratch();
    const server = tokenServer(root, { offsetMs: 0 });
    const origin = loopbackOrigin(server.server.port);
    const machine = sessionMachine({ origin });
    const codeFile = server.code(PHONE, join(root, "phone.code"));
    const enrolled = await enrollA2ASession({
      codeFile,
      env: machine.env,
      origin,
      role: ROLES[PHONE] as RoleBinding,
      supervisorId: PHONE,
    });
    const path = a2aSessionCredentialPath(PHONE, machine.env);
    expect(enrolled.path).toBe(path);
    expect(path).toBe(
      join(machine.home, ".loop", "credentials", "ra2-phone.json")
    );
    // biome-ignore lint/suspicious/noBitwiseOperators: permission bits
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // biome-ignore lint/suspicious/noBitwiseOperators: permission bits
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
    const credential = readA2ASessionCredential(path);
    expect(credential?.origin).toBe(origin);
    expect(credential?.supervisorId).toBe(PHONE);
    expect(credential?.sessionId).toBe(enrolled.sessionId);
    expect(server.service.verify(credential?.token ?? "")?.address).toBe(PHONE);
    // The code went in the body, never a URL.
    expect(server.seen.map((entry) => entry.path)).toEqual([
      "/api/v1/tokens/enroll",
    ]);
    // The resolved endpoint never renders the token.
    const endpoint = resolveA2AClientEndpoint(PHONE, { env: machine.env });
    expect(endpoint.auth).toBe("session");
    for (const rendering of [
      JSON.stringify(endpoint),
      String(endpoint),
      inspect(endpoint, { depth: 5, showHidden: true }),
    ]) {
      expect(rendering).not.toContain(credential?.token ?? "?");
    }
    // A spent code enrolls nothing.
    await expect(
      enrollA2ASession({
        codeFile,
        env: machine.env,
        origin,
        role: ROLES[PHONE] as RoleBinding,
        supervisorId: PHONE,
      })
    ).rejects.toThrow("unknown, spent or expired");
  });

  test("a code for another address, or one in a readable file, is not kept", async () => {
    const root = scratch();
    const server = tokenServer(root, { offsetMs: 0 });
    const origin = loopbackOrigin(server.server.port);
    const machine = sessionMachine({ origin });
    const desk = server.code(DESK, join(root, "desk.code"));
    await expect(
      enrollA2ASession({
        codeFile: desk,
        env: machine.env,
        origin,
        role: ROLES[PHONE] as RoleBinding,
        supervisorId: PHONE,
      })
    ).rejects.toThrow(A2ASessionCredentialError);
    expect(
      readA2ASessionCredential(a2aSessionCredentialPath(PHONE, machine.env))
    ).toBeUndefined();
    const readable = server.code(PHONE, join(root, "readable.code"));
    chmodSync(readable, 0o644);
    const requests = server.seen.length;
    await expect(
      enrollA2ASession({
        codeFile: readable,
        env: machine.env,
        origin,
        role: ROLES[PHONE] as RoleBinding,
        supervisorId: PHONE,
      })
    ).rejects.toThrow("0600");
    // Refused before any request: the code never left the file.
    expect(server.seen.length).toBe(requests);
  });

  test("loop connect takes the code and the trust anchors as files only", () => {
    const options = parseConnectArgs([
      "connect",
      "--as",
      PHONE,
      "--deliver",
      "claude",
      "--session",
      "s-1",
      "--enroll-code-file",
      "/private/tmp/ra2.code",
      "--trust-file",
      "/private/tmp/ca.pem",
    ]);
    expect(options.enrollCodeFile).toBe("/private/tmp/ra2.code");
    expect(options.trustFile).toBe("/private/tmp/ca.pem");
    expect(() =>
      parseConnectArgs([
        "connect",
        "--as",
        PHONE,
        "--deliver",
        "claude",
        "--session",
        "s-1",
        "--enroll-code",
        "abc",
      ])
    ).toThrow("invalid argument: --enroll-code");
  });
});

describe("ra2 server resolution", () => {
  test("beyond loopback a static token is refused before any request", async () => {
    let requests = 0;
    const fetchImpl = (() => {
      requests += 1;
      return Promise.resolve(new Response(null, { status: 500 }));
    }) as unknown as typeof fetch;
    const machine = sessionMachine({ origin: "https://loop.home.lab" });
    expect(() =>
      resolveA2AClientEndpoint(PHONE, { env: machine.env, fetchImpl })
    ).toThrow("a static token is only sent on loopback");
    await expect(
      runA2ACommand(["a2a", "status", "--as", PHONE, "--message-id", "m1"], {
        env: machine.env,
        fetchImpl,
      })
    ).rejects.toThrow("enroll-code-file");
    expect(requests).toBe(0);
    // On loopback the static token keeps working.
    const local = sessionMachine({ origin: "http://127.0.0.1:7321" });
    const endpoint = resolveA2AClientEndpoint(PHONE, { env: local.env });
    expect(endpoint.auth).toBe("static");
    expect(await endpoint.authorization()).toBe(`Bearer ${STATIC_TOKEN}`);
  });

  test("a session credential is sent only to the origin it was enrolled at", async () => {
    const root = scratch();
    const server = tokenServer(root, { offsetMs: 0 });
    const origin = loopbackOrigin(server.server.port);
    const machine = sessionMachine({ origin });
    await enrollA2ASession({
      codeFile: server.code(PHONE, join(root, "phone.code")),
      env: machine.env,
      origin,
      role: ROLES[PHONE] as RoleBinding,
      supervisorId: PHONE,
    });
    const status = await a2aMessageStatus(
      resolveA2AClientEndpoint(PHONE, { env: machine.env }),
      "m-1"
    );
    expect(status.to).toBe(PHONE);
    const sent = server.seen.at(-1)?.authorization ?? "";
    // The session token, not the static one, even on loopback.
    expect(sent).not.toContain(STATIC_TOKEN);
    expect(server.service.verify(sent.replace("Bearer ", ""))).toBeDefined();
    // The config now names another origin: the credential is not sent there.
    writeFileSync(
      machine.configPath,
      JSON.stringify({
        a2aV2: { routePath: ROUTE },
        origin: "https://loop.home.lab",
        supervisors: [{ role: ROLES[PHONE], supervisorId: PHONE }],
      })
    );
    const requests = server.seen.length;
    const moved = resolveA2AClientEndpoint(PHONE, { env: machine.env });
    await expect(moved.authorization()).rejects.toThrow("enroll again");
    expect(server.seen.length).toBe(requests);
  });

  test("--trust-file is for an https origin, from a file only this user can change", () => {
    const root = scratch();
    const machine = sessionMachine({ origin: "http://127.0.0.1:7321" });
    const trust = join(root, "ca.pem");
    writeFileSync(
      trust,
      "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n",
      { mode: 0o644 }
    );
    expect(() =>
      resolveA2AClientEndpoint(PHONE, { env: machine.env, trustFile: trust })
    ).toThrow("only to an https origin");
    const remote = sessionMachine({ origin: "https://127.0.0.1:7443" });
    expect(
      resolveA2AClientEndpoint(PHONE, { env: remote.env, trustFile: trust })
        .baseUrl
    ).toBe("https://127.0.0.1:7443");
    chmodSync(trust, 0o664);
    expect(() =>
      resolveA2AClientEndpoint(PHONE, { env: remote.env, trustFile: trust })
    ).toThrow("not group- or world-writable");
    writeFileSync(join(root, "empty.pem"), "nothing\n", { mode: 0o644 });
    expect(() =>
      resolveA2AClientEndpoint(PHONE, {
        env: remote.env,
        trustFile: join(root, "empty.pem"),
      })
    ).toThrow("no PEM certificate");
  });
});

describe("ra2 refresh", () => {
  const enrolledMachine = async () => {
    const root = scratch();
    const clock = { offsetMs: 0 };
    const server = tokenServer(root, clock);
    const origin = loopbackOrigin(server.server.port);
    const machine = sessionMachine({ origin });
    await enrollA2ASession({
      codeFile: server.code(PHONE, join(root, "phone.code")),
      env: machine.env,
      origin,
      role: ROLES[PHONE] as RoleBinding,
      supervisorId: PHONE,
    });
    const path = a2aSessionCredentialPath(PHONE, machine.env);
    const source = (offsetMs: number) =>
      new A2ASessionTokenSource({
        now: () => Date.now() + offsetMs,
        origin,
        path,
        supervisorId: PHONE,
      });
    return { clock, machine, origin, path, server, source };
  };

  test("a token is refreshed before it expires, once across concurrent callers, and the old one is denied", async () => {
    const h = await enrolledMachine();
    const first = readA2ASessionCredential(h.path)?.token ?? "";
    // Far from expiry: no refresh.
    expect(await h.source(0).bearer()).toBe(first);
    expect(h.server.counts.refresh).toBe(0);
    // Within the margin (26 of 30 minutes): the first caller refreshes, the
    // others wait on the lock and take the new token.
    const late = (TOKEN_TTL_SECONDS - 4 * 60) * 1000;
    // The server shares the session's clock.
    h.clock.offsetMs = late;
    const tokens = await Promise.all([
      h.source(late).bearer(),
      h.source(late).bearer(),
      h.source(late).bearer(),
    ]);
    expect(h.server.counts.refresh).toBe(1);
    expect(new Set(tokens).size).toBe(1);
    const second = tokens[0] ?? "";
    expect(second).not.toBe(first);
    expect(readA2ASessionCredential(h.path)?.token).toBe(second);
    expect(h.server.service.verify(first)).toBeUndefined();
    expect(h.server.service.verify(second)?.address).toBe(PHONE);
  });

  test("a request refused for a token another process just replaced is retried once with the new one", async () => {
    const h = await enrolledMachine();
    const late = (TOKEN_TTL_SECONDS - 4 * 60) * 1000;
    // The server shares the session's clock.
    h.clock.offsetMs = late;
    let raced = false;
    // Another process of this session refreshes while this request is in
    // flight, so the server sees the denied token.
    const racing = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ) => {
      if (!raced) {
        raced = true;
        await h.source(late).bearer();
      }
      return await fetch(input, init);
    }) as typeof fetch;
    const endpoint = resolveA2AClientEndpoint(PHONE, { env: h.machine.env });
    const status = await a2aMessageStatus(endpoint, "m-race", racing);
    expect(status.messageId).toBe("m-race");
    const statusPath = a2aV2MessageStatusPath(ROUTE, "m-race");
    const attempts = h.server.seen.filter((entry) => entry.path === statusPath);
    expect(attempts.length).toBe(2);
    expect(attempts[0]?.authorization).not.toBe(attempts[1]?.authorization);
    expect(h.server.counts.refresh).toBe(1);
  });

  test("an expired token is not refreshable: the session enrolls again", async () => {
    const h = await enrolledMachine();
    const expired = (TOKEN_TTL_SECONDS + 60) * 1000;
    const endpoint = resolveA2AClientEndpoint(PHONE, {
      env: h.machine.env,
      nowMs: () => Date.now() + expired,
    });
    await expect(a2aMessageStatus(endpoint, "m-1")).rejects.toThrow(
      "enroll again with a new code"
    );
    expect(h.server.counts.refresh).toBe(0);
  });

  test("a revoked session's refresh is refused and nothing is rewritten", async () => {
    const h = await enrolledMachine();
    const before = readFileSync(h.path, "utf8");
    const credential = readA2ASessionCredential(h.path);
    h.server.service.revoke(
      { kind: "host" },
      { sessionId: credential?.sessionId ?? "" }
    );
    const late = (TOKEN_TTL_SECONDS - 4 * 60) * 1000;
    // The server shares the session's clock.
    h.clock.offsetMs = late;
    await expect(h.source(late).bearer()).rejects.toThrow("refused");
    expect(readFileSync(h.path, "utf8")).toBe(before);
  });

  test("keepFresh refreshes on a timer armed for when the token is due, then stops on abort", async () => {
    const h = await enrolledMachine();
    const first = readA2ASessionCredential(h.path)?.token;
    const late = (TOKEN_TTL_SECONDS - 4 * 60) * 1000;
    // The server shares the session's clock.
    h.clock.offsetMs = late;
    const abort = new AbortController();
    const ended: Error[] = [];
    h.source(late).keepFresh(abort.signal, (error) => ended.push(error));
    for (let index = 0; index < 60 && h.server.counts.refresh === 0; index++) {
      await sleep(50);
    }
    abort.abort();
    expect(h.server.counts.refresh).toBe(1);
    expect(readA2ASessionCredential(h.path)?.token).not.toBe(first);
    expect(ended).toEqual([]);
  });

  test("a credential file another user could read is refused", () => {
    const root = scratch();
    const path = join(root, "credentials", "ra2-phone.json");
    writeA2ASessionCredential(path, {
      enrolledAt: "2026-10-11T00:00:00.000Z",
      expiresAt: 1,
      origin: "https://loop.home.lab",
      schema: A2A_SESSION_CREDENTIAL_SCHEMA,
      sessionId: `s-${"0".repeat(32)}`,
      supervisorId: PHONE,
      token: "a.b.c",
    });
    expect(readA2ASessionCredential(path)?.supervisorId).toBe(PHONE);
    chmodSync(path, 0o640);
    expect(() => readA2ASessionCredential(path)).toThrow("0600");
  });
});
