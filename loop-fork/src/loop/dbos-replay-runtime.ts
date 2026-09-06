/*
 * RETIRED (gov-6).
 * Replacement: the governess beat now runs as the governess-beat.v1
 * WorkflowDefinition on Temporal, driven by the generic host workflow in
 * ./temporal-workflow.ts; replay is Temporal replay and the journal is a read
 * model exported from workflow history.
 * Left in place deliberately: deletion is the gov-7 cutover's job, not this
 * slice's. Unwired here, not removed.
 */
import {
  type ChildProcessWithoutNullStreams,
  execFile,
  spawn,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  SupervisorMessageDeliveryOutcome,
  SupervisorMessageDeliveryPort,
} from "./supervisor-message-coordinator";
import type { SupervisorMessageDeliveryRequest } from "./supervisor-message-workflow";
import {
  WorkflowError,
  type WorkflowErrorCode,
  type WorkflowPort,
} from "./workflow-port";
import type { SupervisorMessageReplayRuntime } from "./workflow-replay-corpus";

const execFileAsync = promisify(execFile);
const POSTGRES_IMAGE =
  "postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73";
const POSTGRES_PASSWORD = "orch-dbos-test";
const POSTGRES_PORT_PATTERN = /:(\d+)$/;
const RPC_PREFIX = "__DBOS_REPLAY_RPC__";
const WORKER_PATH = fileURLToPath(
  new URL("./dbos-replay-worker.ts", import.meta.url)
);

const docker = async (...args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync("docker", args, {
    encoding: "utf8",
    timeout: 30_000,
  });
  return stdout.trim();
};

const startPostgres = async (): Promise<{
  containerId: string;
  databaseUrl: string;
}> => {
  const containerId = await docker(
    "run",
    "--detach",
    "--rm",
    "--publish",
    "127.0.0.1::5432",
    "--env",
    `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
    "--env",
    "POSTGRES_USER=postgres",
    "--env",
    "POSTGRES_DB=postgres",
    "--health-cmd",
    "pg_isready --username postgres --dbname postgres",
    "--health-interval",
    "100ms",
    "--health-retries",
    "100",
    "--health-start-period",
    "100ms",
    POSTGRES_IMAGE
  );
  const endpoint = await docker("port", containerId, "5432/tcp");
  const port = endpoint.match(POSTGRES_PORT_PATTERN)?.[1];
  if (!port) {
    await docker("stop", "--time", "1", containerId);
    throw new Error(`cannot parse PostgreSQL endpoint ${endpoint}`);
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const health = await docker(
        "inspect",
        "--format",
        "{{.State.Health.Status}}",
        containerId
      );
      if (health === "healthy") {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return {
          containerId,
          databaseUrl: `postgresql://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${port}/postgres`,
        };
      }
    } catch {
      // The next bounded probe rechecks container health.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await docker("stop", "--time", "1", containerId);
  throw new Error("isolated PostgreSQL container did not become ready");
};

