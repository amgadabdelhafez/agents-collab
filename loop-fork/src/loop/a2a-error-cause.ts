/**
 * The underlying error of a client refusal, reduced to what is safe to print.
 *
 * The A2A clients answer every transport or SDK failure with one fixed,
 * token-free message; on its own that hides why a send failed (on
 * 2026-10-11 the compiled binary refused every send and nothing said why).
 * This keeps the cause's `name`, `message` and string `code`, and nothing
 * else: no stack, no request, no headers, no nested cause object. Each
 * secret the caller passes (the bearer token) and any `Bearer <value>` are
 * redacted, control characters are replaced and the message is capped, so
 * the result can go into a JSON detail field, a log line or a CLI error.
 */
export interface A2AErrorCause {
  code?: string;
  message: string;
  name: string;
}

const MAX_MESSAGE_CHARS = 400;
const MAX_NAME_CHARS = 64;
const MIN_SECRET_CHARS = 8;
const REDACTED = "[redacted]";
const BEARER_RE = /\bbearer\s+[^\s"',;]+/giu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: replaced on purpose
const CONTROL_RE = /[\u0000-\u001f\u007f]+/gu;
const CODE_RE = /^[A-Za-z0-9_.:-]{1,64}$/u;

const clean = (
  value: string,
  secrets: readonly string[],
  limit: number
): string => {
  let text = value;
  for (const secret of secrets) {
    // A secret too short to be a real token would only mangle the text.
    if (secret.length >= MIN_SECRET_CHARS) {
      text = text.split(secret).join(REDACTED);
    }
  }
  text = text.replace(BEARER_RE, `Bearer ${REDACTED}`);
  text = text.replace(CONTROL_RE, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
};

const field = (error: object, key: string): unknown => {
  try {
    return (error as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
};

export const safeErrorCause = (
  error: unknown,
  secrets: readonly string[] = []
): A2AErrorCause => {
  if (typeof error !== "object" || error === null) {
    return {
      message: clean(String(error), secrets, MAX_MESSAGE_CHARS),
      name: typeof error,
    };
  }
  const name = field(error, "name");
  const message = field(error, "message");
  const code = field(error, "code");
  const codeText =
    typeof code === "number" && Number.isSafeInteger(code)
      ? String(code)
      : code;
  return {
    ...(typeof codeText === "string" && CODE_RE.test(codeText)
      ? { code: clean(codeText, secrets, MAX_NAME_CHARS) }
      : {}),
    message: clean(
      typeof message === "string" ? message : "",
      secrets,
      MAX_MESSAGE_CHARS
    ),
    name: clean(
      typeof name === "string" && name ? name : "Error",
      secrets,
      MAX_NAME_CHARS
    ),
  };
};

/** A cause that is the caller's own timeout or abort, not a refusal. */
export const isTimeoutCause = (cause: A2AErrorCause): boolean =>
  cause.name === "TimeoutError" || cause.name === "AbortError";

/** `Name: message [code]`, for a one-line error. */
export const describeErrorCause = (cause: A2AErrorCause): string =>
  `${cause.name}: ${cause.message || "(no message)"}${cause.code ? ` [${cause.code}]` : ""}`;
