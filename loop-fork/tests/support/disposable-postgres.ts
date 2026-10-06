import { randomUUID } from "node:crypto";
import { privateDocker } from "./private-docker";

const POSTGRES_IMAGE =
  "postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73";
const PORT = /:(\d+)$/;

const docker = (...args: string[]) => privateDocker({}, ...args);

/**
 * A task-owned PostgreSQL container on a random loopback port, removed on
 * close. The password travels in the container environment, never in argv.
 */
export class DisposablePostgres {
  readonly #containerId: string;
  readonly #password: string;
  readonly #port: string;

  private constructor(containerId: string, password: string, port: string) {
    this.#containerId = containerId;
    this.#password = password;
    this.#port = port;
  }

  static async create(): Promise<DisposablePostgres> {
    const password = randomUUID();
    const containerId = await privateDocker(
      { POSTGRES_PASSWORD: password },
      "run",
      "--detach",
      "--rm",
      "--publish",
      "127.0.0.1::5432",
      "--env",
      "POSTGRES_PASSWORD",
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
    try {
      const port = (await docker("port", containerId, "5432/tcp")).match(
        PORT
      )?.[1];
      if (!port) {
        throw new Error("cannot parse disposable PostgreSQL port");
      }
      const postgres = new DisposablePostgres(containerId, password, port);
      await postgres.#waitHealthy();
      return postgres;
    } catch (error) {
      await docker("stop", "--time", "1", containerId).catch(() => "");
      throw error;
    }
  }

  databaseUrl(): string {
    return `postgres://postgres:${encodeURIComponent(this.#password)}@127.0.0.1:${this.#port}/postgres`;
  }

  async close(): Promise<void> {
    await docker("stop", "--time", "1", this.#containerId).catch(() => "");
  }

  async #waitHealthy(): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        (await docker(
          "inspect",
          "--format",
          "{{.State.Health.Status}}",
          this.#containerId
        )) === "healthy"
      ) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("disposable PostgreSQL did not become healthy");
  }
}
