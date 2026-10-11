import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { readBoundedRequestText } from "./bounded-request-body";
import { isSupervisorRepoKey } from "./supervisor-id";

/**
 * RA1: session tokens for the orchestration control surface.
 *
 * - Ed25519 JWTs (alg EdDSA), 30 minutes, audience `loop-control`, claims
 *   sub (the session id), repoKey, project, role, epoch, aud, jti, iat, exp.
 * - The signing key is a PKCS#8 PEM in a 0600 regular file owned by the
 *   server's user, named in config and never inline.
 * - A session starts from a single-use enrollment code (10 minutes) bound to
 *   one configured address. The address is fixed for the session's life: the
 *   token subject decides who the caller is; no request field can.
 * - Refresh needs a valid token of a live, non-revoked session and denylists
 *   the token it replaces.
 * - Revocation: a session (no token of it verifies again), one jti (denied
 *   until it would have expired), or a role epoch bump (every token issued
 *   for that role and subtree before the bump stops verifying).
 * - The store is a 0600 JSON file under the server's state directory, so a
 *   revocation survives a restart and the host CLI can mint and revoke while
 *   the server runs.
 */

export const TOKEN_AUDIENCE = "loop-control";
export const TOKEN_TTL_SECONDS = 30 * 60;
export const ENROLLMENT_CODE_TTL_SECONDS = 10 * 60;
export const TOKEN_ROLES = [
  "owner",
  "operator",
  "supervisor",
  "worker",
] as const;
export type TokenRole = (typeof TOKEN_ROLES)[number];

/** What a configured address is in the control hierarchy. */
export interface RoleBinding {
  project: string;
  /**
   * A flat scope name, or (RA2) the repository's "<owner>/<name>". Only the
   * latter names a role id, so only it routes a legacy supervisor address.
   */
  repoKey: string;
  role: TokenRole;
}

export interface TokenClaims extends RoleBinding {
  aud: typeof TOKEN_AUDIENCE;
  epoch: number;
  exp: number;
  iat: number;
  jti: string;
  sub: string;
}

/** A token that verified against the key, the store and the config. */
export interface VerifiedTokenSession {
  address: string;
  claims: TokenClaims;
}

export interface TokenSigningKey {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

const SCOPE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SESSION_ID_RE = /^s-[0-9a-f]{32}$/;
const JTI_RE = /^[0-9a-f]{32}$/;
const CODE_RE = /^[A-Za-z0-9_-]{43}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const MAX_TOKEN_LENGTH = 4096;
const CLOCK_SKEW_SECONDS = 60;
const CLAIM_KEYS = [
  "aud",
  "epoch",
  "exp",
  "iat",
  "jti",
  "project",
  "repoKey",
  "role",
  "sub",
].join(",");
const STORE_SCHEMA = "loop-orchestration-token-store.v1";
const LOCK_STALE_MS = 10_000;
const LOCK_ATTEMPTS = 200;
const LOCK_WAIT_MS = 10;
const ROUTE_BODY_MAX_BYTES = 4096;
export const TOKEN_ROUTE_PREFIX = "/api/v1/tokens";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isTokenRole = (value: unknown): value is TokenRole =>
  typeof value === "string" &&
  (TOKEN_ROLES as readonly string[]).includes(value);

export const parseRoleBinding = (
  value: unknown,
  label: string
): RoleBinding => {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "project,repoKey,role"
  ) {
    throw new Error(`${label} has invalid fields`);
  }
  if (
    !(
      isTokenRole(value.role) &&
      typeof value.repoKey === "string" &&
      (SCOPE_RE.test(value.repoKey) || isSupervisorRepoKey(value.repoKey)) &&
      typeof value.project === "string" &&
      SCOPE_RE.test(value.project)
    )
  ) {
    throw new Error(`${label} is invalid`);
  }
  return { project: value.project, repoKey: value.repoKey, role: value.role };
};

export const roleEpochKey = (binding: RoleBinding): string =>
  `${binding.role}:${binding.repoKey}/${binding.project}`;

