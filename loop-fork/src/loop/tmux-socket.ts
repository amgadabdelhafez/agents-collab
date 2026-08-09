/**
 * Single chokepoint for tmux socket identity and command composition.
 *
 * Every tmux invocation in the product must be composed here. The product
 * previously named no socket at all and relied on tmux's ambient default
 * discovery, so a consumer running with a different `TMUX` / `TMUX_TMPDIR`
 * than the run it was inspecting would silently address a different server —
 * reading a same-named session on the wrong server as evidence about this run.
 *
 * The design rests on four facts measured against tmux 3.7b, not read from
 * documentation; see `runs/tmux-socket-normalization/environment-probes.txt`.
 *   1. `-S <path>` wins over `-L <label>` when both are given.
 *   2. `$TMUX` is `<socket>,<pid>,<session-index>`.
 *   3. A socket pathname may legally contain a comma, so `$TMUX` must be
 *      parsed from the right; a first-field parse truncates `…/so,ck-c`
 *      to `…/so`.
 *   4. The Darwin usable pathname budget is 103 bytes (104 fails with
 *      `File name too long`); Linux is 107.
 */

import { platform as osPlatform } from "node:os";

// --- Brands -----------------------------------------------------------------
// Declared, never exported. A consumer cannot name these, so it cannot write a
// type assertion that mints one, and it cannot construct a value structurally.

declare const socketBrand: unique symbol;
declare const targetBrand: unique symbol;
declare const paneBrand: unique symbol;
declare const handleBrand: unique symbol;

/** An absolute, validated, platform-budget-checked tmux socket pathname. */
export type TmuxSocket = string & { readonly [socketBrand]: "TmuxSocket" };

/**
 * A run's server plus session identity. Opaque: there is no public
 * constructor and no public field, so a socket from one run cannot be paired
 * with a session from another.
 */
export interface TmuxTarget {
  readonly [targetBrand]: "TmuxTarget";
}

/**
 * A pane that belongs to a specific target. Opaque for the same reason: a
 * `(TmuxTarget, paneId: string)` signature would leave target-A-with-pane-B
 * pairable by any caller, so pane subordination is enforced by type.
 */
export interface OwnedPaneTarget {
  readonly [paneBrand]: "OwnedPaneTarget";
}

/**
 * Evidence that a manifest was read from disk. The manifest read path in
 * `run-state.ts` is the sole producer; the derived migration check (T-11)
 * asserts `createManifestHandle` is imported nowhere else.
 */
export interface ManifestHandle {
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly runId: string;
  readonly [handleBrand]: "ManifestHandle";
}

// Runtime witness. Module-private, so a plain object literal can never carry
// it and `targetFromManifest` can tell a real handle from a look-alike.
const HANDLE_WITNESS = Symbol("loop.tmux.manifestHandle");

interface HandleContents {
  readonly panes: Readonly<
    Record<string, string | readonly string[] | undefined>
  >;
  readonly session: string | undefined;
  readonly socket: TmuxSocket | undefined;
  /** Why the socket is unusable, retained so a skip record can name it. */
  readonly socketState: TmuxSocketState | undefined;
}

// Socket and session are held here rather than on the handle, so they are not
// readable through the public `ManifestHandle` surface at all.
const handleContents = new WeakMap<object, HandleContents>();
const targetContents = new WeakMap<
  object,
  { socket: TmuxSocket; session: string }
>();
const paneContents = new WeakMap<
  object,
  { socket: TmuxSocket; session: string; pane: string }
>();

// --- Errors -----------------------------------------------------------------

export class TmuxSocketUnknownError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`tmux socket unknown: ${reason}`);
    this.name = "TmuxSocketUnknownError";
    this.reason = reason;
  }
}

export class TmuxTargetProvenanceError extends Error {
  constructor(detail: string) {
    super(`tmux target provenance: ${detail}`);
    this.name = "TmuxTargetProvenanceError";
  }
}

// --- Skip records -----------------------------------------------------------

