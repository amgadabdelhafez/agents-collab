import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseServerOrigin } from "./orchestration-origin-policy";
import {
  type RoleBinding,
  TOKEN_AUDIENCE,
  TOKEN_ROUTE_PREFIX,
} from "./orchestration-token-service";
import {
  requireSupervisorEndpointRecipient,
  supervisorEndpointSlug,
} from "./supervisor-endpoint-lease";

/**
 * ra2: a session's own credential for a non-local orchestration server.
 *
 * - A session enrolls once with a single-use enrollment code read from a
 *   file (`loop connect --enroll-code-file <path>`; the code is never in
 *   argv), and keeps the RA1 session token it gets in
 *   `<home>/.loop/credentials/<slug>.json`: a 0600 file in a 0700
 *   directory, owned by this user, bound to the supervisor id and the server
 *   origin it was enrolled at. No other origin is ever sent the token.
 * - The token is refreshed before it expires (within the refresh margin) by
 *   whichever process of this session needs it first, under a lock file, so
 *   `loop connect` and every `loop a2a` call share one current token. A
 *   refresh denies the token it replaces, so a process that was refused with
 *   a token another process has since replaced retries once with the new one.
 * - An expired token cannot be refreshed (the server needs a valid one): the
 *   session enrolls again with a new code.
 * - Nothing here prints or returns the token except to the request that
 *   carries it: errors name paths, ids and times only.
 */

export const A2A_SESSION_CREDENTIAL_SCHEMA =
  "loop-a2a-session-credential.v1" as const;
/** Refresh once a token has this little life left (its lifetime is 30 min). */
export const A2A_TOKEN_REFRESH_MARGIN_SECONDS = 5 * 60;
const REQUEST_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 25;
const LOCK_ATTEMPTS = 1600;
const RETRY_UNAVAILABLE_MS = 30_000;
const MIN_TIMER_MS = 1000;
const CODE_RE = /^[A-Za-z0-9_-]{43}$/;
const TRAILING_NEWLINE_RE = /\r?\n$/;
const SESSION_ID_RE = /^s-[0-9a-f]{32}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_TOKEN_LENGTH = 4096;
const MAX_TRUST_FILE_BYTES = 256 * 1024;
const PEM_CERT_RE = /-----BEGIN CERTIFICATE-----/;
const CREDENTIAL_KEYS = [
  "enrolledAt",
  "expiresAt",
  "origin",
  "schema",
  "sessionId",
  "supervisorId",
  "token",
].join(",");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A refusal that only enrolling again (a new code) resolves. */
export class A2ASessionCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "A2ASessionCredentialError";
  }
}

export interface A2ASessionCredential {
  enrolledAt: string;
  /** Seconds since the epoch: the current token's `exp`. */
  expiresAt: number;
  origin: string;
  schema: typeof A2A_SESSION_CREDENTIAL_SCHEMA;
  sessionId: string;
  supervisorId: string;
  token: string;
}

/** `<home>/.loop/credentials/<slug>.json` for `supervisorId`. */
export const a2aSessionCredentialPath = (
  supervisorId: string,
  env: NodeJS.ProcessEnv = process.env
): string =>
  join(
    env.HOME?.trim() || homedir(),
    ".loop",
    "credentials",
    `${supervisorEndpointSlug(supervisorId)}.json`
  );

/**
 * Opens a file that must be a regular file owned by this user. `secret`
 * also refuses any group or world permission bit; otherwise only group and
 * world write (a trust anchor is public, but whoever can rewrite it chooses
 * which server is trusted).
 */
const openOwnedFile = (
  path: string,
  label: string,
  secret: boolean,
  uid: number | undefined
): number => {
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags.
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
    );
  } catch {
    throw new Error(`${label} is not readable: ${path}`);
  }
  const stat = fstatSync(descriptor);
  const mask = secret ? 0o077 : 0o022;
  if (
    !stat.isFile() ||
    // biome-ignore lint/suspicious/noBitwiseOperators: permission bits.
    (stat.mode & mask) !== 0 ||
    (uid !== undefined && stat.uid !== uid)
  ) {
    closeSync(descriptor);
    throw new Error(
      secret
        ? `${label} must be a regular 0600 file owned by this user: ${path}`
        : `${label} must be a regular file owned by this user and not group- or world-writable: ${path}`
    );
  }
  return descriptor;
};

