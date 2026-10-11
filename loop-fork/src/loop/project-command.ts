import {
  initProjectFile,
  type ProjectIdentityDeps,
  resolveOriginRepoKey,
  resolveRepoIdentity,
  supervisorRoleId,
} from "./project-identity";

export const PROJECT_COMMAND = "project";
export const PROJECT_USAGE =
  "loop project init --project <name> [--project <name> ...] [--repo <owner>/<name>] [--force] | loop project show";

interface InitArgs {
  force: boolean;
  projects: string[];
  repo?: string;
}

const parseInitArgs = (args: string[]): InitArgs => {
  const parsed: InitArgs = { force: false, projects: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = (): string => {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`${arg} needs a value. Usage: ${PROJECT_USAGE}`);
      }
      index += 1;
      return next;
    };
    if (arg === "--force") {
      parsed.force = true;
    } else if (arg === "--project") {
      parsed.projects.push(value());
    } else if (arg === "--repo") {
      if (parsed.repo !== undefined) {
        throw new Error(`--repo given twice. Usage: ${PROJECT_USAGE}`);
      }
      parsed.repo = value();
    } else {
      throw new Error(`unknown argument ${arg}. Usage: ${PROJECT_USAGE}`);
    }
  }
  return parsed;
};

/**
 * `loop project init|show`. Returns the JSON result, or `undefined` when argv
 * is not a project command.
 */
export const runProjectCommand = (
  argv: string[],
  cwd = process.cwd(),
  deps: Partial<ProjectIdentityDeps> = {}
): Record<string, unknown> | undefined => {
  if (argv[0] !== PROJECT_COMMAND) {
    return undefined;
  }
  const sub = argv[1];
  if (sub === "init") {
    const args = parseInitArgs(argv.slice(2));
    return {
      ...initProjectFile({
        cwd,
        deps,
        force: args.force,
        projects: args.projects,
        ...(args.repo === undefined ? {} : { repo: args.repo }),
      }),
    };
  }
  if (sub === "show" && argv.length === 2) {
    const identity = resolveRepoIdentity(cwd, deps);
    const originRepoKey = identity.repoRoot
      ? resolveOriginRepoKey(identity.repoRoot, deps)
      : undefined;
    const { repoKey } = identity;
    return {
      ...identity,
      ...(originRepoKey ? { originRepoKey } : {}),
      roles: repoKey
        ? identity.projects.map((project) => supervisorRoleId(repoKey, project))
        : [],
    };
  }
  throw new Error(`Usage: ${PROJECT_USAGE}`);
};
