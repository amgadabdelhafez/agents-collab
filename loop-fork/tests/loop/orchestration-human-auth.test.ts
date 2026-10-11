import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  createHmac,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, sleep } from "bun";
import {
  createConfiguredTokenService,
  createLoopOrchestrationFetchHandler,
  orchestrationAuthenticator,
  parseLoopOrchestrationConfig,
} from "../../src/loop/loop-orchestration-server";
import {
  createHumanRoutes,
  DEFAULT_HUMAN_JWT_HEADER,
  HumanJwtVerifier,
  JwksCache,
} from "../../src/loop/orchestration-human-auth";
import {
  type OrchestrationTokenService,
  writeTokenSigningKey,
} from "../../src/loop/orchestration-token-service";
import {
  createSupervisorOrchestrationHttpHandler,
  type SupervisorControlSurfaceAuthenticator,
} from "../../src/loop/supervisor-orchestration-http";

// ------------------------------------------------------------------ keys

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rsaNext = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const rsaWeak = generateKeyPairSync("rsa", { modulusLength: 1024 });

const jwk = (key: KeyObject, extra: Record<string, unknown>) => ({
  ...(key.export({ format: "jwk" }) as Record<string, unknown>),
  ...extra,
});

const b64 = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

const ISSUER = "http://127.0.0.1/application/o/loop/";
const AUDIENCE = "loop-human-client";

const nowSeconds = () => Math.floor(Date.now() / 1000);

const claims = (extra: Record<string, unknown> = {}) => ({
  aud: AUDIENCE,
  exp: nowSeconds() + 300,
  groups: ["loop-owners"],
  iat: nowSeconds(),
  iss: ISSUER,
  sub: "akadmin",
  ...extra,
});

const signJwt = (
  input: {
    alg?: string;
    header?: Record<string, unknown>;
    key?: KeyObject;
    kid?: string | null;
  },
  payload: Record<string, unknown> = claims()
): string => {
  const alg = input.alg ?? "RS256";
  const header = {
    alg,
    typ: "JWT",
    ...(input.kid === null ? {} : { kid: input.kid ?? "rsa-1" }),
    ...input.header,
  };
  const signingInput = `${b64(header)}.${b64(payload)}`;
  const key = input.key ?? rsa.privateKey;
  const signature = alg.startsWith("ES")
    ? sign("sha256", Buffer.from(signingInput), {
        dsaEncoding: "ieee-p1363",
        key,
      })
    : sign(
        alg === "RS384" ? "sha384" : "sha256",
        Buffer.from(signingInput),
        key
      );
  return `${signingInput}.${signature.toString("base64url")}`;
};

// --------------------------------------------------- a local JWKS server

interface JwksState {
  body?: string;
  delayMs: number;
  hits: number;
  keys: unknown[];
  redirectTo?: string;
  status: number;
}

const jwksState: JwksState = { delayMs: 0, hits: 0, keys: [], status: 200 };
const resetJwks = (keys: unknown[]) => {
  jwksState.body = undefined;
  jwksState.delayMs = 0;
  jwksState.hits = 0;
  jwksState.keys = keys;
  jwksState.redirectTo = undefined;
  jwksState.status = 200;
};
const defaultKeys = () => [
  jwk(rsa.publicKey, { alg: "RS256", kid: "rsa-1", use: "sig" }),
  jwk(ec.publicKey, { alg: "ES256", kid: "ec-1", use: "sig" }),
];

let jwksServer: ReturnType<typeof serve>;
let otherServer: ReturnType<typeof serve>;
let jwksUrl = "";
let otherUrl = "";

