import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
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

test("Governess environment refuses multiply linked secret inodes", () => {
  const root = mkdtempSync(join(tmpdir(), "governess-env-linked-"));
  const path = join(root, "environment.json");
  const alias = join(root, "environment-alias.json");
  try {
    writeGovernessEnvironmentFile(path, ["SECRET=value"]);
    linkSync(path, alias);
    expect(() => consumeGovernessEnvironmentFile(path)).toThrow(
      "not private and owned"
    );
    expect(existsSync(path)).toBe(true);
    expect(existsSync(alias)).toBe(true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Governess environment requires exact mode 0600", () => {
  const root = mkdtempSync(join(tmpdir(), "governess-env-mode-"));
  try {
    for (const mode of [0o400, 0o700]) {
      const path = join(root, `environment-${mode.toString(8)}.json`);
      writeGovernessEnvironmentFile(path, ["SECRET=value"]);
      chmodSync(path, mode);
      expect(() => consumeGovernessEnvironmentFile(path)).toThrow(
        "not private and owned"
      );
      expect(existsSync(path)).toBe(true);
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