const sameBinding = (left: RoleBinding, right: RoleBinding): boolean =>
  left.role === right.role &&
  left.repoKey === right.repoKey &&
  left.project === right.project;

const sameSubtree = (left: RoleBinding, right: RoleBinding): boolean =>
  left.repoKey === right.repoKey && left.project === right.project;

/**
 * How a role-bound sender may address a recipient:
 * - "allowed": an owner anyone; a supervisor the workers of its own
 *   repoKey/project and any operator (upward); a worker only its own
 *   subtree's supervisor; an operator supervisors.
 * - "owner-thread-reply" (RA2): a supervisor to the owner, only as a reply on
 *   a thread the owner started; the caller checks the thread. An unprompted
 *   owner notification is an attention-os interaction, never a message.
 * - "denied": anything else.
 */
export type RoleMessagePolicy = "allowed" | "denied" | "owner-thread-reply";

export const roleMessagePolicy = (
  sender: RoleBinding,
  recipient: RoleBinding | undefined
): RoleMessagePolicy => {
  const allowed = (condition: boolean): RoleMessagePolicy =>
    condition ? "allowed" : "denied";
  switch (sender.role) {
    case "owner":
      return "allowed";
    case "supervisor":
      if (recipient?.role === "owner") {
        return "owner-thread-reply";
      }
      return allowed(
        recipient?.role === "operator" ||
          (recipient?.role === "worker" && sameSubtree(sender, recipient))
      );
    case "worker":
      return allowed(
        recipient?.role === "supervisor" && sameSubtree(sender, recipient)
      );
    case "operator":
      return allowed(recipient?.role === "supervisor");
    default:
      return "denied";
  }
};

/** Whether the pair is allowed with no further condition. */
export const roleMayMessage = (
  sender: RoleBinding,
  recipient: RoleBinding | undefined
): boolean => roleMessagePolicy(sender, recipient) === "allowed";

/**
 * Who may revoke a session of `target`: an owner any, a supervisor its own
 * subtree's workers. Minting an enrollment code is narrower (RA2): only the
 * host and an owner (`mayMintEnrollmentCode`).
 */
export const roleMayControl = (
  actor: RoleBinding,
  target: RoleBinding
): boolean =>
  actor.role === "owner" ||
  (actor.role === "supervisor" &&
    target.role === "worker" &&
    sameSubtree(actor, target));

// ---------------------------------------------------------------- signing key

const openOwnerOnlyFile = (path: string, label: string): number => {
  let descriptor: number | undefined;
  try {
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags require bitwise composition.
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error(`${label} is not readable: ${path}`);
  }
  const stat = fstatSync(descriptor);
  const uid = process.getuid?.();
  if (
    !stat.isFile() ||
    // biome-ignore lint/suspicious/noBitwiseOperators: permission bits.
    (stat.mode & 0o077) !== 0 ||
    (uid !== undefined && stat.uid !== uid)
  ) {
    closeSync(descriptor);
    throw new Error(
      `${label} must be a regular 0600 file owned by this user: ${path}`
    );
  }
  return descriptor;
};

const keyId = (publicKey: KeyObject): string =>
  createHash("sha256")
    .update(publicKey.export({ format: "der", type: "spki" }))
    .digest("hex")
    .slice(0, 32);

/** Loads the Ed25519 signing key; errors name the path, never the key. */
export const loadTokenSigningKey = (path: string): TokenSigningKey => {
  const descriptor = openOwnerOnlyFile(path, "orchestration token signing key");
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(readFileSync(descriptor, "utf8"));
  } catch {
    throw new Error(`orchestration token signing key is malformed: ${path}`);
  } finally {
    closeSync(descriptor);
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(`orchestration token signing key is not Ed25519: ${path}`);
  }
  const publicKey = createPublicKey(privateKey);
  return { kid: keyId(publicKey), privateKey, publicKey };
};

/** Writes a new Ed25519 key to a file that must not exist yet (0600). */
export const writeTokenSigningKey = (path: string): { kid: string } => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeOwnerOnlyFile(
    path,
    String(privateKey.export({ format: "pem", type: "pkcs8" }))
  );
  return { kid: keyId(publicKey) };
};

