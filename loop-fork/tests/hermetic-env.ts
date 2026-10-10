import { relative } from "node:path";

/**
 * Why the launch environment could reach the operator's live state, or
 * `undefined` when it cannot. The suite must never read the live storage root
 * (`$HOME/.loop/runs` feeds the other-run index that teardown, GC and the
 * release consult: every run there would be judged against the live process
 * table and probed on its tmux server) nor reach a live tmux server. Only the
 * launch environment can prevent that: Bun fixes `os.homedir()` and the
 * environment `Bun.spawn` hands its children at startup, so editing
 * `process.env` in a preload reaches neither. `scripts/test-hermetic.sh`
 * (which `test:file` and `test:ci` run) provides it.
 */
export const hermeticEnvGap = (
  env: Readonly<Record<string, string | undefined>>
): string | undefined => {
  const scratch = env.LOOP_TEST_HERMETIC_ENV;
  if (!scratch) {
    return "LOOP_TEST_HERMETIC_ENV is unset";
  }
  const inside = (path: string | undefined): boolean => {
    if (!path) {
      return false;
    }
    const rel = relative(scratch, path);
    return rel !== "" && !rel.startsWith("..") && !rel.startsWith("/");
  };
  if (!inside(env.HOME)) {
    return `HOME (${env.HOME ?? "unset"}) is not inside ${scratch}`;
  }
  if (!inside(env.TMUX_TMPDIR)) {
    return `TMUX_TMPDIR (${env.TMUX_TMPDIR ?? "unset"}) is not inside ${scratch}`;
  }
  for (const name of ["TMUX", "TMUX_PANE", "LOOP_TMUX_SOCKET"]) {
    if (env[name] !== undefined) {
      return `${name} is set`;
    }
  }
  return undefined;
};
