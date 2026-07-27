import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Deprecated compatibility is intentionally isolated here. New code must use
// governess names; remove these aliases after the migration release.
const LEGACY_WORD = "babysit";
const LEGACY_NAME = `${LEGACY_WORD}ter`;
const LEGACY_ENV_PREFIX = `LOOP_${LEGACY_WORD.toUpperCase()}_`;

export const LEGACY_GOVERNESS_SUBCOMMAND = `__${LEGACY_WORD}`;
export const LEGACY_GOVERNESS_STATE_FILE = `${LEGACY_NAME}-state.json`;
export const LEGACY_MANIFEST_KEYS = {
  enabled: LEGACY_WORD,
  pane: `tmuxPane${LEGACY_WORD[0].toUpperCase()}${LEGACY_WORD.slice(1)}`,
  paneSnake: `tmux_pane_${LEGACY_WORD}`,
} as const;

export const normalizeLegacyGovernessArgs = (argv: string[]): string[] =>
  argv.map((arg) =>
    arg.startsWith(`--${LEGACY_WORD}`)
      ? `--governess${arg.slice(LEGACY_WORD.length + 2)}`
      : arg
  );

export const withLegacyGovernessEnv = (
  input: NodeJS.ProcessEnv
): NodeJS.ProcessEnv => {
  const output = { ...input };
  for (const [key, value] of Object.entries(input)) {
    if (!key.startsWith(LEGACY_ENV_PREFIX) || value === undefined) {
      continue;
    }
    const canonical = `LOOP_GOVERNESS_${key.slice(LEGACY_ENV_PREFIX.length)}`;
    output[canonical] ??= value;
  }
  return output;
};

export const migrateLegacyGovernessState = (
  runDir: string,
  canonicalStateFile: string
): void => {
  const legacyStateFile = join(runDir, LEGACY_GOVERNESS_STATE_FILE);
  if (!existsSync(legacyStateFile)) {
    return;
  }
  if (existsSync(canonicalStateFile)) {
    try {
      const canonical = JSON.parse(readFileSync(canonicalStateFile, "utf8")) as {
        governessEpoch?: number;
      };
      if ((canonical.governessEpoch ?? 0) > 0) {
        return;
      }
    } catch {
      // Replace an unreadable pre-epoch migration copy with the live legacy state.
    }
  }
  copyFileSync(legacyStateFile, canonicalStateFile);
};