/**
 * Writes a secret (an enrollment code) to a new 0600 file: never an existing
 * file or a symlink, so it cannot land somewhere another user reads.
 */
export const writeOwnerOnlyFile = (path: string, text: string): void => {
  const descriptor = openSync(
    path,
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags require bitwise composition.
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600
  );
  try {
    writeSync(descriptor, text);
  } finally {
    closeSync(descriptor);
  }
};

// ----------------------------------------------------------------------- JWT

const encodeJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

const headerFor = (kid: string): string =>
  encodeJson({ alg: "EdDSA", kid, typ: "JWT" });

export const signTokenClaims = (
  key: TokenSigningKey,
  claims: TokenClaims
): string => {
  const ordered = {
    aud: claims.aud,
    epoch: claims.epoch,
    exp: claims.exp,
    iat: claims.iat,
    jti: claims.jti,
    project: claims.project,
    repoKey: claims.repoKey,
    role: claims.role,
    sub: claims.sub,
  };
  const input = `${headerFor(key.kid)}.${encodeJson(ordered)}`;
  const signature = sign(null, Buffer.from(input), key.privateKey);
  return `${input}.${signature.toString("base64url")}`;
};

const decodeJson = (part: string): unknown => {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
};

const isSafeSeconds = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

const parseClaims = (value: unknown): TokenClaims | undefined => {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== CLAIM_KEYS) {
    return undefined;
  }
  if (
    value.aud !== TOKEN_AUDIENCE ||
    !isSafeSeconds(value.epoch) ||
    !isSafeSeconds(value.iat) ||
    !isSafeSeconds(value.exp) ||
    value.exp - value.iat !== TOKEN_TTL_SECONDS ||
    typeof value.jti !== "string" ||
    !JTI_RE.test(value.jti) ||
    typeof value.sub !== "string" ||
    !SESSION_ID_RE.test(value.sub)
  ) {
    return undefined;
  }
  let binding: RoleBinding;
  try {
    binding = parseRoleBinding(
      { project: value.project, repoKey: value.repoKey, role: value.role },
      "token"
    );
  } catch {
    return undefined;
  }
  return {
    ...binding,
    aud: TOKEN_AUDIENCE,
    epoch: value.epoch,
    exp: value.exp,
    iat: value.iat,
    jti: value.jti,
    sub: value.sub,
  };
};

/**
 * The claims of a token this key signed for this audience, still within its
 * lifetime; undefined for anything else. Says nothing about revocation.
 */
export const verifyTokenSignature = (
  key: TokenSigningKey,
  token: string,
  nowSeconds: number
): TokenClaims | undefined => {
  if (token.length > MAX_TOKEN_LENGTH) {
    return undefined;
  }
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((part) => B64URL_RE.test(part))) {
    return undefined;
  }
  const [header, payload, signature] = parts as [string, string, string];
  // The header is compared as issued: no other alg, kid or field is accepted.
  if (header !== headerFor(key.kid)) {
    return undefined;
  }
  if (
    !verify(
      null,
      Buffer.from(`${header}.${payload}`),
      key.publicKey,
      Buffer.from(signature, "base64url")
    )
  ) {
    return undefined;
  }
  const claims = parseClaims(decodeJson(payload));
  if (
    !claims ||
    claims.exp <= nowSeconds ||
    claims.iat > nowSeconds + CLOCK_SKEW_SECONDS
  ) {
    return undefined;
  }
  return claims;
};

// --------------------------------------------------------------------- store

interface CodeRecord {
  address: string;
  binding: RoleBinding;
  expiresAt: number;
  hash: string;
}

interface SessionRecord {
  address: string;
  binding: RoleBinding;
  createdAt: number;
  /** The exp of the newest token issued for it; no later token exists. */
  liveUntil: number;
  revokedAt?: number;
  sessionId: string;
}

interface DeniedRecord {
  expiresAt: number;
  jti: string;
}

export interface TokenStoreState {
  codes: CodeRecord[];
  denied: DeniedRecord[];
  epochs: Record<string, number>;
  schema: typeof STORE_SCHEMA;
  sessions: SessionRecord[];
}

