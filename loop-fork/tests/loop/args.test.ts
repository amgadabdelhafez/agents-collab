import { afterEach, expect, test } from "bun:test";
import { findImmediateInfoRequest, parseArgs } from "../../src/loop/args";
import {
  DEFAULT_CAVEMAN_MODE,
  DEFAULT_HELPER_CAVEMAN_MODE,
} from "../../src/loop/caveman";
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_DONE_SIGNAL,
  DEFAULT_MAX_ITERATIONS,
  LOOP_VERSION,
} from "../../src/loop/constants";
import { DEFAULT_LAUNCH_EFFORT } from "../../src/loop/effort";

const ORIGINAL_LOOP_CODEX_MODEL = process.env.LOOP_CODEX_MODEL;
const ORIGINAL_LOOP_CAVEMAN_MODE = process.env.LOOP_CAVEMAN_MODE;
const ORIGINAL_LOOP_HELPER_CAVEMAN_MODE = process.env.LOOP_HELPER_CAVEMAN_MODE;
const ORIGINAL_LOOP_EFFORT = process.env.LOOP_EFFORT;
const ORIGINAL_LOOP_DRIVER_EFFORT = process.env.LOOP_DRIVER_EFFORT;
const ORIGINAL_LOOP_REVIEWER_EFFORT = process.env.LOOP_REVIEWER_EFFORT;
const originalExit = process.exit;
const originalLog = console.log;
const CONFLICT_ONLY_MODE_ERROR = "Cannot combine multiple --*-only flags.";

const clearModelEnv = (): void => {
  Reflect.deleteProperty(process.env, "LOOP_CODEX_MODEL");
};

const restoreModelEnv = (): void => {
  if (ORIGINAL_LOOP_CODEX_MODEL === undefined) {
    clearModelEnv();
    return;
  }
  process.env.LOOP_CODEX_MODEL = ORIGINAL_LOOP_CODEX_MODEL;
};

const restoreEnv = (name: string, original: string | undefined): void => {
  if (original === undefined) {
    Reflect.deleteProperty(process.env, name);
  } else {
    process.env[name] = original;
  }
};

afterEach(() => {
  restoreModelEnv();
  restoreEnv("LOOP_CAVEMAN_MODE", ORIGINAL_LOOP_CAVEMAN_MODE);
  restoreEnv("LOOP_HELPER_CAVEMAN_MODE", ORIGINAL_LOOP_HELPER_CAVEMAN_MODE);
  restoreEnv("LOOP_EFFORT", ORIGINAL_LOOP_EFFORT);
  restoreEnv("LOOP_DRIVER_EFFORT", ORIGINAL_LOOP_DRIVER_EFFORT);
  restoreEnv("LOOP_REVIEWER_EFFORT", ORIGINAL_LOOP_REVIEWER_EFFORT);
  process.exit = originalExit;
  console.log = originalLog;
});

test("parseArgs prints version and exits when --version is passed", () => {
  let code: number | undefined;
  console.log = ((_: string) => {
    expect(_).toBe(`loop v${LOOP_VERSION}`);
  }) as typeof console.log;
  process.exit = ((exitCode?: number): never => {
    code = exitCode;
    throw new Error("exit");
  }) as typeof process.exit;

  expect(() => {
    parseArgs(["--version"]);
  }).toThrow("exit");

  expect(code).toBe(0);
});

test("parseArgs prints version and exits when -v is passed", () => {
  let code: number | undefined;
  console.log = ((_: string) => {
    expect(_).toBe(`loop v${LOOP_VERSION}`);
  }) as typeof console.log;
  process.exit = ((exitCode?: number): never => {
    code = exitCode;
    throw new Error("exit");
  }) as typeof process.exit;

  expect(() => {
    parseArgs(["-v"]);
  }).toThrow("exit");

  expect(code).toBe(0);
});

test.each([
  [["--help"], "help"],
  [["collab", "-h"], "help"],
  [["dashboard", "--help"], "help"],
  [["update", "--version"], "version"],
  [["governess", "doctor", "42", "-v"], "version"],
  [["--review", "--help"], "help"],
  [["--review-plan", "--version"], "version"],
] as const)("findImmediateInfoRequest recognizes active information argv %j", (argv, expected) => {
  expect(findImmediateInfoRequest([...argv])).toBe(expected);
});

