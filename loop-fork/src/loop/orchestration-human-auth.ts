import { createPublicKey, type KeyObject, verify } from "node:crypto";
import { parseServerEndpointUrl } from "./orchestration-origin-policy";
import type {
  SupervisorControlSurfaceAuthenticator,
  SupervisorControlSurfaceIdentity,
} from "./supervisor-orchestration-http";

/**
 * RA2: optional Authentik JWT verification for the human (owner and
 * operator) routes of the orchestration server.
 *
 * - Human routes are everything under one configured `routePath`. There the
 *   caller is whoever the Authentik JWT (the forward-auth `X-authentik-jwt`
 *   header by default) says, mapped from its `groups` claim to one configured
 *   owner or operator address. Nothing else establishes a human identity on
 *   those routes: no bearer token, no unsigned `X-authentik-*` header and no
 *   source address. A request that reaches the server without passing
 *   Authentik (a LAN client, a Traefik router without the middleware) has no
 *   valid JWT and is refused.
 * - The JWT's signature is checked against the configured JWKS (RS256/384/512
 *   or ES256/384/512, never `none` or an HMAC), and exp, nbf, iss and aud are
 *   enforced.
 * - The JWKS is cached for `jwksCacheTtlMs`. An unknown `kid` (a rotation)
 *   refreshes it at most once per refresh interval, every fetch is time- and
 *   size-bounded and follows no redirect, and a cache past its TTL that
 *   cannot be refreshed verifies nothing (fail closed).
 * - API routes are unchanged: they keep using session (and legacy static)
 *   bearer tokens, and the JWT header means nothing there.
 */

export const DEFAULT_HUMAN_JWT_HEADER = "x-authentik-jwt";
export const DEFAULT_JWKS_CACHE_TTL_MS = 10 * 60 * 1000;
export const JWKS_MIN_REFRESH_INTERVAL_MS = 30 * 1000;
export const JWKS_FETCH_TIMEOUT_MS = 5000;
export const JWKS_MAX_BYTES = 64 * 1024;
export const JWKS_MAX_KEYS = 32;
const MIN_JWKS_CACHE_TTL_MS = 60 * 1000;
const MAX_JWKS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_JWT_LENGTH = 16 * 1024;
const MAX_GROUP_MAPPINGS = 32;
const CLOCK_SKEW_SECONDS = 60;
const MIN_RSA_MODULUS_BITS = 2048;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const HEADER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const AUDIENCE_RE = /^[\x21-\x7e]{1,256}$/;
const GROUP_RE = /^[^\p{Cc}]{1,128}$/u;
const PRINCIPAL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,255}$/;
const ROUTE_PATH_RE = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,255}$/;
// The server's own namespaces a human routePath may not overlap.
const RESERVED_ROUTE_PATHS = ["/api", "/healthz"];
// Headers that already carry another credential on this server.
const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
]);
export const HUMAN_ROLES = ["owner", "operator"] as const;
type HumanRole = (typeof HUMAN_ROLES)[number];

export interface HumanGroupMapping {
  group: string;
  principal: string;
}

export interface HumanAuthConfig {
  audience: string;
  /**
   * Ordered: the first mapping whose group the JWT carries decides the
   * principal, so a person in both an owner and an operator group acts as
   * whichever the config lists first.
   */
  groups: HumanGroupMapping[];
  /** Lower-case request header carrying the JWT. */
  header: string;
  issuer: string;
  jwksCacheTtlMs: number;
  jwksUrl: string;
  routePath: string;
}

