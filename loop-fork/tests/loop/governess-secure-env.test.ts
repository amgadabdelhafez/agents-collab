import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumeGovernessEnvironmentFile,
  writeGovernessEnvironmentFile,
} from "../../src/loop/governess-secure-env";

test("Governess environment crosses a private one-shot file, not argv", () => {
  const root = mkdtempSync(join(tmpdir(), "governess-env-"));
  const path = join(root, "environment.json");
  try {
    writeGovernessEnvironmentFile(path, [
      "LOOP_USAGE_TRACKER_SECRET=redacted-test-secret",
      "LOOP_GOVERNESS_IDLE=120",
    ]);
    expect(consumeGovernessEnvironmentFile(path)).toEqual({
      LOOP_GOVERNESS_IDLE: "120",
      LOOP_USAGE_TRACKER_SECRET: "redacted-test-secret",
    });
    expect(existsSync(path)).toBe(false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Governess environment refuses permissive files and symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "governess-env-refuse-"));
  const exposed = join(root, "exposed.json");
  const link = join(root, "link.json");
  try {
    writeFileSync(exposed, '{"SECRET":"value"}\n', { mode: 0o644 });
    expect(() => consumeGovernessEnvironmentFile(exposed)).toThrow(
      "not private and owned"
    );
    chmodSync(exposed, 0o600);
    symlinkSync(exposed, link);
    expect(() => consumeGovernessEnvironmentFile(link)).toThrow(
      "not private and owned"
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