test.each([
  ["spaced prompt value", ["--prompt", "--help"]],
  ["spaced proof value", ["--proof", "--version"]],
  ["positional delimiter", ["collab", "--", "--help"]],
  ["strict model value error", ["--codex-model", "--help"]],
  ["strict run-id value error", ["--run-id", "--version"]],
  ["unknown option first", ["--unknown", "--help"]],
] as const)("findImmediateInfoRequest preserves %s semantics", (_label, argv) => {
  expect(findImmediateInfoRequest([...argv])).toBeUndefined();
});

test("findImmediateInfoRequest is independent of invalid ambient config", () => {
  process.env.LOOP_CAVEMAN_MODE = "banana";
  process.env.LOOP_HELPER_CAVEMAN_MODE = "invalid";

  expect(findImmediateInfoRequest(["collab", "--help"])).toBe("help");
  expect(findImmediateInfoRequest(["upgrade", "--version"])).toBe("version");
});

test("parseArgs returns expected defaults when proof is omitted", () => {
  clearModelEnv();
  Reflect.deleteProperty(process.env, "LOOP_CAVEMAN_MODE");
  Reflect.deleteProperty(process.env, "LOOP_HELPER_CAVEMAN_MODE");
  Reflect.deleteProperty(process.env, "LOOP_EFFORT");
  Reflect.deleteProperty(process.env, "LOOP_DRIVER_EFFORT");
  Reflect.deleteProperty(process.env, "LOOP_REVIEWER_EFFORT");
  const opts = parseArgs([]);

  expect(opts.agent).toBe("claude");
  expect(opts.pairWith).toBe("codex");
  expect(opts.doneSignal).toBe(DEFAULT_DONE_SIGNAL);
  expect(opts.proof).toBe("");
  expect(opts.format).toBe("pretty");
  expect(opts.maxIterations).toBe(DEFAULT_MAX_ITERATIONS);
  expect(opts.codexModel).toBe(DEFAULT_CODEX_MODEL);
  expect(opts.governess).toBe(true);
  expect(opts.cavemanMode).toBe(DEFAULT_CAVEMAN_MODE);
  expect(opts.helperCavemanMode).toBe(DEFAULT_HELPER_CAVEMAN_MODE);
  expect(opts.driverEffort).toBe(DEFAULT_LAUNCH_EFFORT);
  expect(opts.driverEffortSource).toBe("default");
  expect(opts.reviewerEffort).toBe(DEFAULT_LAUNCH_EFFORT);
  expect(opts.reviewerEffortSource).toBe("default");
  expect(opts.promptInput).toBeUndefined();
  expect(opts.review).toBe("claudex");
  expect(opts.reviewPlan).toBeUndefined();
  expect(opts.resumeRunId).toBeUndefined();
  expect(opts.tmux).toBe(false);
  expect(opts.worktree).toBe(false);
});

test("parseArgs resolves global and per-role effort with order-independent CLI precedence", () => {
  process.env.LOOP_EFFORT = "low";
  process.env.LOOP_DRIVER_EFFORT = "high";
  process.env.LOOP_REVIEWER_EFFORT = "xhigh";

  const roleThenGlobal = parseArgs([
    "--effort-driver",
    "medium",
    "--effort=max",
  ]);
  expect(roleThenGlobal).toMatchObject({
    driverEffort: "medium",
    driverEffortSource: "cli-role",
    reviewerEffort: "max",
    reviewerEffortSource: "cli-global",
  });

  const globalThenRole = parseArgs([
    "--effort",
    "low",
    "--effort-reviewer=high",
  ]);
  expect(globalThenRole).toMatchObject({
    driverEffort: "low",
    driverEffortSource: "cli-global",
    reviewerEffort: "high",
    reviewerEffortSource: "cli-role",
  });
});

test("parseArgs resolves role environment effort above the global fallback", () => {
  process.env.LOOP_EFFORT = "low";
  process.env.LOOP_DRIVER_EFFORT = "medium";
  process.env.LOOP_REVIEWER_EFFORT = "high";

  expect(parseArgs([])).toMatchObject({
    driverEffort: "medium",
    driverEffortSource: "env-role",
    reviewerEffort: "high",
    reviewerEffortSource: "env-role",
  });
});

