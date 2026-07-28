import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const configDir = mkdtempSync(join(tmpdir(), "loop-claude-test-config-"));
process.env.CLAUDE_CONFIG_DIR = configDir;
process.on("exit", () => {
  rmSync(configDir, { force: true, recursive: true });
});