export type TmuxSocketState = "conflicting" | "invalid" | "missing" | "unknown";

/**
 * Emitted whenever a consumer declines to act because the target is not
 * usable. A skip that emits no record is a fail-open: the effect silently did
 * not happen and nothing observable says so.
 *
 * `session` and `pane` are `null` for explicit absence rather than optional,
 * so a caller cannot satisfy the shape by omitting them.
 */
export interface TmuxSkipRecord {
  readonly consumer: string;
  /** The concrete effect that was suppressed, e.g. "kill-pane". */
  readonly effectSkipped: string;
  readonly pane: string | null;
  readonly reason: string;
  readonly runId: string;
  readonly session: string | null;
  readonly socketState: TmuxSocketState;
}

export interface TmuxSkipSink {
  record(record: TmuxSkipRecord): void;
}

/** Collects skip records for assertion. Tests read this, never rendered text. */
export const createTmuxSkipSink = (): TmuxSkipSink & {
  readonly records: readonly TmuxSkipRecord[];
} => {
  const records: TmuxSkipRecord[] = [];
  return {
    records,
    record(record: TmuxSkipRecord) {
      records.push(record);
    },
  };
};

// --- Socket validation ------------------------------------------------------

/** Usable `sun_path` bytes, excluding the NUL terminator. Measured, not read. */
export const DARWIN_SOCKET_BYTE_LIMIT = 103;
export const LINUX_SOCKET_BYTE_LIMIT = 107;

export const socketByteLimit = (plat: string = osPlatform()): number =>
  plat === "darwin" ? DARWIN_SOCKET_BYTE_LIMIT : LINUX_SOCKET_BYTE_LIMIT;

export interface SocketValidation {
  readonly ok: boolean;
  readonly reason?: string;
  readonly socket?: TmuxSocket;
}

/**
 * Validates a candidate socket pathname. Length is measured in UTF-8 bytes,
 * because that is what `sun_path` holds: a multibyte path can sit under the
 * character limit and still overflow.
 */
export const validateTmuxSocket = (
  value: unknown,
  plat: string = osPlatform()
): SocketValidation => {
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, reason: "socket is empty or not a string" };
  }
  if (value.includes("\0")) {
    return { ok: false, reason: "socket contains a NUL byte" };
  }
  if (!value.startsWith("/")) {
    // Never resolved against cwd: a relative socket would silently mean a
    // different server depending on where the consumer happened to run.
    return {
      ok: false,
      reason: `socket is relative, which is never resolved against cwd: ${value}`,
    };
  }
  const bytes = Buffer.byteLength(value, "utf8");
  const limit = socketByteLimit(plat);
  if (bytes > limit) {
    return {
      ok: false,
      reason: `socket is ${bytes} UTF-8 bytes, over the ${plat} limit of ${limit} bytes: ${value}`,
    };
  }
  return { ok: true, socket: value as TmuxSocket };
};

/** Throwing form, for the launch path where an unusable socket is fatal. */
export const requireTmuxSocket = (
  value: unknown,
  plat: string = osPlatform()
): TmuxSocket => {
  const result = validateTmuxSocket(value, plat);
  if (!(result.ok && result.socket)) {
    throw new TmuxSocketUnknownError(result.reason ?? "socket is unusable");
  }
  return result.socket;
};

// --- Resolution -------------------------------------------------------------

/**
 * Recovers the socket from a `$TMUX` value by removing exactly the final two
 * comma-delimited metadata fields. Parsing the first field instead truncates
 * any socket pathname containing a legal comma.
 */
export const parseTmuxEnvSocket = (value: string): string | undefined => {
  const fields = value.split(",");
  if (fields.length < 3) {
    return undefined;
  }
  return fields.slice(0, -2).join(",");
};

export interface ResolveTmuxSocketOptions {
  readonly platform?: string;
  readonly uid: number;
}