test("parseArgs rejects malformed CLI and environment effort", () => {
  expect(() => parseArgs(["--effort-driver", "ultra"])).toThrow(
    "Invalid --effort-driver value: ultra"
  );
  expect(() => parseArgs(["--effort-reviewer="])).toThrow(
    "Invalid --effort-reviewer value"
  );
  expect(() => parseArgs(["--effort"])).toThrow("Missing value for --effort");

  process.env.LOOP_REVIEWER_EFFORT = "banana";
  expect(() => parseArgs([])).toThrow(
    "Invalid LOOP_REVIEWER_EFFORT value: banana"
  );
});

test("parseArgs accepts Caveman CLI and environment modes", () => {
  process.env.LOOP_CAVEMAN_MODE = "full";
  process.env.LOOP_HELPER_CAVEMAN_MODE = "lite";
  const fromEnv = parseArgs([]);
  expect(fromEnv).toMatchObject({
    cavemanMode: "full",
    cavemanModeSource: "env",
    helperCavemanMode: "lite",
    helperCavemanModeSource: "env",
  });

  const fromCli = parseArgs(["--caveman=ultra", "--helper-caveman", "off"]);
  expect(fromCli).toMatchObject({
    cavemanMode: "ultra",
    cavemanModeSource: "cli",
    helperCavemanMode: "off",
    helperCavemanModeSource: "cli",
  });
});

test("parseArgs rejects invalid Caveman modes before launch", () => {
  expect(() => parseArgs(["--caveman", "banana"])).toThrow(
    "Invalid --caveman value: banana; expected off, lite, full, or ultra"
  );
  expect(() => parseArgs(["--helper-caveman=wenyan-full"])).toThrow(
    "Invalid --helper-caveman value: wenyan-full"
  );
});

test("parseArgs uses LOOP_CODEX_MODEL when present", () => {
  process.env.LOOP_CODEX_MODEL = "test-model";
  const opts = parseArgs(["--proof", "verify with tests"]);

  expect(opts.codexModel).toBe("test-model");
});

test("parseArgs uses --codex-model when provided", () => {
  const opts = parseArgs([
    "--codex-model",
    "custom-model",
    "--proof",
    "verify",
  ]);

  expect(opts.codexModel).toBe("custom-model");
});

test("parseArgs with --codex-model= overrides LOOP_CODEX_MODEL", () => {
  process.env.LOOP_CODEX_MODEL = "env-model";
  const opts = parseArgs(["--codex-model=flag-model", "--proof", "verify"]);

  expect(opts.codexModel).toBe("flag-model");
});

test("parseArgs handles all value flags and explicit reviewer", () => {
  const opts = parseArgs([
    "--agent",
    "claude",
    "--prompt",
    "PLAN.md",
    "--max-iterations",
    "3",
    "--done",
    "<done/>",
    "--run-id",
    "17",
    "--proof",
    "verify this",
    "--format",
    "pretty",
    "--review=claudex",
    "--codex-model",
    "custom-model",
    "--codex-reviewer-model",
    "codex-review",
    "--claude-reviewer-model",
    "claude-review",
  ]);

  expect(opts.agent).toBe("claude");
  expect(opts.promptInput).toBe("PLAN.md");
  expect(opts.maxIterations).toBe(3);
  expect(opts.doneSignal).toBe("<done/>");
  expect(opts.resumeRunId).toBe("17");
  expect(opts.proof).toBe("verify this");
  expect(opts.format).toBe("pretty");
  expect(opts.review).toBe("claudex");
  expect(opts.codexModel).toBe("custom-model");
  expect(opts.codexReviewerModel).toBe("codex-review");
  expect(opts.claudeReviewerModel).toBe("claude-review");
});

test("parseArgs rejects invalid --review values in only-mode", () => {
  expect(() =>
    parseArgs(["--claude-only", "--review", "banana", "--proof", "x"])
  ).toThrow("Invalid --review value: banana");
  expect(() =>
    parseArgs(["--codex-only", "--review=banana", "--proof", "x"])
  ).toThrow("Invalid --review value: banana");
});

