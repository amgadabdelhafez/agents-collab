import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AGENTS,
  defaultPeerAgent,
  isAgent,
  isHistoricalAgent,
  isRetiredAgent,
  RETIRED_AGENTS,
} from "../../src/loop/agents";
import { parseArgs } from "../../src/loop/args";
import { BRIDGE_SERVER } from "../../src/loop/bridge-constants";
import {
  DEFAULT_OSS_MODEL,
  REVIEW_FAIL,
  REVIEW_PASS,
} from "../../src/loop/constants";
import { resolveGovernessConfig } from "../../src/loop/governess";
import {
  buildOssRunArgs,
  buildOssRunConfig,
  ensureOssConfig,
  OSS_CONFIG_DIR_ENV,
  OSS_CONFIG_FILE_NAME,
  ossConfigEnv,
  ossConfigFilePath,
  ossSessionTitle,
  parseOssSessionId,
  parseOssSessionListing,
  resolveOssCredentialEnv,
  resolveOssSessionId,
} from "../../src/loop/oss-adapter";
import { applyPairedOptions } from "../../src/loop/paired-options";
import { createRunReview } from "../../src/loop/review";
import {
  ADVISORY_REVIEWER_NOTE,
  RELEASE_AUTHORITY_ENV,
  resolveReleaseAuthorityPolicy,
  reviewerHasReleaseAuthority,
} from "../../src/loop/review-authority";
import {
  createRunManifest,
  readRunManifest,
  resolveRunStorage,
  writeRunManifest,
} from "../../src/loop/run-state";
import type { Agent, Options, RunResult } from "../../src/loop/types";

const LAUNCH_ARGV = ["/usr/local/bin/loop"];

const makeTempDir = (label: string): string =>
  mkdtempSync(join(tmpdir(), `loop-oss-${label}-`));

const makeOptions = (overrides: Partial<Options> = {}): Options =>
  ({
    agent: "claude",
    cavemanMode: "off",
    cavemanModeSource: "default",
    codexModel: "codex-test",
    doneSignal: "<done/>",
    format: "raw",
    governessCooldownSeconds: 1,
    governessHeight: "40%",
    governessIdleSeconds: 1,
    governessMaxRecoveries: 1,
    governessModel: "governess-test",
    governessUrl: "http://127.0.0.1:8082",
    helperCavemanMode: "off",
    helperCavemanModeSource: "default",
    maxIterations: 1,
    ossModel: DEFAULT_OSS_MODEL,
    proof: "verify",
    ...overrides,
  }) as Options;

const makeRunResult = (parsed: string): RunResult => ({
  combined: parsed,
  exitCode: 0,
  parsed,
});

// --- Topology ---------------------------------------------------------------

test("the launchable topology is exactly claude, codex, and oss", () => {
  expect([...AGENTS]).toEqual(["claude", "codex", "oss"]);
  expect([...RETIRED_AGENTS]).toEqual(["gemini", "cursor", "copilot"]);
  for (const retired of RETIRED_AGENTS) {
    expect(isAgent(retired)).toBe(false);
    expect(isRetiredAgent(retired)).toBe(true);
    // Still parseable so historical manifests stay inspectable and reapable.
    expect(isHistoricalAgent(retired)).toBe(true);
  }
});

test("every ordered distinct Claude/Codex/OSS pairing parses in either order", () => {
  const ordered: [Agent, Agent][] = [];
  for (const agent of AGENTS) {
    for (const peer of AGENTS) {
      if (agent !== peer) {
        ordered.push([agent, peer]);
      }
    }
  }
  expect(ordered).toHaveLength(6);

  for (const [agent, peer] of ordered) {
    const opts = parseArgs([
      "--agent",
      agent,
      "--pair-with",
      peer,
      "--proof",
      "verify",
    ]);
    expect(opts.agent).toBe(agent);
    expect(opts.pairWith).toBe(peer);
    expect(opts.pairedMode).toBe(true);
  }
});