export interface ResolvedTmuxSocket {
  readonly socket: TmuxSocket;
  /** Which precedence rule produced it, recorded rather than re-derived. */
  readonly source: "LOOP_TMUX_SOCKET" | "TMUX" | "TMUX_TMPDIR";
  /** The `TMUX_TMPDIR` actually in force at resolution time, if rule three ran. */
  readonly tmuxTmpdir?: string;
}

/**
 * Precedence: `LOOP_TMUX_SOCKET`, then parsed `$TMUX`, then
 * `${TMUX_TMPDIR:-/tmp}/tmux-<uid>/default`.
 *
 * A malformed `$TMUX` is a hard error rather than a fallback to rule three:
 * falling through would silently address a different server than the one the
 * caller is demonstrably sitting inside.
 *
 * This is a launch-time function. No post-launch consumer may reach it — after
 * launch the manifest is the only source of truth (R6).
 */
export const resolveTmuxSocket = (
  env: Readonly<Record<string, string | undefined>>,
  options: ResolveTmuxSocketOptions
): ResolvedTmuxSocket => {
  const plat = options.platform ?? osPlatform();

  // An operator who exports the variable at all has stated an intent. Treating
  // an empty value as "unset" and falling through would silently launch onto a
  // different server than the one they meant to name, so an empty launch value
  // is a hard error (R4, verify 2) rather than an absent one.
  const override = env.LOOP_TMUX_SOCKET;
  if (override !== undefined) {
    return {
      socket: requireTmuxSocket(override, plat),
      source: "LOOP_TMUX_SOCKET",
    };
  }

  const ambient = env.TMUX;
  if (ambient !== undefined) {
    if (ambient === "") {
      throw new TmuxSocketUnknownError(
        "TMUX is set but empty, which names no server"
      );
    }
    const parsed = parseTmuxEnvSocket(ambient);
    if (parsed === undefined) {
      throw new TmuxSocketUnknownError(
        `TMUX is malformed and is not fallen back from: ${ambient}`
      );
    }
    return { socket: requireTmuxSocket(parsed, plat), source: "TMUX" };
  }

  const tmpdir =
    env.TMUX_TMPDIR && env.TMUX_TMPDIR !== "" ? env.TMUX_TMPDIR : "/tmp";
  const candidate = `${tmpdir}/tmux-${options.uid}/default`;
  return {
    socket: requireTmuxSocket(candidate, plat),
    source: "TMUX_TMPDIR",
    tmuxTmpdir: tmpdir,
  };
};

// --- Manifest handles -------------------------------------------------------

export interface ManifestHandleInput {
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly panes?: Readonly<
    Record<string, string | readonly string[] | undefined>
  >;
  readonly platform?: string;
  readonly runId: string;
  readonly session: unknown;
  readonly socket: unknown;
  /**
   * Set by the read path when camel-case `tmuxSocket` and snake-case
   * `tmux_socket` disagree. A conflict is explicit unknown targeting, never a
   * coerced pick of one of the two.
   */
  readonly socketConflict?: boolean;
}

/**
 * Sole producer of `ManifestHandle`. Imported only by the manifest read path
 * in `run-state.ts`; the derived migration check asserts no other importer.
 *
 * An invalid socket is not an error here — it becomes unknown targeting, which
 * every consumer must then skip on. Rejecting at read time would make a legacy
 * manifest unreadable rather than untargetable.
 */
/**
 * Why a socket is unusable, so a skip record can name it. `undefined` means
 * the socket itself is fine and any remaining unknown comes from the session.
 */
const manifestSocketStateFor = (
  input: ManifestHandleInput,
  validated: SocketValidation
): TmuxSocketState | undefined => {
  if (input.socketConflict) {
    return "conflicting";
  }
  if (validated.ok) {
    return undefined;
  }
  if (
    input.socket === undefined ||
    input.socket === null ||
    input.socket === ""
  ) {
    return "missing";
  }
  return "invalid";
};