test("parseArgs uses reviewer after --review when valid", () => {
  const opts = parseArgs(["--review", "claude", "--proof", "verify"]);

  expect(opts.review).toBe("claude");
});

test("parseArgs uses --reviewer as paired peer without changing completion review", () => {
  const opts = parseArgs([
    "--agent",
    "claude",
    "--reviewer",
    "gemini",
    "--proof",
    "verify",
  ]);

  expect(opts.agent).toBe("claude");
  expect(opts.pairWith).toBe("gemini");
  expect(opts.review).toBe("claudex");
});

test("parseArgs treats bare --review-plan as other when no reviewer follows", () => {
  const opts = parseArgs(["--review-plan", "ship it", "--proof", "verify"]);

  expect(opts.reviewPlan).toBe("other");
  expect(opts.promptInput).toBe("ship it");
});

test("parseArgs uses reviewer after --review-plan when valid", () => {
  const opts = parseArgs(["--review-plan", "claude", "--proof", "verify"]);

  expect(opts.reviewPlan).toBe("claude");
});

test("parseArgs accepts none after --review-plan", () => {
  const opts = parseArgs(["--review-plan", "none", "--proof", "verify"]);

  expect(opts.reviewPlan).toBe("none");
});

test("parseArgs supports equals form for --review-plan", () => {
  const opts = parseArgs(["--review-plan=codex", "--proof", "verify"]);

  expect(opts.reviewPlan).toBe("codex");
});

test("parseArgs supports equals form for --review-plan=none", () => {
  const opts = parseArgs(["--review-plan=none", "--proof", "verify"]);

  expect(opts.reviewPlan).toBe("none");
});

test("parseArgs supports run id resume flags", () => {
  const spaced = parseArgs(["--run-id", "19", "--proof", "verify"]);
  const equals = parseArgs(["--run-id=21", "--proof", "verify"]);

  expect(spaced.resumeRunId).toBe("19");
  expect(equals.resumeRunId).toBe("21");
});

test("parseArgs keeps run id resume separate from agent session resume", () => {
  const opts = parseArgs([
    "--run-id",
    "31",
    "--session",
    "claude-session",
    "--proof",
    "verify",
  ]);

  expect(opts.resumeRunId).toBe("31");
  expect(opts.sessionId).toBe("claude-session");
});

test("parseArgs sets agent/review/reviewPlan to claude with --claude-only", () => {
  const opts = parseArgs(["--claude-only", "--proof", "verify"]);

  expect(opts.agent).toBe("claude");
  expect(opts.review).toBe("claude");
  expect(opts.reviewPlan).toBe("claude");
});

test("parseArgs sets agent/review/reviewPlan to codex with --codex-only", () => {
  const opts = parseArgs(["--codex-only", "--proof", "verify"]);

  expect(opts.agent).toBe("codex");
  expect(opts.review).toBe("codex");
  expect(opts.reviewPlan).toBe("codex");
});

test("parseArgs throws on conflicting --claude-only and --codex-only", () => {
  expect(() => parseArgs(["--claude-only", "--codex-only"])).toThrow(
    CONFLICT_ONLY_MODE_ERROR
  );
  expect(() => parseArgs(["--codex-only", "--claude-only"])).toThrow(
    CONFLICT_ONLY_MODE_ERROR
  );
});

test("parseArgs keeps only-mode authoritative while honoring --review-plan none", () => {
  const opts = parseArgs([
    "--codex-only",
    "--agent",
    "claude",
    "--review",
    "claude",
    "--review-plan",
    "other",
    "--review-plan",
    "none",
    "--proof",
    "x",
  ]);

  expect(opts.agent).toBe("codex");
  expect(opts.review).toBe("codex");
  expect(opts.reviewPlan).toBe("none");
});

test("parseArgs preserves explicit --review-plan none when only-mode comes later", () => {
  const opts = parseArgs([
    "--review-plan=none",
    "--codex-only",
    "--proof",
    "x",
  ]);

  expect(opts.agent).toBe("codex");
  expect(opts.review).toBe("codex");
  expect(opts.reviewPlan).toBe("none");
});