/** A configured address as far as human authentication needs it. */
export interface HumanAuthSupervisor {
  principal: string;
  role?: { role: string };
  supervisorId: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isHumanRole = (value: unknown): value is HumanRole =>
  typeof value === "string" &&
  (HUMAN_ROLES as readonly string[]).includes(value);

const overlaps = (left: string, right: string): boolean =>
  left === right ||
  left.startsWith(`${right}/`) ||
  right.startsWith(`${left}/`);

const requireMatch = (value: unknown, pattern: RegExp, label: string) => {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
};

/** The one owner or operator address a principal names, or undefined. */
const humanAddressFor = (
  supervisors: readonly HumanAuthSupervisor[],
  principal: string
): HumanAuthSupervisor | undefined => {
  const matches = supervisors.filter((entry) => entry.principal === principal);
  const [only] = matches;
  return matches.length === 1 && only && isHumanRole(only.role?.role)
    ? only
    : undefined;
};

const parseGroups = (
  value: unknown,
  supervisors: readonly HumanAuthSupervisor[]
): HumanGroupMapping[] => {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_GROUP_MAPPINGS
  ) {
    throw new Error("orchestration humanAuth groups are invalid");
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      Object.keys(entry).sort().join(",") !== "group,principal"
    ) {
      throw new Error("orchestration humanAuth group mapping is invalid");
    }
    const group = requireMatch(
      entry.group,
      GROUP_RE,
      "orchestration humanAuth group"
    );
    const principal = requireMatch(
      entry.principal,
      PRINCIPAL_RE,
      "orchestration humanAuth principal"
    );
    if (seen.has(group)) {
      throw new Error(
        `orchestration humanAuth group ${group} is mapped more than once`
      );
    }
    seen.add(group);
    if (!humanAddressFor(supervisors, principal)) {
      throw new Error(
        `orchestration humanAuth principal ${principal} is not one owner or operator address`
      );
    }
    return { group, principal };
  });
};

const parseCacheTtl = (value: unknown): number => {
  if (value === undefined) {
    return DEFAULT_JWKS_CACHE_TTL_MS;
  }
  if (
    !(
      Number.isSafeInteger(value) &&
      Number(value) >= MIN_JWKS_CACHE_TTL_MS &&
      Number(value) <= MAX_JWKS_CACHE_TTL_MS
    )
  ) {
    throw new Error("orchestration humanAuth jwksCacheTtlMs is invalid");
  }
  return Number(value);
};

const parseHeaderName = (value: unknown): string => {
  if (value === undefined) {
    return DEFAULT_HUMAN_JWT_HEADER;
  }
  const header = requireMatch(
    typeof value === "string" ? value.toLowerCase() : value,
    HEADER_NAME_RE,
    "orchestration humanAuth header"
  );
  if (RESERVED_HEADERS.has(header)) {
    throw new Error(
      "orchestration humanAuth header is invalid: it already carries another credential"
    );
  }
  return header;
};

const parseRoutePath = (
  value: unknown,
  otherRoutePaths: readonly string[]
): string => {
  const routePath = requireMatch(
    value,
    ROUTE_PATH_RE,
    "orchestration humanAuth routePath"
  );
  if (routePath.endsWith("/") || routePath.includes("//")) {
    throw new Error("orchestration humanAuth routePath is invalid");
  }
  for (const other of [...RESERVED_ROUTE_PATHS, ...otherRoutePaths]) {
    if (overlaps(routePath, other)) {
      throw new Error(`orchestration humanAuth routePath overlaps ${other}`);
    }
  }
  return routePath;
};

/**
 * The optional `humanAuth` config section, or undefined without one. Every
 * group maps to exactly one configured owner or operator address, and the
 * route path overlaps none of the server's other routes.
 */
export const parseHumanAuth = (
  value: unknown,
  supervisors: readonly HumanAuthSupervisor[],
  otherRoutePaths: readonly string[] = []
): HumanAuthConfig | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("orchestration humanAuth is invalid");
  }
  const required = ["audience", "groups", "issuer", "jwksUrl", "routePath"];
  const optional = new Set(["header", "jwksCacheTtlMs"]);
  const keys = Object.keys(value);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !(required.includes(key) || optional.has(key)))
  ) {
    throw new Error("orchestration humanAuth has invalid fields");
  }
  // Issuer and JWKS: https, or http only on a loopback IP literal. The
  // issuer is compared verbatim, so it is kept exactly as configured.
  const jwksUrl = parseServerEndpointUrl(
    value.jwksUrl,
    "orchestration humanAuth jwksUrl"
  ).href;
  parseServerEndpointUrl(value.issuer, "orchestration humanAuth issuer");
  return {
    audience: requireMatch(
      value.audience,
      AUDIENCE_RE,
      "orchestration humanAuth audience"
    ),
    groups: parseGroups(value.groups, supervisors),
    header: parseHeaderName(value.header),
    issuer: value.issuer as string,
    jwksCacheTtlMs: parseCacheTtl(value.jwksCacheTtlMs),
    jwksUrl,
    routePath: parseRoutePath(value.routePath, otherRoutePaths),
  };
};

// ------------------------------------------------------------------- JWKS

