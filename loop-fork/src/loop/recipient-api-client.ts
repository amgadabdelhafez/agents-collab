import { resolve } from "node:path";
import { safeErrorCause } from "./a2a-error-cause";
import { parseServerEndpointUrl } from "./orchestration-origin-policy";

const reference = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,511}$/;
export interface RecipientApiCommand {
  operation: "claim" | "acknowledge" | "publish-result";
  requestId: string;
  taskId?: string;
  workflowId: string;
}

/**
 * RA1's origin policy: https, or http only on 127.0.0.1 or [::1]; never
 * credentials, a query or a fragment in the URL.
 */
const recipientEndpointUrl = (value: string): URL => {
  try {
    return parseServerEndpointUrl(value);
  } catch {
    throw new Error(
      "Recipient API requires an explicit https or loopback endpoint"
    );
  }
};

export const recipientApiConfigured = (
  runDir: string,
  seat: string,
  env: NodeJS.ProcessEnv
): boolean =>
  (seat === "codex" || seat === "claude") &&
  env.LOOP_RECIPIENT_SEAT === seat &&
  !!env.LOOP_RECIPIENT_RUN_DIR &&
  resolve(env.LOOP_RECIPIENT_RUN_DIR) === resolve(runDir) &&
  !!env.LOOP_RECIPIENT_API_URL &&
  !!env.LOOP_RECIPIENT_API_TOKEN;

/** Protected environment only. No argv/config discovery, token in tool input,
 * redirect, remote endpoint or unsanitized response/error propagation. */
export const callRecipientApi = async (input: {
  runDir: string;
  seat: string;
  command: RecipientApiCommand;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<Record<string, unknown>> => {
  const env = input.env ?? process.env;
  if (!recipientApiConfigured(input.runDir, input.seat, env)) {
    throw new Error("Recipient API is not enrolled for this seat and run");
  }
  return await callRecipientRoute({
    command: input.command,
    fetchImpl: input.fetchImpl,
    token: env.LOOP_RECIPIENT_API_TOKEN ?? "",
    url: env.LOOP_RECIPIENT_API_URL ?? "",
  });
};

/**
 * The refusal codes the recipient route answers with (`{ code }`), and the
 * outer server's `{ error: { code } }`. Only a code from this fixed set is
 * surfaced: a response body is otherwise untrusted, and the route holds the
 * bearer token, so no free text from it ever reaches an error.
 */
export const RECIPIENT_ROUTE_REFUSAL_CODES = [
  "assignment-denied",
  "body-too-large",
  /** The intended recipient's claim before its delivery is recorded. */
  "delivery-not-recorded",
  "invalid-command",
  "json-required",
  "lifecycle-command-refused",
  "method-not-allowed",
  /** The intended recipient's acknowledge before its claim is recorded. */
  "not-claimed",
  "not-found",
  "result-publication-unavailable",
  "unauthenticated",
  "v2-unavailable",
] as const;

/** Refusals that mean "early, retry the same command", never "wrong". */
const EARLY_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "delivery-not-recorded",
  "not-claimed",
]);
const MAX_RETRY_AFTER_MS = 600_000;
export type RecipientRouteRefusalCode =
  | (typeof RECIPIENT_ROUTE_REFUSAL_CODES)[number]
  /** A refusal whose body named no known code. */
  | "refused"
  /** No response: the server is down, timed out, or redirected. */
  | "unavailable"
  /** A 2xx whose receipt did not match the command. */
  | "invalid-receipt";

const KNOWN_REFUSAL_CODES: ReadonlySet<string> = new Set(
  RECIPIENT_ROUTE_REFUSAL_CODES
);

/** A refused or failed recipient route call; `code` is from a fixed set. */
export class RecipientRouteError extends Error {
  readonly code: RecipientRouteRefusalCode;
  /** For an early refusal only: when the server expects the retry to pass. */
  readonly retryAfterMs: number | undefined;
  constructor(
    code: RecipientRouteRefusalCode,
    retryAfterMs?: number,
    /** What is safe to print of the underlying failure (`safeErrorCause`). */
    cause?: ReturnType<typeof safeErrorCause>
  ) {
    super(
      `Recipient API ${code === "unavailable" ? "is unavailable" : `refused (${code})`}; no completion is claimed`,
      cause ? { cause } : undefined
    );
    this.name = "RecipientRouteError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

const refusalOfResponse = async (
  response: Response
): Promise<RecipientRouteError> => {
  const cause = safeErrorCause(new Error(`refused (${response.status})`));
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return new RecipientRouteError("refused", undefined, cause);
  }
  const record =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const nested =
    record.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>).code
      : undefined;
  const code = typeof record.code === "string" ? record.code : nested;
  if (!(typeof code === "string" && KNOWN_REFUSAL_CODES.has(code))) {
    return new RecipientRouteError("refused", undefined, cause);
  }
  const retryAfterMs = record.retryAfterMs;
  return new RecipientRouteError(
    code as RecipientRouteRefusalCode,
    EARLY_REFUSAL_CODES.has(code) &&
      Number.isSafeInteger(retryAfterMs) &&
      Number(retryAfterMs) >= 0
      ? Math.min(Number(retryAfterMs), MAX_RETRY_AFTER_MS)
      : undefined,
    cause
  );
};

