import { NEWLINE_RE, REVIEW_FAIL, REVIEW_PASS } from "./constants";

export const SPAWN_TEAM_WITH_WORKTREE_ISOLATION =
  "Spawn a team of agents with worktree isolation.";

const HUMAN_CLARIFICATION_GUIDANCE =
  "Use AskUserQuestion, or the equivalent user-input tool if available, whenever scope, requirements, acceptance criteria, or direction are unclear. Ask concise questions before guessing, and confirm direction when a choice would materially affect the work.";

export const SESSION_STATE_GUIDANCE = [
  "Session state:",
  "- Maintain `PLAN.md` and `status.md` in the current repo for every loop session that does project work.",
  "- If either file is missing, create it once the task is clear. If it exists, read it before changing work and update it instead of replacing useful history.",
  "- Keep `PLAN.md` focused on the current plan, decisions, acceptance criteria, and verification approach.",
  "- Keep `status.md` as the running handoff: what was done in this session, proof/checks run, open questions, risks, and exactly what should happen next.",
  "- When the human asks to update progress, check in work, stop, or hand off to a next session, update both files first so the next session can resume without hidden context.",
].join("\n");

const appendProofRequirements = (parts: string[], proof: string): void => {
  const trimmed = proof.trim();
  if (!trimmed) {
    return;
  }
  parts.push(`Proof requirements:\n${trimmed}`);
};

const hasProofInTask = (task: string, proof: string): boolean => {
  const proofLines = proof
    .split(NEWLINE_RE)
    .map((line) => line.trim())
    .filter(Boolean);
  if (proofLines.length === 0) {
    return true;
  }

  const taskLines = new Set(
    task
      .split(NEWLINE_RE)
      .map((line) => line.trim())
      .filter(Boolean)
  );
  return proofLines.every((line) => taskLines.has(line));
};

export const buildPlanPrompt = (task: string): string =>
  [
    "Plan mode:",
    `Task:\n${task.trim()}`,
    "Create or update PLAN.md in the current repo with a clear implementation plan.",
    "Create or update status.md with a concise session entry, current state, open questions, and next step.",
    SESSION_STATE_GUIDANCE,
    "Only write the plan in this step. Enter plan mode. Do not implement code yet.",
  ].join("\n\n");

export const buildPlanReviewPrompt = (task: string): string =>
  [
    "Plan review mode:",
    `Task:\n${task.trim()}`,
    "Review PLAN.md for correctness, missing steps, and verification gaps.",
    "Update PLAN.md directly if needed.",
    "Check that status.md exists or that PLAN.md explicitly calls out when it should be created before implementation.",
    "Only edit PLAN.md in this step. Enter plan mode. Do not implement code yet.",
  ].join("\n\n");

export const buildWorkPrompt = (
  task: string,
  doneSignal: string,
  proof: string,
  reviewNotes?: string
): string => {
  const parts = [task.trim()];

  if (reviewNotes) {
    parts.push(
      `Review feedback:\n${reviewNotes.trim()}\n\nDecide what to address now. If you skip any comment, explain why briefly.`
    );
  }

  if (!hasProofInTask(task, proof)) {
    appendProofRequirements(parts, proof);
  }

  parts.push(
    `${SPAWN_TEAM_WITH_WORKTREE_ISOLATION} When all work is verified and once you have a proof that the task is completed, append "${doneSignal}" on its own final line.`
  );
  parts.push(SESSION_STATE_GUIDANCE);
  parts.push(HUMAN_CLARIFICATION_GUIDANCE);
  return parts.join("\n\n");
};

export const buildReviewPrompt = (
  task: string,
  doneSignal: string,
  proof: string
): string => {
  const parts = [
    `Review this completed work for the task below and verify it in the current repo.\n\nTask:\n${task.trim()}`,
    "Focus your review on unstaged changes (the diff produced by `git diff`). Run checks/tests/commands as needed.",
  ];

  appendProofRequirements(parts, proof);

  parts.push(
    `If review is needed, end your response with exactly "${REVIEW_FAIL}" on the final non-empty line. Nothing may follow this line.`
  );
  parts.push(
    `If the work is complete, end with exactly "${REVIEW_PASS}" on the final non-empty line. No extra content after this line.`
  );
  parts.push(
    "When reporting failures, include concrete file paths, commands, and code locations that must change."
  );
  parts.push(
    "Check that PLAN.md and status.md are current enough for a next session to understand what was done, what proof ran, and what remains."
  );
  parts.push(
    `${SPAWN_TEAM_WITH_WORKTREE_ISOLATION} The final line must be one of the two review signals on its own line, with no surrounding comments or markdown, and it must not include "${doneSignal}".`
  );
  return parts.join("\n\n");
};
