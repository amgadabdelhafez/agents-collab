import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CLAUDE_REVIEWER_MODEL,
  DEFAULT_CODEX_REVIEWER_MODEL,
} from "./constants";
import type { Agent, Options } from "./types";

export const resolveLaunchModel = (
  agent: Agent,
  opts: Options,
  reviewer: boolean
): string => {
  if (agent === "codex") {
    return reviewer
      ? (opts.codexReviewerModel ??
          (opts.codexModelSource === "default"
            ? DEFAULT_CODEX_REVIEWER_MODEL
            : opts.codexModel))
      : opts.codexModel;
  }
  if (agent === "claude") {
    return reviewer
      ? (opts.claudeReviewerModel ?? DEFAULT_CLAUDE_REVIEWER_MODEL)
      : (opts.claudeModel ?? DEFAULT_CLAUDE_MODEL);
  }
  return reviewer ? (opts.ossReviewerModel ?? opts.ossModel) : opts.ossModel;
};
