import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
// Verify 5a enumerates the module's public exports to assert the socket-only
// `tmuxArgv` and the brand symbols are absent from them. A named import cannot
// observe what is *not* exported, so the namespace import is the assertion.
// biome-ignore lint/performance/noNamespaceImport: required to enumerate the public export surface
import * as tmuxSocketModule from "../../src/loop/tmux-socket";
import {
  createManifestHandle,
  createTmuxSkipSink,
  DARWIN_SOCKET_BYTE_LIMIT,
  LINUX_SOCKET_BYTE_LIMIT,
  launchAttachCommand,
  launchServerArgv,
  launchSessionArgv,
  type ManifestHandle,
  manifestHasTarget,
  manifestSocketState,
  paneArgv,
  paneTargetFromManifest,
  parseTmuxEnvSocket,
  requireTmuxSocket,
  resolveTmuxSocket,
  spawnParts,
  TMUX_UNKNOWN_SOCKET_HINT,
  TmuxSocketUnknownError,
  type TmuxTarget,
  TmuxTargetProvenanceError,
  targetArgv,
  targetFromManifest,
  tmuxAttachCommand,
  validateTmuxSocket,
} from "../../src/loop/tmux-socket";

const SOCKET_A = "/tmp/ls-a/a.sock";
const SESSION_A = "run-a";

const handleFor = (
  overrides: Partial<Parameters<typeof createManifestHandle>[0]> = {}
): ManifestHandle =>
  createManifestHandle({
    manifestPath: "/tmp/ls-a/manifest.json",
    manifestSha256: "a".repeat(64),
    panes: { tmuxPaneLeft: "%1", tmuxPaneRecon: ["%7", "%8"] },
    platform: "darwin",
    runId: "run-a",
    session: SESSION_A,
    socket: SOCKET_A,
    ...overrides,
  });

// --- verify 1: resolution precedence ----------------------------------------

describe("resolveTmuxSocket precedence (verify 1)", () => {
  test("LOOP_TMUX_SOCKET wins when TMUX is also set", () => {
    const resolved = resolveTmuxSocket(
      {
        LOOP_TMUX_SOCKET: "/tmp/ls-o/override.sock",
        TMUX: "/tmp/ls-a/a.sock,123,0",
      },
      { platform: "darwin", uid: 501 }
    );
    expect(String(resolved.socket)).toBe("/tmp/ls-o/override.sock");
    expect(resolved.source).toBe("LOOP_TMUX_SOCKET");
  });

  test("parses $TMUX by removing exactly the final two metadata fields", () => {
    const resolved = resolveTmuxSocket(
      { TMUX: "/tmp/ls-a/a.sock,7391,0" },
      { platform: "darwin", uid: 501 }
    );
    expect(String(resolved.socket)).toBe("/tmp/ls-a/a.sock");
    expect(resolved.source).toBe("TMUX");
  });

  test("preserves a socket pathname containing a legal comma", () => {
    // Measured against tmux 3.7b: a first-field parse truncates this to
    // "/tmp/ls-a/so", silently naming a different server.
    const resolved = resolveTmuxSocket(
      { TMUX: "/tmp/ls-a/so,ck-c,7391,0" },
      { platform: "darwin", uid: 501 }
    );
    expect(String(resolved.socket)).toBe("/tmp/ls-a/so,ck-c");
    expect(parseTmuxEnvSocket("/tmp/ls-a/so,ck-c,7391,0")).toBe(
      "/tmp/ls-a/so,ck-c"
    );
    expect("/tmp/ls-a/so,ck-c,7391,0".split(",")[0]).toBe("/tmp/ls-a/so");
  });

  test("rule three honours an operator-exported TMUX_TMPDIR and records it", () => {
    const resolved = resolveTmuxSocket(
      { TMUX_TMPDIR: "/tmp/ls-op" },
      { platform: "darwin", uid: 501 }
    );
    expect(String(resolved.socket)).toBe("/tmp/ls-op/tmux-501/default");
    expect(resolved.source).toBe("TMUX_TMPDIR");
    expect(resolved.tmuxTmpdir).toBe("/tmp/ls-op");
  });

  test("rule three defaults to /tmp when TMUX_TMPDIR is unset", () => {
    const resolved = resolveTmuxSocket({}, { platform: "darwin", uid: 501 });
    expect(String(resolved.socket)).toBe("/tmp/tmux-501/default");
  });

  test("every successful result is absolute", () => {
    for (const env of [
      { LOOP_TMUX_SOCKET: "/tmp/ls-o/o.sock" },
      { TMUX: "/tmp/ls-a/a.sock,1,0" },
      { TMUX_TMPDIR: "/tmp/ls-op" },
      {},
    ]) {
      expect(
        String(
          resolveTmuxSocket(env, { platform: "darwin", uid: 501 }).socket
        ).startsWith("/")
      ).toBe(true);
    }
  });

  test("an explicitly empty launch value is a hard error, not an absent one", () => {
    // An operator who exports the variable at all has stated an intent.
    // Treating "" as unset and falling through would silently launch onto a
    // different server than the one they meant to name (R4, verify 2).
    expect(() =>
      resolveTmuxSocket(
        { LOOP_TMUX_SOCKET: "" },
        { platform: "darwin", uid: 501 }
      )
    ).toThrow(TmuxSocketUnknownError);
    expect(() =>
      resolveTmuxSocket({ TMUX: "" }, { platform: "darwin", uid: 501 })
    ).toThrow(TmuxSocketUnknownError);
  });

  test("a malformed $TMUX is a hard error, never a fallback to rule three", () => {
    // Falling through would silently address a different server than the one
    // the caller is demonstrably sitting inside.
    expect(() =>
      resolveTmuxSocket(
        { TMUX: "garbage-no-fields" },
        { platform: "darwin", uid: 501 }
      )
    ).toThrow(TmuxSocketUnknownError);
  });
});