export const createManifestHandle = (
  input: ManifestHandleInput
): ManifestHandle => {
  const validated = validateTmuxSocket(
    input.socket,
    input.platform ?? osPlatform()
  );
  const session =
    typeof input.session === "string" && input.session !== ""
      ? input.session
      : undefined;
  const usable = validated.ok && !input.socketConflict;
  const socketState = manifestSocketStateFor(input, validated);
  const handle = Object.freeze({
    [HANDLE_WITNESS]: true,
    runId: input.runId,
    manifestPath: input.manifestPath,
    manifestSha256: input.manifestSha256,
  }) as unknown as ManifestHandle;
  handleContents.set(handle, {
    socket: usable ? validated.socket : undefined,
    session,
    panes: Object.freeze({ ...(input.panes ?? {}) }),
    socketState,
  });
  return handle;
};

const contentsOf = (handle: ManifestHandle): HandleContents => {
  if (
    handle === null ||
    typeof handle !== "object" ||
    !(HANDLE_WITNESS in (handle as object))
  ) {
    throw new TmuxTargetProvenanceError(
      "value is not a ManifestHandle produced by the manifest read path"
    );
  }
  const contents = handleContents.get(handle as object);
  if (!contents) {
    throw new TmuxTargetProvenanceError(
      "ManifestHandle has no recorded contents"
    );
  }
  return contents;
};

/**
 * The socket state a consumer names in its skip record. `missing`, `invalid`,
 * and `conflicting` describe the socket field itself; `unknown` covers a valid
 * socket whose session is absent, where the server is known but the run's
 * identity on it is not.
 */
export const manifestSocketState = (
  handle: ManifestHandle
): TmuxSocketState => {
  const contents = contentsOf(handle);
  return contents.socketState ?? "unknown";
};

/** True when the handle yields a usable target. */
export const manifestHasTarget = (handle: ManifestHandle): boolean => {
  const contents = contentsOf(handle);
  return contents.socket !== undefined && contents.session !== undefined;
};

// --- Targets ----------------------------------------------------------------

/**
 * The only production constructor for `TmuxTarget`, and it takes **exactly one
 * parameter**. There is therefore no socket parameter anywhere in the public
 * surface through which an independently sourced socket could be supplied, so
 * the wrong-run pairing is unconstructible rather than merely rejected.
 *
 * Returns `undefined` — never a partially-built target — when the manifest has
 * no usable socket or no session. That is the legacy case, and it must read as
 * unknown, never as dead.
 */
export const targetFromManifest = (
  handle: ManifestHandle
): TmuxTarget | undefined => {
  const { socket, session } = contentsOf(handle);
  if (socket === undefined || session === undefined) {
    return undefined;
  }
  const target = Object.freeze({}) as unknown as TmuxTarget;
  targetContents.set(target, { socket, session });
  return target;
};

const targetOf = (target: TmuxTarget) => {
  const contents = targetContents.get(target as object);
  if (!contents) {
    throw new TmuxTargetProvenanceError(
      "value is not a TmuxTarget produced by targetFromManifest"
    );
  }
  return contents;
};

/**
 * Read-only identity for diagnostics and rendering. This does not mint a
 * target and cannot authorize an effect; it only exposes the two values from
 * the same opaque target snapshot so observers cannot mix manifest versions.
 */
export const describeTmuxTarget = (
  target: TmuxTarget
): Readonly<{ session: string; socket: string }> => {
  const { session, socket } = targetOf(target);
  return Object.freeze({ session, socket });
};

/**
 * The one and only production constructor of `OwnedPaneTarget` (R10, as ruled
 * by the harness owner 2026-08-08). Reads a pane field from the same handle
 * that yields the target, so a pane can never be paired with a foreign target.
 * Yields nothing when the handle's socket or session is unknown.
 *
 * `index` addresses the one array-valued pane field, `tmuxPaneRecon`:
 *   - scalar field: `index` must be **absent**; supplying one fails closed;
 *   - `tmuxPaneRecon`: `index` is **required** and must be a non-negative
 *     integer in bounds.
 * Every missing, malformed, or out-of-range case yields no target. The caller
 * is then obliged to emit a `TmuxSkipRecord` naming the effect it suppressed —
 * a silent `undefined` at a consumer is a fail-open.
 */