const emptyState = (): TokenStoreState => ({
  codes: [],
  denied: [],
  epochs: {},
  schema: STORE_SCHEMA,
  sessions: [],
});

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * The token store: one JSON file (0600) in a 0700 directory, rewritten
 * atomically under an exclusive lock file. Reads are cached by the file's
 * identity and modification time, so a revocation written by the host CLI
 * is seen by the running server on its next request.
 */
export class TokenStore {
  readonly #dir: string;
  readonly #path: string;
  readonly #lock: string;
  #cache: { key: string; state: TokenStoreState } | undefined;

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, "token-store.json");
    this.#lock = join(dir, "token-store.lock");
    mkdirSync(dir, { mode: 0o700, recursive: true });
  }

  read(): TokenStoreState {
    let key: string;
    try {
      const stat = statSync(this.#path);
      key = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return emptyState();
    }
    if (this.#cache?.key === key) {
      return this.#cache.state;
    }
    const descriptor = openOwnerOnlyFile(
      this.#path,
      "orchestration token store"
    );
    let state: unknown;
    try {
      state = JSON.parse(readFileSync(descriptor, "utf8"));
    } catch {
      throw new Error(`orchestration token store is malformed: ${this.#path}`);
    } finally {
      closeSync(descriptor);
    }
    if (!isRecord(state) || state.schema !== STORE_SCHEMA) {
      throw new Error(`orchestration token store is malformed: ${this.#path}`);
    }
    const parsed = state as unknown as TokenStoreState;
    this.#cache = { key, state: parsed };
    return parsed;
  }

  update<T>(nowSeconds: number, change: (state: TokenStoreState) => T): T {
    this.#acquire();
    try {
      this.#cache = undefined;
      const state = structuredClone(this.read());
      const result = change(state);
      this.#write(prune(state, nowSeconds));
      return result;
    } finally {
      rmSync(this.#lock, { force: true });
    }
  }

  #acquire(): void {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      try {
        closeSync(
          openSync(
            this.#lock,
            // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags require bitwise composition.
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
            0o600
          )
        );
        return;
      } catch {
        try {
          if (Date.now() - statSync(this.#lock).mtimeMs > LOCK_STALE_MS) {
            rmSync(this.#lock, { force: true });
            continue;
          }
        } catch {
          continue;
        }
        sleepSync(LOCK_WAIT_MS);
      }
    }
    throw new Error(`orchestration token store is locked: ${this.#lock}`);
  }

  #write(state: TokenStoreState): void {
    const temporary = join(
      this.#dir,
      `.token-store.${randomBytes(8).toString("hex")}.tmp`
    );
    const descriptor = openSync(
      temporary,
      // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags require bitwise composition.
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600
    );
    try {
      writeSync(descriptor, `${JSON.stringify(state)}\n`);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, this.#path);
  }
}

/** Drops what can no longer matter: every token it could affect expired. */
const prune = (state: TokenStoreState, now: number): TokenStoreState => ({
  ...state,
  codes: state.codes.filter((entry) => entry.expiresAt > now),
  denied: state.denied.filter((entry) => entry.expiresAt > now),
  sessions: state.sessions.filter((entry) =>
    entry.revokedAt === undefined
      ? entry.liveUntil > now
      : entry.revokedAt + TOKEN_TTL_SECONDS > now
  ),
});

// ------------------------------------------------------------------- service

export class TokenAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenAuthorityError";
  }
}

/** Who asks: the server host's operator (the CLI) or a verified session. */
export type TokenActor =
  | { kind: "host" }
  | { kind: "session"; session: VerifiedTokenSession };

export type TokenRevocation =
  | { sessionId: string }
  | { jti: string }
  | { epochFor: string };

export interface IssuedToken {
  expiresAt: number;
  sessionId: string;
  token: string;
}

const hashCode = (code: string): string =>
  createHash("sha256").update(code).digest("hex");