export class DbosSupervisorMessageReplayRuntime
  implements SupervisorMessageReplayRuntime
{
  readonly delivery: SupervisorMessageDeliveryPort;
  readonly #containerId: string;
  readonly #databaseUrl: string;
  readonly #deliveries: SupervisorMessageDeliveryRequest[] = [];
  #applicationVersion = "supervisor-message.v1-worker";
  #deliveryIndex = 0;
  #deliveryOutcomes: readonly SupervisorMessageDeliveryOutcome[] = [];
  #generation = 1;
  #worker: ChildProcessWithoutNullStreams | undefined;
  readonly #pending = new Map<
    string,
    { reject: (error: Error) => void; resolve: (value: unknown) => void }
  >();

  private constructor(containerId: string, databaseUrl: string) {
    this.#containerId = containerId;
    this.#databaseUrl = databaseUrl;
    this.delivery = {
      deliver: (request) => {
        const outcome = this.#deliveryOutcomes[this.#deliveryIndex];
        if (!outcome) {
          throw new Error(
            `fixture did not define delivery outcome ${this.#deliveryIndex + 1}`
          );
        }
        this.#deliveryIndex += 1;
        this.#deliveries.push(structuredClone(request));
        return Promise.resolve(structuredClone(outcome));
      },
    };
  }

  static async create(): Promise<DbosSupervisorMessageReplayRuntime> {
    const postgres = await startPostgres();
    const runtime = new DbosSupervisorMessageReplayRuntime(
      postgres.containerId,
      postgres.databaseUrl
    );
    try {
      await runtime.#launch();
      return runtime;
    } catch (error) {
      await runtime.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.#stopWorker();
    await docker("stop", "--time", "1", this.#containerId).catch(() => "");
  }

  deliveries(): readonly SupervisorMessageDeliveryRequest[] {
    return structuredClone(this.#deliveries);
  }

  async restartWorker(): Promise<void> {
    await this.#shutdown();
    this.#generation += 1;
    await this.#launch();
  }

  setClock(at: string): void {
    this.#clock = at;
  }

  setDeliveryOutcomes(
    outcomes: readonly SupervisorMessageDeliveryOutcome[]
  ): void {
    this.#deliveryOutcomes = structuredClone(outcomes);
    this.#deliveryIndex = 0;
    this.#deliveries.length = 0;
    this.#clock = "2026-08-30T04:00:00.000Z";
  }

  async upgradeWorker(version: string): Promise<void> {
    await this.#shutdown();
    this.#generation += 1;
    this.#applicationVersion = version;
    await this.#launch();
  }

  workflowPort(): WorkflowPort {
    if (!this.#worker) {
      throw new Error("DBOS replay runtime is not launched");
    }
    return {
      cancel: (command) => this.#rpc("cancel", command),
      inspect: (workflowId) => this.#rpc("inspect", workflowId),
      query: (command) => this.#rpc("query", command),
      signal: (command) =>
        this.#rpc("signal", {
          ...command,
          payload: { ...command.payload, at: this.#clock },
        }),
      start: (command) =>
        this.#rpc("start", {
          ...command,
          input: { ...command.input, receivedAt: this.#clock },
        }),
    };
  }

  workflowStatus(workflowId: string): Promise<unknown> {
    return this.#rpc("status", workflowId);
  }

  workerIdentity(): { generation: number; version: string } {
    return { generation: this.#generation, version: this.#applicationVersion };
  }

  async #launch(): Promise<void> {
    const worker = spawn(
      process.execPath,
      [
        WORKER_PATH,
        this.#databaseUrl,
        this.#applicationVersion,
        "orch-dbos-test",
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    this.#worker = worker;
    worker.stderr.on("data", (chunk) => process.stderr.write(chunk));
    worker.once("exit", (code, signal) => {
      if (this.#worker === worker) {
        this.#worker = undefined;
      }
      const error = new Error(
        `DBOS replay worker exited code=${String(code)} signal=${String(signal)}`
      );
      for (const pending of this.#pending.values()) {
        pending.reject(error);
      }
      this.#pending.clear();
    });
    let buffered = "";
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("DBOS replay worker readiness timed out")),
        15_000
      );
      const acceptMessage = (line: string): void => {
        if (!line.startsWith(RPC_PREFIX)) {
          return;
        }
        const message = JSON.parse(line.slice(RPC_PREFIX.length)) as {
          error?: string;
          errorCode?: WorkflowErrorCode;
          id?: string;
          ready?: boolean;
          value?: unknown;
        };
        if (message.ready) {
          clearTimeout(timeout);
          resolve();
          return;
        }
        if (!message.id) {
          return;
        }
        const pending = this.#pending.get(message.id);
        if (!pending) {
          return;
        }
        this.#pending.delete(message.id);
        if (message.error) {
          pending.reject(
            message.errorCode
              ? new WorkflowError(message.errorCode, message.error)
              : new Error(message.error)
          );
        } else {
          pending.resolve(message.value);
        }
      };
      worker.stdout.on("data", (chunk) => {
        buffered += chunk.toString();
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          acceptMessage(line);
        }
      });
      worker.once("error", reject);
      worker.once("exit", (code, signal) =>
        reject(
          new Error(
            `DBOS replay worker exited before ready code=${String(code)} signal=${String(signal)}`
          )
        )
      );
    });
    await ready;
  }

  async #shutdown(): Promise<void> {
    await this.#stopWorker();
  }

  #clock = "2026-08-30T04:00:00.000Z";

  #rpc<T>(method: string, value: unknown): Promise<T> {
    const worker = this.#worker;
    if (!worker) {
      throw new Error("DBOS replay worker is not running");
    }
    const id = randomUUID();
    const result = new Promise<T>((resolve, reject) => {
      this.#pending.set(id, {
        reject,
        resolve: resolve as (value: unknown) => void,
      });
    });
    worker.stdin.write(`${JSON.stringify({ id, method, value })}\n`);
    return result;
  }

  async #stopWorker(): Promise<void> {
    const worker = this.#worker;
    if (!worker) {
      return;
    }
    this.#worker = undefined;
    worker.kill("SIGKILL");
    await new Promise<void>((resolve) => worker.once("exit", () => resolve()));
  }
}
