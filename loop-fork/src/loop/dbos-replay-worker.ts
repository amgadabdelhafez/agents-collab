import { createInterface } from "node:readline";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { registerDbosWorkflow } from "./dbos-workflow";
import { DbosWorkflowPort } from "./dbos-workflow-port";
import type {
  WorkflowCancelCommand,
  WorkflowQueryCommand,
  WorkflowSignalCommand,
  WorkflowStartCommand,
} from "./workflow-port";
import { WorkflowError } from "./workflow-port";

interface ReplayWorkerRequest {
  id: string;
  method: "cancel" | "inspect" | "query" | "signal" | "start" | "status";
  value: unknown;
}

const [databaseUrl, applicationVersion, executorID] = process.argv.slice(2);
if (!(databaseUrl && applicationVersion && executorID)) {
  throw new Error(
    "DBOS replay worker requires database URL, version, and executor ID"
  );
}

const write = (value: unknown): void => {
  process.stdout.write(`__DBOS_REPLAY_RPC__${JSON.stringify(value)}\n`);
};

const registeredWorkflow = registerDbosWorkflow();
DBOS.setConfig({
  applicationVersion,
  executorID,
  logLevel: "error",
  name: "orch-dbos-replay",
  systemDatabaseUrl: databaseUrl,
  tracingEnabled: false,
});
await DBOS.launch();

let now = "2026-08-30T04:00:00.000Z";
const port = new DbosWorkflowPort({
  commandObservationSeconds: 10,
  now: () => now,
  registeredWorkflow,
});

const dispatch = async (request: ReplayWorkerRequest): Promise<unknown> => {
  if (request.method === "start") {
    const command = request.value as WorkflowStartCommand;
    now = command.input.receivedAt as string;
    return port.start(command);
  }
  if (request.method === "signal") {
    const command = request.value as WorkflowSignalCommand;
    now = (command.payload.at as string | undefined) ?? now;
    return port.signal(command);
  }
  if (request.method === "cancel") {
    return port.cancel(request.value as WorkflowCancelCommand);
  }
  if (request.method === "query") {
    return port.query(request.value as WorkflowQueryCommand);
  }
  if (request.method === "inspect") {
    return port.inspect(request.value as string);
  }
  const status = await DBOS.getWorkflowStatus(request.value as string);
  return status
    ? {
        applicationVersion: status.applicationVersion,
        errorMessage:
          status.error instanceof Error ? status.error.message : undefined,
        status: status.status,
        workflowID: status.workflowID,
      }
    : null;
};

createInterface({ input: process.stdin }).on("line", async (line) => {
  let request: ReplayWorkerRequest;
  try {
    request = JSON.parse(line) as ReplayWorkerRequest;
  } catch (error) {
    write({
      error: error instanceof Error ? error.message : "invalid request",
      id: "invalid",
    });
    return;
  }
  try {
    write({ id: request.id, value: await dispatch(request) });
  } catch (error) {
    write({
      ...(error instanceof WorkflowError ? { errorCode: error.code } : {}),
      error: error instanceof Error ? error.message : "worker request failed",
      id: request.id,
    });
  }
});

write({ ready: true });
