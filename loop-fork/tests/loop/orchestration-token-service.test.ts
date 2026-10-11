import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTokenRoutes,
  ENROLLMENT_CODE_TTL_SECONDS,
  loadTokenSigningKey,
  OrchestrationTokenService,
  type RoleBinding,
  roleMayControl,
  roleMayMessage,
  signTokenClaims,
  TOKEN_AUDIENCE,
  TOKEN_TTL_SECONDS,
  TokenAuthorityError,
  type TokenClaims,
  TokenStore,
  verifyTokenSignature,
  writeTokenSigningKey,
} from "../../src/loop/orchestration-token-service";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const scratch = (): string => {
  const root = mkdtempSync(join(tmpdir(), "ra1-tokens-"));
  roots.push(root);
  return root;
};

const OWNER = "supervisor:owner";
const OPERATOR = "supervisor:portfolio";
const SUP = "supervisor:harness";
const WORKER = "supervisor:harness-worker";
const OTHER_SUP = "supervisor:aicur";
const OTHER_WORKER = "supervisor:aicur-worker";

const binding = (
  role: RoleBinding["role"],
  repoKey = "agents-collab",
  project = "loop"
): RoleBinding => ({ project, repoKey, role });

const bindings = new Map<string, RoleBinding>([
  [OWNER, binding("owner", "estate", "all")],
  [OPERATOR, binding("operator", "estate", "all")],
  [SUP, binding("supervisor")],
  [WORKER, binding("worker")],
  [OTHER_SUP, binding("supervisor", "ai-cur", "app")],
  [OTHER_WORKER, binding("worker", "ai-cur", "app")],
]);

const T0 = Date.parse("2026-10-11T12:00:00Z");

const setup = (
  options: { bindings?: Map<string, RoleBinding>; root?: string } = {}
) => {
  const root = options.root ?? scratch();
  const keyPath = join(root, "signing.pem");
  try {
    statSync(keyPath);
  } catch {
    writeTokenSigningKey(keyPath);
  }
  const clock = { now: T0 };
  const make = () =>
    new OrchestrationTokenService({
      bindings: options.bindings ?? bindings,
      key: loadTokenSigningKey(keyPath),
      now: () => clock.now,
      store: new TokenStore(join(root, "tokens")),
    });
  const service = make();
  const host = { kind: "host" } as const;
  const enroll = (address: string, via = service) => {
    const { code } = via.issueEnrollmentCode(host, address);
    const issued = via.enroll(code);
    if (!issued) {
      throw new Error("fixture enrollment failed");
    }
    return issued;
  };
  const actor = (token: string) => {
    const session = service.verify(token);
    if (!session) {
      throw new Error("fixture token does not verify");
    }
    return { kind: "session", session } as const;
  };
  return { actor, clock, enroll, host, keyPath, make, root, service };
};

// biome-ignore lint/suspicious/noBitwiseOperators: permission bits are a bit mask.
const mode = (path: string) => statSync(path).mode & 0o777;

const payloadOf = (token: string): Record<string, unknown> =>
  JSON.parse(
    Buffer.from(token.split(".")[1] as string, "base64url").toString("utf8")
  );

describe("RA1 signing key file", () => {
  test("a 0600 Ed25519 key this user owns loads; errors name the path, never the key", () => {
    const root = scratch();
    const path = join(root, "signing.pem");
    const { kid } = writeTokenSigningKey(path);
    // biome-ignore lint/suspicious/noBitwiseOperators: permission bits.
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadTokenSigningKey(path).kid).toBe(kid);
    expect(() => writeTokenSigningKey(path)).toThrow();
    const pem = readFileSync(path, "utf8");
    chmodSync(path, 0o640);
    let message = "";
    try {
      loadTokenSigningKey(path);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("must be a regular 0600 file owned by this user");
    expect(message).not.toContain(pem.split("\n")[1] as string);
  });

  test("a symlink, a malformed file or a non-Ed25519 key is refused", () => {
    const root = scratch();
    const real = join(root, "real.pem");
    writeTokenSigningKey(real);
    const link = join(root, "link.pem");
    symlinkSync(real, link);
    expect(() => loadTokenSigningKey(link)).toThrow("is not readable");
    const junk = join(root, "junk.pem");
    writeFileSync(junk, "not a key", { mode: 0o600 });
    expect(() => loadTokenSigningKey(junk)).toThrow("is malformed");
    const rsa = join(root, "rsa.pem");
    writeFileSync(
      rsa,
      generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({
        format: "pem",
        type: "pkcs8",
      }),
      { mode: 0o600 }
    );
    expect(() => loadTokenSigningKey(rsa)).toThrow("is not Ed25519");
  });
});

