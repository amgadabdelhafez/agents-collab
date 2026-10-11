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
  EnrollmentAttemptLimiter,
  enrollmentCodeBucket,
  loadTokenSigningKey,
  OrchestrationTokenService,
  type RoleBinding,
  roleMayControl,
  roleMayMessage,
  roleMessagePolicy,
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
    // RA2: a supervisor messages an operator (upward), and the owner only as
    // a reply on a thread the owner started (the caller checks the thread).
    expect(allowed(SUP, OPERATOR)).toBe(true);
    expect(allowed(OTHER_SUP, OPERATOR)).toBe(true);
    expect(roleMessagePolicy(of(SUP), of(OWNER))).toBe("owner-thread-reply");
    expect(roleMessagePolicy(of(SUP), of(OPERATOR))).toBe("allowed");
    expect(roleMessagePolicy(of(SUP), of(OTHER_SUP))).toBe("denied");
    for (const from of [WORKER, OPERATOR]) {
      expect(roleMessagePolicy(of(from), of(OWNER))).toBe("denied");
    }
    expect(allowed(WORKER, OPERATOR)).toBe(false);
    expect(allowed(OPERATOR, OPERATOR)).toBe(false);
    expect(roleMayControl(of(SUP), of(WORKER))).toBe(true);
    expect(roleMayControl(of(SUP), of(OTHER_WORKER))).toBe(false);
    expect(roleMayControl(of(OPERATOR), of(SUP))).toBe(false);
    expect(roleMayControl(of(OWNER), of(OTHER_SUP))).toBe(true);
  });

  test("RA2: only the host and an owner mint; revoking follows the subtree", () => {
    const { actor, enroll, host, service } = setup();
    const owner = actor(enroll(OWNER).token);
    const supervisor = actor(enroll(SUP).token);
    const worker = actor(enroll(WORKER).token);
    const operator = actor(enroll(OPERATOR).token);
    expect(service.issueEnrollmentCode(owner, OTHER_SUP).code).toBeString();
    expect(service.issueEnrollmentCode(owner, WORKER).code).toBeString();
    expect(service.issueEnrollmentCode(host, WORKER).code).toBeString();
    // A supervisor never mints, not even for a worker of its own subtree: a
    // code it held would let it enroll as that worker.
    for (const [who, address] of [
      [supervisor, WORKER],
      [supervisor, OTHER_WORKER],
      [supervisor, SUP],
      [worker, WORKER],
      [operator, SUP],
      [operator, WORKER],
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
    // RA2: a supervisor session never mints, even for its own worker.
    for (const supervisorId of [WORKER, OWNER]) {
      expect(
        await call(
          routes,
          post("/api/v1/tokens/enrollment-codes", { supervisorId }, next)
        )
      ).toEqual({ body: { error: { code: "authority-denied" } }, status: 403 });
    }
    const ownerToken = enroll(OWNER).token;
    const minted = await call(
      routes,
      post(
        "/api/v1/tokens/enrollment-codes",
        { supervisorId: WORKER },
        ownerToken
      )
    );
    expect(minted.status).toBe(200);
    expect(service.enroll(minted.body.data.code)?.sessionId).toBeString();
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

describe("RA2 unauthenticated enrollment", () => {
  const BOGUS = "A".repeat(43);
  const storeStat = (root: string) => {
    const path = join(root, "tokens", "token-store.json");
    const stat = statSync(path);
    return {
      body: readFileSync(path, "utf8"),
      ino: stat.ino,
      mtimeMs: stat.mtimeMs,
    };
  };

  test("a code that matches nothing takes no lock and rewrites nothing", () => {
    const { enroll, host, root, service } = setup();
    enroll(SUP);
    const pending = service.issueEnrollmentCode(host, WORKER);
    const before = storeStat(root);
    // A held lock: an enroll that wanted it would wait and then throw.
    const lock = join(root, "tokens", "token-store.lock");
    writeFileSync(lock, "");
    const started = Date.now();
    for (const code of [BOGUS, `${"b".repeat(42)}_`]) {
      expect(service.enroll(code)).toBeUndefined();
    }
    expect(Date.now() - started).toBeLessThan(500);
    expect(storeStat(root)).toEqual(before);
    expect(statSync(lock).isFile()).toBe(true);
    rmSync(lock);
    // A real code is still exchanged (re-checked under the lock).
    expect(service.enroll(pending.code)?.sessionId).toBeString();
    expect(storeStat(root).body).not.toBe(before.body);
  });

  test("with no store yet, a code that matches nothing creates no store", () => {
    const { root, service } = setup();
    expect(service.enroll(BOGUS)).toBeUndefined();
    expect(() => statSync(join(root, "tokens", "token-store.json"))).toThrow();
  });

  test("past its free failures a source is slowed by a doubling delay, not locked out", () => {
    const clock = { now: 0 };
    const limiter = new EnrollmentAttemptLimiter({
      baseDelayMs: 1000,
      limit: 3,
      maxSources: 2,
      now: () => clock.now,
      windowMs: 10_000,
    });
    const attacker = "203.0.113.1";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(limiter.retryAfterSeconds(attacker)).toBe(0);
      limiter.recordFailure(attacker);
    }
    // 1 s, then 2, 4, 8, and capped at the 10 s window.
    const waits: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const wait = limiter.retryAfterSeconds(attacker);
      waits.push(wait);
      clock.now += wait * 1000;
      expect(limiter.retryAfterSeconds(attacker)).toBe(0);
      limiter.recordFailure(attacker);
    }
    expect(waits).toEqual([1, 2, 4, 8, 10, 10]);
    expect(limiter.retryAfterSeconds("203.0.113.2")).toBe(0);
    // Half way through a wait the rest is what remains.
    clock.now += 5000;
    expect(limiter.retryAfterSeconds(attacker)).toBe(5);
    // Quiet for two windows: forgotten, its free failures back.
    clock.now += 15_000;
    expect(limiter.retryAfterSeconds(attacker)).toBe(0);
    limiter.recordFailure(attacker);
    expect(limiter.retryAfterSeconds(attacker)).toBe(0);
  });

  test("a key is remembered until it has been quiet for two windows", () => {
    const clock = { now: 0 };
    const limiter = new EnrollmentAttemptLimiter({
      baseDelayMs: 1000,
      limit: 1,
      now: () => clock.now,
      windowMs: 10_000,
    });
    const source = "203.0.113.1";
    limiter.recordFailure(source);
    expect(limiter.retryAfterSeconds(source)).toBe(1);
    // Its delay is over, but it is still remembered: the next failure
    // doubles the delay.
    clock.now = 19_999;
    expect(limiter.retryAfterSeconds(source)).toBe(0);
    limiter.recordFailure(source);
    expect(limiter.retryAfterSeconds(source)).toBe(2);
    // Quiet for two windows: it starts over at the first delay.
    clock.now += 20_000;
    limiter.recordFailure(source);
    expect(limiter.retryAfterSeconds(source)).toBe(1);
  });

  test("a full limiter shares one overflow key and evicts nobody", () => {
    const clock = { now: 0 };
    const limiter = new EnrollmentAttemptLimiter({
      baseDelayMs: 1000,
      limit: 3,
      maxSources: 2,
      now: () => clock.now,
      windowMs: 10_000,
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      limiter.recordFailure("203.0.113.1");
    }
    expect(limiter.retryAfterSeconds("203.0.113.1")).toBe(1);
    limiter.recordFailure("203.0.113.2");
    for (let index = 3; index < 50; index += 1) {
      limiter.recordFailure(`203.0.113.${index}`);
    }
    expect(limiter.size).toBe(3);
    expect(limiter.retryAfterSeconds("203.0.113.1")).toBe(1);
    expect(limiter.retryAfterSeconds("203.0.113.99")).toBe(10);
    expect(limiter.retryAfterSeconds("203.0.113.2")).toBe(0);
    // The overflow key is slowed too, never closed: it may try again.
    clock.now += 10_000;
    expect(limiter.retryAfterSeconds("203.0.113.99")).toBe(0);
    // Forgotten keys are dropped when the map is full, so a new source gets
    // its own key again, not the shared overflow one.
    clock.now += 20_000;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      limiter.recordFailure("198.51.100.1");
    }
    expect(limiter.retryAfterSeconds("198.51.100.1")).toBe(1);
    expect(limiter.retryAfterSeconds("198.51.100.2")).toBe(0);
    expect(limiter.retryAfterSeconds("203.0.113.1")).toBe(0);
    expect(limiter.size).toBeLessThanOrEqual(3);
  });

  test("the code-prefix bucket is the code's first two characters", () => {
    expect(enrollmentCodeBucket("Ab-rest")).toBe("code:Ab");
    expect(enrollmentCodeBucket("_9")).toBe("code:_9");
    for (const malformed of ["", "A", "A.", "..", " A", "é1"]) {
      expect(enrollmentCodeBucket(malformed)).toBe(enrollmentCodeBucket(".."));
    }
    expect(enrollmentCodeBucket("..")).not.toContain("code:");
  });

  const enrollRequest = (body: string, contentType = "application/json") =>
    new Request("http://127.0.0.1:7321/api/v1/tokens/enroll", {
      body,
      headers: { "content-type": contentType },
      method: "POST",
    });
  const enrollWith = async (
    routes: ReturnType<typeof createTokenRoutes>,
    source: string,
    request: Request
  ) => {
    const response = await routes(request, "/api/v1/tokens/enroll", source);
    if (!response) {
      throw new Error("not a token route");
    }
    return response;
  };

  test("the enroll route slows a source before reading the code", async () => {
    const { host, service } = setup();
    const limiter = new EnrollmentAttemptLimiter({ limit: 2 });
    const routes = createTokenRoutes(service, limiter);
    const enrollAs = (source: string, code: unknown) =>
      enrollWith(routes, source, enrollRequest(JSON.stringify({ code })));
    const attacker = "203.0.113.7";
    expect((await enrollAs(attacker, BOGUS)).status).toBe(401);
    expect((await enrollAs(attacker, 42)).status).toBe(401);
    const { code } = service.issueEnrollmentCode(host, WORKER);
    const blocked = await enrollAs(attacker, code);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("1");
    expect(await blocked.json()).toEqual({
      error: { code: "too-many-attempts" },
    });
    // The slowed attempt did not consume the code; another source uses it.
    expect((await enrollAs("198.51.100.2", code)).status).toBe(200);
    // A success counts nothing against its source.
    for (const address of [SUP, OTHER_SUP]) {
      const fresh = service.issueEnrollmentCode(host, address);
      expect((await enrollAs("198.51.100.3", fresh.code)).status).toBe(200);
    }
    expect(limiter.retryAfterSeconds("198.51.100.3")).toBe(0);
    expect(limiter.retryAfterSeconds("198.51.100.2")).toBe(0);
  });

  test("a body that cannot be read or parsed counts as a failed attempt", async () => {
    const { service } = setup();
    // Six attempts below; a limit of six slows the source only if every one
    // of them counted.
    const sources = new EnrollmentAttemptLimiter({ limit: 6 });
    const routes = createTokenRoutes(service, { sources });
    const unreadable = new Request(
      "http://127.0.0.1:7321/api/v1/tokens/enroll",
      {
        body: new ReadableStream({
          pull(controller) {
            controller.error(new Error("connection reset"));
          },
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }
    );
    const attempts: [string, Request][] = [
      ["not json", enrollRequest("{")],
      ["not an object", enrollRequest("[1]")],
      ["wrong type", enrollRequest('{"code":"x"}', "text/plain")],
      ["too large", enrollRequest(`{"code":"${"A".repeat(70_000)}"}`)],
      ["extra field", enrollRequest('{"code":"x","more":1}')],
      ["unreadable", unreadable],
    ];
    const statuses: [string, number][] = [];
    for (const [label, request] of attempts) {
      expect(sources.retryAfterSeconds("203.0.113.8")).toBe(0);
      statuses.push([
        label,
        (await enrollWith(routes, "203.0.113.8", request)).status,
      ]);
    }
    expect(statuses).toEqual([
      ["not json", 401],
      ["not an object", 401],
      ["wrong type", 401],
      ["too large", 401],
      ["extra field", 401],
      ["unreadable", 500],
    ]);
    expect(sources.retryAfterSeconds("203.0.113.8")).toBe(1);
  });

  test("failures are capped per code-prefix bucket across every source", async () => {
    const { host, service } = setup();
    const codePrefixes = new EnrollmentAttemptLimiter({ limit: 3 });
    const sources = new EnrollmentAttemptLimiter({ limit: 1 });
    const routes = createTokenRoutes(service, { codePrefixes, sources });
    const enrollAs = (source: string, code: string) =>
      enrollWith(routes, source, enrollRequest(JSON.stringify({ code })));
    const real = service.issueEnrollmentCode(host, WORKER);
    const realBucket = enrollmentCodeBucket(real.code);
    const prefix = realBucket === "code:AA" ? "BB" : "AA";
    // Three sources, one guess each, all in one bucket.
    for (const source of ["203.0.113.1", "203.0.113.2", "203.0.113.3"]) {
      expect(
        (await enrollAs(source, `${prefix}${"x".repeat(41)}`)).status
      ).toBe(401);
    }
    const slowed = await enrollAs("203.0.113.4", `${prefix}${"y".repeat(41)}`);
    expect(slowed.status).toBe(429);
    expect(slowed.headers.get("retry-after")).toBe("1");
    // The refused guess was never evaluated, so its source is not charged.
    expect(sources.retryAfterSeconds("203.0.113.4")).toBe(0);
    // Another bucket is untouched: a real code in it is exchanged.
    expect(codePrefixes.retryAfterSeconds(realBucket)).toBe(0);
    expect((await enrollAs("203.0.113.4", real.code)).status).toBe(200);
  });
});