beforeAll(() => {
  jwksServer = serve({
    fetch: async () => {
      jwksState.hits += 1;
      if (jwksState.delayMs > 0) {
        await sleep(jwksState.delayMs);
      }
      if (jwksState.redirectTo) {
        return new Response(null, {
          headers: { location: jwksState.redirectTo },
          status: 302,
        });
      }
      return new Response(
        jwksState.body ?? JSON.stringify({ keys: jwksState.keys }),
        {
          headers: { "content-type": "application/json" },
          status: jwksState.status,
        }
      );
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  // A second JWKS that a redirect points at: it serves the signing key, so
  // only refusing the redirect keeps its keys out.
  otherServer = serve({
    fetch: () =>
      Response.json({
        keys: [jwk(rsa.publicKey, { alg: "RS256", kid: "rsa-1" })],
      }),
    hostname: "127.0.0.1",
    port: 0,
  });
  jwksUrl = `http://127.0.0.1:${jwksServer.port}/application/o/loop/jwks/`;
  otherUrl = `http://127.0.0.1:${otherServer.port}/jwks/`;
});

afterAll(() => {
  jwksServer.stop(true);
  otherServer.stop(true);
});

// ------------------------------------------------------------------ config

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

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

const estate = { project: "all", repoKey: "estate" };

const humanAuth = (extra: Record<string, unknown> = {}) => ({
  audience: AUDIENCE,
  groups: [
    { group: "loop-owners", principal: "principal:owner" },
    { group: "loop-operators", principal: "principal:portfolio" },
  ],
  issuer: ISSUER,
  jwksUrl,
  routePath: "/human",
  ...extra,
});

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
  ],
  hostname: "127.0.0.1",
  humanAuth: humanAuth(),
  identity: "loop-orchestration@local",
  namespace: "default",
  port: 7321,
  schema: "loop-orchestration-server.v1",
  stateDir: "/private/tmp/ra2-state",
  supervisors: [
    supervisor("supervisor:legacy"),
    supervisor("supervisor:owner", { ...estate, role: "owner" }),
    supervisor("supervisor:portfolio", { ...estate, role: "operator" }),
    supervisor("supervisor:harness", {
      project: "harness",
      repoKey: "harness-engineering",
      role: "supervisor",
    }),
  ],
  taskQueue: "loop-orchestration",
  ...extra,
});

describe("RA2 humanAuth config", () => {
  test("parses with the Authentik header and a 10 minute JWKS cache by default", () => {
    const parsed = parseLoopOrchestrationConfig(config());
    expect(parsed.humanAuth).toEqual({
      audience: AUDIENCE,
      groups: [
        { group: "loop-owners", principal: "principal:owner" },
        { group: "loop-operators", principal: "principal:portfolio" },
      ],
      header: DEFAULT_HUMAN_JWT_HEADER,
      issuer: ISSUER,
      jwksCacheTtlMs: 600_000,
      jwksUrl,
      routePath: "/human",
    });
    expect(DEFAULT_HUMAN_JWT_HEADER).toBe("x-authentik-jwt");
    expect(
      parseLoopOrchestrationConfig(
        config({ humanAuth: humanAuth({ header: "X-Loop-Human-JWT" }) })
      ).humanAuth?.header
    ).toBe("x-loop-human-jwt");
    const { humanAuth: _absent, ...withoutHuman } = config();
    expect(
      parseLoopOrchestrationConfig(withoutHuman).humanAuth
    ).toBeUndefined();
  });

  test("a group maps only to one owner or operator address", () => {
    const groups = (principal: string) =>
      config({ humanAuth: humanAuth({ groups: [{ group: "g", principal }] }) });
    for (const principal of [
      "principal:harness",
      "principal:legacy",
      "principal:nobody",
    ]) {
      expect(() => parseLoopOrchestrationConfig(groups(principal))).toThrow(
        "is not one owner or operator address"
      );
    }
    expect(() =>
      parseLoopOrchestrationConfig(
        config({
          humanAuth: humanAuth({
            groups: [
              { group: "g", principal: "principal:owner" },
              { group: "g", principal: "principal:portfolio" },
            ],
          }),
        })
      )
    ).toThrow("mapped more than once");
    expect(() =>
      parseLoopOrchestrationConfig(
        config({ humanAuth: humanAuth({ groups: [] }) })
      )
    ).toThrow("groups are invalid");
  });

  test("the JWKS and issuer are https, or http only on a loopback literal", () => {
    for (const bad of [
      "http://auth.home.lab/application/o/loop/jwks/",
      "http://localhost:9000/jwks/",
      `${jwksUrl}?x=1`,
      "https://user:pw@auth.home.lab/jwks/",
    ]) {
      expect(() =>
        parseLoopOrchestrationConfig(
          config({ humanAuth: humanAuth({ jwksUrl: bad }) })
        )
      ).toThrow("humanAuth jwksUrl");
    }
    expect(() =>
      parseLoopOrchestrationConfig(
        config({ humanAuth: humanAuth({ issuer: "http://auth.home.lab/" }) })
      )
    ).toThrow("humanAuth issuer");
    expect(
      parseLoopOrchestrationConfig(
        config({
          humanAuth: humanAuth({
            issuer: "https://auth.home.lab/application/o/loop/",
            jwksUrl: "https://auth.home.lab/application/o/loop/jwks/",
          }),
        })
      ).humanAuth?.issuer
    ).toBe("https://auth.home.lab/application/o/loop/");
  });

  test("the human routePath overlaps none of the server's routes", () => {
    for (const routePath of [
      "/api",
      "/api/v1/human",
      "/healthz",
      "/",
      "/human/",
    ]) {
      expect(() =>
        parseLoopOrchestrationConfig(
          config({ humanAuth: humanAuth({ routePath }) })
        )
      ).toThrow("routePath");
    }
  });

  test("the JWT header never reuses a header that carries another credential", () => {
    for (const header of ["Authorization", "cookie", "proxy-authorization"]) {
      expect(() =>
        parseLoopOrchestrationConfig(
          config({ humanAuth: humanAuth({ header }) })
        )
      ).toThrow("another credential");
    }
  });

  test("fields, audience and cache TTL are strict", () => {
    expect(() =>
      parseLoopOrchestrationConfig(
        config({ humanAuth: humanAuth({ extra: 1 }) })
      )
    ).toThrow("invalid fields");
    const { audience: _audience, ...noAudience } = humanAuth();
    expect(() =>
      parseLoopOrchestrationConfig(config({ humanAuth: noAudience }))
    ).toThrow("invalid fields");
    for (const jwksCacheTtlMs of [59_999, 86_400_001, 1.5, "600000"]) {
      expect(() =>
        parseLoopOrchestrationConfig(
          config({ humanAuth: humanAuth({ jwksCacheTtlMs }) })
        )
      ).toThrow("jwksCacheTtlMs");
    }
    expect(() =>
      parseLoopOrchestrationConfig(
        config({ humanAuth: humanAuth({ audience: "has space" }) })
      )
    ).toThrow("audience");
  });
});