describe("RA1 enrollment and session tokens", () => {
  test("a code enrolls one session as its address; the token carries exactly the RA1 claims", () => {
    const { enroll, service } = setup();
    const issued = enroll(SUP);
    const claims = payloadOf(issued.token);
    expect(Object.keys(claims).sort()).toEqual([
      "aud",
      "epoch",
      "exp",
      "iat",
      "jti",
      "project",
      "repoKey",
      "role",
      "sub",
    ]);
    expect(claims).toMatchObject({
      aud: TOKEN_AUDIENCE,
      epoch: 0,
      project: "loop",
      repoKey: "agents-collab",
      role: "supervisor",
      sub: issued.sessionId,
    });
    expect(Number(claims.exp) - Number(claims.iat)).toBe(TOKEN_TTL_SECONDS);
    expect(service.verify(issued.token)).toEqual({
      address: SUP,
      claims: claims as unknown as TokenClaims,
    });
  });

  test("a code is single-use, expires after ten minutes and binds only a role-bound address", () => {
    const { clock, host, service } = setup();
    const { code } = service.issueEnrollmentCode(host, WORKER);
    expect(service.enroll(code)).toBeDefined();
    expect(service.enroll(code)).toBeUndefined();
    const late = service.issueEnrollmentCode(host, WORKER);
    clock.now += ENROLLMENT_CODE_TTL_SECONDS * 1000;
    expect(service.enroll(late.code)).toBeUndefined();
    expect(service.enroll("A".repeat(43))).toBeUndefined();
    expect(service.enroll("short")).toBeUndefined();
    expect(() =>
      service.issueEnrollmentCode(host, "supervisor:nobody")
    ).toThrow("has no configured role");
  });

  test("a code whose address changed role before it was used enrolls nothing", () => {
    const root = scratch();
    const first = setup({ root });
    const { code } = first.service.issueEnrollmentCode(first.host, WORKER);
    const changed = new Map(bindings);
    changed.set(WORKER, binding("supervisor", "other", "x"));
    const later = setup({ bindings: changed, root });
    expect(later.service.enroll(code)).toBeUndefined();
  });

  test("a token expires after thirty minutes", () => {
    const { clock, enroll, service } = setup();
    const { token } = enroll(WORKER);
    clock.now += (TOKEN_TTL_SECONDS - 1) * 1000;
    expect(service.verify(token)).toBeDefined();
    clock.now += 1000;
    expect(service.verify(token)).toBeUndefined();
  });

  test("a token is refused for another audience, another key, another alg header, or a tampered payload", () => {
    const { enroll, keyPath, service } = setup();
    const { token, sessionId } = enroll(WORKER);
    const key = loadTokenSigningKey(keyPath);
    const claims = payloadOf(token) as unknown as TokenClaims;
    const now = Math.floor(T0 / 1000);
    expect(verifyTokenSignature(key, token, now)).toBeDefined();
    // Another audience, signed by the right key.
    const [header, ,] = token.split(".") as [string, string, string];
    const otherAud = Buffer.from(
      JSON.stringify({ ...claims, aud: "attention-os" })
    ).toString("base64url");
    const otherAudSig = sign(
      null,
      Buffer.from(`${header}.${otherAud}`),
      key.privateKey
    ).toString("base64url");
    expect(
      service.verify(`${header}.${otherAud}.${otherAudSig}`)
    ).toBeUndefined();
    // Another key.
    const other = setup();
    expect(other.service.verify(token)).toBeUndefined();
    // An alg:none or HS256 header, or one naming another kid.
    for (const fake of [
      { alg: "none", kid: key.kid, typ: "JWT" },
      { alg: "HS256", kid: key.kid, typ: "JWT" },
      { alg: "EdDSA", kid: "0".repeat(32), typ: "JWT" },
    ]) {
      const fakeHeader = Buffer.from(JSON.stringify(fake)).toString(
        "base64url"
      );
      const [, payload, signature] = token.split(".") as [
        string,
        string,
        string,
      ];
      expect(
        service.verify(`${fakeHeader}.${payload}.${signature}`)
      ).toBeUndefined();
    }
    // A payload naming another session, keeping the original signature.
    const [, , signature] = token.split(".") as [string, string, string];
    const tampered = Buffer.from(
      JSON.stringify({ ...claims, role: "owner" })
    ).toString("base64url");
    expect(
      service.verify(`${header}.${tampered}.${signature}`)
    ).toBeUndefined();
    // A correctly signed token for a session the store never enrolled.
    const forged = signTokenClaims(key, {
      ...claims,
      sub: `s-${"f".repeat(32)}`,
    });
    expect(service.verify(forged)).toBeUndefined();
    expect(sessionId).toMatch(/^s-[0-9a-f]{32}$/);
  });

  test("a correctly signed token whose role claims differ from its session's is refused", () => {
    const { enroll, keyPath, service } = setup();
    const { token } = enroll(WORKER);
    const key = loadTokenSigningKey(keyPath);
    const claims = payloadOf(token) as unknown as TokenClaims;
    const escalated = signTokenClaims(key, { ...claims, role: "owner" });
    expect(service.verify(escalated)).toBeUndefined();
  });

  test("a valid token's header and claims under another key's signature are refused", () => {
    const { enroll, service } = setup();
    const { token } = enroll(WORKER);
    const [header, payload, signature] = token.split(".") as [
      string,
      string,
      string,
    ];
    const stranger = generateKeyPairSync("ed25519").privateKey;
    const forged = sign(
      null,
      Buffer.from(`${header}.${payload}`),
      stranger
    ).toString("base64url");
    expect(service.verify(`${header}.${payload}.${forged}`)).toBeUndefined();
    const flipped = `${signature.slice(0, -2)}${signature.endsWith("AA") ? "AB" : "AA"}`;
    expect(service.verify(`${header}.${payload}.${flipped}`)).toBeUndefined();
    expect(service.verify(token)).toBeDefined();
  });

  test("only the header as issued is accepted, even when the right key signs another", () => {
    const { enroll, keyPath, service } = setup();
    const { token } = enroll(WORKER);
    const key = loadTokenSigningKey(keyPath);
    const [, payload] = token.split(".") as [string, string, string];
    for (const fake of [
      { alg: "none", kid: key.kid, typ: "JWT" },
      { alg: "EdDSA", typ: "JWT" },
      { alg: "EdDSA", kid: key.kid, typ: "JWT", x5u: "https://evil" },
    ]) {
      const header = Buffer.from(JSON.stringify(fake)).toString("base64url");
      const signature = sign(
        null,
        Buffer.from(`${header}.${payload}`),
        key.privateKey
      ).toString("base64url");
      expect(
        service.verify(`${header}.${payload}.${signature}`)
      ).toBeUndefined();
    }
  });

  test("a signed token issued in the future, or living longer than thirty minutes, is refused", () => {
    const { enroll, keyPath, service } = setup();
    const { token } = enroll(WORKER);
    const key = loadTokenSigningKey(keyPath);
    const claims = payloadOf(token) as unknown as TokenClaims;
    const future = signTokenClaims(key, {
      ...claims,
      exp: claims.exp + 3600,
      iat: claims.iat + 3600,
    });
    expect(service.verify(future)).toBeUndefined();
    const longLived = signTokenClaims(key, { ...claims, exp: claims.exp + 60 });
    expect(service.verify(longLived)).toBeUndefined();
    expect(service.verify(signTokenClaims(key, claims))).toBeDefined();
  });

  test("a token past its own exp is refused while its session lives on and its denial was pruned", () => {
    const { clock, enroll, service } = setup();
    const first = enroll(SUP);
    clock.now += 1000 * 1000;
    const second = service.refresh(first.token) as { token: string };
    // Past the first token's exp: the next write prunes its denial.
    clock.now += 900 * 1000;
    const third = service.refresh(second.token) as { token: string };
    expect(service.verify(third.token)?.address).toBe(SUP);
    expect(service.verify(first.token)).toBeUndefined();
  });
});

