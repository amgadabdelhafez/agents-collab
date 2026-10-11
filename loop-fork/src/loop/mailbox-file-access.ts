import { appendFile, mkdir, open, opendir, readFile } from "node:fs/promises";
import { DeadlineExceededError, withDeadline } from "./startup-deadline";
import {
  emptyCursor,
  type MailboxCursor,
  type MailboxReadOutcome,
  parseMailboxCursor,
  parseMailboxText,
} from "./supervisor-mailbox-cursor";

/**
 * The orchestration server's file access for paths it does not own: mailboxes
 * and their cursors, and (as probes) run manifests and run directories, any
 * of which may live under ~/Documents.
 *
 * 2026-10-11: under launchd, `loop orchestration serve` never opened its
 * port. Its start-time reconcile read a mailbox under ~/Documents with
 * readFileSync; macOS parked the open until someone answered a Documents
 * privacy (TCC) prompt, and every new ad-hoc-signed build prompts again. The
 * event loop froze, and nothing listened.
 *
 * Every access here is async (fs/promises: the open waits on a worker
 * thread, not the event loop) and bounded by a deadline. A path whose access
 * missed its deadline and has not returned yet is refused at once, without
 * entering the filesystem again, so a parked open costs one worker thread,
 * not one per pass. A timeout, EPERM or EACCES marks only that binding
 * unreadable, logged once with the path and a hint; its recovery is logged
 * once. ENOENT is absent, as before. `unreadableBindingCount` is the count
 * /healthz reports (no paths).
 *
 * Not covered: TCC decisions are per process, so a path that answered once
 * is not expected to park again; the sync readers it gates (see
 * SupervisorPathGate in loop-orchestration-server.ts) rely on that.
 */
export const MAILBOX_FILE_ACCESS_DEADLINE_MS = 5000;

export const MAILBOX_PRIVACY_HINT =
  "possible macOS privacy prompt or permission denied";

/** The filesystem effects, injectable so a test can hang one of them. */
export interface MailboxFileSystem {
  /** Appends `data` (utf8), creating the file 0600. */
  appendFile(path: string, data: string): Promise<void>;
  /** Creates `path` and its parents, 0700. */
  mkdir(path: string): Promise<void>;
  /** Opens `path` (a file) or lists it (a directory), then closes it. */
  probe(path: string, kind: "directory" | "file"): Promise<void>;
  readFile(path: string): Promise<string>;
}

export const nodeMailboxFileSystem: MailboxFileSystem = {
  appendFile: (path, data) =>
    appendFile(path, data, { encoding: "utf8", mode: 0o600 }),
  mkdir: async (path) => {
    await mkdir(path, { mode: 0o700, recursive: true });
  },
  probe: async (path, kind) => {
    if (kind === "directory") {
      const directory = await opendir(path);
      await directory.close();
      return;
    }
    const handle = await open(path, "r");
    await handle.close();
  },
  readFile: (path) => readFile(path, "utf8"),
};

export type FileAccessOutcome<T> =
  | { kind: "absent" }
  | { kind: "ok"; value: T }
  | { kind: "unavailable"; reason: string };

export type MailboxCursorReadOutcome =
  | { cursor: MailboxCursor; kind: "read" }
  | { kind: "unavailable"; reason: string };

export interface MailboxFileAccessOptions {
  deadlineMs?: number;
  fs?: MailboxFileSystem;
  log?: (line: string) => void;
}

const PRIVACY_CODES = new Set(["EACCES", "EPERM"]);

const errorCode = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
};

export class MailboxFileAccess {
  readonly #deadlineMs: number;
  readonly #fs: MailboxFileSystem;
  readonly #log: (line: string) => void;
  /** Paths whose access missed its deadline and has not returned. */
  readonly #unsettled = new Set<string>();
  /** binding -> its unreadable paths. A binding is listed only while any is. */
  readonly #unreadable = new Map<string, Set<string>>();

  constructor(options: MailboxFileAccessOptions = {}) {
    this.#deadlineMs = options.deadlineMs ?? MAILBOX_FILE_ACCESS_DEADLINE_MS;
    this.#fs = options.fs ?? nodeMailboxFileSystem;
    this.#log = options.log ?? (() => undefined);
  }