// ---------------------------------------------------------------- verifier

const verifierFor = (
  options: {
    minRefreshIntervalMs?: number;
    now?: () => number;
    timeoutMs?: number;
    ttlMs?: number;
  } = {}
) => {
  const jwks = new JwksCache({
    ...(options.minRefreshIntervalMs === undefined
      ? {}
      : { minRefreshIntervalMs: options.minRefreshIntervalMs }),
    ...(options.now ? { now: options.now } : {}),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
    ttlMs: options.ttlMs ?? 600_000,
    url: jwksUrl,
  });
  const verifier = new HumanJwtVerifier({
    config: { audience: AUDIENCE, issuer: ISSUER },
    jwks,
  });
  return { jwks, verifier };
};

describe("RA2 Authentik JWT verification", () => {
  test("an RS256 or ES256 token signed by a JWKS key verifies", async () => {
    resetJwks(defaultKeys());
    const { verifier } = verifierFor();
    expect(await verifier.verify(signJwt({}))).toMatchObject({
      groups: ["loop-owners"],
      iss: ISSUER,
      sub: "akadmin",
    });
    expect(
      await verifier.verify(
        signJwt({ alg: "ES256", key: ec.privateKey, kid: "ec-1" })
      )
    ).toMatchObject({ groups: ["loop-owners"] });
  });

  test("a forged or tampered signature verifies nothing", async () => {
    resetJwks(defaultKeys());
    const { verifier } = verifierFor();
    // Signed by a key the JWKS does not hold, under a kid it does.
    expect(
      await verifier.verify(signJwt({ key: rsaNext.privateKey }))
    ).toBeUndefined();
    const [header, , signature] = signJwt({}).split(".");
    const promoted = b64(claims({ groups: ["loop-owners", "admins"] }));
    expect(
      await verifier.verify(`${header}.${promoted}.${signature}`)
    ).toBeUndefined();
    expect(await verifier.verify(`${header}.${promoted}.`)).toBeUndefined();
  });

  test("exp is required and enforced; nbf in the future is refused", async () => {
    resetJwks(defaultKeys());
    const { verifier } = verifierFor();
    expect(
      await verifier.verify(signJwt({}, claims({ exp: nowSeconds() - 120 })))
    ).toBeUndefined();
    const { exp: _exp, ...noExp } = claims();
    expect(await verifier.verify(signJwt({}, noExp))).toBeUndefined();
    expect(
      await verifier.verify(signJwt({}, claims({ exp: "never" })))
    ).toBeUndefined();
    expect(
      await verifier.verify(signJwt({}, claims({ nbf: nowSeconds() + 600 })))
    ).toBeUndefined();
    expect(
      await verifier.verify(signJwt({}, claims({ iat: nowSeconds() + 600 })))
    ).toBeUndefined();
    // Within the clock skew both still verify.
    expect(
      await verifier.verify(
        signJwt({}, claims({ exp: nowSeconds() - 10, nbf: nowSeconds() + 10 }))
      )
    ).toBeDefined();
  });

  test("iss and aud must be this server's", async () => {
    resetJwks(defaultKeys());
    const { verifier } = verifierFor();
    expect(
      await verifier.verify(
        signJwt({}, claims({ iss: "http://127.0.0.1/application/o/other/" }))
      )
    ).toBeUndefined();
    const { iss: _iss, ...noIss } = claims();
    expect(await verifier.verify(signJwt({}, noIss))).toBeUndefined();
    expect(
      await verifier.verify(signJwt({}, claims({ aud: "another-client" })))
    ).toBeUndefined();
    expect(
      await verifier.verify(signJwt({}, claims({ aud: ["another-client"] })))
    ).toBeUndefined();
    const { aud: _aud, ...noAud } = claims();
    expect(await verifier.verify(signJwt({}, noAud))).toBeUndefined();
    expect(
      await verifier.verify(
        signJwt({}, claims({ aud: ["another-client", AUDIENCE] }))
      )
    ).toBeDefined();
  });

  test("none, HMAC, crit and a key of the wrong type are refused", async () => {
    resetJwks(defaultKeys());
    const { verifier } = verifierFor();
    const payload = b64(claims());
    const none = `${b64({ alg: "none", kid: "rsa-1" })}.${payload}.`;
    expect(await verifier.verify(none)).toBeUndefined();
    // HS256 keyed with the public key's own bytes: the classic confusion.
    const hsInput = `${b64({ alg: "HS256", kid: "rsa-1" })}.${payload}`;
    const hs = createHmac(
      "sha256",
      rsa.publicKey.export({ format: "pem", type: "spki" })
    )
      .update(hsInput)
      .digest("base64url");
    expect(await verifier.verify(`${hsInput}.${hs}`)).toBeUndefined();
    expect(
      await verifier.verify(signJwt({ header: { crit: ["exp"] } }))
    ).toBeUndefined();
    // An RS256 signature named as the EC key's kid.
    expect(await verifier.verify(signJwt({ kid: "ec-1" }))).toBeUndefined();
    expect(await verifier.verify("not.a.jwt")).toBeUndefined();
    expect(await verifier.verify("x".repeat(20_000))).toBeUndefined();
  });

  test("a token without a kid needs exactly one usable key", async () => {
    resetJwks([jwk(rsa.publicKey, { kid: "rsa-1" })]);
    expect(
      await verifierFor().verifier.verify(signJwt({ kid: null }))
    ).toBeDefined();
    resetJwks([
      jwk(rsa.publicKey, { kid: "rsa-1" }),
      jwk(rsaNext.publicKey, { kid: "rsa-2" }),
    ]);
    expect(
      await verifierFor().verifier.verify(signJwt({ kid: null }))
    ).toBeUndefined();
  });

  test("JWKS entries with private material, another use or a weak key are never trusted", async () => {
    resetJwks([
      jwk(rsa.privateKey, { kid: "rsa-1" }),
      jwk(rsaNext.publicKey, { kid: "rsa-2", use: "enc" }),
      jwk(rsaWeak.publicKey, { kid: "rsa-weak" }),
    ]);
    const { verifier } = verifierFor();
    expect(await verifier.verify(signJwt({}))).toBeUndefined();
    expect(
      await verifier.verify(signJwt({ key: rsaNext.privateKey, kid: "rsa-2" }))
    ).toBeUndefined();
    expect(
      await verifier.verify(
        signJwt({ key: rsaWeak.privateKey, kid: "rsa-weak" })
      )
    ).toBeUndefined();
  });
});

