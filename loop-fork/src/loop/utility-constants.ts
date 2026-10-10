/**
 * The hidden subcommand a detached utility worker (Direct, Nanny, Au Pair) is
 * spawned with: `loop __utility-worker <runDir> <epoch> <jobId>`. Kept apart
 * from the runtime so teardown cleanup can recognise a worker's command line
 * without loading the whole utility runtime.
 */
export const UTILITY_WORKER_SUBCOMMAND = "__utility-worker";