describe("RA1 refresh and revocation", () => {
  test("refresh issues a new token for the same session and denies the old one", () => {
    const { clock, enroll, service } = setup();
    const first = enroll(SUP);
    clock.now += 60_000;
    const second = service.refresh(first.token);
    expect(second?.sessionId).toBe(first.sessionId);
    expect(second?.token).not.toBe(first.token);
    expect(service.verify(first.token)).toBeUndefined();
    expect(service.refresh(first.token)).toBeUndefined();
    expect(service.verify(second?.token as string)?.address).toBe(SUP);
  });

  test("refresh needs an unexpired token of a live, non-revoked session", () => {
    const { actor, clock, enroll, host, service } = setup();
    const expired = enroll(WORKER);
    clock.now += TOKEN_TTL_SECONDS * 1000;
    expect(service.refresh(expired.token)).toBeUndefined();
    const revoked = enroll(WORKER);
    service.revoke(actor(revoked.token), { sessionId: revoked.sessionId });
    expect(service.refresh(revoked.token)).toBeUndefined();
    expect(host.kind).toBe("host");
  });

  test("a revoked session's tokens stop verifying, and the revocation survives a restart", () => {
    const root = scratch();
    const first = setup({ root });
    const { sessionId, token } = first.enroll(WORKER);
    first.service.revoke(first.host, { sessionId });
    expect(first.service.verify(token)).toBeUndefined();
    const restarted = setup({ root });
    expect(restarted.service.verify(token)).toBeUndefined();
    expect(mode(join(root, "tokens", "token-store.json"))).toBe(0o600);
    expect(mode(join(root, "tokens"))).toBe(0o700);
  });

  test("a denied jti stops that token only; the session refreshes from another", () => {
    const { actor, clock, enroll, host, service } = setup();
    const first = enroll(SUP);
    clock.now += 1000;
    const second = service.refresh(first.token);
    const jti = String(payloadOf(second?.token as string).jti);
    service.revoke(actor(second?.token as string), { jti });
    expect(service.verify(second?.token as string)).toBeUndefined();
    const other = enroll(SUP);
    service.revoke(host, { jti: String(payloadOf(other.token).jti) });
    expect(service.verify(other.token)).toBeUndefined();
  });

  test("a role epoch bump stops every earlier token of that role and subtree, and only those", () => {
    const { enroll, host, service } = setup();
    const worker = enroll(WORKER);
    const supervisor = enroll(SUP);
    service.revoke(host, { epochFor: WORKER });
    expect(service.verify(worker.token)).toBeUndefined();
    expect(service.refresh(worker.token)).toBeUndefined();
    expect(service.verify(supervisor.token)).toBeDefined();
    const fresh = enroll(WORKER);
    expect(payloadOf(fresh.token).epoch).toBe(1);
    expect(service.verify(fresh.token)?.address).toBe(WORKER);
  });

  test("a changed config binding stops a session's tokens", () => {
    const root = scratch();
    const first = setup({ root });
    const { token } = first.enroll(WORKER);
    const changed = new Map(bindings);
    changed.delete(WORKER);
    expect(
      setup({ bindings: changed, root }).service.verify(token)
    ).toBeUndefined();
    const rebound = new Map(bindings);
    rebound.set(WORKER, binding("worker", "agents-collab", "other"));
    expect(
      setup({ bindings: rebound, root }).service.verify(token)
    ).toBeUndefined();
  });

  test("a token whose claims match the new config but not its session's enrollment is refused", () => {
    const root = scratch();
    const first = setup({ root });
    const { token } = first.enroll(WORKER);
    const key = loadTokenSigningKey(first.keyPath);
    const claims = payloadOf(token) as unknown as TokenClaims;
    const forged = signTokenClaims(key, { ...claims, project: "other" });
    const rebound = new Map(bindings);
    rebound.set(WORKER, binding("worker", "agents-collab", "other"));
    expect(
      setup({ bindings: rebound, root }).service.verify(forged)
    ).toBeUndefined();
  });
});

