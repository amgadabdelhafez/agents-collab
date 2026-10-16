import { type GitResult, runGit } from "./git";
import { runAgent } from "./runner";
import type { Options } from "./types";

const GITHUB_SCP_RE = /^git@github\.com:(.+)$/;
const GIT_SUFFIX_RE = /\.git$/;
const GIT_REMOTE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GITHUB_OWNER_RE =
  /^(?=.{1,39}$)[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*$/;
const GITHUB_REPO_RE = /^(?=.{1,100}$)(?!-)(?!\.{1,2}$)[A-Za-z0-9._-]+$/;
const SINGLE_QUOTE_RE = /'/g;
const SUPPORTED_GITHUB_PROTOCOLS = new Set(["https:", "ssh:"]);

const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });

interface DraftPrDependencies {
  runAgent: typeof runAgent;
  runGit: (args: string[]) => GitResult;
}

const defaultDependencies: DraftPrDependencies = {
  runAgent,
  runGit: (args) => runGit(process.cwd(), args),
};

let dependencies = defaultDependencies;

export const draftPrInternals = {
  resetDependencies(): void {
    dependencies = defaultDependencies;
  },
  setDependencies(next: Partial<DraftPrDependencies>): void {
    dependencies = { ...defaultDependencies, ...next };
  },
};

const validatedGithubRepo = (path: string): string | undefined => {
  const normalized = path.replace(GIT_SUFFIX_RE, "");
  const parts = normalized.split("/");
  if (parts.length !== 2) {
    return undefined;
  }
  const [owner, repo] = parts;
  return owner &&
    repo &&
    GITHUB_OWNER_RE.test(owner) &&
    GITHUB_REPO_RE.test(repo)
    ? `${owner}/${repo}`
    : undefined;
};

const githubRepo = (remoteUrl: string): string | undefined => {
  if (hasControlCharacter(remoteUrl)) {
    return undefined;
  }
  const scp = remoteUrl.match(GITHUB_SCP_RE);
  if (scp?.[1]) {
    return validatedGithubRepo(scp[1]);
  }
  try {
    const parsed = new URL(remoteUrl);
    if (
      parsed.hostname.toLowerCase() !== "github.com" ||
      !SUPPORTED_GITHUB_PROTOCOLS.has(parsed.protocol) ||
      parsed.port ||
      parsed.search ||
      parsed.hash
    ) {
      return undefined;
    }
    if (
      (parsed.protocol === "https:" && (parsed.username || parsed.password)) ||
      (parsed.protocol === "ssh:" &&
        (parsed.username !== "git" || Boolean(parsed.password)))
    ) {
      return undefined;
    }
    return validatedGithubRepo(parsed.pathname.slice(1));
  } catch {
    return undefined;
  }
};

const shellQuote = (value: string): string =>
  `'${value.replace(SINGLE_QUOTE_RE, "'\\''")}'`;

const buildDraftPrPrompt = (
  task: string,
  hasExistingPr: boolean,
  remote: string,
  repo: string
): string =>
  hasExistingPr
    ? [
        "A PR already exists for this branch. Send a follow-up commit to it.",
        `Task context:\n${task.trim()}`,
        `Publication is explicitly authorized only through Git remote "${remote}" (${repo}).`,
        "Commit your follow-up changes, push them only to that remote, and return the commit in your final response.",
      ].join("\n\n")
    : [
        "Create a draft GitHub pull request for the current branch.",
        `Task context:\n${task.trim()}`,
        `Publication is explicitly authorized only through Git remote "${remote}" (${repo}).`,
        `Use \`gh pr create --draft --repo ${shellQuote(repo)}\` with a clear title and description.`,
        "If a PR already exists for this branch, do not create another one.",
        "Return the PR URL in your final response.",
      ].join("\n\n");

export const runDraftPrStep = async (
  task: string,
  opts: Options,
  hasExistingPr = false
): Promise<void> => {
  const remote = opts.publishDraftPrRemote;
  if (!remote) {
    console.log(
      "\n[loop] review passed. draft publication was not explicitly authorized; local source is ready for handoff."
    );
    return;
  }
  if (!GIT_REMOTE_NAME_RE.test(remote)) {
    console.log(
      "\n[loop] review passed. selected publication remote is invalid; local source is ready for handoff."
    );
    return;
  }
  const remoteResult = dependencies.runGit([
    "remote",
    "get-url",
    "--push",
    remote,
  ]);
  const repo =
    remoteResult.exitCode === 0 ? githubRepo(remoteResult.stdout) : undefined;
  if (!repo) {
    const reason =
      remoteResult.exitCode === 0
        ? `remote "${remote}" is not a supported GitHub publication target`
        : `remote "${remote}" could not be resolved`;
    console.log(
      `\n[loop] review passed. ${reason}; local source is ready for handoff.`
    );
    return;
  }
  const action = hasExistingPr ? "send commit" : "create draft PR";
  console.log(`\n[loop] review passed. asking model to ${action}.`);
  const result = await dependencies.runAgent(
    opts.agent,
    buildDraftPrPrompt(task, hasExistingPr, remote, repo),
    opts
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `[loop] draft PR ${opts.agent} exited with code ${result.exitCode}`
    );
  }
};