const readOwnedFile = (
  path: string,
  label: string,
  secret: boolean,
  uid: number | undefined,
  maxBytes: number
): string => {
  const descriptor = openOwnedFile(path, label, secret, uid);
  try {
    if (fstatSync(descriptor).size > maxBytes) {
      throw new Error(`${label} is too large: ${path}`);
    }
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
};

const currentUid = (): number | undefined => process.getuid?.();

/** The enrollment code in `path`: one line, nothing else. */
export const readEnrollmentCodeFile = (
  path: string,
  uid: number | undefined = currentUid()
): string => {
  const code = readOwnedFile(path, "enrollment code file", true, uid, 256)
    .replace(TRAILING_NEWLINE_RE, "")
    .trim();
  if (!CODE_RE.test(code)) {
    throw new Error(`enrollment code file holds no enrollment code: ${path}`);
  }
  return code;
};

/** The PEM trust anchors of a private CA, for an https origin. */
export const readTrustFile = (
  path: string,
  uid: number | undefined = currentUid()
): string => {
  const text = readOwnedFile(
    path,
    "trust file",
    false,
    uid,
    MAX_TRUST_FILE_BYTES
  );
  if (!PEM_CERT_RE.test(text)) {
    throw new Error(`trust file holds no PEM certificate: ${path}`);
  }
  return text;
};

/**
 * A fetch whose TLS trusts exactly `trustCa` (the private CA of a
 * self-hosted origin) when one is given; otherwise `fetchImpl` unchanged.
 */
export const fetchWithTrust = (
  fetchImpl: typeof fetch,
  trustCa: string | undefined
): typeof fetch => {
  if (trustCa === undefined) {
    return fetchImpl;
  }
  return Object.assign(
    (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ): Promise<Response> =>
      fetchImpl(input, {
        ...init,
        tls: { ca: trustCa },
      } as RequestInit),
    { preconnect: fetch.preconnect }
  );
};

const parseCredential = (
  value: unknown,
  path: string
): A2ASessionCredential => {
  try {
    if (
      !isRecord(value) ||
      Object.keys(value).sort().join(",") !== CREDENTIAL_KEYS ||
      value.schema !== A2A_SESSION_CREDENTIAL_SCHEMA
    ) {
      throw new Error("fields");
    }
    const token = value.token;
    if (
      !(
        typeof token === "string" &&
        token.length <= MAX_TOKEN_LENGTH &&
        TOKEN_RE.test(token) &&
        typeof value.sessionId === "string" &&
        SESSION_ID_RE.test(value.sessionId) &&
        Number.isSafeInteger(value.expiresAt) &&
        typeof value.enrolledAt === "string"
      )
    ) {
      throw new Error("values");
    }
    return {
      enrolledAt: value.enrolledAt,
      expiresAt: value.expiresAt as number,
      origin: parseServerOrigin(value.origin),
      schema: A2A_SESSION_CREDENTIAL_SCHEMA,
      sessionId: value.sessionId,
      supervisorId: requireSupervisorEndpointRecipient(value.supervisorId),
      token,
    };
  } catch {
    throw new Error(`${path} is not a valid session credential`);
  }
};

/** The credential at `path`, or undefined when there is none. */
export const readA2ASessionCredential = (
  path: string,
  uid: number | undefined = currentUid()
): A2ASessionCredential | undefined => {
  try {
    statSync(path);
  } catch {
    return undefined;
  }
  const text = readOwnedFile(path, "session credential", true, uid, 16_384);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not a valid session credential`);
  }
  return parseCredential(value, path);
};

/** Atomically replaces the credential (0600, in a 0700 directory). */
export const writeA2ASessionCredential = (
  path: string,
  credential: A2ASessionCredential
): void => {
  const dir = join(path, "..");
  mkdirSync(dir, { mode: 0o700, recursive: true });
  const temporary = join(
    dir,
    `.credential.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  const descriptor = openSync(
    temporary,
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags.
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_NOFOLLOW,
    0o600
  );
  try {
    writeSync(descriptor, `${JSON.stringify(credential, null, 2)}\n`);
  } catch (error) {
    closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(descriptor);
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
};

/**
 * The role a token was issued for, decoded WITHOUT verifying it: only to
 * check locally that an enrollment code was this address's, before the
 * credential is kept. The server verifies every token it is sent.
 */
export const unverifiedTokenRole = (token: string): RoleBinding | undefined => {
  const payload = token.split(".")[1];
  if (!payload) {
    return undefined;
  }
  try {
    const claims: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );
    if (
      isRecord(claims) &&
      claims.aud === TOKEN_AUDIENCE &&
      typeof claims.role === "string" &&
      typeof claims.repoKey === "string" &&
      typeof claims.project === "string"
    ) {
      return {
        project: claims.project,
        repoKey: claims.repoKey,
        role: claims.role as RoleBinding["role"],
      };
    }
  } catch {
    // Not a token of this audience.
  }
  return undefined;
};

interface IssuedToken {
  expiresAt: number;
  sessionId: string;
  token: string;
}

const parseIssued = (value: unknown): IssuedToken | undefined => {
  const data = isRecord(value) ? value.data : undefined;
  if (
    !(
      isRecord(data) &&
      data.audience === TOKEN_AUDIENCE &&
      data.tokenType === "Bearer" &&
      Number.isSafeInteger(data.expiresAt) &&
      typeof data.sessionId === "string" &&
      SESSION_ID_RE.test(data.sessionId) &&
      typeof data.token === "string" &&
      data.token.length <= MAX_TOKEN_LENGTH &&
      TOKEN_RE.test(data.token)
    )
  ) {
    return undefined;
  }
  return {
    expiresAt: data.expiresAt as number,
    sessionId: data.sessionId,
    token: data.token,
  };
};

type TokenCall =
  | { issued: IssuedToken; kind: "issued" }
  | { kind: "refused"; status: number }
  | { kind: "unavailable" };

/** One POST to a token route of `origin`. Never follows a redirect. */
const postTokenRoute = async (
  fetchImpl: typeof fetch,
  origin: string,
  route: "enroll" | "refresh",
  init: { body?: unknown; bearer?: string }
): Promise<TokenCall> => {
  let response: Response;
  try {
    response = await fetchImpl(`${origin}${TOKEN_ROUTE_PREFIX}/${route}`, {
      body: JSON.stringify(init.body ?? {}),
      headers: {
        ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
        "content-type": "application/json",
      },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { kind: "unavailable" };
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    value = undefined;
  }
  if (response.status >= 500) {
    return { kind: "unavailable" };
  }
  const issued = response.ok ? parseIssued(value) : undefined;
  return issued
    ? { issued, kind: "issued" }
    : { kind: "refused", status: response.status };
};

const sameRole = (left: RoleBinding, right: RoleBinding): boolean =>
  left.role === right.role &&
  left.repoKey === right.repoKey &&
  left.project === right.project;

export interface A2AEnrollInput {
  codeFile: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
  origin: string;
  /** The configured role of `supervisorId`: the code must be for it. */
  role: RoleBinding;
  supervisorId: string;
  uid?: number;
}

/**
 * Exchanges the enrollment code in `codeFile` for a session token at
 * `origin` and keeps it as `supervisorId`'s credential. The code is spent
 * whatever the outcome (the server consumes it). A token whose role is not
 * `supervisorId`'s configured one is not kept: the code was for another
 * address.
 */
export const enrollA2ASession = async (
  input: A2AEnrollInput
): Promise<{ expiresAt: number; path: string; sessionId: string }> => {
  const supervisorId = requireSupervisorEndpointRecipient(input.supervisorId);
  const origin = parseServerOrigin(input.origin, "orchestration origin");
  const uid = input.uid ?? currentUid();
  const code = readEnrollmentCodeFile(input.codeFile, uid);
  const call = await postTokenRoute(
    input.fetchImpl ?? fetch,
    origin,
    "enroll",
    {
      body: { code },
    }
  );
  if (call.kind === "unavailable") {
    throw new Error(`enrollment at ${origin}: the server is unavailable`);
  }
  if (call.kind === "refused") {
    throw new A2ASessionCredentialError(
      `enrollment at ${origin} refused (${call.status}): the code is unknown, spent or expired`
    );
  }
  const role = unverifiedTokenRole(call.issued.token);
  if (!(role && sameRole(role, input.role))) {
    throw new A2ASessionCredentialError(
      `the enrollment code was not issued for ${supervisorId}; nothing was kept`
    );
  }
  const path = a2aSessionCredentialPath(supervisorId, input.env);
  writeA2ASessionCredential(path, {
    enrolledAt: new Date((input.now ?? Date.now)()).toISOString(),
    expiresAt: call.issued.expiresAt,
    origin,
    schema: A2A_SESSION_CREDENTIAL_SCHEMA,
    sessionId: call.issued.sessionId,
    supervisorId,
    token: call.issued.token,
  });
  return {
    expiresAt: call.issued.expiresAt,
    path,
    sessionId: call.issued.sessionId,
  };
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface A2ASessionTokenSourceOptions {
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  /** Milliseconds since the epoch (default Date.now). */
  now?: () => number;
  origin: string;
  path: string;
  refreshMarginSeconds?: number;
  supervisorId: string;
  uid?: number;
}

/**
 * The bearer of one enrolled session: the credential file's current token,
 * refreshed first when it is within the refresh margin of expiry.
 */
export class A2ASessionTokenSource {
  readonly #options: A2ASessionTokenSourceOptions;
  readonly #margin: number;

  constructor(options: A2ASessionTokenSourceOptions) {
    this.#options = options;
    this.#margin =
      options.refreshMarginSeconds ?? A2A_TOKEN_REFRESH_MARGIN_SECONDS;
  }

  #nowSeconds(): number {
    return Math.floor((this.#options.now ?? Date.now)() / 1000);
  }

  /** The credential, which must still be this session's at this origin. */
  current(): A2ASessionCredential {
    const { origin, path, supervisorId } = this.#options;
    const credential = readA2ASessionCredential(path, this.#options.uid);
    if (!credential) {
      throw new A2ASessionCredentialError(
        `${supervisorId} has no session credential; enroll with loop connect --enroll-code-file <path>`
      );
    }
    if (credential.supervisorId !== supervisorId) {
      throw new A2ASessionCredentialError(
        `${path} is not ${supervisorId}'s session credential`
      );
    }
    if (credential.origin !== origin) {
      throw new A2ASessionCredentialError(
        `${supervisorId}'s session credential was enrolled at ${credential.origin}, not ${origin}; enroll again`
      );
    }
    return credential;
  }

  /** A token with more than the margin left, refreshing first if needed. */
  async bearer(): Promise<string> {
    const credential = this.current();
    if (credential.expiresAt - this.#nowSeconds() > this.#margin) {
      return credential.token;
    }
    return await this.#refresh();
  }

  /**
   * After a refusal of `used`: whether the credential now holds another
   * token that is still valid (another process of this session refreshed),
   * so one retry with it is worthwhile.
   */
  superseded(used: string): Promise<boolean> {
    try {
      const credential = this.current();
      return Promise.resolve(
        credential.token !== used && credential.expiresAt > this.#nowSeconds()
      );
    } catch {
      return Promise.resolve(false);
    }
  }

  /** Seconds until the next refresh is due (0: now). */
  dueInSeconds(): number {
    const credential = this.current();
    return Math.max(
      0,
      credential.expiresAt - this.#margin - this.#nowSeconds()
    );
  }

  async #refresh(): Promise<string> {
    const release = await this.#lock();
    try {
      const credential = this.current();
      const now = this.#nowSeconds();
      // Another process of this session refreshed while this one waited.
      if (credential.expiresAt - now > this.#margin) {
        return credential.token;
      }
      if (credential.expiresAt <= now) {
        throw new A2ASessionCredentialError(
          `${credential.supervisorId}'s session token expired at ${new Date(credential.expiresAt * 1000).toISOString()}; enroll again with a new code`
        );
      }
      const call = await postTokenRoute(
        this.#options.fetchImpl ?? fetch,
        credential.origin,
        "refresh",
        { bearer: credential.token }
      );
      if (call.kind === "unavailable") {
        // Still valid: use it, and refresh on a later call.
        this.#options.log?.(
          `[loop] session token refresh for ${credential.supervisorId}: the server is unavailable; retrying later`
        );
        return credential.token;
      }
      if (
        call.kind === "refused" ||
        call.issued.sessionId !== credential.sessionId
      ) {
        throw new A2ASessionCredentialError(
          `${credential.supervisorId}'s session token refresh was refused (the session is revoked or the token denied); enroll again with a new code`
        );
      }
      writeA2ASessionCredential(this.#options.path, {
        ...credential,
        expiresAt: call.issued.expiresAt,
        token: call.issued.token,
      });
      return call.issued.token;
    } finally {
      release();
    }
  }

  async #lock(): Promise<() => void> {
    const lock = `${this.#options.path}.lock`;
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      try {
        closeSync(
          openSync(
            lock,
            // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags.
            fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
            0o600
          )
        );
        return () => rmSync(lock, { force: true });
      } catch {
        try {
          if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
            rmSync(lock, { force: true });
            continue;
          }
        } catch {
          continue;
        }
        await sleep(LOCK_WAIT_MS);
      }
    }
    throw new Error(`session credential is locked: ${lock}`);
  }

  /**
   * Keeps the token fresh while `signal` is open: one timer, armed for when
   * the next refresh is due (a schedule, not a poll: nothing is read in
   * between). A refusal ends it and is reported once; an unavailable
   * server is retried later while the token is still valid.
   */
  keepFresh(signal: AbortSignal, onEnd?: (error: Error) => void): void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number) => {
      if (signal.aborted) {
        return;
      }
      timer = setTimeout(tick, Math.max(MIN_TIMER_MS, ms));
    };
    const tick = async () => {
      try {
        await this.bearer();
        const due = this.dueInSeconds();
        arm(due > 0 ? due * 1000 : RETRY_UNAVAILABLE_MS);
      } catch (error) {
        onEnd?.(error instanceof Error ? error : new Error("refresh failed"));
      }
    };
    signal.addEventListener("abort", () => clearTimeout(timer), {
      once: true,
    });
    try {
      arm(this.dueInSeconds() * 1000);
    } catch (error) {
      onEnd?.(error instanceof Error ? error : new Error("refresh failed"));
    }
  }
}