test("parseArgs ignores later --agent after only-mode", () => {
  const opts = parseArgs(["--codex-only", "--agent", "claude", "--proof", "x"]);

  expect(opts.agent).toBe("codex");
  expect(opts.review).toBe("codex");
  expect(opts.reviewPlan).toBe("codex");
});

test("parseArgs accepts --codex-only with both --codex-model flag forms", () => {
  const spaced = parseArgs([
    "--codex-only",
    "--codex-model",
    "custom-spaced",
    "--proof",
    "verify",
  ]);
  const equals = parseArgs([
    "--codex-only",
    "--codex-model=custom-equals",
    "--proof",
    "verify",
  ]);

  expect(spaced.agent).toBe("codex");
  expect(spaced.review).toBe("codex");
  expect(spaced.reviewPlan).toBe("codex");
  expect(spaced.codexModel).toBe("custom-spaced");
  expect(equals.agent).toBe("codex");
  expect(equals.review).toBe("codex");
  expect(equals.reviewPlan).toBe("codex");
  expect(equals.codexModel).toBe("custom-equals");
});

test("parseArgs accepts both reviewer-model flag forms", () => {
  const spaced = parseArgs([
    "--codex-reviewer-model",
    "codex-review",
    "--claude-reviewer-model",
    "claude-review",
    "--proof",
    "verify",
  ]);
  const equals = parseArgs([
    "--codex-reviewer-model=codex-equals",
    "--claude-reviewer-model=claude-equals",
    "--proof",
    "verify",
  ]);

  expect(spaced.codexReviewerModel).toBe("codex-review");
  expect(spaced.claudeReviewerModel).toBe("claude-review");
  expect(equals.codexReviewerModel).toBe("codex-equals");
  expect(equals.claudeReviewerModel).toBe("claude-equals");
});

test("parseArgs rejects empty reviewer model values", () => {
  expect(() =>
    parseArgs(["--codex-reviewer-model", "   ", "--proof", "verify"])
  ).toThrow("Invalid --codex-reviewer-model value: cannot be empty");
  expect(() =>
    parseArgs(["--claude-reviewer-model=", "--proof", "verify"])
  ).toThrow("Invalid --claude-reviewer-model value: cannot be empty");
});

test("parseArgs rejects missing model values when another flag follows", () => {
  expect(() => parseArgs(["--codex-model", "--proof", "verify"])).toThrow(
    "Missing value for --codex-model"
  );
  expect(() =>
    parseArgs(["--codex-reviewer-model", "--proof", "verify"])
  ).toThrow("Missing value for --codex-reviewer-model");
  expect(() =>
    parseArgs(["--claude-reviewer-model", "--proof", "verify"])
  ).toThrow("Missing value for --claude-reviewer-model");
});

test("parseArgs rejects invalid --review-plan value", () => {
  expect(() =>
    parseArgs(["--review-plan=claudex", "--proof", "verify"])
  ).toThrow("Invalid --review-plan value: claudex");
});

test("parseArgs enables tmux mode with --tmux", () => {
  const opts = parseArgs(["--tmux", "--proof", "verify"]);

  expect(opts.tmux).toBe(true);
});

test("parseArgs enables worktree mode with --worktree", () => {
  const opts = parseArgs(["--worktree", "--proof", "verify"]);

  expect(opts.worktree).toBe(true);
});

test.each([
  [["--workspace", "/tmp/repo-worktree"], "/tmp/repo-worktree"],
  [["--workspace=/tmp/repo-worktree"], "/tmp/repo-worktree"],
] as const)("parseArgs accepts workspace binding %j", (argv, expected) => {
  expect(parseArgs([...argv]).workspace).toBe(expected);
});

test("parseArgs rejects missing, empty, or conflicting workspace bindings", () => {
  expect(() => parseArgs(["--workspace"])).toThrow(
    "Missing value for --workspace"
  );
  expect(() => parseArgs(["--workspace="])).toThrow(
    "Invalid --workspace value: cannot be empty"
  );
  expect(() =>
    parseArgs(["--workspace", "/tmp/repo-worktree", "--worktree"])
  ).toThrow("Cannot combine --workspace with --worktree.");
});