describe("RA1 grants by role subtree", () => {
  test("owner anything; supervisor its workers; worker its supervisor; operator supervisors", () => {
    const of = (id: string) => bindings.get(id) as RoleBinding;
    const allowed = (from: string, to: string) =>
      roleMayMessage(of(from), bindings.get(to));
    expect(allowed(OWNER, OTHER_WORKER)).toBe(true);
    expect(roleMayMessage(of(OWNER), undefined)).toBe(true);
    expect(allowed(SUP, WORKER)).toBe(true);
    expect(allowed(SUP, OTHER_WORKER)).toBe(false);
    expect(allowed(SUP, OTHER_SUP)).toBe(false);
    expect(allowed(SUP, OWNER)).toBe(false);
    expect(allowed(WORKER, SUP)).toBe(true);
    expect(allowed(WORKER, OTHER_SUP)).toBe(false);
    expect(allowed(WORKER, WORKER)).toBe(false);
    expect(allowed(WORKER, OWNER)).toBe(false);
    expect(allowed(OPERATOR, SUP)).toBe(true);
    expect(allowed(OPERATOR, OTHER_SUP)).toBe(true);
    expect(allowed(OPERATOR, WORKER)).toBe(false);
    expect(roleMayMessage(of(SUP), undefined)).toBe(false);
    expect(roleMayControl(of(SUP), of(WORKER))).toBe(true);
    expect(roleMayControl(of(SUP), of(OTHER_WORKER))).toBe(false);
    expect(roleMayControl(of(OPERATOR), of(SUP))).toBe(false);
    expect(roleMayControl(of(OWNER), of(OTHER_SUP))).toBe(true);
  });

  test("minting and revoking follow the same subtree", () => {
    const { actor, enroll, service } = setup();
    const owner = actor(enroll(OWNER).token);
    const supervisor = actor(enroll(SUP).token);
    const worker = actor(enroll(WORKER).token);
    const operator = actor(enroll(OPERATOR).token);
    expect(service.issueEnrollmentCode(owner, OTHER_SUP).code).toBeString();
    expect(service.issueEnrollmentCode(supervisor, WORKER).code).toBeString();
    for (const [who, address] of [
      [supervisor, OTHER_WORKER],
      [supervisor, SUP],
      [worker, WORKER],
      [operator, SUP],
    ] as const) {
      expect(() => service.issueEnrollmentCode(who, address)).toThrow(
        TokenAuthorityError
      );
    }
    const target = enroll(WORKER);
    const otherTarget = enroll(OTHER_WORKER);
    expect(() =>
      service.revoke(worker, { sessionId: otherTarget.sessionId })
    ).toThrow(TokenAuthorityError);
    expect(() =>
      service.revoke(supervisor, { sessionId: otherTarget.sessionId })
    ).toThrow(TokenAuthorityError);
    service.revoke(supervisor, { sessionId: target.sessionId });
    expect(service.verify(target.token)).toBeUndefined();
    expect(() => service.revoke(supervisor, { epochFor: WORKER })).toThrow(
      TokenAuthorityError
    );
    expect(() =>
      service.revoke(worker, { jti: String(payloadOf(otherTarget.token).jti) })
    ).toThrow(TokenAuthorityError);
    service.revoke(owner, { epochFor: OTHER_WORKER });
    expect(service.verify(otherTarget.token)).toBeUndefined();
  });
});

