import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { privateDocker } from "./private-docker";

const POSTGRES_IMAGE =
  "postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73";
const PORT = /:(\d+)$/;
const docker = (...args: string[]) => privateDocker({}, ...args);

/** Task-owned PostgreSQL container: `--rm`, loopback-only port, password in
 * env (never argv). `close()` stops it, which removes it. */
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
      await postgres.#waitAcceptingQueries();
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

  /** The image's first boot runs a temporary server for initialisation and
   * then restarts, and `pg_isready` can report healthy across that restart
   * ("the database system is starting up"). Wait for a real query over TCP. */
  async #waitAcceptingQueries(): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const sql = new SQL(this.databaseUrl());
      try {
        await sql`SELECT 1`;
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      } finally {
        await sql.close({ timeout: 0 }).catch(() => undefined);
      }
    }
    throw new Error("disposable PostgreSQL did not accept queries");
  }
}
