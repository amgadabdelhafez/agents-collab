import { env } from "bun";
import { defaultPeerAgent, isAgent } from "./agents";
import {
  DEFAULT_BABYSIT_COOLDOWN_SECONDS,
  DEFAULT_BABYSIT_HEIGHT,
  DEFAULT_BABYSIT_IDLE_SECONDS,
  DEFAULT_BABYSIT_MAX_RECOVERIES,
  DEFAULT_BABYSIT_MODEL,
  DEFAULT_BABYSIT_URL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_COPILOT_MODEL,
  DEFAULT_CURSOR_MODEL,
  DEFAULT_DONE_SIGNAL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_MAX_ITERATIONS,
  HELP,
  LOOP_VERSION,
  VALUE_FLAGS,
} from "./constants";
import type {
  Agent,
  Format,
  Options,
  PlanReviewMode,
  ReviewMode,
  ValueFlag,
} from "./types";

const EMPTY_DONE_SIGNAL_ERROR = "Invalid --done value: cannot be empty";
const ONLY_MODE_CONFLICT_ERROR = "Cannot combine multiple --*-only flags.";
const INVALID_RUN_ID_ERROR = "Invalid --run-id value: cannot be empty";

const parseAgent = (value: string): Agent => {
  if (isAgent(value)) {
    return value;
  }
  throw new Error(`Invalid --agent value: ${value}`);
};

const parseFormat = (value: string): Format => {
  if (value === "pretty" || value === "raw") {
    return value;
  }
  throw new Error(`Invalid --format value: ${value}`);
};

const parseReviewValue = (value: string): ReviewMode => {
  if (isAgent(value) || value === "claudex") {
    return value;
  }
  throw new Error(`Invalid --review value: ${value}`);
};

const maybeParsePlanReviewValue = (
  value: string | undefined
): PlanReviewMode | undefined => {
  if (value === "other" || isAgent(value) || value === "none") {
    return value;
  }
};

const parsePlanReviewValue = (value: string | undefined): PlanReviewMode => {
  const parsed = maybeParsePlanReviewValue(value);
  if (parsed) {
    return parsed;
  }
  throw new Error(`Invalid --review-plan value: ${value}`);
};

const requireTrimmedValue = (value: string, message: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(message);
  }
  return trimmed;
};

const parsePositiveInt = (value: string, flag: string): number => {
  const num = Number(value);
  if (!Number.isInteger(num) || num < 1) {
    throw new Error(`Invalid ${flag} value: ${value}`);
  }
  return num;
};

const requireFlagValue = (arg: string, value: string | undefined): string => {
  if (!value || value === "--" || value.startsWith("-")) {
    throw new Error(`Missing value for ${arg}`);
  }
  return value;
};