/**
 * The recipient route (`{routePath}/recipient`) with an explicit server URL
 * and bearer token, for callers that resolved both themselves: `loop a2a ack`
 * and `loop mailbox ack` for V2 envelopes read the token from the
 * supervisor's own `tokenEnv`. The same refusals as the run-bound client:
 * https or loopback http only, no redirect, a strict command, no response or error detail
 * propagated, and no token in any result or error.
 */
export const callRecipientRoute = async (input: {
  command: RecipientApiCommand;
  fetchImpl?: typeof fetch;
  token: string;
  url: string;
}): Promise<Record<string, unknown>> => {
  const url = recipientEndpointUrl(input.url);
  if (!input.token) {
    throw new Error("Recipient API token is not available");
  }
  const command = input.command;
  if (
    Object.keys(command).some(
      (key) => !["operation", "requestId", "workflowId", "taskId"].includes(key)
    ) ||
    !(
      ["claim", "acknowledge", "publish-result"].includes(command.operation) &&
      reference.test(command.workflowId) &&
      reference.test(command.requestId)
    ) ||
    (command.operation === "publish-result"
      ? !(command.taskId && reference.test(command.taskId))
      : command.taskId !== undefined)
  ) {
    throw new Error("Recipient API command is invalid");
  }
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
    });
  } catch (error) {
    // The cause is reduced to what is safe to print: the token redacted, no
    // headers (`safeErrorCause`).
    throw new RecipientRouteError(
      "unavailable",
      undefined,
      safeErrorCause(error, [input.token])
    );
  }
  if (!response.ok) {
    throw await refusalOfResponse(response);
  }
  try {
    const value = (await response.json()) as Record<string, unknown>;
    if (
      !value ||
      typeof value !== "object" ||
      value.workflowId !== command.workflowId
    ) {
      throw new Error("invalid receipt");
    }
    if (command.operation === "publish-result") {
      if (
        value.schema !== "supervisor-work-result-receipt.v1" ||
        value.taskId !== command.taskId ||
        value.resultPublished !== true
      ) {
        throw new Error("invalid result receipt");
      }
      return {
        schema: value.schema,
        workflowId: value.workflowId,
        taskId: value.taskId,
        resultPublished: true,
      };
    }
    if (
      value.schema !== "supervisor-message-recipient-receipt.v2" ||
      value.workResultCompleted !== false ||
      typeof value.phase !== "string"
    ) {
      throw new Error("invalid lifecycle receipt");
    }
    return {
      schema: value.schema,
      workflowId: value.workflowId,
      phase: value.phase,
      workResultCompleted: false,
    };
  } catch (error) {
    throw new RecipientRouteError(
      "invalid-receipt",
      undefined,
      safeErrorCause(error, [input.token])
    );
  }
};

/**
 * A V2 message workflow id (legacy or deployment format). V1 ids
 * (`supervisor-message:<hex>`) never match, so the V1 mailbox reconciler and
 * the recipient route never both act on one message.
 */
const V2_WORKFLOW_ID_RE =
  /^supervisor-message-workflow:v2:(?:deployment:)?[a-f0-9]{64}$/u;

export const isSupervisorMessageV2WorkflowId = (value: unknown): boolean =>
  typeof value === "string" && V2_WORKFLOW_ID_RE.test(value);

/**
 * The one request id of a recipient's read acknowledgement of a V2 message,
 * per operation. `loop a2a ack`, `loop mailbox ack` and the server's mailbox
 * consumption reconciler all derive it from the workflow id alone, so the
 * three paths are the SAME command to the workflow port: whichever runs
 * second replays the first's outcome instead of signalling again.
 */
export const recipientAckRequestId = (
  operation: "acknowledge" | "claim",
  workflowId: string
): string => `a2a-ack:${operation}:${workflowId}`;

export interface RecipientAcknowledgement {
  phase: string;
  schema: "supervisor-message-recipient-receipt.v2";
  workflowId: string;
  /** Always false: a read acknowledgement is never work completion. */
  workResultCompleted: false;
}

const routeErrorOf = (error: unknown): RecipientRouteError =>
  error instanceof RecipientRouteError
    ? error
    : new RecipientRouteError("refused", undefined, safeErrorCause(error));

/**
 * A refused recipient acknowledgement. `reason` names the refusal code of
 * each command that was refused, claim and acknowledge (codes from the fixed
 * set only; never a token or a response body).
 */
