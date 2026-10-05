import { resolve } from "node:path";

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
  const url = loopbackUrl(env.LOOP_RECIPIENT_API_URL ?? "");
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
        authorization: `Bearer ${env.LOOP_RECIPIENT_API_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
    });
    if (!response.ok) {
      throw new Error("refused");
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
  } catch {
    throw new Error(
      "Recipient API refused or is unavailable; no completion is claimed"
    );
  }
};
