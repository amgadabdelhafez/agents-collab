import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CLAUDE_REVIEWER_MODEL,
  DEFAULT_CODEX_REVIEWER_MODEL,
} from "./constants";
import { DEFAULT_DRIVER_EFFORT, DEFAULT_REVIEWER_EFFORT } from "./effort";
import type { RunManifest } from "./run-state";
import type { Agent, Options } from "./types";

export const resolveLaunchModel = (
  agent: Agent,
  opts: Options,
  reviewer: boolean
): string => {
  if (agent === "codex") {
    if (reviewer && opts.codexReviewerModel) {
      return opts.codexReviewerModel;
    }
    if (opts.codexModelSource === "default" && (reviewer || !opts.tmux)) {
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

export const restoreSavedLaunchDefaults = (
  opts: Options,
  manifest: RunManifest
): void => {
  if (opts.codexModelSource === "default") {
    opts.codexModel =
      manifest.seatModels?.codex ?? DEFAULT_CODEX_REVIEWER_MODEL;
    opts.codexModelSource = "manifest";
  }
  opts.claudeModel ??= manifest.seatModels?.claude ?? DEFAULT_CLAUDE_MODEL;
  opts.claudeReviewerModel ??=
    manifest.seatModels?.claude ?? DEFAULT_CLAUDE_MODEL;
  if (opts.driverEffortSource === "default") {
    opts.driverEffort = manifest.driverEffort ?? DEFAULT_DRIVER_EFFORT;
    opts.driverEffortSource = "manifest";
  }
  if (opts.reviewerEffortSource === "default") {
    opts.reviewerEffort = manifest.reviewerEffort ?? DEFAULT_REVIEWER_EFFORT;
    opts.reviewerEffortSource = "manifest";
  }
};