export interface OrchestrationTokenServiceOptions {
  /** Every configured address that has a role, by supervisor id. */
  bindings: ReadonlyMap<string, RoleBinding>;
  key: TokenSigningKey;
  /** Milliseconds since the epoch (default Date.now). */
  now?: () => number;
  store: TokenStore;
}

export class OrchestrationTokenService {
  readonly #options: OrchestrationTokenServiceOptions;

  constructor(options: OrchestrationTokenServiceOptions) {
    this.#options = options;
  }

  #now(): number {
    return Math.floor((this.#options.now ?? Date.now)() / 1000);
  }

  #actorBinding(actor: TokenActor): RoleBinding | undefined {
    return actor.kind === "host" ? undefined : actor.session.claims;
  }

  #mayControl(actor: TokenActor, target: RoleBinding): boolean {
    const binding = this.#actorBinding(actor);
    return (
      actor.kind === "host" || (!!binding && roleMayControl(binding, target))
    );
  }

  /**
   * A single-use code that enrolls one session as `address`. RA2: only the
   * host (its CLI) and an owner session mint. A supervisor never does: a code
   * it minted for a worker of its subtree would let it hold that worker's
   * identity.
   */
  issueEnrollmentCode(
    actor: TokenActor,
    address: string
  ): { code: string; expiresAt: number } {
    const binding = this.#options.bindings.get(address);
    if (!binding) {
      throw new TokenAuthorityError(`${address} has no configured role`);
    }
    if (!mayMintEnrollmentCode(actor)) {
      throw new TokenAuthorityError("not allowed to enroll this address");
    }
    const code = randomBytes(32).toString("base64url");
    const now = this.#now();
    const expiresAt = now + ENROLLMENT_CODE_TTL_SECONDS;
    this.#options.store.update(now, (state) => {
      state.codes.push({ address, binding, expiresAt, hash: hashCode(code) });
    });
    return { code, expiresAt };
  }

  #issue(state: TokenStoreState, session: SessionRecord, now: number): string {
    const claims: TokenClaims = {
      ...session.binding,
      aud: TOKEN_AUDIENCE,
      epoch: state.epochs[roleEpochKey(session.binding)] ?? 0,
      exp: now + TOKEN_TTL_SECONDS,
      iat: now,
      jti: randomBytes(16).toString("hex"),
      sub: session.sessionId,
    };
    session.liveUntil = claims.exp;
    return signTokenClaims(this.#options.key, claims);
  }

  /**
   * Exchanges a code (consumed whatever the outcome) for a session token.
   * RA2: a code that matches no record is refused from a lock-free read, so
   * an unauthenticated caller can neither hold the store lock nor make the
   * store be rewritten. A match is re-checked under the lock.
   */
  enroll(code: string): IssuedToken | undefined {
    if (!CODE_RE.test(code)) {
      return undefined;
    }
    const now = this.#now();
    const hash = hashCode(code);
    if (
      !this.#options.store.read().codes.some((entry) => entry.hash === hash)
    ) {
      return undefined;
    }
    return this.#options.store.update(now, (state) => {
      const index = state.codes.findIndex((entry) => entry.hash === hash);
      const record = index === -1 ? undefined : state.codes[index];
      if (!record) {
        return undefined;
      }
      state.codes.splice(index, 1);
      const current = this.#options.bindings.get(record.address);
      if (
        record.expiresAt <= now ||
        !current ||
        !sameBinding(current, record.binding)
      ) {
        return undefined;
      }
      const session: SessionRecord = {
        address: record.address,
        binding: record.binding,
        createdAt: now,
        liveUntil: now,
        sessionId: `s-${randomBytes(16).toString("hex")}`,
      };
      state.sessions.push(session);
      const token = this.#issue(state, session, now);
      return {
        expiresAt: session.liveUntil,
        sessionId: session.sessionId,
        token,
      };
    });
  }

  #verifyAgainst(
    state: TokenStoreState,
    claims: TokenClaims,
    now: number
  ): VerifiedTokenSession | undefined {
    const session = state.sessions.find(
      (entry) => entry.sessionId === claims.sub
    );
    const configured = session
      ? this.#options.bindings.get(session.address)
      : undefined;
    if (
      !session ||
      session.revokedAt !== undefined ||
      session.liveUntil <= now ||
      !sameBinding(session.binding, claims) ||
      !configured ||
      !sameBinding(configured, claims) ||
      claims.epoch !== (state.epochs[roleEpochKey(claims)] ?? 0) ||
      state.denied.some((entry) => entry.jti === claims.jti)
    ) {
      return undefined;
    }
    return { address: session.address, claims };
  }

  /** A token of a live session, at its role's current epoch, not denied. */
  verify(token: string): VerifiedTokenSession | undefined {
    const now = this.#now();
    const claims = verifyTokenSignature(this.#options.key, token, now);
    return claims
      ? this.#verifyAgainst(this.#options.store.read(), claims, now)
      : undefined;
  }

  /** A fresh token for the same session; the presented one is denied. */
  refresh(token: string): IssuedToken | undefined {
    const now = this.#now();
    const claims = verifyTokenSignature(this.#options.key, token, now);
    if (!claims) {
      return undefined;
    }
    return this.#options.store.update(now, (state) => {
      if (!this.#verifyAgainst(state, claims, now)) {
        return undefined;
      }
      const session = state.sessions.find(
        (entry) => entry.sessionId === claims.sub
      ) as SessionRecord;
      state.denied.push({ expiresAt: claims.exp, jti: claims.jti });
      const next = this.#issue(state, session, now);
      return {
        expiresAt: session.liveUntil,
        sessionId: session.sessionId,
        token: next,
      };
    });
  }

  revoke(actor: TokenActor, target: TokenRevocation): void {
    const now = this.#now();
    this.#options.store.update(now, (state) => {
      if ("sessionId" in target) {
        this.#revokeSession(state, actor, target.sessionId, now);
      } else if ("jti" in target) {
        denyJti(state, actor, target.jti, now);
      } else {
        this.#bumpEpoch(state, actor, target.epochFor);
      }
    });
  }

  /** Its own session, or one the actor controls (host, owner, supervisor). */
  #revokeSession(
    state: TokenStoreState,
    actor: TokenActor,
    sessionId: string,
    now: number
  ): void {
    const session = state.sessions.find(
      (entry) => entry.sessionId === sessionId
    );
    if (!session) {
      throw new TokenAuthorityError(`no live session ${sessionId}`);
    }
    const own =
      actor.kind === "session" && actor.session.claims.sub === sessionId;
    if (!(own || this.#mayControl(actor, session.binding))) {
      throw new TokenAuthorityError("not allowed to revoke this session");
    }
    session.revokedAt ??= now;
  }

  /** Host or owner only: every earlier token of that role and subtree. */
  #bumpEpoch(state: TokenStoreState, actor: TokenActor, address: string): void {
    const binding = this.#options.bindings.get(address);
    if (!(binding && isHostOrOwner(actor))) {
      throw new TokenAuthorityError("not allowed to bump this role epoch");
    }
    const key = roleEpochKey(binding);
    state.epochs[key] = (state.epochs[key] ?? 0) + 1;
  }
}

