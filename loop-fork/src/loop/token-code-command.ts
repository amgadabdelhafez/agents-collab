import { lstatSync } from "node:fs";
import { describeErrorCause, safeErrorCause } from "./a2a-error-cause";
import {
  type A2AClientDeps,
  type A2AClientEndpoint,
  resolveA2AClientEndpoint,
} from "./a2a-session-client";
import {
  TOKEN_ROUTE_PREFIX,
  writeOwnerOnlyFile,
} from "./orchestration-token-service";
import { isSupervisorId } from "./supervisor-id";

/**
 * `loop token code`: mint a single-use enrollment code through the server's
 * own route (RA2: an owner session only; the host uses `loop orchestration
 * token-code`), so a code can be minted from anywhere an owner session is
 * enrolled, without shell access to the server host.
 *
 *   loop token code --as <supervisor:id> --for <supervisor:id> --out <new-file>
 *                   [--trust-file <ca.pem>] [--allow-multi-token-env]
 *
 * - The server and the bearer are resolved exactly as `loop a2a` resolves
 *   them (the orchestration config's origin, the enrolled session credential
 *   of `--as`, refreshed before use). A static tokenEnv token never mints,
 *   so it is refused here before any request.
 * - The code is written only to `--out`, a new 0600 file (O_EXCL, no
 *   symlink). An existing `--out` is refused before anything is minted.
 *   The code is never printed, logged, or put in an error: the output names
 *   who it is for, where it is and when it expires.
 */
export const TOKEN_COMMAND = "token";
export const ALLOW_MULTI_TOKEN_ENV_FLAG = "--allow-multi-token-env";
export const AUTHORITY_DENIED_MESSAGE =
  "only an owner session or the host can mint codes";

const USAGE =
  "Usage: loop token code --as <supervisor:id> --for <supervisor:id> --out <new-file> [--trust-file <ca.pem>] [--allow-multi-token-env]";
const VALUE_FLAGS = ["--as", "--for", "--out", "--trust-file"] as const;
const REQUEST_TIMEOUT_MS = 10_000;
const ENROLLMENT_CODE_RE = /^[A-Za-z0-9_-]{16,256}$/;
const ROUTE_ERROR_CODE_RE = /^[a-z-]{1,64}$/;

const usageError = (detail?: string): Error =>
  new Error(detail ? `${detail}\n${USAGE}` : USAGE);

const parseFlags = (
  args: readonly string[]
): { allowMultiTokenEnv: boolean; values: Map<string, string> } => {
  const values = new Map<string, string>();
  let allowMultiTokenEnv = false;
  for (let index = 0; index < args.length; index++) {
    const name = args[index] ?? "";
    if (name === ALLOW_MULTI_TOKEN_ENV_FLAG) {
      allowMultiTokenEnv = true;
      continue;
    }
    const value = args[index + 1];
    if (
      !(VALUE_FLAGS as readonly string[]).includes(name) ||
      value === undefined ||
      value.startsWith("--") ||
      !value.trim()
    ) {
      throw usageError(`invalid argument: ${name}`);
    }
    if (values.has(name)) {
      throw usageError(`${name} given more than once`);
    }
    values.set(name, value);
    index++;
  }
  return { allowMultiTokenEnv, values };
};

const requireId = (values: Map<string, string>, flag: string): string => {
  const value = values.get(flag);
  if (value === undefined) {
    throw usageError(`${flag} is required`);
  }
  if (!isSupervisorId(value)) {
    throw usageError(`${flag} is not a supervisor id`);
  }
  return value;
};

