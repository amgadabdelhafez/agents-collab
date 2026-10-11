import { resolve } from "node:path";
import { safeErrorCause } from "./a2a-error-cause";

const reference = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,511}$/;
export interface RecipientApiCommand {
  operation: "claim" | "acknowledge" | "publish-result";
  requestId: string;
  taskId?: string;
  workflowId: string;
}

const loopbackUrl = (value: string): URL => {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("invalid endpoint");
    }
    return url;
  } catch {
    throw new Error("Recipient API requires an explicit loopback endpoint");
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
 * The recipient route (`{routePath}/recipient`) with an explicit loopback URL
 * and bearer token, for callers that resolved both themselves: `loop a2a ack`
 * and `loop mailbox ack` for V2 envelopes read the token from the
 * supervisor's own `tokenEnv`. The same refusals as the run-bound client:
 * loopback only, no redirect, a strict command, no response or error detail
 * propagated, and no token in any result or error.
 */
export const callRecipientRoute = async (input: {
  command: RecipientApiCommand;
  fetchImpl?: typeof fetch;
  token: string;
  url: string;
}): Promise<Record<string, unknown>> => {
  const url = loopbackUrl(input.url);
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
  try {
    const response = await (input.fetchImpl ?? fetch)(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
    });
    if (!response.ok) {
      throw new Error(`refused (${response.status})`);
    }
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
    // The cause is reduced to what is safe to print: the token redacted, no
    // headers (`safeErrorCause`).
    throw new Error(
      "Recipient API refused or is unavailable; no completion is claimed",
      { cause: safeErrorCause(error, [input.token]) }
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

export interface RecipientAcknowledgement {
  phase: string;
  schema: "supervisor-message-recipient-receipt.v2";
  workflowId: string;
  /** Always false: a read acknowledgement is never work completion. */
  workResultCompleted: false;
}

/**
 * The recipient's delivery/read acknowledgement of one V2 message: claim, then
 * acknowledge, on the recipient route. Request ids are derived from the
 * workflow id, so a retry repeats the same commands instead of minting new
 * ones. A refused claim is not final (this recipient may have claimed it
 * already); a refused acknowledge is. Never publishes a result.
 */
export const acknowledgeRecipientWorkflow = async (input: {
  fetchImpl?: typeof fetch;
  token: string;
  url: string;
  workflowId: string;
}): Promise<RecipientAcknowledgement> => {
  if (!isSupervisorMessageV2WorkflowId(input.workflowId)) {
    throw new Error("workflow id is not a V2 message workflow id");
  }
  const call = (operation: "acknowledge" | "claim") =>
    callRecipientRoute({
      command: {
        operation,
        requestId: `a2a-ack:${operation}:${input.workflowId}`,
        workflowId: input.workflowId,
      },
      fetchImpl: input.fetchImpl,
      token: input.token,
      url: input.url,
    });
  try {
    await call("claim");
  } catch {
    // Already claimed by this recipient, or refused: the acknowledge below
    // decides, and its refusal is the one reported.
  }
  const receipt = await call("acknowledge");
  return {
    phase: String(receipt.phase),
    schema: "supervisor-message-recipient-receipt.v2",
    workResultCompleted: false,
    workflowId: input.workflowId,
  };
};