const isHostOrOwner = (actor: TokenActor): boolean =>
  actor.kind === "host" || actor.session.claims.role === "owner";

/** RA2: the host and an owner session mint enrollment codes; no one else. */
export const mayMintEnrollmentCode = (actor: TokenActor): boolean =>
  isHostOrOwner(actor);

/**
 * Host or owner: any jti; a session: its own token's. Every token expires
 * within its lifetime of being issued and none with this jti can be issued
 * later, so the denial ends when it no longer matters.
 */
const denyJti = (
  state: TokenStoreState,
  actor: TokenActor,
  jti: string,
  now: number
): void => {
  const own =
    actor.kind === "session" && actor.session.claims.jti === jti
      ? actor.session.claims
      : undefined;
  if (!(own || isHostOrOwner(actor))) {
    throw new TokenAuthorityError("not allowed to revoke this token");
  }
  state.denied.push({ expiresAt: own?.exp ?? now + TOKEN_TTL_SECONDS, jti });
};

// --------------------------------------------------------- enroll rate limit

export const ENROLL_FAILURE_LIMIT = 10;
export const ENROLL_FAILURE_WINDOW_MS = 60_000;
export const ENROLL_LIMITER_MAX_SOURCES = 1024;
/** The one shared window every new source lands in while the map is full. */
const OVERFLOW_SOURCE = "\u0000overflow";