type JwsAlgorithm = "ES256" | "ES384" | "ES512" | "RS256" | "RS384" | "RS512";

interface AlgorithmSpec {
  crv?: string;
  hash: string;
  kty: "EC" | "RSA";
}

const ALGORITHMS: Readonly<Record<JwsAlgorithm, AlgorithmSpec>> = {
  ES256: { crv: "P-256", hash: "sha256", kty: "EC" },
  ES384: { crv: "P-384", hash: "sha384", kty: "EC" },
  ES512: { crv: "P-521", hash: "sha512", kty: "EC" },
  RS256: { hash: "sha256", kty: "RSA" },
  RS384: { hash: "sha384", kty: "RSA" },
  RS512: { hash: "sha512", kty: "RSA" },
};

const isAlgorithm = (value: unknown): value is JwsAlgorithm =>
  typeof value === "string" && Object.hasOwn(ALGORITHMS, value);

interface CachedKey {
  alg?: string;
  crv?: string;
  key: KeyObject;
  kid?: string;
  kty: "EC" | "RSA";
}

/** One public signing key from a JWKS entry, or undefined to skip it. */
const parseJwk = (value: unknown): CachedKey | undefined => {
  if (!isRecord(value) || (value.kty !== "RSA" && value.kty !== "EC")) {
    return undefined;
  }
  // A JWKS publishes public keys only; an entry with private material, or
  // one marked for another use, is never trusted.
  if ("d" in value || (value.use !== undefined && value.use !== "sig")) {
    return undefined;
  }
  if (value.kid !== undefined && typeof value.kid !== "string") {
    return undefined;
  }
  if (value.alg !== undefined && !isAlgorithm(value.alg)) {
    return undefined;
  }
  let key: KeyObject;
  try {
    key = createPublicKey({ format: "jwk", key: value as never });
  } catch {
    return undefined;
  }
  if (
    value.kty === "RSA" &&
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_MODULUS_BITS
  ) {
    return undefined;
  }
  return {
    ...(typeof value.alg === "string" ? { alg: value.alg } : {}),
    ...(typeof value.crv === "string" ? { crv: value.crv } : {}),
    key,
    ...(typeof value.kid === "string" ? { kid: value.kid } : {}),
    kty: value.kty,
  };
};

const readBoundedResponseText = async (
  response: Response,
  maxBytes: number
): Promise<string | undefined> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
};

export interface JwksCacheOptions {
  fetch?: typeof fetch;
  minRefreshIntervalMs?: number;
  now?: () => number;
  timeoutMs?: number;
  ttlMs: number;
  url: string;
}

/**
 * The JWKS, cached for `ttlMs`. A refresh happens when the cache is past its
 * TTL or when a caller names a key the cache lacks, and never more than once
 * per `minRefreshIntervalMs`, whatever the outcome; concurrent callers share
 * one fetch. A cache past its TTL that could not be refreshed yields no keys.
 */
export class JwksCache {
  private keys: CachedKey[] | undefined;
  private fetchedAt = Number.NEGATIVE_INFINITY;
  private attemptedAt = Number.NEGATIVE_INFINITY;
  private inflight: Promise<void> | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly minRefreshIntervalMs: number;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly ttlMs: number;
  private readonly url: string;
  /** How many fetches this cache has started (observability, tests). */
  fetches = 0;

  constructor(options: JwksCacheOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.minRefreshIntervalMs =
      options.minRefreshIntervalMs ?? JWKS_MIN_REFRESH_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? JWKS_FETCH_TIMEOUT_MS;
    this.ttlMs = options.ttlMs;
    this.url = options.url;
  }

  /**
   * The current keys: refreshed first when the cache is past its TTL, or
   * when `refreshForUnknownKey` asks and the refresh interval allows it.
   */
  async current(refreshForUnknownKey = false): Promise<readonly CachedKey[]> {
    const now = this.now();
    const fresh = this.keys !== undefined && now - this.fetchedAt < this.ttlMs;
    const mayAttempt = now - this.attemptedAt >= this.minRefreshIntervalMs;
    if ((!fresh || refreshForUnknownKey) && mayAttempt) {
      await this.refresh();
    } else if (this.inflight) {
      await this.inflight;
    }
    const after = this.now();
    return this.keys !== undefined && after - this.fetchedAt < this.ttlMs
      ? this.keys
      : [];
  }