  /** How many bindings have a path that is unreadable now; no paths. */
  unreadableBindingCount(): number {
    return this.#unreadable.size;
  }

  /** One bounded operation on `path`, on behalf of `binding`. */
  async access<T>(
    binding: string,
    path: string,
    operation: (fs: MailboxFileSystem) => Promise<T>
  ): Promise<FileAccessOutcome<T>> {
    if (this.#unsettled.has(path)) {
      return {
        kind: "unavailable",
        reason: `an earlier access to ${path} has not returned (${MAILBOX_PRIVACY_HINT})`,
      };
    }
    let work: Promise<T>;
    try {
      work = operation(this.#fs);
    } catch (error) {
      work = Promise.reject(error);
    }
    try {
      const value = await withDeadline(
        work,
        this.#deadlineMs,
        `access to ${path}`
      );
      this.#readable(binding, path);
      return { kind: "ok", value };
    } catch (error) {
      return this.#failed(binding, path, work, error);
    }
  }

  async readMailbox(
    binding: string,
    path: string
  ): Promise<MailboxReadOutcome> {
    const outcome = await this.access(binding, path, (fs) => fs.readFile(path));
    if (outcome.kind === "ok") {
      return parseMailboxText(outcome.value);
    }
    return outcome;
  }

  /**
   * A missing or malformed cursor is the empty cursor, as the sync reader has
   * it; an unreadable one is unavailable, never empty (empty would read
   * every delivered message as unread).
   */
  async readCursor(
    binding: string,
    path: string
  ): Promise<MailboxCursorReadOutcome> {
    const outcome = await this.access(binding, path, (fs) => fs.readFile(path));
    if (outcome.kind === "unavailable") {
      return outcome;
    }
    return {
      cursor:
        outcome.kind === "ok"
          ? parseMailboxCursor(outcome.value)
          : emptyCursor(),
      kind: "read",
    };
  }

  async probe(
    binding: string,
    path: string,
    kind: "directory" | "file"
  ): Promise<"absent" | "readable" | "unavailable"> {
    const outcome = await this.access(binding, path, (fs) =>
      fs.probe(path, kind)
    );
    return outcome.kind === "ok" ? "readable" : outcome.kind;
  }

  #failed<T>(
    binding: string,
    path: string,
    work: Promise<T>,
    error: unknown
  ): FileAccessOutcome<T> {
    if (error instanceof DeadlineExceededError) {
      this.#unsettled.add(path);
      const settled = () => {
        this.#unsettled.delete(path);
      };
      work.then(settled, settled);
      this.#markUnreadable(
        binding,
        path,
        `no answer within ${this.#deadlineMs}ms`
      );
      return {
        kind: "unavailable",
        reason: `${path} did not answer within ${this.#deadlineMs}ms (${MAILBOX_PRIVACY_HINT})`,
      };
    }
    const code = errorCode(error);
    if (code === "ENOENT") {
      // Absent is an answer: whatever guards the path let the lookup through.
      this.#readable(binding, path);
      return { kind: "absent" };
    }
    if (code && PRIVACY_CODES.has(code)) {
      this.#markUnreadable(binding, path, code);
      return {
        kind: "unavailable",
        reason: `${code} (${MAILBOX_PRIVACY_HINT})`,
      };
    }
    return {
      kind: "unavailable",
      reason:
        code ?? (error instanceof Error ? error.message : "access failed"),
    };
  }

  #markUnreadable(binding: string, path: string, cause: string): void {
    const paths = this.#unreadable.get(binding) ?? new Set<string>();
    if (paths.has(path)) {
      return;
    }
    paths.add(path);
    this.#unreadable.set(binding, paths);
    this.#log(
      `[loop] ${binding}: ${path} is unreadable: ${cause} (${MAILBOX_PRIVACY_HINT})`
    );
  }

  #readable(binding: string, path: string): void {
    const paths = this.#unreadable.get(binding);
    if (!paths?.delete(path)) {
      return;
    }
    if (paths.size === 0) {
      this.#unreadable.delete(binding);
    }
    this.#log(`[loop] ${binding}: ${path} is readable again`);
  }
}