const applyValueFlag = (
  flag: ValueFlag,
  value: string,
  opts: Options,
  onlyAgent?: Agent
): void => {
  switch (flag) {
    case "agent":
      if (!onlyAgent) {
        opts.agent = parseAgent(value);
      }
      return;
    case "prompt":
      opts.promptInput = value;
      return;
    case "max": {
      const num = Number(value);
      if (!Number.isInteger(num) || num < 1) {
        throw new Error(`Invalid --max-iterations value: ${value}`);
      }
      opts.maxIterations = num;
      return;
    }
    case "done":
      opts.doneSignal = requireTrimmedValue(value, EMPTY_DONE_SIGNAL_ERROR);
      return;
    case "proof":
      opts.proof = requireTrimmedValue(
        value,
        "Invalid --proof value: cannot be empty"
      );
      return;
    case "pairWith":
      opts.pairWith = parseAgent(value);
      return;
    case "codexModel":
      opts.codexModel = requireTrimmedValue(
        value,
        "Invalid --codex-model value: cannot be empty"
      );
      return;
    case "codexReviewerModel":
      opts.codexReviewerModel = requireTrimmedValue(
        value,
        "Invalid --codex-reviewer-model value: cannot be empty"
      );
      return;
    case "copilotModel":
      opts.copilotModel = requireTrimmedValue(
        value,
        "Invalid --copilot-model value: cannot be empty"
      );
      return;
    case "copilotReviewerModel":
      opts.copilotReviewerModel = requireTrimmedValue(
        value,
        "Invalid --copilot-reviewer-model value: cannot be empty"
      );
      return;
    case "cursorModel":
      opts.cursorModel = requireTrimmedValue(
        value,
        "Invalid --cursor-model value: cannot be empty"
      );
      return;
    case "cursorReviewerModel":
      opts.cursorReviewerModel = requireTrimmedValue(
        value,
        "Invalid --cursor-reviewer-model value: cannot be empty"
      );
      return;
    case "claudeReviewerModel":
      opts.claudeReviewerModel = requireTrimmedValue(
        value,
        "Invalid --claude-reviewer-model value: cannot be empty"
      );
      return;
    case "geminiModel":
      opts.geminiModel = requireTrimmedValue(
        value,
        "Invalid --gemini-model value: cannot be empty"
      );
      return;
    case "geminiReviewerModel":
      opts.geminiReviewerModel = requireTrimmedValue(
        value,
        "Invalid --gemini-reviewer-model value: cannot be empty"
      );
      return;
    case "session":
      opts.sessionId = requireTrimmedValue(
        value,
        "Invalid --session value: cannot be empty"
      );
      return;
    case "runId":
      opts.resumeRunId = requireTrimmedValue(value, INVALID_RUN_ID_ERROR);
      return;
    case "format":
      opts.format = parseFormat(value);
      return;
    case "babysitIdle":
      opts.babysitIdleSeconds = parsePositiveInt(value, "--babysit-idle");
      return;
    case "babysitCooldown":
      opts.babysitCooldownSeconds = parsePositiveInt(
        value,
        "--babysit-cooldown"
      );
      return;
    case "babysitMaxRecoveries":
      opts.babysitMaxRecoveries = parsePositiveInt(
        value,
        "--babysit-max-recoveries"
      );
      return;
    case "babysitUrl":
      opts.babysitUrl = requireTrimmedValue(
        value,
        "Invalid --babysit-url value: cannot be empty"
      );
      return;
    case "babysitModel":
      opts.babysitModel = requireTrimmedValue(
        value,
        "Invalid --babysit-model value: cannot be empty"
      );
      return;
    case "babysitHeight":
      opts.babysitHeight = requireTrimmedValue(
        value,
        "Invalid --babysit-height value: cannot be empty"
      );
      return;
    default: {
      const exhaustive: never = flag;
      throw new Error(`Unhandled value flag: ${exhaustive}`);
    }
  }
};

const applyOnlyMode = (agent: Agent, opts: Options): void => {
  opts.agent = agent;
  opts.pairedMode = false;
  opts.review = agent;
  if (opts.reviewPlan !== "none") {
    opts.reviewPlan = agent;
  }
};

const parseOnlyModeFlag = (arg: string): Agent | undefined => {
  if (arg === "--claude-only") {
    return "claude";
  }
  if (arg === "--codex-only") {
    return "codex";
  }
  if (arg === "--gemini-only") {
    return "gemini";
  }
  if (arg === "--cursor-only") {
    return "cursor";
  }
  if (arg === "--copilot-only") {
    return "copilot";
  }
  return undefined;
};

const resolveOnlyMode = (current: Agent | undefined, next: Agent): Agent => {
  if (current && current !== next) {
    throw new Error(ONLY_MODE_CONFLICT_ERROR);
  }
  return next;
};

const parseReviewArg = (
  argv: string[],
  index: number,
  opts: Options,
  arg: string,
  onlyAgent?: Agent
): number => {
  if (onlyAgent) {
    if (arg.startsWith("--review=")) {
      parseReviewValue(arg.slice("--review=".length));
      return index;
    }

    const next = argv[index + 1];
    if (isAgent(next) || next === "claudex") {
      return index + 1;
    }

    if (next && !next.startsWith("-")) {
      parseReviewValue(next);
    }

    return index;
  }

  if (arg.startsWith("--review=")) {
    const review = parseReviewValue(arg.slice("--review=".length));
    opts.review = review;
    return index;
  }

  const next = argv[index + 1];
  if (isAgent(next) || next === "claudex") {
    opts.review = parseReviewValue(next);
    return index + 1;
  }

  opts.review = "claudex";
  return index;
};

const parsePlanReviewArg = (
  argv: string[],
  index: number,
  opts: Options,
  arg: string,
  onlyAgent?: Agent
): number => {
  if (onlyAgent) {
    if (arg.startsWith("--review-plan=")) {
      if (parsePlanReviewValue(arg.slice("--review-plan=".length)) === "none") {
        opts.reviewPlan = "none";
      }
      return index;
    }

    const reviewPlan = maybeParsePlanReviewValue(argv[index + 1]);
    if (reviewPlan === "none") {
      opts.reviewPlan = "none";
      return index + 1;
    }

    if (reviewPlan) {
      return index + 1;
    }

    return index;
  }

  if (arg.startsWith("--review-plan=")) {
    const reviewPlan = parsePlanReviewValue(arg.slice("--review-plan=".length));
    opts.reviewPlan = reviewPlan;
    return index;
  }

  const next = argv[index + 1];
  const reviewPlan = maybeParsePlanReviewValue(next);
  if (reviewPlan) {
    opts.reviewPlan = reviewPlan;
    return index + 1;
  }

  opts.reviewPlan = "other";
  return index;
};