interface FailureWindow {
  count: number;
  startedAt: number;
}

/**
 * RA2: failed enrollments per source address, in a fixed window, in memory.
 * Bounded: at most `maxSources` addresses plus one shared overflow window.
 * When the map is full (after dropping expired windows) a new address shares
 * the overflow window, so flooding addresses cannot evict a blocked one; it
 * only blocks the flood sooner.
 */
export class EnrollmentAttemptLimiter {
  readonly #limit: number;
  readonly #maxSources: number;
  readonly #now: () => number;
  readonly #windowMs: number;
  readonly #windows = new Map<string, FailureWindow>();

  constructor(
    options: {
      limit?: number;
      maxSources?: number;
      now?: () => number;
      windowMs?: number;
    } = {}
  ) {
    this.#limit = options.limit ?? ENROLL_FAILURE_LIMIT;
    this.#maxSources = options.maxSources ?? ENROLL_LIMITER_MAX_SOURCES;
    this.#now = options.now ?? Date.now;
    this.#windowMs = options.windowMs ?? ENROLL_FAILURE_WINDOW_MS;
  }

  get size(): number {
    return this.#windows.size;
  }

  /** Seconds until the source may try again, or 0 when it may now. */
  retryAfterSeconds(source: string): number {
    const window = this.#current(this.#keyFor(source));
    if (!window || window.count < this.#limit) {
      return 0;
    }
    const remaining = window.startedAt + this.#windowMs - this.#now();
    return Math.max(1, Math.ceil(remaining / 1000));
  }

  recordFailure(source: string): void {
    const key = this.#keyFor(source);
    const window = this.#current(key) ?? { count: 0, startedAt: this.#now() };
    window.count += 1;
    this.#windows.set(key, window);
  }

  #current(key: string): FailureWindow | undefined {
    const window = this.#windows.get(key);
    if (window && this.#now() - window.startedAt >= this.#windowMs) {
      this.#windows.delete(key);
      return undefined;
    }
    return window;
  }

  #keyFor(source: string): string {
    if (this.#windows.has(source)) {
      return source;
    }
    if (this.#windows.size >= this.#maxSources) {
      for (const key of [...this.#windows.keys()]) {
        this.#current(key);
      }
    }
    return this.#windows.size >= this.#maxSources ? OVERFLOW_SOURCE : source;
  }
}

// -------------------------------------------------------------------- routes

const noStore = { "cache-control": "no-store" };

const routeJson = (status: number, body: unknown): Response =>
  Response.json(body, { headers: noStore, status });

const routeError = (status: number, code: string): Response =>
  routeJson(status, { error: { code } });

const bearer = (request: Request): string | undefined => {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
};