describe("RA2 JWKS cache", () => {
  test("keys are cached for the TTL, then fetched again", async () => {
    resetJwks(defaultKeys());
    let now = 1_000_000;
    const { jwks, verifier } = verifierFor({ now: () => now, ttlMs: 60_000 });
    expect(await verifier.verify(signJwt({}))).toBeDefined();
    expect(await verifier.verify(signJwt({}))).toBeDefined();
    expect(jwks.fetches).toBe(1);
    now += 60_000;
    expect(await verifier.verify(signJwt({}))).toBeDefined();
    expect(jwks.fetches).toBe(2);
    expect(jwksState.hits).toBe(2);
  });

  test("the TTL alone refreshes, without an unknown kid to prompt it", async () => {
    // A kid-less token never asks for a rotation refresh, so only the TTL
    // can replace a key that Authentik has withdrawn.
    resetJwks([jwk(rsa.publicKey, { kid: "rsa-1" })]);
    let now = 1_000_000;
    const { jwks, verifier } = verifierFor({ now: () => now, ttlMs: 60_000 });
    expect(await verifier.verify(signJwt({ kid: null }))).toBeDefined();
    resetJwks([jwk(rsaNext.publicKey, { kid: "rsa-2" })]);
    now += 59_000;
    expect(await verifier.verify(signJwt({ kid: null }))).toBeDefined();
    expect(jwks.fetches).toBe(1);
    now += 1000;
    expect(await verifier.verify(signJwt({ kid: null }))).toBeUndefined();
    expect(
      await verifier.verify(signJwt({ key: rsaNext.privateKey, kid: null }))
    ).toBeDefined();
    expect(jwks.fetches).toBe(2);
  });

  test("concurrent requests on a cold cache share one fetch", async () => {
    resetJwks(defaultKeys());
    jwksState.delayMs = 50;
    // No refresh interval, so only the shared in-flight fetch bounds this.
    const { jwks, verifier } = verifierFor({ minRefreshIntervalMs: 0 });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => verifier.verify(signJwt({})))
    );
    expect(results.every((result) => result !== undefined)).toBe(true);
    expect(jwks.fetches).toBe(1);
  });

  test("an unknown kid refreshes once per interval, so a rotation is picked up", async () => {
    resetJwks(defaultKeys());
    let now = 1_000_000;
    const { jwks, verifier } = verifierFor({
      minRefreshIntervalMs: 30_000,
      now: () => now,
    });
    expect(await verifier.verify(signJwt({}))).toBeDefined();
    expect(jwks.fetches).toBe(1);
    // Authentik rotates its signing key.
    resetJwks([
      ...defaultKeys(),
      jwk(rsaNext.publicKey, { alg: "RS256", kid: "rsa-2" }),
    ]);
    const rotated = signJwt({ key: rsaNext.privateKey, kid: "rsa-2" });
    // Inside the interval since the first fetch: no new fetch, refused.
    now += 1000;
    expect(await verifier.verify(rotated)).toBeUndefined();
    expect(jwks.fetches).toBe(1);
    now += 30_000;
    expect(await verifier.verify(rotated)).toBeDefined();
    expect(jwks.fetches).toBe(2);
    // A flood of made-up kids cannot turn into a flood of fetches.
    for (let index = 0; index < 20; index += 1) {
      expect(
        await verifier.verify(
          signJwt({ key: rsaNext.privateKey, kid: `bogus-${index}` })
        )
      ).toBeUndefined();
    }
    expect(jwks.fetches).toBe(2);
    // The server saw one request since the rotation reset its counter.
    expect(jwksState.hits).toBe(1);
  });

  test("past its TTL a cache that cannot refresh verifies nothing (fail closed)", async () => {
    resetJwks(defaultKeys());
    let now = 1_000_000;
    const { jwks, verifier } = verifierFor({
      minRefreshIntervalMs: 30_000,
      now: () => now,
      ttlMs: 60_000,
    });
    expect(await verifier.verify(signJwt({}))).toBeDefined();
    jwksState.status = 503;
    now += 60_000;
    expect(await verifier.verify(signJwt({}))).toBeUndefined();
    expect(jwks.fetches).toBe(2);
    // The failed attempt also bounds the retry rate.
    now += 1000;
    expect(await verifier.verify(signJwt({}))).toBeUndefined();
    expect(jwks.fetches).toBe(2);
    jwksState.status = 200;
    now += 30_000;
    expect(await verifier.verify(signJwt({}))).toBeDefined();
    expect(jwks.fetches).toBe(3);
  });

  test("a fetch never follows a redirect", async () => {
    resetJwks([]);
    jwksState.redirectTo = otherUrl;
    const { verifier } = verifierFor();
    expect(await verifier.verify(signJwt({}))).toBeUndefined();
    expect(jwksState.hits).toBe(1);
  });

  test("an oversized, malformed or slow JWKS yields no keys", async () => {
    resetJwks(defaultKeys());
    jwksState.body = JSON.stringify({
      keys: defaultKeys(),
      padding: "x".repeat(70 * 1024),
    });
    expect(await verifierFor().verifier.verify(signJwt({}))).toBeUndefined();
    resetJwks(defaultKeys());
    jwksState.body = "{not json";
    expect(await verifierFor().verifier.verify(signJwt({}))).toBeUndefined();
    resetJwks(Array.from({ length: 33 }, () => defaultKeys()[0]));
    expect(await verifierFor().verifier.verify(signJwt({}))).toBeUndefined();
    resetJwks(defaultKeys());
    jwksState.delayMs = 500;
    expect(
      await verifierFor({ timeoutMs: 100 }).verifier.verify(signJwt({}))
    ).toBeUndefined();
  });
});

