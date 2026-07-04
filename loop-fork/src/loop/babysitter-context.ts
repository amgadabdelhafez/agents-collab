import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Project docs to feed the summary as "what this project is", newest-priority
// first. Kept small; each is truncated to PROJECT_DOC_CHARS.
const PROJECT_DOC_FILES = ["PLAN.md", "CLAUDE.md", "AGENTS.md"];
const PROJECT_DOC_CHARS = 1200;
const PROJECT_CONTEXT_CHARS = 3000;
const MAX_PRIOR_SUMMARIES = 2;
const RUN_ID_RE = /^\d+$/;

const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

// Read the project docs from the run's working directory into one bounded blob.
export const readProjectContext = (cwd?: string): string => {
  if (!cwd) {
    return "";
  }
  const parts: string[] = [];
  for (const file of PROJECT_DOC_FILES) {
    const path = join(cwd, file);
    if (!existsSync(path)) {
      continue;
    }
    try {
      const body = readFileSync(path, "utf8").trim();
      if (body) {
        parts.push(`### ${file}\n${truncate(body, PROJECT_DOC_CHARS)}`);
      }
    } catch {
      // Skip unreadable docs.
    }
  }
  return truncate(parts.join("\n\n"), PROJECT_CONTEXT_CHARS);
};

const summaryOf = (stateFile: string): string | undefined => {
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as {
      summary?: unknown;
    };
    return typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim()
      : undefined;
  } catch {
    return undefined;
  }
};

// Persisted summaries from prior run dirs (siblings of the current run dir),
// newest first, so the LLM has cross-session memory of what came before.
export const readPriorSummaries = (runDir?: string): string[] => {
  if (!runDir) {
    return [];
  }
  const parent = dirname(runDir);
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return [];
  }
  // Run dirs are numeric ids; visit the highest (most recent) first.
  const siblings = entries
    .filter((name) => join(parent, name) !== runDir && RUN_ID_RE.test(name))
    .sort((a, b) => Number(b) - Number(a));
  const summaries: string[] = [];
  for (const name of siblings) {
    if (summaries.length >= MAX_PRIOR_SUMMARIES) {
      break;
    }
    const found = summaryOf(join(parent, name, "babysitter-state.json"));
    if (found) {
      summaries.push(found);
    }
  }
  return summaries;
};