/** Refuses an `--out` that exists in any form, a dangling symlink included. */
const requireNewPath = (path: string): void => {
  let exists = true;
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`--out cannot be checked: ${path}`);
    }
    exists = false;
  }
  if (exists) {
    throw new Error(`--out already exists, refusing to overwrite: ${path}`);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const send = async (
  endpoint: A2AClientEndpoint,
  forId: string,
  token: string,
  fetchImpl: typeof fetch
): Promise<Response> => {
  try {
    return await endpoint.fetch(fetchImpl)(
      endpoint.url(`${TOKEN_ROUTE_PREFIX}/enrollment-codes`),
      {
        body: JSON.stringify({ supervisorId: forId }),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
  } catch (error) {
    throw new Error(
      `mint: the server is unavailable (cause: ${describeErrorCause(safeErrorCause(error, [token]))})`
    );
  }
};

const routeErrorCode = (value: unknown): string | undefined => {
  const code =
    isRecord(value) && isRecord(value.error) ? value.error.code : undefined;
  return typeof code === "string" && ROUTE_ERROR_CODE_RE.test(code)
    ? code
    : undefined;
};

/** Mints through the route; one retry when another process refreshed. */
const mintCode = async (
  endpoint: A2AClientEndpoint,
  forId: string,
  fetchImpl: typeof fetch
): Promise<{ code: string; expiresAt: number }> => {
  const token = await endpoint.token();
  let response = await send(endpoint, forId, token, fetchImpl);
  if (response.status === 401 && (await endpoint.superseded(token))) {
    await response.body?.cancel().catch(() => undefined);
    response = await send(endpoint, forId, await endpoint.token(), fetchImpl);
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    value = undefined;
  }
  if (!response.ok) {
    const code = routeErrorCode(value);
    if (response.status === 403 && code === "authority-denied") {
      throw new Error(
        `mint refused: ${AUTHORITY_DENIED_MESSAGE} (authority-denied; also when ${forId} has no configured role)`
      );
    }
    if (response.status === 401) {
      throw new Error(
        `mint refused: ${endpoint.supervisorId}'s session token was not accepted (unauthorized); enroll again with loop connect --enroll-code-file <path>`
      );
    }
    throw new Error(
      `mint refused: ${code ?? `the server refused (${response.status})`}`
    );
  }
  const data = isRecord(value) ? value.data : undefined;
  if (
    !(
      isRecord(data) &&
      typeof data.code === "string" &&
      ENROLLMENT_CODE_RE.test(data.code) &&
      Number.isSafeInteger(data.expiresAt) &&
      Number(data.expiresAt) > 0
    )
  ) {
    throw new Error("mint: the server returned an invalid response");
  }
  return { code: data.code, expiresAt: Number(data.expiresAt) };
};

export type TokenCommandDeps = A2AClientDeps;

/** Runs `loop token <action>`; returns the lines to print (never the code). */
export const runTokenCommand = async (
  argv: readonly string[],
  callerDeps: TokenCommandDeps = {}
): Promise<string[]> => {
  const [, action, ...rest] = argv;
  if (action !== "code") {
    throw usageError();
  }
  const { allowMultiTokenEnv, values } = parseFlags(rest);
  const asId = requireId(values, "--as");
  const forId = requireId(values, "--for");
  const out = values.get("--out");
  if (out === undefined) {
    throw usageError("--out is required");
  }
  // Before anything is minted: a code that cannot be saved is a wasted one.
  requireNewPath(out);
  const trustFile = values.get("--trust-file");
  const endpoint = resolveA2AClientEndpoint(asId, {
    ...callerDeps,
    allowMultiTokenEnv,
    ...(trustFile === undefined ? {} : { trustFile }),
  });
  if (endpoint.auth !== "session") {
    throw new Error(
      `${asId} has no enrolled session credential; a static token never mints (on the server host use loop orchestration token-code)`
    );
  }
  const { code, expiresAt } = await mintCode(
    endpoint,
    forId,
    callerDeps.fetchImpl ?? fetch
  );
  const expires = new Date(expiresAt * 1000).toISOString();
  try {
    writeOwnerOnlyFile(out, `${code}\n`);
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code ?? "write failed";
    throw new Error(
      `the minted code for ${forId} could not be written to ${out} (${reason}); it was not saved and expires unused at ${expires}`
    );
  }
  return [
    `enrollment code for ${forId} written to ${out} (single use, expires ${expires})`,
  ];
};