export const paneTargetFromManifest = (
  handle: ManifestHandle,
  field: string,
  index?: number
): OwnedPaneTarget | undefined => {
  const { socket, session, panes } = contentsOf(handle);
  if (socket === undefined || session === undefined) {
    return undefined;
  }
  const value = panes[field];

  if (Array.isArray(value)) {
    // Index is required here. Defaulting to 0 would silently address the first
    // pane whenever a caller forgot which pane it meant.
    if (
      index === undefined ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= value.length
    ) {
      return undefined;
    }
    const pane = value[index];
    return typeof pane === "string" && pane !== ""
      ? makePaneTarget(socket, session, pane)
      : undefined;
  }

  // Scalar field: an index means the caller believes this field is an array,
  // so honouring it would act on a pane the caller did not identify.
  if (index !== undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value === "") {
    return undefined;
  }
  return makePaneTarget(socket, session, value);
};

const makePaneTarget = (
  socket: TmuxSocket,
  session: string,
  pane: string
): OwnedPaneTarget => {
  const owned = Object.freeze({}) as unknown as OwnedPaneTarget;
  paneContents.set(owned, { socket, session, pane });
  return owned;
};

const paneOf = (pane: OwnedPaneTarget) => {
  const contents = paneContents.get(pane as object);
  if (!contents) {
    throw new TmuxTargetProvenanceError(
      "value is not an OwnedPaneTarget produced by paneTargetFromManifest"
    );
  }
  return contents;
};

// --- Command composition ----------------------------------------------------

const TARGET_FLAGS = new Set(["-S", "-s", "-t"]);

/**
 * Rejects any caller-supplied target-naming flag. A caller that could pass
 * `-t` could re-aim a composed command at another session on the same server,
 * which is the same defect one level down.
 */
const assertNoTargetFlags = (args: readonly string[]): void => {
  for (const arg of args) {
    if (TARGET_FLAGS.has(arg)) {
      throw new TmuxTargetProvenanceError(
        `args may not contain the target-naming flag ${arg}; composition supplies it`
      );
    }
    for (const flag of TARGET_FLAGS) {
      if (arg.startsWith(`${flag}=`)) {
        throw new TmuxTargetProvenanceError(
          `args may not contain the =-joined target flag ${arg}; composition supplies it`
        );
      }
    }
  }
};

/**
 * Socket-only composition. Module-private and unexported on purpose: an
 * exported socket-only helper would let a consumer compose a command carrying
 * a socket but no session, which is how a same-named session on the right
 * server still becomes the wrong answer. The derived check asserts no import
 * of this name outside this module.
 */
const tmuxArgv = (socket: TmuxSocket, args: readonly string[]): string[] => [
  "tmux",
  "-S",
  socket,
  ...args,
];

/** Server-scoped commands: `start-server`, `list-sessions`, `kill-server`. */
export const serverArgv = (
  target: TmuxTarget,
  args: readonly string[]
): string[] => {
  assertNoTargetFlags(args);
  return tmuxArgv(targetOf(target).socket, args);
};

export interface TargetArgvOptions {
  /** `-s` for session-creating commands, `-t` for everything else. */
  readonly sessionFlag?: "-s" | "-t";
}

/** Session-scoped commands. Supplies both `-S` and the session flag itself. */
export const targetArgv = (
  target: TmuxTarget,
  command: string,
  args: readonly string[] = [],
  options: TargetArgvOptions = {}
): string[] => {
  assertNoTargetFlags(args);
  const { socket, session } = targetOf(target);
  return tmuxArgv(socket, [
    command,
    options.sessionFlag ?? "-t",
    session,
    ...args,
  ]);
};