  private refresh(): Promise<void> {
    if (!this.inflight) {
      this.attemptedAt = this.now();
      this.inflight = this.load().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  private async load(): Promise<void> {
    this.fetches += 1;
    try {
      const response = await this.fetchImpl(this.url, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      const text = await readBoundedResponseText(response, JWKS_MAX_BYTES);
      if (text === undefined) {
        return;
      }
      const document: unknown = JSON.parse(text);
      if (
        !(
          isRecord(document) &&
          Array.isArray(document.keys) &&
          document.keys.length <= JWKS_MAX_KEYS
        )
      ) {
        return;
      }
      const keys = document.keys.flatMap((entry) => {
        const parsed = parseJwk(entry);
        return parsed ? [parsed] : [];
      });
      if (keys.length === 0) {
        return;
      }
      this.keys = keys;
      this.fetchedAt = this.now();
    } catch {
      // A failed refresh leaves the previous keys until their TTL ends.
    }
  }
}

// -------------------------------------------------------------------- JWT

export interface HumanJwtClaims {
  aud: string | string[];
  exp: number;
  groups: string[];
  iss: string;
  sub?: string;
}

const decodeJson = (part: string): unknown => {
  if (!B64URL_RE.test(part)) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
};

const candidateKeys = (
  keys: readonly CachedKey[],
  alg: JwsAlgorithm,
  kid: string | undefined
): CachedKey[] => {
  const spec = ALGORITHMS[alg];
  const usable = keys.filter(
    (key) =>
      key.kty === spec.kty &&
      (spec.crv === undefined || key.crv === spec.crv) &&
      (key.alg === undefined || key.alg === alg)
  );
  if (kid !== undefined) {
    return usable.filter((key) => key.kid === kid);
  }
  // Without a kid, only an unambiguous key is used.
  return usable.length === 1 ? usable : [];
};

const signatureValid = (
  alg: JwsAlgorithm,
  key: KeyObject,
  signingInput: string,
  signature: Buffer
): boolean => {
  const spec = ALGORITHMS[alg];
  try {
    return verify(
      spec.hash,
      Buffer.from(signingInput),
      spec.kty === "EC" ? { dsaEncoding: "ieee-p1363", key } : key,
      signature
    );
  } catch {
    return false;
  }
};

const audienceMatches = (aud: unknown, audience: string): boolean =>
  aud === audience ||
  (Array.isArray(aud) &&
    aud.length > 0 &&
    aud.every((entry) => typeof entry === "string") &&
    aud.includes(audience));

const optionalNumber = (value: unknown): boolean =>
  value === undefined || (typeof value === "number" && Number.isFinite(value));

/** The claims of a payload that is current and meant for this server. */
const acceptClaims = (
  payload: unknown,
  config: Pick<HumanAuthConfig, "audience" | "issuer">,
  nowSeconds: number
): HumanJwtClaims | undefined => {
  if (!isRecord(payload)) {
    return undefined;
  }
  const { exp, iat, nbf } = payload;
  if (
    !(
      typeof exp === "number" &&
      Number.isFinite(exp) &&
      optionalNumber(nbf) &&
      optionalNumber(iat)
    )
  ) {
    return undefined;
  }
  if (
    nowSeconds >= exp + CLOCK_SKEW_SECONDS ||
    (typeof nbf === "number" && nowSeconds + CLOCK_SKEW_SECONDS < nbf) ||
    (typeof iat === "number" && iat > nowSeconds + CLOCK_SKEW_SECONDS)
  ) {
    return undefined;
  }
  if (payload.iss !== config.issuer) {
    return undefined;
  }
  if (!audienceMatches(payload.aud, config.audience)) {
    return undefined;
  }
  const groups = payload.groups;
  if (
    groups !== undefined &&
    !(
      Array.isArray(groups) &&
      groups.every((group) => typeof group === "string")
    )
  ) {
    return undefined;
  }
  return {
    aud: payload.aud as string | string[],
    exp,
    groups: (groups as string[] | undefined) ?? [],
    iss: payload.iss,
    ...(typeof payload.sub === "string" ? { sub: payload.sub } : {}),
  };
};

export interface HumanJwtVerifierOptions {
  config: Pick<HumanAuthConfig, "audience" | "issuer">;
  jwks: Pick<JwksCache, "current">;
  now?: () => number;
}

/** Verifies an Authentik JWT: signature, exp, nbf, iss and aud. */
export class HumanJwtVerifier {
  private readonly config: Pick<HumanAuthConfig, "audience" | "issuer">;
  private readonly jwks: Pick<JwksCache, "current">;
  private readonly now: () => number;

  constructor(options: HumanJwtVerifierOptions) {
    this.config = options.config;
    this.jwks = options.jwks;
    this.now = options.now ?? Date.now;
  }

  async verify(token: string): Promise<HumanJwtClaims | undefined> {
    if (token.length === 0 || token.length > MAX_JWT_LENGTH) {
      return undefined;
    }
    const parts = token.split(".");
    if (parts.length !== 3) {
      return undefined;
    }
    const [headerPart, payloadPart, signaturePart] = parts as [
      string,
      string,
      string,
    ];
    if (!B64URL_RE.test(signaturePart)) {
      return undefined;
    }
    const header = decodeJson(headerPart);
    if (!(isRecord(header) && isAlgorithm(header.alg)) || "crit" in header) {
      return undefined;
    }
    if (header.kid !== undefined && typeof header.kid !== "string") {
      return undefined;
    }
    const alg = header.alg;
    const kid = header.kid as string | undefined;
    let keys = candidateKeys(await this.jwks.current(), alg, kid);
    if (keys.length === 0 && kid !== undefined) {
      // A key this cache has not seen: a rotation, at most once per interval.
      keys = candidateKeys(await this.jwks.current(true), alg, kid);
    }
    const signingInput = `${headerPart}.${payloadPart}`;
    const signature = Buffer.from(signaturePart, "base64url");
    if (
      !keys.some((key) => signatureValid(alg, key.key, signingInput, signature))
    ) {
      return undefined;
    }
    return acceptClaims(
      decodeJson(payloadPart),
      this.config,
      Math.floor(this.now() / 1000)
    );
  }
}

// ------------------------------------------------------------- the routes

/**
 * The human identity of a request: the configured JWT header verified and its
 * groups mapped, in config order, to one owner or operator address. Nothing
 * else on the request is read, so a bearer token, an unsigned
 * `X-authentik-username` or a LAN source address establishes no one.
 */
export const humanAuthenticator = (
  config: Pick<HumanAuthConfig, "groups" | "header">,
  supervisors: readonly HumanAuthSupervisor[],
  verifier: Pick<HumanJwtVerifier, "verify">
): SupervisorControlSurfaceAuthenticator => ({
  async authenticate(
    request: Request
  ): Promise<SupervisorControlSurfaceIdentity | undefined> {
    const token = request.headers.get(config.header)?.trim();
    if (!token) {
      return undefined;
    }
    const claims = await verifier.verify(token);
    if (!claims) {
      return undefined;
    }
    const mapping = config.groups.find((entry) =>
      claims.groups.includes(entry.group)
    );
    const address = mapping
      ? humanAddressFor(supervisors, mapping.principal)
      : undefined;
    return address
      ? { principal: address.principal, supervisorId: address.supervisorId }
      : undefined;
  },
});

/**
 * The path a human route serves once its `routePath` is stripped, or
 * undefined when `pathname` is not under it.
 */
export const humanRouteSubpath = (
  routePath: string,
  pathname: string
): string | undefined => {
  if (pathname === routePath) {
    return "/";
  }
  return pathname.startsWith(`${routePath}/`)
    ? pathname.slice(routePath.length)
    : undefined;
};

/** The human route mount: its path and the authenticator its surface uses. */
export interface HumanRoutes {
  authenticator: SupervisorControlSurfaceAuthenticator;
  routePath: string;
}

/** The configured human routes, with their own JWKS cache and verifier. */
export const createHumanRoutes = (
  config: HumanAuthConfig,
  supervisors: readonly HumanAuthSupervisor[],
  options: { fetch?: typeof fetch; now?: () => number } = {}
): HumanRoutes => {
  const jwks = new JwksCache({
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
    ttlMs: config.jwksCacheTtlMs,
    url: config.jwksUrl,
  });
  const verifier = new HumanJwtVerifier({
    config,
    jwks,
    ...(options.now ? { now: options.now } : {}),
  });
  return {
    authenticator: humanAuthenticator(config, supervisors, verifier),
    routePath: config.routePath,
  };
};
