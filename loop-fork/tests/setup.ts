import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hermeticEnvGap } from "./hermetic-env";

if (process.env.LOOP_TEST_CERTIFICATION_MODE !== "single-file") {
  console.error(
    "[loop] direct `bun test` is unsupported because Bun can terminate a shared-process suite before all files run; use `bun run test:file -- <file>` for focused tests or `bun run test:ci` for the complete suite."
  );
  process.exit(2);
}

// The suite never reads or probes the operator's live state (the storage root
// under HOME, a live tmux server); see `hermeticEnvGap`.
const gap = hermeticEnvGap(process.env);
if (gap) {
  console.error(
    `[loop] the test environment could reach live state (${gap}); use \`bun run test:file -- <file>\` or \`bun run test:ci\`, which run each file under scripts/test-hermetic.sh.`
  );
  process.exit(2);
}

const configDir = mkdtempSync(join(tmpdir(), "loop-claude-test-config-"));
process.env.CLAUDE_CONFIG_DIR = configDir;
process.on("exit", () => {
  rmSync(configDir, { force: true, recursive: true });
});
