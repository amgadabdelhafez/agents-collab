import { isAgent } from "./agents";
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CLAUDE_REVIEWER_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REVIEWER_MODEL,
} from "./constants";
import { DEFAULT_DRIVER_EFFORT, DEFAULT_REVIEWER_EFFORT } from "./effort";
import type { RunManifest } from "./run-state";
import type { Agent, Options } from "./types";

// Options built without parseArgs carry no source; their default model value
// still means the default, so foreground keeps the legacy model.
const usesDefaultCodexModel = (opts: Options): boolean =>
  opts.codexModelSource === "default" ||
  (opts.codexModelSource === undefined &&
    opts.codexModel === DEFAULT_CODEX_MODEL);

export const resolveLaunchModel = (
  agent: Agent,
  opts: Options,
  reviewer: boolean
): string => {
  if (agent === "codex") {
    if (reviewer && opts.codexReviewerModel) {
      return opts.codexReviewerModel;
    }
    if (usesDefaultCodexModel(opts) && (reviewer || !opts.tmux)) {
      return DEFAULT_CODEX_REVIEWER_MODEL;
    }
    return opts.codexModel;
  }
  if (agent === "claude") {
    if (!reviewer) {
      return opts.claudeModel ?? DEFAULT_CLAUDE_MODEL;
    }
    const defaultModel = opts.tmux
      ? DEFAULT_CLAUDE_REVIEWER_MODEL
      : DEFAULT_CLAUDE_MODEL;
    return opts.claudeReviewerModel ?? defaultModel;
  }
  return reviewer ? (opts.ossReviewerModel ?? opts.ossModel) : opts.ossModel;
};

// Each saved model belongs to the role its agent held when it was recorded.
// Older manifests lack seatModelsDriver; primaryAgent is the best evidence
// they carry, then the current driver.
const savedModelDriver = (opts: Options, manifest: RunManifest): Agent => {
  if (manifest.seatModelsDriver) {
    return manifest.seatModelsDriver;
  }
  return isAgent(manifest.primaryAgent) ? manifest.primaryAgent : opts.agent;
};

export const restoreSavedLaunchDefaults = (
  opts: Options,
  manifest: RunManifest
): void => {
  const driver = savedModelDriver(opts, manifest);
  const savedCodex = manifest.seatModels?.codex;
  const savedClaude = manifest.seatModels?.claude;
  if (usesDefaultCodexModel(opts)) {
    // Manifests without a saved Claude model predate role-resolved seat
    // models: they saved the one Codex model both roles used.
    if (savedCodex === undefined || savedClaude === undefined) {
      opts.codexModel = savedCodex ?? DEFAULT_CODEX_REVIEWER_MODEL;
      opts.codexModelSource = "manifest";
    } else if (driver === "codex") {
      opts.codexModel = savedCodex;
      opts.codexModelSource = "manifest";
      opts.codexReviewerModel ??= DEFAULT_CODEX_REVIEWER_MODEL;
    } else {
      opts.codexReviewerModel ??= savedCodex;
    }
  }
  if (savedClaude === undefined) {
    opts.claudeModel ??= DEFAULT_CLAUDE_MODEL;
    opts.claudeReviewerModel ??= DEFAULT_CLAUDE_MODEL;
  } else if (driver === "claude") {
    opts.claudeModel ??= savedClaude;
  } else {
    opts.claudeReviewerModel ??= savedClaude;
  }
  if (opts.driverEffortSource === "default") {
    opts.driverEffort = manifest.driverEffort ?? DEFAULT_DRIVER_EFFORT;
    opts.driverEffortSource = "manifest";
  }
  if (opts.reviewerEffortSource === "default") {
    opts.reviewerEffort = manifest.reviewerEffort ?? DEFAULT_REVIEWER_EFFORT;
    opts.reviewerEffortSource = "manifest";
  }
};