const readRouteBody = async (
  request: Request
): Promise<Record<string, unknown> | undefined> => {
  const contentType = request.headers.get("content-type") ?? "";
  if (
    contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
  ) {
    return undefined;
  }
  const text = await readBoundedRequestText(request, ROUTE_BODY_MAX_BYTES);
  if (text === undefined) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

const onlyKey = (
  body: Record<string, unknown>,
  key: string
): string | undefined =>
  Object.keys(body).join(",") === key && typeof body[key] === "string"
    ? (body[key] as string)
    : undefined;

const issuedBody = (issued: IssuedToken) => ({
  data: {
    audience: TOKEN_AUDIENCE,
    expiresAt: issued.expiresAt,
    sessionId: issued.sessionId,
    token: issued.token,
    tokenType: "Bearer",
  },
});

const parseRevocation = (
  body: Record<string, unknown>
): TokenRevocation | undefined => {
  const sessionId = onlyKey(body, "sessionId");
  if (sessionId !== undefined) {
    return SESSION_ID_RE.test(sessionId) ? { sessionId } : undefined;
  }
  const jti = onlyKey(body, "jti");
  if (jti !== undefined) {
    return JTI_RE.test(jti) ? { jti } : undefined;
  }
  const epochFor = onlyKey(body, "epochFor");
  return epochFor === undefined ? undefined : { epochFor };
};

type TokenRoute = "enroll" | "enrollment-codes" | "refresh" | "revoke";
const TOKEN_ROUTES: readonly TokenRoute[] = [
  "enroll",
  "enrollment-codes",
  "refresh",
  "revoke",
];

const issuedResponse = (
  issued: IssuedToken | undefined,
  refusal: string
): Response =>
  issued ? routeJson(200, issuedBody(issued)) : routeError(401, refusal);

/** The source key of a request whose peer address is unknown. */
const UNKNOWN_SOURCE = "unknown";

/**
 * The code is the credential: no bearer is read. RA2: a source over its
 * failure window is refused (429) before its body is read, and every refused
 * enrollment counts against its source.
 */
const enrollRoute = async (
  service: OrchestrationTokenService,
  request: Request,
  limiter: EnrollmentAttemptLimiter,
  source: string
): Promise<Response> => {
  const retryAfter = limiter.retryAfterSeconds(source);
  if (retryAfter > 0) {
    return Response.json(
      { error: { code: "too-many-attempts" } },
      {
        headers: { ...noStore, "retry-after": String(retryAfter) },
        status: 429,
      }
    );
  }
  const body = await readRouteBody(request);
  const code = body ? onlyKey(body, "code") : undefined;
  const issued = code === undefined ? undefined : service.enroll(code);
  if (!issued) {
    limiter.recordFailure(source);
  }
  return issuedResponse(issued, "enrollment-refused");
};

/** Minting and revoking act as the verified session, never as a body field. */
const sessionRoute = async (
  service: OrchestrationTokenService,
  request: Request,
  route: "enrollment-codes" | "revoke",
  token: string | undefined
): Promise<Response> => {
  const session = token === undefined ? undefined : service.verify(token);
  if (!session) {
    return routeError(401, "unauthorized");
  }
  const body = await readRouteBody(request);
  const actor: TokenActor = { kind: "session", session };
  if (route === "enrollment-codes") {
    const address = body ? onlyKey(body, "supervisorId") : undefined;
    return address === undefined
      ? routeError(400, "invalid-request")
      : routeJson(200, { data: service.issueEnrollmentCode(actor, address) });
  }
  const target = body ? parseRevocation(body) : undefined;
  if (!target) {
    return routeError(400, "invalid-request");
  }
  service.revoke(actor, target);
  return routeJson(200, { data: { revoked: true } });
};

/**
 * The token routes under /api/v1/tokens, or undefined for any other path.
 * `enroll` is authenticated by its code and rate limited per `source` (the
 * request's peer address); every other route by a session token (a static
 * legacy token never mints, refreshes or revokes).
 */
export const createTokenRoutes =
  (
    service: OrchestrationTokenService,
    limiter: EnrollmentAttemptLimiter = new EnrollmentAttemptLimiter()
  ) =>
  async (
    request: Request,
    pathname: string,
    source: string = UNKNOWN_SOURCE
  ): Promise<Response | undefined> => {
    if (!pathname.startsWith(`${TOKEN_ROUTE_PREFIX}/`)) {
      return undefined;
    }
    const route = TOKEN_ROUTES.find(
      (name) => pathname === `${TOKEN_ROUTE_PREFIX}/${name}`
    );
    if (!route) {
      return routeError(404, "not-found");
    }
    if (request.method !== "POST") {
      return routeError(405, "method-not-allowed");
    }
    try {
      if (route === "enroll") {
        return await enrollRoute(service, request, limiter, source);
      }
      const token = bearer(request);
      if (route === "refresh") {
        return issuedResponse(
          token === undefined ? undefined : service.refresh(token),
          "unauthorized"
        );
      }
      return await sessionRoute(service, request, route, token);
    } catch (error) {
      return error instanceof TokenAuthorityError
        ? routeError(403, "authority-denied")
        : routeError(500, "internal-error");
    }
  };