// --- verify 2: validation and the byte budget --------------------------------

describe("socket validation (verify 2)", () => {
  test("rejects empty, relative, and NUL-containing values", () => {
    expect(validateTmuxSocket("", "darwin").ok).toBe(false);
    expect(validateTmuxSocket("relative/a.sock", "darwin").ok).toBe(false);
    expect(validateTmuxSocket("/tmp/a\0b.sock", "darwin").ok).toBe(false);
    expect(validateTmuxSocket(undefined, "darwin").ok).toBe(false);
  });

  test("a relative LOOP_TMUX_SOCKET is a hard error, never resolved against cwd", () => {
    const result = validateTmuxSocket("relative/a.sock", "darwin");
    expect(result.reason).toContain("never resolved against cwd");
    expect(() =>
      resolveTmuxSocket(
        { LOOP_TMUX_SOCKET: "relative/a.sock" },
        {
          platform: "darwin",
          uid: 501,
        }
      )
    ).toThrow(TmuxSocketUnknownError);
  });

  test("Darwin boundary: 103 bytes passes, 104 fails", () => {
    // Measured, not read: 104 fails with "File name too long" on tmux 3.7b.
    const at = `/tmp/${"a".repeat(DARWIN_SOCKET_BYTE_LIMIT - 5)}`;
    const over = `${at}a`;
    expect(at.length).toBe(DARWIN_SOCKET_BYTE_LIMIT);
    expect(validateTmuxSocket(at, "darwin").ok).toBe(true);
    expect(validateTmuxSocket(over, "darwin").ok).toBe(false);
  });

  test("Linux boundary: 107 bytes passes, 108 fails", () => {
    const at = `/tmp/${"a".repeat(LINUX_SOCKET_BYTE_LIMIT - 5)}`;
    expect(at.length).toBe(LINUX_SOCKET_BYTE_LIMIT);
    expect(validateTmuxSocket(at, "linux").ok).toBe(true);
    expect(validateTmuxSocket(`${at}a`, "linux").ok).toBe(false);
  });

  test("character count is not the instrument: multibyte under chars, over bytes", () => {
    const multibyte = `/tmp/${"é".repeat(50)}`;
    expect(multibyte.length).toBeLessThan(DARWIN_SOCKET_BYTE_LIMIT);
    expect(Buffer.byteLength(multibyte, "utf8")).toBeGreaterThan(
      DARWIN_SOCKET_BYTE_LIMIT
    );
    expect(validateTmuxSocket(multibyte, "darwin").ok).toBe(false);
  });

  test("the failure reports UTF-8 byte length and the platform limit", () => {
    const over = `/tmp/${"a".repeat(DARWIN_SOCKET_BYTE_LIMIT)}`;
    const reason = validateTmuxSocket(over, "darwin").reason ?? "";
    expect(reason).toContain(String(Buffer.byteLength(over, "utf8")));
    expect(reason).toContain(String(DARWIN_SOCKET_BYTE_LIMIT));
    expect(reason).toContain("darwin");
  });
});