const parseRunIdArg = (
  argv: string[],
  index: number,
  opts: Options,
  arg: string
): number | undefined => {
  if (arg.startsWith("--run-id=")) {
    applyValueFlag(
      "runId",
      requireTrimmedValue(arg.slice("--run-id=".length), INVALID_RUN_ID_ERROR),
      opts
    );
    return index + 1;
  }

  if (arg === "--run-id") {
    applyValueFlag("runId", requireFlagValue(arg, argv[index + 1]), opts);
    return index + 2;
  }
};

const parseModelArg = (
  argv: string[],
  index: number,
  opts: Options,
  arg: string
): number | undefined => {
  if (arg.startsWith("--codex-model=")) {
    applyValueFlag("codexModel", arg.slice("--codex-model=".length), opts);
    return index + 1;
  }
  if (arg.startsWith("--codex-reviewer-model=")) {
    applyValueFlag(
      "codexReviewerModel",
      arg.slice("--codex-reviewer-model=".length),
      opts
    );
    return index + 1;
  }
  if (arg.startsWith("--copilot-model=")) {
    applyValueFlag("copilotModel", arg.slice("--copilot-model=".length), opts);
    return index + 1;
  }
  if (arg.startsWith("--copilot-reviewer-model=")) {
    applyValueFlag(
      "copilotReviewerModel",
      arg.slice("--copilot-reviewer-model=".length),
      opts
    );
    return index + 1;
  }
  if (arg.startsWith("--cursor-model=")) {
    applyValueFlag("cursorModel", arg.slice("--cursor-model=".length), opts);
    return index + 1;
  }
  if (arg.startsWith("--cursor-reviewer-model=")) {
    applyValueFlag(
      "cursorReviewerModel",
      arg.slice("--cursor-reviewer-model=".length),
      opts
    );
    return index + 1;
  }
  if (arg.startsWith("--claude-reviewer-model=")) {
    applyValueFlag(
      "claudeReviewerModel",
      arg.slice("--claude-reviewer-model=".length),
      opts
    );
    return index + 1;
  }
  if (arg.startsWith("--gemini-model=")) {
    applyValueFlag("geminiModel", arg.slice("--gemini-model=".length), opts);
    return index + 1;
  }
  if (arg.startsWith("--gemini-reviewer-model=")) {
    applyValueFlag(
      "geminiReviewerModel",
      arg.slice("--gemini-reviewer-model=".length),
      opts
    );
    return index + 1;
  }
  if (
    arg === "--codex-model" ||
    arg === "--codex-reviewer-model" ||
    arg === "--copilot-model" ||
    arg === "--copilot-reviewer-model" ||
    arg === "--cursor-model" ||
    arg === "--cursor-reviewer-model" ||
    arg === "--claude-reviewer-model" ||
    arg === "--gemini-model" ||
    arg === "--gemini-reviewer-model"
  ) {
    applyValueFlag(
      VALUE_FLAGS[arg],
      requireFlagValue(arg, argv[index + 1]),
      opts
    );
    return index + 2;
  }
};