/** Pane-scoped commands. The pane's `-t` value comes from its owning handle. */
export const paneArgv = (
  pane: OwnedPaneTarget,
  command: string,
  args: readonly string[] = []
): string[] => {
  assertNoTargetFlags(args);
  const contents = paneOf(pane);
  return tmuxArgv(contents.socket, [command, "-t", contents.pane, ...args]);
};

// --- Launch window (pre-manifest) -------------------------------------------
// Narrow exception authorised by the harness-owner ruling of 2026-08-08
// (`5a7e6cd3-1216-487c-84f3-ddbcfd371a11`). A non-paired `--tmux` launch holds a
// resolved socket but has no manifest, so it has no `TmuxTarget` and cannot use
// the target-bound composers. These two functions are the ONLY sanctioned way
// to compose from a bare socket, they are usable only before a manifest-backed
// target exists, and no post-launch consumer may import them.
// `targetFromManifest` remains the sole post-launch `TmuxTarget` producer.

/**
 * Composes the non-paired session-creating command from an already validated
 * socket. Supplies `-S` and `-s` itself and rejects caller-supplied target
 * flags, exactly as the target-bound composers do.
 */
export const launchSessionArgv = (
  socket: TmuxSocket,
  session: string,
  args: readonly string[] = []
): string[] => {
  assertNoTargetFlags(args);
  return tmuxArgv(socket, ["new-session", "-s", session, ...args]);
};

/**
 * Composes a server-scoped launch-window command (for example `has-session`)
 * from the same resolved socket, so the pre-session probe cannot address a
 * different server than the one the session is about to be created on.
 */
export const launchServerArgv = (
  socket: TmuxSocket,
  command: string,
  session: string,
  args: readonly string[] = []
): string[] => {
  assertNoTargetFlags(args);
  return tmuxArgv(socket, [command, "-t", session, ...args]);
};

/**
 * Socket-binds an arbitrary tmux command during the bounded paired-start
 * window, before every created pane has a persisted manifest-backed identity.
 * The caller must supply command arguments without the leading `tmux` binary.
 * Once startup publishes the complete pane topology, post-launch consumers
 * must use manifest-derived target and pane composers instead.
 */
export const pairedLaunchArgv = (
  socket: TmuxSocket,
  args: readonly string[]
): string[] => {
  if (args.length === 0) {
    throw new TmuxTargetProvenanceError(
      "paired launch command must not be empty"
    );
  }
  if (args.includes("-S") || args.some((arg) => arg.startsWith("-S="))) {
    throw new TmuxTargetProvenanceError(
      "paired launch command must not supply its own socket flag"
    );
  }
  return tmuxArgv(socket, args);
};

/**
 * The attach hint for a non-paired run, built from the SAME resolved socket the
 * session was created on. Deriving it separately would let the two diverge
 * under changed ambient state, which is the defect this exists to prevent.
 */
export const launchAttachCommand = (
  socket: TmuxSocket,
  session: string
): string => `tmux -S ${shellQuote(socket)} attach -t ${shellQuote(session)}`;

/** Splits a composed argv into Node `spawn` form without dropping `-S`. */
export const spawnParts = (
  argv: readonly string[]
): { command: string; args: string[] } => {
  const [command, ...args] = argv;
  if (command === undefined) {
    throw new TmuxTargetProvenanceError("empty argv has no command");
  }
  return { command, args };
};

// --- Human-facing attach hint ----------------------------------------------

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The attach command shown to a human. Socket and session are shell-escaped,
 * so a path containing spaces or metacharacters round trips as data.
 */
export const tmuxAttachCommand = (target: TmuxTarget): string => {
  const { socket, session } = targetOf(target);
  return `tmux -S ${shellQuote(socket)} attach -t ${shellQuote(session)}`;
};

/** Shown instead of a command when the manifest has no usable socket. */
export const TMUX_UNKNOWN_SOCKET_HINT =
  "tmux socket unknown for this run: recorded before socket normalization, so it cannot be attached";