// --- verify 5a: constructibility bound --------------------------------------

describe("target provenance (verify 5a)", () => {
  test("targetFromManifest takes exactly one parameter", () => {
    // There is therefore no socket parameter anywhere in the public surface
    // through which an independently sourced socket could be supplied.
    expect(targetFromManifest.length).toBe(1);
  });

  test("an unbranded plain object throws TmuxTargetProvenanceError", () => {
    const forged = {
      manifestPath: "/tmp/ls-b/manifest.json",
      manifestSha256: "b".repeat(64),
      runId: "run-b",
      session: "run-b",
      socket: "/tmp/ls-b/b.sock",
    } as unknown as ManifestHandle;
    expect(() => targetFromManifest(forged)).toThrow(TmuxTargetProvenanceError);
  });

  test("the module-private socket-only tmuxArgv is absent from public exports", () => {
    // An exported socket-only helper would let a consumer compose a command
    // carrying a socket but no session.
    const exported = Object.keys(tmuxSocketModule);
    expect(exported).not.toContain("tmuxArgv");
    // The only own symbol on an ESM namespace is the standard Symbol.toStringTag
    // marker; asserting that no *module-defined* symbol escapes is the real
    // property, since a leaked brand symbol would let a consumer mint a handle.
    const leaked = Object.getOwnPropertySymbols(tmuxSocketModule).filter(
      (symbol) => symbol !== Symbol.toStringTag
    );
    expect(leaked).toHaveLength(0);
  });

  test("ManifestHandle is frozen and carries runId, path, and bytes SHA-256", () => {
    const handle = handleFor();
    expect(Object.isFrozen(handle)).toBe(true);
    expect(handle.runId).toBe("run-a");
    expect(handle.manifestPath).toBe("/tmp/ls-a/manifest.json");
    expect(handle.manifestSha256).toBe("a".repeat(64));
  });

  test("a TmuxTarget exposes no socket or session field to read or swap", () => {
    const target = targetFromManifest(handleFor());
    expect(target).toBeDefined();
    expect(Object.keys(target as object)).toHaveLength(0);
    expect(Object.isFrozen(target as object)).toBe(true);
  });

  test("negative type tests: the wrong-run pairing does not compile", () => {
    // These assertions are discharged by `tsc`, not at runtime: each expect-error
    // directive below fails the typecheck if its line ever starts compiling.
    // (Do not write the directive token in prose — TypeScript parses it from a
    // comment anywhere, and an unused one is itself an error.)
    // The body is deliberately never invoked: calling it would throw the runtime
    // provenance error and say nothing about the compile-time bound.
    const neverCalled = (handle: ManifestHandle) => {
      // @ts-expect-error a second socket argument does not exist in the surface
      targetFromManifest(handle, "/tmp/ls-b/b.sock");
      // Each bad value is hoisted so the suppressed error lands on the single
      // line directly after its directive. Inlining the literal lets the
      // formatter wrap it, which moves the error off that line and silently
      // turns the assertion into an unused directive.
      const literalTarget = { session: SESSION_A, socket: SOCKET_A };
      // @ts-expect-error a target cannot be built from an object literal
      const _literal: TmuxTarget = literalTarget;
      const plainManifest = {
        runId: "run-b",
        session: "run-b",
        socket: "/tmp/b.sock",
      };
      // @ts-expect-error a plain manifest-shaped object is not a ManifestHandle
      targetFromManifest(plainManifest);
    };
    expect(typeof neverCalled).toBe("function");
  });
});

// --- verify 3: unknown targeting and pane subordination ----------------------