const consumeArg = (
  argv: string[],
  index: number,
  opts: Options,
  positional: string[],
  onlyAgent: Agent | undefined
): { nextIndex: number; stop: boolean; onlyAgent: Agent | undefined } => {
  const arg = argv[index];

  if (arg === "-v" || arg === "--version") {
    console.log(`loop v${LOOP_VERSION}`);
    process.exit(0);
  }

  if (arg === "-h" || arg === "--help") {
    console.log(HELP);
    process.exit(0);
  }

  if (arg === "--") {
    positional.push(...argv.slice(index + 1));
    return { nextIndex: argv.length, stop: true, onlyAgent };
  }

  const modelNextIndex = parseModelArg(argv, index, opts, arg);
  if (modelNextIndex !== undefined) {
    return { nextIndex: modelNextIndex, stop: false, onlyAgent };
  }

  const modeAgent = parseOnlyModeFlag(arg);
  if (modeAgent) {
    applyOnlyMode(modeAgent, opts);
    return {
      nextIndex: index + 1,
      stop: false,
      onlyAgent: resolveOnlyMode(onlyAgent, modeAgent),
    };
  }

  if (arg === "--review" || arg.startsWith("--review=")) {
    return {
      nextIndex: parseReviewArg(argv, index, opts, arg, onlyAgent) + 1,
      stop: false,
      onlyAgent,
    };
  }

  if (arg === "--review-plan" || arg.startsWith("--review-plan=")) {
    return {
      nextIndex: parsePlanReviewArg(argv, index, opts, arg, onlyAgent) + 1,
      stop: false,
      onlyAgent,
    };
  }

  const runIdNextIndex = parseRunIdArg(argv, index, opts, arg);
  if (runIdNextIndex !== undefined) {
    return { nextIndex: runIdNextIndex, stop: false, onlyAgent };
  }

  if (arg === "--tmux") {
    opts.tmux = true;
    return { nextIndex: index + 1, stop: false, onlyAgent };
  }

  if (arg === "--worktree") {
    opts.worktree = true;
    return { nextIndex: index + 1, stop: false, onlyAgent };
  }

  if (arg === "--babysit") {
    opts.babysit = true;
    return { nextIndex: index + 1, stop: false, onlyAgent };
  }

  if (arg === "--babysit-dry-run") {
    opts.babysitDryRun = true;
    return { nextIndex: index + 1, stop: false, onlyAgent };
  }

  const flag = VALUE_FLAGS[arg];
  if (flag) {
    const value = argv[index + 1];
    if (!value) {
      throw new Error(`Missing value for ${arg}`);
    }
    applyValueFlag(flag, value, opts, onlyAgent);
    return { nextIndex: index + 2, stop: false, onlyAgent };
  }

  if (arg.startsWith("-")) {
    throw new Error(`Unknown argument: ${arg}`);
  }

  positional.push(arg);
  return { nextIndex: index + 1, stop: false, onlyAgent };
};

export const parseArgs = (argv: string[]): Options => {
  const opts: Options = {
    agent: "claude",
    doneSignal: DEFAULT_DONE_SIGNAL,
    proof: "",
    format: "pretty",
    maxIterations: DEFAULT_MAX_ITERATIONS,
    codexModel: env.LOOP_CODEX_MODEL ?? DEFAULT_CODEX_MODEL,
    copilotModel: env.LOOP_COPILOT_MODEL ?? DEFAULT_COPILOT_MODEL,
    cursorModel: env.LOOP_CURSOR_MODEL ?? DEFAULT_CURSOR_MODEL,
    geminiModel: env.LOOP_GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL,
    babysitIdleSeconds: DEFAULT_BABYSIT_IDLE_SECONDS,
    babysitCooldownSeconds: DEFAULT_BABYSIT_COOLDOWN_SECONDS,
    babysitMaxRecoveries: DEFAULT_BABYSIT_MAX_RECOVERIES,
    babysitUrl: env.LOOP_BABYSIT_URL ?? DEFAULT_BABYSIT_URL,
    babysitModel: env.LOOP_BABYSIT_MODEL ?? DEFAULT_BABYSIT_MODEL,
    babysitHeight: DEFAULT_BABYSIT_HEIGHT,
    babysitLlmTrace: env.LOOP_BABYSIT_LLM_TRACE,
    pairedMode: true,
    review: "claudex",
    resumeRunId: undefined,
    tmux: false,
    worktree: false,
  };
  const positional: string[] = [];
  let onlyAgent: Agent | undefined;

  for (let index = 0; index < argv.length; ) {
    const {
      nextIndex,
      stop,
      onlyAgent: nextOnlyAgent,
    } = consumeArg(argv, index, opts, positional, onlyAgent);
    index = nextIndex;
    onlyAgent = nextOnlyAgent;
    if (stop) {
      break;
    }
  }

  if (positional.length > 0) {
    if (opts.promptInput) {
      throw new Error(
        "Unexpected positional prompt when --prompt is already set."
      );
    }
    opts.promptInput = positional.join(" ");
  }

  if (opts.pairedMode && opts.pairWith === opts.agent) {
    throw new Error(
      `Invalid --pair-with value: ${opts.pairWith} matches --agent ${opts.agent}`
    );
  }
  if (opts.pairedMode && !opts.pairWith) {
    opts.pairWith = defaultPeerAgent(opts.agent);
  }

  return opts;
};