test("parseArgs joins positional prompt words", () => {
  const opts = parseArgs(["--proof", "verify", "fix", "the", "bug"]);

  expect(opts.promptInput).toBe("fix the bug");
});

test("parseArgs rejects empty proof values", () => {
  expect(() => parseArgs(["--proof", "   "])).toThrow(
    "Invalid --proof value: cannot be empty"
  );
});

test("parseArgs rejects empty done signals", () => {
  expect(() => parseArgs(["--done", "   ", "--proof", "verify"])).toThrow(
    "Invalid --done value: cannot be empty"
  );
});

test("parseArgs throws for unknown flags", () => {
  expect(() => parseArgs(["--unknown"])).toThrow("Unknown argument: --unknown");
});

test("parseArgs rejects removed single-agent aliases", () => {
  expect(() => parseArgs(["--claude"])).toThrow("Unknown argument: --claude");
  expect(() => parseArgs(["--codex"])).toThrow("Unknown argument: --codex");
});

test("parseArgs throws when a value flag is missing its value", () => {
  expect(() => parseArgs(["--prompt"])).toThrow("Missing value for --prompt");
});

test("parseArgs throws for invalid max iteration value", () => {
  expect(() => parseArgs(["--max-iterations", "0"])).toThrow(
    "Invalid --max-iterations value: 0"
  );
});

test("parseArgs throws for fractional max iteration value", () => {
  expect(() => parseArgs(["--max-iterations", "2.5"])).toThrow(
    "Invalid --max-iterations value: 2.5"
  );
});

test("parseArgs trims done signal value", () => {
  const opts = parseArgs(["--done", "  <done/>  ", "--proof", "verify"]);
  expect(opts.doneSignal).toBe("<done/>");
});

test("parseArgs throws when positional prompt is provided with --prompt", () => {
  expect(() =>
    parseArgs(["--proof", "verify", "--prompt", "PLAN.md", "extra"])
  ).toThrow("Unexpected positional prompt when --prompt is already set.");
});

test("parseArgs sets agent/review/reviewPlan to copilot with --copilot-only", () => {
  const opts = parseArgs(["--copilot-only", "--proof", "verify"]);

  expect(opts.agent).toBe("copilot");
  expect(opts.review).toBe("copilot");
  expect(opts.reviewPlan).toBe("copilot");
  expect(opts.pairedMode).toBe(false);
});

test("parseArgs throws on conflicting --copilot-only and --claude-only", () => {
  expect(() => parseArgs(["--copilot-only", "--claude-only"])).toThrow(
    CONFLICT_ONLY_MODE_ERROR
  );
});

test("parseArgs accepts copilot as --agent value", () => {
  const opts = parseArgs(["--agent", "copilot", "--proof", "verify"]);

  expect(opts.agent).toBe("copilot");
  expect(opts.pairWith).toBe("claude");
});

test("parseArgs handles --copilot-model and --copilot-reviewer-model", () => {
  const opts = parseArgs([
    "--copilot-model",
    "gpt-4.1",
    "--copilot-reviewer-model",
    "gpt-4.1-mini",
    "--proof",
    "verify",
  ]);

  expect(opts.copilotModel).toBe("gpt-4.1");
  expect(opts.copilotReviewerModel).toBe("gpt-4.1-mini");
});

test("parseArgs handles --copilot-model= equals form", () => {
  const opts = parseArgs(["--copilot-model=o3", "--proof", "verify"]);

  expect(opts.copilotModel).toBe("o3");
});

test("parseArgs accepts copilot as --pair-with value", () => {
  const opts = parseArgs([
    "--agent",
    "claude",
    "--pair-with",
    "copilot",
    "--proof",
    "verify",
  ]);

  expect(opts.agent).toBe("claude");
  expect(opts.pairWith).toBe("copilot");
});

test("parseArgs accepts copilot as --review value", () => {
  const opts = parseArgs(["--review", "copilot", "--proof", "verify"]);

  expect(opts.review).toBe("copilot");
});

test("parseArgs accepts copilot as --review-plan value", () => {
  const opts = parseArgs(["--review-plan", "copilot", "--proof", "verify"]);

  expect(opts.reviewPlan).toBe("copilot");
});