export class RecipientAcknowledgementError extends Error {
  readonly acknowledgeCode: RecipientRouteRefusalCode | undefined;
  readonly claimCode: RecipientRouteRefusalCode | undefined;
  readonly reason: string;
  constructor(
    refused: {
      acknowledge?: RecipientRouteRefusalCode;
      claim?: RecipientRouteRefusalCode;
    },
    /** The deciding refusal's safe cause (`safeErrorCause`), if it has one. */
    cause?: unknown
  ) {
    const reason = [
      ...(refused.acknowledge ? [`acknowledge: ${refused.acknowledge}`] : []),
      ...(refused.claim ? [`claim: ${refused.claim}`] : []),
    ].join("; ");
    super(
      `Recipient acknowledgement refused (${reason}); no completion is claimed`,
      cause === undefined ? undefined : { cause }
    );
    this.name = "RecipientAcknowledgementError";
    this.acknowledgeCode = refused.acknowledge;
    this.claimCode = refused.claim;
    this.reason = reason;
  }
}

/**
 * How long an acknowledgement waits out early refusals by default: a Claude
 * session or mailbox reader can hold a message before its delivery is
 * recorded, for up to the message's retryDelayMs (after which a claim
 * records the delivery itself) and a recovery sweep's attempt lease.
 */
export const RECIPIENT_ACK_EARLY_WAIT_MS = 120_000;
const EARLY_RETRY_FIRST_MS = 250;
const EARLY_RETRY_MAX_MS = 5000;
const EARLY_RETRY_MARGIN_MS = 100;

/** The server's hint (plus a margin), never sooner than a bounded backoff. */
const earlyRetryDelay = (early: RecipientRouteError, retry: number): number => {
  const backoff = Math.min(
    EARLY_RETRY_FIRST_MS * 2 ** retry,
    EARLY_RETRY_MAX_MS
  );
  return early.retryAfterMs === undefined
    ? backoff
    : Math.max(early.retryAfterMs + EARLY_RETRY_MARGIN_MS, backoff);
};

/**
 * The recipient's delivery/read acknowledgement of one V2 message: claim, then
 * acknowledge, on the recipient route. Request ids are derived from the
 * workflow id, so a retry repeats the same commands instead of minting new
 * ones. A refused claim is not final (this recipient may have claimed it
 * already); a refused acknowledge is, except an early one. Early refusals
 * (`delivery-not-recorded`, `not-claimed`: the intended recipient, before its
 * delivery or claim is recorded) signal nothing, so the same commands are
 * repeated, at the server's `retryAfterMs` or a bounded backoff, for up to
 * `earlyWaitMs`. Never publishes a result.
 */
export const acknowledgeRecipientWorkflow = async (input: {
  /** Bound on waiting out early refusals; 0 refuses at the first one. */
  earlyWaitMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  token: string;
  url: string;
  workflowId: string;
}): Promise<RecipientAcknowledgement> => {
  if (!isSupervisorMessageV2WorkflowId(input.workflowId)) {
    throw new Error("workflow id is not a V2 message workflow id");
  }
  const now = input.now ?? Date.now;
  const sleep =
    input.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline =
    now() + Math.max(0, input.earlyWaitMs ?? RECIPIENT_ACK_EARLY_WAIT_MS);
  const call = (operation: "acknowledge" | "claim") =>
    callRecipientRoute({
      command: {
        operation,
        requestId: recipientAckRequestId(operation, input.workflowId),
        workflowId: input.workflowId,
      },
      fetchImpl: input.fetchImpl,
      token: input.token,
      url: input.url,
    });
  for (let retry = 0; ; retry++) {
    let claimRefusal: RecipientRouteError | undefined;
    try {
      await call("claim");
    } catch (error) {
      // Already claimed by this recipient, or refused: the acknowledge below
      // decides. Its refusal is the one reported, with the claim's beside it.
      claimRefusal = routeErrorOf(error);
    }
    let early: RecipientRouteError | undefined;
    if (claimRefusal?.code === "delivery-not-recorded") {
      // Not claimed, so the acknowledge would only be early too.
      early = claimRefusal;
    } else {
      try {
        const receipt = await call("acknowledge");
        return {
          phase: String(receipt.phase),
          schema: "supervisor-message-recipient-receipt.v2",
          workResultCompleted: false,
          workflowId: input.workflowId,
        };
      } catch (error) {
        const refusal = routeErrorOf(error);
        if (refusal.code !== "not-claimed") {
          throw new RecipientAcknowledgementError(
            { acknowledge: refusal.code, claim: claimRefusal?.code },
            refusal.cause
          );
        }
        early = refusal;
      }
    }
    const delay = earlyRetryDelay(early, retry);
    if (now() + delay > deadline) {
      throw new RecipientAcknowledgementError(
        early === claimRefusal
          ? { claim: early.code }
          : { acknowledge: early.code, claim: claimRefusal?.code },
        early.cause
      );
    }
    await sleep(delay);
  }
};