describe("RA1 token routes", () => {
  const post = (
    path: string,
    body: unknown,
    token?: string,
    method = "POST"
  ): Request =>
    new Request(`http://127.0.0.1:7321${path}`, {
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      method,
    });
  const call = async (
    routes: ReturnType<typeof createTokenRoutes>,
    request: Request
  ) => {
    const response = await routes(request, new URL(request.url).pathname);
    if (!response) {
      throw new Error("not a token route");
    }
    return { body: await response.json(), status: response.status };
  };

  test("enroll, refresh, mint and revoke over HTTP, as the verified session only", async () => {
    const { enroll, host, service } = setup();
    const routes = createTokenRoutes(service);
    const { code } = service.issueEnrollmentCode(host, SUP);
    const enrolled = await call(
      routes,
      post("/api/v1/tokens/enroll", { code })
    );
    expect(enrolled.status).toBe(200);
    expect(enrolled.body.data).toMatchObject({
      audience: TOKEN_AUDIENCE,
      tokenType: "Bearer",
    });
    const token = enrolled.body.data.token as string;
    expect(
      (await call(routes, post("/api/v1/tokens/enroll", { code }))).status
    ).toBe(401);
    const refreshed = await call(
      routes,
      post("/api/v1/tokens/refresh", {}, token)
    );
    expect(refreshed.status).toBe(200);
    const next = refreshed.body.data.token as string;
    expect(
      (await call(routes, post("/api/v1/tokens/refresh", {}, token))).status
    ).toBe(401);
    const minted = await call(
      routes,
      post("/api/v1/tokens/enrollment-codes", { supervisorId: WORKER }, next)
    );
    expect(minted.status).toBe(200);
    expect(service.enroll(minted.body.data.code)?.sessionId).toBeString();
    expect(
      (
        await call(
          routes,
          post("/api/v1/tokens/enrollment-codes", { supervisorId: OWNER }, next)
        )
      ).status
    ).toBe(403);
    const victim = enroll(OTHER_WORKER);
    expect(
      (
        await call(
          routes,
          post("/api/v1/tokens/revoke", { sessionId: victim.sessionId }, next)
        )
      ).status
    ).toBe(403);
    const self = payloadOf(next).sub as string;
    expect(
      (
        await call(
          routes,
          post("/api/v1/tokens/revoke", { sessionId: self }, next)
        )
      ).status
    ).toBe(200);
    expect(service.verify(next)).toBeUndefined();
  });

  test("a static or absent bearer, a bad body, another method or path is refused", async () => {
    const { service } = setup();
    const routes = createTokenRoutes(service);
    expect(
      (
        await call(
          routes,
          post(
            "/api/v1/tokens/enrollment-codes",
            { supervisorId: WORKER },
            "legacy-static-token"
          )
        )
      ).status
    ).toBe(401);
    expect(
      (await call(routes, post("/api/v1/tokens/revoke", { jti: "x" }))).status
    ).toBe(401);
    expect(
      (await call(routes, post("/api/v1/tokens/enroll", { code: 1 }))).status
    ).toBe(401);
    expect(
      (await call(routes, post("/api/v1/tokens/enroll", {}, undefined, "GET")))
        .status
    ).toBe(405);
    expect((await call(routes, post("/api/v1/tokens/other", {}))).status).toBe(
      404
    );
    expect(
      await routes(
        post("/api/v1/supervisor-threads", {}),
        "/api/v1/supervisor-threads"
      )
    ).toBeUndefined();
  });
});