test("every launchable agent has a launchable default peer", () => {
  for (const agent of AGENTS) {
    const peer = defaultPeerAgent(agent);
    expect(peer).not.toBe(agent);
    expect(isAgent(peer)).toBe(true);
  }
});

// --- Retired seats fail closed ---------------------------------------------

test("retired agents are rejected for agent, pair, review, and plan review", () => {
  for (const retired of RETIRED_AGENTS) {
    for (const flag of ["--agent", "--pair-with", "--reviewer", "--review"]) {
      expect(() => parseArgs([flag, retired, "--proof", "verify"])).toThrow(
        `Agent "${retired}" is retired`
      );
    }
    expect(() =>
      parseArgs(["--review-plan", retired, "--proof", "verify"])
    ).toThrow(`Agent "${retired}" is retired`);
  }
});

test("retired only-mode and model flags fail closed naming oss", () => {
  const retiredFlags = [
    "--gemini-only",
    "--cursor-only",
    "--copilot-only",
    "--gemini-model",
    "--gemini-reviewer-model",
    "--cursor-model",
    "--cursor-reviewer-model",
    "--copilot-model",
    "--copilot-reviewer-model",
  ];
  for (const flag of retiredFlags) {
    expect(() => parseArgs([flag, "x", "--proof", "verify"])).toThrow(
      `${flag} is retired`
    );
    // The `=` form must fail the same way rather than falling through to
    // "Unknown argument", which would read as a typo instead of a migration.
    expect(() => parseArgs([`${flag}=x`, "--proof", "verify"])).toThrow(
      `${flag} is retired`
    );
  }
});

