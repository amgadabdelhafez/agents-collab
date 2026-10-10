/**
 * The hidden subcommand a detached utility worker (Direct, Nanny, Au Pair) is
 * spawned with: `loop __utility-worker <runDir> <epoch> <jobId>`. Kept apart
 * from the runtime so teardown cleanup can recognise a worker's command line
 * without loading the whole utility runtime.
 */
export const UTILITY_WORKER_SUBCOMMAND = "__utility-worker";

/**
 * `ps -o command=` joins argv with single spaces, so a runDir containing
 * spaces cannot be recovered by splitting, and a bare substring match also
 * accepts another run whose directory merely starts with this one. The
 * detached workers (bridge worker, bridge MCP, utility worker) are spawned
 * with their run arguments in a fixed trailing position, so only that exact
 * tail proves ownership; anything else is left unsignaled.
 */
export const commandEndsWithArgs = (
  command: string,
  args: readonly string[]
): boolean => {
  const trimmed = command.trimEnd();
  const tail = args.join(" ");
  return trimmed === tail || trimmed.endsWith(` ${tail}`);
};

/**
 * Whether a live command line is the utility worker of exactly this run
 * directory, claim epoch and job: the identity check before its process group
 * is signalled (by a teardown or a stale recovery). The worker is spawned as
 * `<loop> __utility-worker <runDir> <epoch> <jobId>`, so its argv must end with
 * exactly that tail. A recycled pid running anything else, another job's
 * worker, or a run directory that merely prefixes another never matches.
 */
export const isUtilityWorkerCommand = (
  command: string | undefined,
  identity: { epoch: number; jobId: string; runDir: string }
): boolean =>
  Boolean(
    command &&
      commandEndsWithArgs(command, [
        UTILITY_WORKER_SUBCOMMAND,
        identity.runDir,
        String(identity.epoch),
        identity.jobId,
      ])
  );