describe("unknown targeting and pane subordination (verify 3)", () => {
  test("a legacy manifest with no socket yields no target, never a partial one", () => {
    const legacy = handleFor({ socket: undefined });
    expect(targetFromManifest(legacy)).toBeUndefined();
    expect(manifestSocketState(legacy)).toBe("missing");
  });

  test("an invalid socket is unknown targeting, never a coerced value", () => {
    const invalid = handleFor({ socket: "relative/a.sock" });
    expect(targetFromManifest(invalid)).toBeUndefined();
    expect(manifestSocketState(invalid)).toBe("invalid");
  });

  test("a camel/snake conflict is explicit unknown targeting, not a coerced pick", () => {
    const conflicting = handleFor({ socketConflict: true });
    expect(targetFromManifest(conflicting)).toBeUndefined();
    expect(manifestSocketState(conflicting)).toBe("conflicting");
  });

  test("manifestHasTarget agrees with whether a target can be built", () => {
    expect(manifestHasTarget(handleFor())).toBe(true);
    expect(manifestHasTarget(handleFor({ socket: undefined }))).toBe(false);
    expect(manifestHasTarget(handleFor({ session: undefined }))).toBe(false);
    expect(manifestHasTarget(handleFor({ socketConflict: true }))).toBe(false);
  });

  test("a valid socket with no session yields no target and reads unknown", () => {
    const noSession = handleFor({ session: undefined });
    expect(targetFromManifest(noSession)).toBeUndefined();
    expect(manifestSocketState(noSession)).toBe("unknown");
  });

  test("paneTargetFromManifest yields nothing when the socket is unknown", () => {
    expect(
      paneTargetFromManifest(handleFor({ socket: undefined }), "tmuxPaneLeft")
    ).toBeUndefined();
    expect(
      paneTargetFromManifest(handleFor({ session: undefined }), "tmuxPaneLeft")
    ).toBeUndefined();
  });

  test("recon panes are addressed by index and stay bound to the owning handle", () => {
    const handle = handleFor();
    const first = paneTargetFromManifest(handle, "tmuxPaneRecon", 0);
    const second = paneTargetFromManifest(handle, "tmuxPaneRecon", 1);
    expect(paneArgv(first as never, "capture-pane", ["-p"])).toEqual([
      "tmux",
      "-S",
      SOCKET_A,
      "capture-pane",
      "-t",
      "%7",
      "-p",
    ]);
    expect(paneArgv(second as never, "kill-pane")).toEqual([
      "tmux",
      "-S",
      SOCKET_A,
      "kill-pane",
      "-t",
      "%8",
    ]);
  });

  test("the array pane field fails closed without an index", () => {
    // Defaulting to 0 would silently address the first pane whenever a caller
    // forgot which pane it meant.
    expect(
      paneTargetFromManifest(handleFor(), "tmuxPaneRecon")
    ).toBeUndefined();
  });

  test("a scalar pane field fails closed when an index is supplied", () => {
    // An index means the caller believes the field is an array, so honouring
    // it would act on a pane the caller did not identify.
    expect(
      paneTargetFromManifest(handleFor(), "tmuxPaneLeft", 0)
    ).toBeUndefined();
  });

  test("negative, fractional, and out-of-range indices all fail closed", () => {
    const handle = handleFor();
    for (const index of [
      -1,
      0.5,
      1.5,
      2,
      99,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(
        paneTargetFromManifest(handle, "tmuxPaneRecon", index)
      ).toBeUndefined();
    }
  });

  test("a pane target carries its owning handle's socket, not a supplied one", () => {
    const pane = paneTargetFromManifest(handleFor(), "tmuxPaneLeft");
    expect(pane).toBeDefined();
    expect(paneArgv(pane as never, "kill-pane")).toEqual([
      "tmux",
      "-S",
      SOCKET_A,
      "kill-pane",
      "-t",
      "%1",
    ]);
  });

  test("a session-creating command supplies -s rather than -t", () => {
    const target = targetFromManifest(handleFor()) as never;
    expect(
      targetArgv(target, "new-session", ["-d"], { sessionFlag: "-s" })
    ).toEqual(["tmux", "-S", SOCKET_A, "new-session", "-s", SESSION_A, "-d"]);
  });

  test("a caller-supplied target flag is rejected, plain and =-joined", () => {
    const target = targetFromManifest(handleFor()) as never;
    for (const args of [
      ["-t", "other"],
      ["-S", "/tmp/b.sock"],
      ["-s", "other"],
    ]) {
      expect(() => targetArgv(target, "has-session", args)).toThrow(
        TmuxTargetProvenanceError
      );
    }
    expect(() => targetArgv(target, "has-session", ["-t=other"])).toThrow(
      TmuxTargetProvenanceError
    );
  });

  test("splitting into Node spawn form does not drop -S", () => {
    const target = targetFromManifest(handleFor()) as never;
    const { args, command } = spawnParts(targetArgv(target, "has-session"));
    expect(command).toBe("tmux");
    expect(args[0]).toBe("-S");
    expect(args[1]).toBe(SOCKET_A);
  });
});

// --- verify 12: attach hints -------------------------------------------------

describe("attach hints (verify 12)", () => {
  test("socket and session round trip as data through the hint", () => {
    const hostile = createManifestHandle({
      manifestPath: "/tmp/ls-h/manifest.json",
      manifestSha256: "c".repeat(64),
      platform: "darwin",
      runId: "run-h",
      session: "sess; rm -rf /",
      socket: "/tmp/ls h/a b.sock",
    });
    const hint = tmuxAttachCommand(targetFromManifest(hostile) as never);
    expect(hint).toBe(
      "tmux -S '/tmp/ls h/a b.sock' attach -t 'sess; rm -rf /'"
    );
  });

  test("a single quote in the socket path is escaped, not terminated", () => {
    const quoted = createManifestHandle({
      manifestPath: "/tmp/m.json",
      manifestSha256: "d".repeat(64),
      platform: "darwin",
      runId: "run-q",
      session: "s",
      socket: "/tmp/it's.sock",
    });
    expect(tmuxAttachCommand(targetFromManifest(quoted) as never)).toContain(
      `'/tmp/it'\\''s.sock'`
    );
  });

  test("a legacy row has an explicit unknown-socket line and no command", () => {
    expect(TMUX_UNKNOWN_SOCKET_HINT).toContain("unknown");
    expect(TMUX_UNKNOWN_SOCKET_HINT).not.toContain("tmux -S");
  });
});

// --- verify 8: skip records --------------------------------------------------

describe("skip records (verify 8)", () => {
  test("a record carries every field a consumer must name", () => {
    const sink = createTmuxSkipSink();
    sink.record({
      consumer: "claude-config-gc",
      effectSkipped: "remove-claude-config-registration",
      pane: null,
      reason: "manifest has no usable socket",
      runId: "run-a",
      session: null,
      socketState: "missing",
    });
    expect(sink.records).toHaveLength(1);
    const [record] = sink.records;
    expect(record?.consumer).toBe("claude-config-gc");
    expect(record?.socketState).toBe("missing");
    // effectSkipped must name the concrete effect, not merely say "skipped".
    expect(record?.effectSkipped).toBe("remove-claude-config-registration");
    // Explicit absence, so a caller cannot satisfy the shape by omission.
    expect(record?.session).toBeNull();
    expect(record?.pane).toBeNull();
  });
});

// --- launch window, pre-manifest (ruling 5a7e6cd3) ---------------------------

describe("launch-window composers", () => {
  const socket = requireTmuxSocket("/tmp/ls-a/a.sock", "darwin");

  test("session creation names the socket and supplies -s itself", () => {
    expect(launchSessionArgv(socket, "repo-loop-1", ["-d"])).toEqual([
      "tmux",
      "-S",
      "/tmp/ls-a/a.sock",
      "new-session",
      "-s",
      "repo-loop-1",
      "-d",
    ]);
  });

  test("the pre-session probe addresses the same server", () => {
    // A `has-session` on the ambient socket could answer about a different
    // server than the one the session is about to be created on.
    expect(launchServerArgv(socket, "has-session", "repo-loop-1")).toEqual([
      "tmux",
      "-S",
      "/tmp/ls-a/a.sock",
      "has-session",
      "-t",
      "repo-loop-1",
    ]);
  });

  test("caller-supplied target flags are rejected, as in the target-bound trio", () => {
    for (const args of [
      ["-S", "/tmp/b.sock"],
      ["-s", "other"],
      ["-t", "other"],
    ]) {
      expect(() => launchSessionArgv(socket, "repo-loop-1", args)).toThrow(
        TmuxTargetProvenanceError
      );
    }
    expect(() =>
      launchSessionArgv(socket, "repo-loop-1", ["-s=other"])
    ).toThrow(TmuxTargetProvenanceError);
  });

  test("the hint is built from the same socket the session was created on", () => {
    // Acceptance criterion 1: one resolved value, two consumers. Deriving the
    // hint separately would let the two diverge under changed ambient state.
    const argv = launchSessionArgv(socket, "repo-loop-1", ["-d"]);
    const hint = launchAttachCommand(socket, "repo-loop-1");
    expect(hint).toBe("tmux -S '/tmp/ls-a/a.sock' attach -t 'repo-loop-1'");
    expect(hint).toContain(String(argv[2]));
  });

  test("socket and session round trip as data through the hint", () => {
    const hostile = requireTmuxSocket("/tmp/ls h/a b.sock", "darwin");
    expect(launchAttachCommand(hostile, "sess; rm -rf /")).toBe(
      "tmux -S '/tmp/ls h/a b.sock' attach -t 'sess; rm -rf /'"
    );
  });

  test("the launch window does not mint a TmuxTarget (verify 5a preserved)", () => {
    // Acceptance criterion for A1's rejection: targetFromManifest stays the
    // sole post-launch TmuxTarget producer. The launch composers return argv
    // and strings only — they hand back nothing a consumer could carry forward
    // as a target.
    const exported = Object.keys(tmuxSocketModule);
    expect(exported).toContain("launchSessionArgv");
    expect(exported).toContain("launchAttachCommand");
    expect(Array.isArray(launchSessionArgv(socket, "s"))).toBe(true);
    expect(typeof launchAttachCommand(socket, "s")).toBe("string");
  });

  test("launch-only composers stay confined to named pre-manifest call sites", () => {
    const repoRoot = join(import.meta.dir, "..", "..", "..");
    const srcRoot = join(import.meta.dir, "..", "..", "src");
    const composerNames = [
      "launchAttachCommand",
      "launchServerArgv",
      "launchSessionArgv",
    ] as const;
    const collectTsFiles = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const entryPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          return collectTsFiles(entryPath);
        }
        return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
      });
    const importers = collectTsFiles(srcRoot)
      .filter((filePath) => !filePath.endsWith("tmux-socket.ts"))
      .filter((filePath) => {
        const source = readFileSync(filePath, "utf8");
        return composerNames.some((composer) => source.includes(composer));
      })
      .map((filePath) => relative(repoRoot, filePath).replaceAll("\\", "/"));
    expect(importers).toEqual(["loop-fork/src/loop/tmux.ts"]);

    const tmuxSource = readFileSync(join(srcRoot, "loop", "tmux.ts"), "utf8");
    const requestedStart = tmuxSource.indexOf("const startRequestedSession");
    const autoStart = tmuxSource.indexOf("const startAutoSession");
    const defaultsStart = tmuxSource.indexOf("const defaultDeps");
    const runStart = tmuxSource.indexOf("export const runInTmux");
    const internalsStart = tmuxSource.indexOf("export const tmuxInternals");
    const occurrences = (name: string): number =>
      tmuxSource.match(new RegExp(`\\b${name}\\b`, "g"))?.length ?? 0;
    const serverCalls = tmuxSource.match(/launchServerArgv\(/g) ?? [];
    const qualifiedServerCalls =
      tmuxSource.match(/launchServerArgv\(\s*launchSocket\b/g) ?? [];

    expect(
      tmuxSource.slice(requestedStart, autoStart).match(/launchServerArgv\(/g)
    ).toHaveLength(1);
    expect(
      tmuxSource.slice(requestedStart, autoStart).match(/launchSessionArgv\(/g)
    ).toHaveLength(1);
    expect(
      tmuxSource.slice(autoStart, defaultsStart).match(/launchSessionArgv\(/g)
    ).toHaveLength(1);
    expect(
      tmuxSource.slice(runStart, internalsStart).match(/launchAttachCommand\(/g)
    ).toHaveLength(1);
    expect(qualifiedServerCalls).toHaveLength(serverCalls.length);
    expect(occurrences("launchServerArgv")).toBe(5);
    expect(occurrences("launchSessionArgv")).toBe(3);
    expect(occurrences("launchAttachCommand")).toBe(2);
  });
});