test("a manifest naming a retired seat stays readable but cannot relaunch", () => {
  const root = makeTempDir("retired-manifest");
  const home = join(root, "home");
  const cwd = join(root, "repo");
  mkdirSync(cwd, { recursive: true });
  const storage = resolveRunStorage("77", cwd, home);
  mkdirSync(dirname(storage.manifestPath), { recursive: true });
  writeRunManifest(
    storage.manifestPath,
    createRunManifest({
      cwd,
      mode: "paired",
      pid: 4321,
      primaryAgent: "gemini",
      repoId: storage.repoId,
      runId: "77",
      status: "running",
      tmuxPaneLeft: "repo-loop-77:0.0",
      tmuxPaneLeftAgent: "gemini",
      tmuxPaneRight: "repo-loop-77:0.1",
      tmuxPaneRightAgent: "codex",
      tmuxSession: "repo-loop-77",
    })
  );

  try {
    // Inspection and reaping still work: the retired identity survives parsing.
    const manifest = readRunManifest(storage.manifestPath);
    expect(manifest?.tmuxPaneLeftAgent).toBe("gemini");
    expect(manifest?.primaryAgent).toBe("gemini");
    expect(manifest?.tmuxSession).toBe("repo-loop-77");

    // Relaunch fails during option preparation, before any pane or process.
    expect(() =>
      applyPairedOptions(
        makeOptions({ tmux: true }),
        storage,
        manifest,
        false,
        cwd,
        true
      )
    ).toThrow('Agent "gemini" is retired');
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

// --- Model pass-through -----------------------------------------------------

test("GLM-5.2 is the default OSS profile, not a hard-coded dependency", () => {
  expect(DEFAULT_OSS_MODEL).toBe("openrouter/z-ai/glm-5.2");
  expect(parseArgs(["--proof", "verify"]).ossModel).toBe(DEFAULT_OSS_MODEL);

  const overridden = parseArgs([
    "--oss-model",
    "ollama/qwen3-coder:480b",
    "--proof",
    "verify",
  ]);
  expect(overridden.ossModel).toBe("ollama/qwen3-coder:480b");
});

test("any non-empty provider/model identifier reaches OpenCode unrewritten", () => {
  const identifiers = [
    "openrouter/z-ai/glm-5.2",
    "ollama/qwen3-coder:480b",
    "anthropic/claude-opus-5",
    "self-hosted.vllm/Org_Name/Model-v2.1:awq@2026-01",
    "a/b",
  ];
  for (const model of identifiers) {
    const args = buildOssRunArgs({ model });
    const modelIndex = args.indexOf("--model");
    expect(modelIndex).toBeGreaterThan(-1);
    expect(args[modelIndex + 1]).toBe(model);
  }
});

test("an empty OSS model is rejected rather than silently defaulted", () => {
  expect(() => parseArgs(["--oss-model=", "--proof", "verify"])).toThrow(
    "Invalid --oss-model value: cannot be empty"
  );
  expect(() =>
    parseArgs(["--oss-reviewer-model=", "--proof", "verify"])
  ).toThrow("Invalid --oss-reviewer-model value: cannot be empty");
});

// --- Run-scoped, bridge-only configuration ---------------------------------

test("generated OpenCode config is run-scoped, bridge-only, and source oss", () => {
  const root = makeTempDir("config");
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

  try {
    const configDir = ensureOssConfig(runDir, LAUNCH_ARGV);
    expect(configDir.startsWith(runDir)).toBe(true);
    expect(configDir).not.toBe(runDir);

    const path = ossConfigFilePath(runDir);
    expect(path).toBe(join(configDir, OSS_CONFIG_FILE_NAME));
    const raw = readFileSync(path, "utf8");
    const config = JSON.parse(raw);

    // Exactly one MCP server, and it is this run's bridge.
    expect(Object.keys(config.mcp)).toEqual([BRIDGE_SERVER]);
    const server = config.mcp[BRIDGE_SERVER];
    expect(server.enabled).toBe(true);
    expect(server.type).toBe("local");
    expect(server.command).toEqual([
      ...LAUNCH_ARGV,
      "__bridge-mcp",
      runDir,
      "oss",
    ]);
    // Source identity is "oss", and the run directory scopes the bridge.
    expect(server.command.at(-1)).toBe("oss");
    expect(server.command).toContain(runDir);

    // Explicit permission policy, written down rather than implied.
    expect(config.permission).toEqual({
      bash: "allow",
      edit: "allow",
      webfetch: "deny",
    });

    // The isolation lever is the run-scoped config directory itself.
    expect(ossConfigEnv(configDir)).toEqual({
      [OSS_CONFIG_DIR_ENV]: configDir,
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("the generated OpenCode config carries no credential value", () => {
  const root = makeTempDir("no-secret");
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  const secret = "sk-or-v1-regression-secret-value";
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = secret;

  try {
    ensureOssConfig(runDir, LAUNCH_ARGV);
    const raw = readFileSync(ossConfigFilePath(runDir), "utf8");
    expect(raw).not.toContain(secret);
    expect(raw.toLowerCase()).not.toContain("apikey");
    expect(raw.toLowerCase()).not.toContain("api_key");
    // The argv the seat is launched with must not carry one either.
    expect(
      buildOssRunArgs({ model: DEFAULT_OSS_MODEL, prompt: "go" }).join(" ")
    ).not.toContain(secret);
    // Config file and directory are owner-only.
    expect(statSync(ossConfigFilePath(runDir)).mode % 0o1000).toBe(0o600);
  } finally {
    process.env.OPENROUTER_API_KEY = previous;
    rmSync(root, { force: true, recursive: true });
  }
});

test("the bridge config does not depend on ambient user configuration", () => {
  const config = buildOssRunConfig("/runs/42", LAUNCH_ARGV);
  expect(Object.keys(config.mcp)).toHaveLength(1);
  expect(config.mcp[BRIDGE_SERVER].command).toContain("/runs/42");
});

test("a provider key file is only used when it is a mode-0600 regular file", () => {
  const root = makeTempDir("keyfile");
  const keyPath = join(root, "openrouter.key");

  try {
    // No file: fall back to provider-native lookup rather than inventing a key.
    expect(
      resolveOssCredentialEnv({ LOOP_OSS_API_KEY_FILE: keyPath }).source
    ).toBe("provider-native");

    writeFileSync(keyPath, "sk-or-v1-key\n", "utf8");
    // Default write mode is not 0600, so the key must be ignored.
    const loose = resolveOssCredentialEnv({ LOOP_OSS_API_KEY_FILE: keyPath });
    expect(loose.source).toBe("provider-native");
    expect(loose.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(loose.reason).toContain("mode 0600");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("an explicitly disabled key file never loads a credential", () => {
  const resolution = resolveOssCredentialEnv({ LOOP_OSS_API_KEY_FILE: "" });
  expect(resolution.source).toBe("provider-native");
  expect(resolution.env).toEqual({});
});

// --- Session persistence and resume -----------------------------------------

test("a first OSS turn takes a title and a resume takes the stored session id", () => {
  // OpenCode rejects an unknown --session id, so the first turn cannot invent
  // one; it names the session instead and persists what OpenCode reports.
  const first = buildOssRunArgs({
    model: DEFAULT_OSS_MODEL,
    prompt: "go",
    title: ossSessionTitle("42"),
  });
  expect(first).not.toContain("--session");
  expect(first[first.indexOf("--title") + 1]).toBe("loop-42");

  const resumed = buildOssRunArgs({
    model: DEFAULT_OSS_MODEL,
    prompt: "go",
    sessionId: "ses_abc123",
    title: ossSessionTitle("42"),
  });
  expect(resumed[resumed.indexOf("--session") + 1]).toBe("ses_abc123");
  expect(resumed).not.toContain("--title");
});

test("the OSS session id is recovered from either shape of JSON event", () => {
  expect(
    parseOssSessionId(
      JSON.stringify({
        properties: { info: { id: "ses_from_session_event" } },
        type: "session.created",
      })
    )
  ).toBe("ses_from_session_event");
  expect(
    parseOssSessionId(
      JSON.stringify({
        properties: { sessionID: "ses_from_message_event" },
        type: "message.updated",
      })
    )
  ).toBe("ses_from_message_event");
  expect(parseOssSessionId("not json")).toBeUndefined();
  expect(parseOssSessionId("{broken")).toBeUndefined();
  expect(parseOssSessionId(JSON.stringify({ type: "session.idle" }))).toBe(
    undefined
  );
});

test("a stored OSS session id always wins over a title lookup", () => {
  let looked = 0;
  const resolved = resolveOssSessionId(
    "ses_stored",
    "loop-42",
    () => {
      looked += 1;
      return JSON.stringify([{ id: "ses_other", title: "loop-42" }]);
    },
    {}
  );
  expect(resolved).toBe("ses_stored");
  expect(looked).toBe(0);
});

test("a missing OSS session id is recovered by run title, or left empty", () => {
  const listing = JSON.stringify([
    { id: "ses_unrelated", title: "loop-9" },
    { id: "ses_mine", title: "loop-42" },
  ]);
  expect(resolveOssSessionId(undefined, "loop-42", () => listing, {})).toBe(
    "ses_mine"
  );
  expect(parseOssSessionListing(listing, "loop-404")).toBeUndefined();
  // An unparseable or absent listing must not fabricate an id.
  expect(resolveOssSessionId(undefined, "loop-42", () => "garbage", {})).toBe(
    ""
  );
  expect(resolveOssSessionId(undefined, "loop-42", () => undefined, {})).toBe(
    ""
  );
  expect(
    resolveOssSessionId(
      undefined,
      "loop-42",
      () => JSON.stringify({ sessions: [{ id: "ses_env", title: "loop-42" }] }),
      {}
    )
  ).toBe("ses_env");
});

test("the session lookup runs against the run-scoped config directory", () => {
  let seen: NodeJS.ProcessEnv = {};
  resolveOssSessionId(
    undefined,
    "loop-42",
    (_argv, env) => {
      seen = env;
      return "[]";
    },
    { PATH: "/usr/bin" },
    "/runs/42/oss-config"
  );
  expect(seen[OSS_CONFIG_DIR_ENV]).toBe("/runs/42/oss-config");
  expect(seen.PATH).toBe("/usr/bin");
});

test("a paired manifest round-trips the OSS session id", () => {
  const root = makeTempDir("manifest");
  const home = join(root, "home");
  const cwd = join(root, "repo");
  mkdirSync(cwd, { recursive: true });
  const storage = resolveRunStorage("55", cwd, home);
  mkdirSync(dirname(storage.manifestPath), { recursive: true });

  try {
    writeRunManifest(
      storage.manifestPath,
      createRunManifest({
        cwd,
        mode: "paired",
        ossSessionId: "ses_persisted",
        pid: 1234,
        repoId: storage.repoId,
        runId: "55",
        status: "running",
      })
    );
    expect(readRunManifest(storage.manifestPath)?.ossSessionId).toBe(
      "ses_persisted"
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

// --- Bridge and governess observe the persisted pane ------------------------

test("governess observes an OSS seat through its persisted pane target", () => {
  const root = makeTempDir("governess");
  const home = join(root, "home");
  const cwd = join(root, "repo");
  mkdirSync(cwd, { recursive: true });
  const storage = resolveRunStorage("92", cwd, home);
  mkdirSync(dirname(storage.manifestPath), { recursive: true });
  writeRunManifest(
    storage.manifestPath,
    createRunManifest({
      cwd,
      mode: "paired",
      // Deliberately non-sequential panes: a numeric assumption would produce
      // 0.0 / 0.1 and silently observe the wrong panes.
      ossSessionId: "ses_governed",
      pid: 1234,
      repoId: storage.repoId,
      runId: "92",
      status: "running",
      tmuxPaneLeft: "repo-loop-92:0.4",
      tmuxPaneLeftAgent: "oss",
      tmuxPaneRight: "repo-loop-92:0.7",
      tmuxPaneRightAgent: "claude",
      tmuxSession: "repo-loop-92",
    })
  );

  try {
    const config = resolveGovernessConfig("92", {}, cwd, home);
    expect(config.agents.map(({ agent, pane }) => ({ agent, pane }))).toEqual([
      { agent: "oss", pane: "repo-loop-92:0.4" },
      { agent: "claude", pane: "repo-loop-92:0.7" },
    ]);
    const oss = config.agents.find((entry) => entry.agent === "oss");
    expect(oss?.sessionRef).toBe("ses_governed");
    expect(oss?.hookFile).toBe(join(storage.runDir, "hooks", "oss.jsonl"));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("governess skips a retired seat instead of observing it as live", () => {
  const root = makeTempDir("governess-retired");
  const home = join(root, "home");
  const cwd = join(root, "repo");
  mkdirSync(cwd, { recursive: true });
  const storage = resolveRunStorage("93", cwd, home);
  mkdirSync(dirname(storage.manifestPath), { recursive: true });
  writeRunManifest(
    storage.manifestPath,
    createRunManifest({
      cwd,
      mode: "paired",
      pid: 1234,
      repoId: storage.repoId,
      runId: "93",
      status: "running",
      tmuxPaneLeft: "repo-loop-93:0.0",
      tmuxPaneLeftAgent: "gemini",
      tmuxPaneRight: "repo-loop-93:0.1",
      tmuxPaneRightAgent: "codex",
      tmuxSession: "repo-loop-93",
    })
  );

  try {
    const config = resolveGovernessConfig("93", {}, cwd, home);
    expect(config.agents.map(({ agent }) => agent)).toEqual(["codex"]);
    expect(config.initialDriver).toBeUndefined();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

// --- Release authority ------------------------------------------------------
//
// Binding pre-launch ruling 06fa755e-e432-4239-bb9a-fe924a2989dc. The property
// under test is: an OSS reviewer APPROVE cannot open the release gate unless
// the run's governing policy explicitly grants that authority. Deleting the
// authority check in review.ts must make these fail.

test("an OSS reviewer APPROVE cannot open the release gate without a policy grant", async () => {
  const runReview = createRunReview(() =>
    Promise.resolve(makeRunResult(`looks good\n${REVIEW_PASS}`))
  );
  const result = await runReview(
    ["oss"],
    "task",
    makeOptions({ agent: "oss" })
  );

  expect(result.reviews).toEqual([
    { reason: "", reviewer: "oss", status: "pass" },
  ]);
  expect(result.failureCount).toBe(0);
  // The reviewer passed, and the gate stayed shut anyway.
  expect(result.approved).toBe(false);
  expect(result.advisoryReviewers).toEqual(["oss"]);
  expect(result.notes).toContain(ADVISORY_REVIEWER_NOTE);
});

test("an OSS reviewer APPROVE opens the release gate only under an explicit grant", async () => {
  const previous = process.env[RELEASE_AUTHORITY_ENV];
  process.env[RELEASE_AUTHORITY_ENV] = "1";
  try {
    const runReview = createRunReview(() =>
      Promise.resolve(makeRunResult(`looks good\n${REVIEW_PASS}`))
    );
    const result = await runReview(
      ["oss"],
      "task",
      makeOptions({ agent: "oss" })
    );
    expect(result.approved).toBe(true);
    expect(result.advisoryReviewers).toEqual([]);
  } finally {
    process.env[RELEASE_AUTHORITY_ENV] = previous;
  }
});

test("an advisory OSS reviewer still blocks on FAIL", async () => {
  const runReview = createRunReview(() =>
    Promise.resolve(makeRunResult(`needs work\n${REVIEW_FAIL}`))
  );
  const result = await runReview(
    ["oss"],
    "task",
    makeOptions({ agent: "oss" })
  );

  expect(result.approved).toBe(false);
  expect(result.failureCount).toBe(1);
});

test("an advisory OSS APPROVE does not open the gate even beside a native pass", async () => {
  const runReview = createRunReview(() =>
    Promise.resolve(makeRunResult(`agreed\n${REVIEW_PASS}`))
  );
  const withNative = await runReview(
    ["claude", "oss"],
    "task",
    makeOptions({ agent: "codex" })
  );
  // A native gate-holder is present, so the gate may open; the OSS reviewer is
  // still recorded as advisory rather than silently promoted.
  expect(withNative.approved).toBe(true);
  expect(withNative.advisoryReviewers).toEqual(["oss"]);

  const ossOnly = await runReview(
    ["oss"],
    "task",
    makeOptions({ agent: "oss" })
  );
  expect(ossOnly.approved).toBe(false);
});

test("release authority is a property of policy, never of seat occupancy", () => {
  const denied = resolveReleaseAuthorityPolicy({});
  const granted = resolveReleaseAuthorityPolicy({
    [RELEASE_AUTHORITY_ENV]: "1",
  });

  expect(denied.ossReleaseAuthority).toBe(false);
  expect(granted.ossReleaseAuthority).toBe(true);
  expect(reviewerHasReleaseAuthority("oss", denied)).toBe(false);
  expect(reviewerHasReleaseAuthority("oss", granted)).toBe(true);
  // Native seats are unaffected by the OSS grant in either direction.
  for (const native of ["claude", "codex"] as const) {
    expect(reviewerHasReleaseAuthority(native, denied)).toBe(true);
    expect(reviewerHasReleaseAuthority(native, granted)).toBe(true);
  }
  // Only the exact string "1" grants authority; anything truthy-looking must not.
  for (const value of ["", "0", "true", "yes", "2", " 1 x"]) {
    expect(
      resolveReleaseAuthorityPolicy({ [RELEASE_AUTHORITY_ENV]: value })
        .ossReleaseAuthority
    ).toBe(false);
  }
});