// ------------------------------------------------------------- the routes

describe("RA2 human routes", () => {
  const setup = () => {
    resetJwks(defaultKeys());
    const root = mkdtempSync(join(tmpdir(), "ra2-human-"));
    roots.push(root);
    const signingKeyFile = join(root, "signing.pem");
    writeTokenSigningKey(signingKeyFile);
    const parsed = parseLoopOrchestrationConfig(
      config({ stateDir: root, tokens: { signingKeyFile } })
    );
    const tokens = createConfiguredTokenService(
      parsed
    ) as OrchestrationTokenService;
    const env = { LOOP_OWNER_TOKEN: "owner-static-fixture" };
    const bearerAuth = orchestrationAuthenticator(parsed, env, tokens);
    const humanRoutes = createHumanRoutes(
      parsed.humanAuth as NonNullable<typeof parsed.humanAuth>,
      parsed.supervisors
    );
    const surfaces: string[] = [];
    const received: { principal?: string }[] = [];
    const v1 = (auth: SupervisorControlSurfaceAuthenticator) => {
      surfaces.push(auth === humanRoutes.authenticator ? "human" : "api");
      return createSupervisorOrchestrationHttpHandler({
        authenticator: auth,
        messages: {
          receive: (command: { principal?: string }) => {
            received.push(command);
            return Promise.resolve({ accepted: true });
          },
          threads: () => [{ thread: "t-1" }],
        } as never,
        tasks: {} as never,
      });
    };
    const handler = createLoopOrchestrationFetchHandler({
      authenticator: bearerAuth,
      host: { httpHandler: v1, workerState: () => "RUNNING" } as never,
      humanRoutes,
      reconciliationHealthy: () => true,
      tokenRoutes: async () => undefined,
    });
    const sessionToken = (address: string) => {
      const { code } = tokens.issueEnrollmentCode({ kind: "host" }, address);
      return tokens.enroll(code)?.token as string;
    };
    return { handler, received, sessionToken, surfaces };
  };

  const get = (path: string, headers: Record<string, string> = {}) =>
    new Request(`http://127.0.0.1:7321${path}`, { headers });

  const whoami = async (
    handler: (request: Request) => Promise<Response>,
    headers: Record<string, string>
  ) => {
    const response = await handler(
      new Request(
        "http://127.0.0.1:7321/human/api/v1/supervisor-messages/receive",
        {
          body: JSON.stringify({
            input: { from: "supervisor:any", to: "supervisor:harness" },
            messageKind: "question",
            requestId: "request-1",
          }),
          headers: { "content-type": "application/json", ...headers },
          method: "POST",
        }
      )
    );
    return response.status;
  };

  test("an owner or operator group acts as its configured address, first mapping first", async () => {
    const { handler, received, surfaces } = setup();
    expect(surfaces).toEqual(["api", "human"]);
    const read = await handler(
      get("/human/api/v1/supervisor-threads", {
        "x-authentik-jwt": signJwt({}),
      })
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ data: [{ thread: "t-1" }] });
    // The body's `from` must be the authenticated address, so the receive
    // status shows who the JWT made the caller.
    const as = (groups: string[]) => ({
      "x-authentik-jwt": signJwt({}, claims({ groups })),
    });
    expect(await whoami(handler, as(["loop-owners"]))).toBe(400);
    expect(received).toEqual([]);
    const send = (from: string, groups: string[]) =>
      handler(
        new Request(
          "http://127.0.0.1:7321/human/api/v1/supervisor-messages/receive",
          {
            body: JSON.stringify({
              input: { from, to: "supervisor:harness" },
              messageKind: "question",
              requestId: "request-1",
            }),
            headers: { "content-type": "application/json", ...as(groups) },
            method: "POST",
          }
        )
      );
    expect((await send("supervisor:owner", ["loop-owners"])).status).toBe(200);
    expect(
      (await send("supervisor:portfolio", ["staff", "loop-operators"])).status
    ).toBe(200);
    expect(
      (await send("supervisor:owner", ["loop-operators", "loop-owners"])).status
    ).toBe(200);
    expect(
      (await send("supervisor:portfolio", ["loop-operators", "loop-owners"]))
        .status
    ).toBe(400);
    expect(received.map((entry) => entry.principal)).toEqual([
      "principal:owner",
      "principal:portfolio",
      "principal:owner",
    ]);
  });

  test("a verified JWT without a mapped group is refused", async () => {
    const { handler } = setup();
    for (const groups of [[], ["staff"], ["Loop-Owners"]]) {
      expect(
        (
          await handler(
            get("/human/api/v1/supervisor-threads", {
              "x-authentik-jwt": signJwt({}, claims({ groups })),
            })
          )
        ).status
      ).toBe(401);
    }
  });

  test("without a valid JWT a human route is refused, whatever else the request carries", async () => {
    const { handler, sessionToken } = setup();
    const lan = {
      "x-forwarded-for": "192.168.1.20",
      "x-real-ip": "192.168.1.20",
    };
    const spoofed = {
      "x-authentik-email": "owner@home.lab",
      "x-authentik-groups": "loop-owners",
      "x-authentik-username": "akadmin",
    };
    const refused: Record<string, string>[] = [
      {},
      lan,
      spoofed,
      { ...lan, ...spoofed },
      { authorization: "Bearer owner-static-fixture", ...lan },
      { authorization: `Bearer ${sessionToken("supervisor:owner")}` },
      // Loop's own session token is not an Authentik JWT.
      { "x-authentik-jwt": sessionToken("supervisor:owner") },
      { "x-authentik-jwt": signJwt({ key: rsaNext.privateKey }), ...lan },
      {
        authorization: "Bearer owner-static-fixture",
        "x-authentik-jwt": signJwt({}, claims({ exp: nowSeconds() - 600 })),
      },
    ];
    for (const headers of refused) {
      for (const path of [
        "/human",
        "/human/",
        "/human/api/v1/supervisor-threads",
        "/human/api/v1/tokens/enrollment-codes",
      ]) {
        const response = await handler(get(path, headers));
        expect(response.status).toBe(401);
      }
    }
    expect(
      await whoami(handler, { authorization: "Bearer owner-static-fixture" })
    ).toBe(401);
  });

  test("API routes keep using bearer tokens; the JWT header means nothing there", async () => {
    const { handler, sessionToken } = setup();
    expect(
      (
        await handler(
          get("/api/v1/supervisor-threads", {
            authorization: `Bearer ${sessionToken("supervisor:harness")}`,
          })
        )
      ).status
    ).toBe(200);
    expect(
      (
        await handler(
          get("/api/v1/supervisor-threads", {
            authorization: "Bearer owner-static-fixture",
          })
        )
      ).status
    ).toBe(200);
    expect(
      (
        await handler(
          get("/api/v1/supervisor-threads", { "x-authentik-jwt": signJwt({}) })
        )
      ).status
    ).toBe(401);
    // A path that only starts with the human prefix is not a human route.
    expect(
      (await handler(get("/humanoid", { "x-authentik-jwt": signJwt({}) })))
        .status
    ).toBe(401);
  });
});
