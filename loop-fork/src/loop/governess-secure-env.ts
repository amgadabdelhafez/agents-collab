import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

export const GOVERNESS_SECURE_SUBCOMMAND = "__governess-secure";
export const AGENT_SECURE_SUBCOMMAND = "__agent-secure";

const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
const MAX_ENV_FILE_BYTES = 64 * 1024;

export const writeGovernessEnvironmentFile = (
  path: string,
  assignments: readonly string[]
): void => {
  const values: Record<string, string> = {};
  for (const assignment of assignments) {
    const separator = assignment.indexOf("=");
    const key = assignment.slice(0, separator);
    if (!(separator > 0 && ENV_KEY_RE.test(key))) {
      throw new Error("Governess environment assignment is invalid");
    }
    values[key] = assignment.slice(separator + 1);
  }
  const content = `${JSON.stringify(values)}\n`;
  if (Buffer.byteLength(content, "utf8") > MAX_ENV_FILE_BYTES) {
    throw new Error("Governess environment file exceeds its byte limit");
  }
  writeFileSync(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  chmodSync(path, 0o600);
};

export const consumeGovernessEnvironmentFile = (
  path: string
): Record<string, string> => {
  const pathStat = lstatSync(path);
  if (
    !pathStat.isFile() ||
    pathStat.isSymbolicLink() ||
    pathStat.uid !== process.getuid?.() ||
    pathStat.nlink !== 1 ||
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX permission masks require bitwise inspection.
    (pathStat.mode & 0o777) !== 0o600
  ) {
    throw new Error("Governess environment file is not private and owned");
  }
  let descriptor: number | undefined;
  let content: string;
  try {
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags require bitwise composition.
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.size > MAX_ENV_FILE_BYTES ||
      stat.uid !== pathStat.uid ||
      stat.mode !== pathStat.mode ||
      stat.nlink !== 1 ||
      stat.dev !== pathStat.dev ||
      stat.ino !== pathStat.ino
    ) {
      throw new Error("Governess environment file is invalid");
    }
    content = readFileSync(descriptor, "utf8");
    const unlinkTarget = lstatSync(path);
    if (
      unlinkTarget.dev !== stat.dev ||
      unlinkTarget.ino !== stat.ino ||
      unlinkTarget.uid !== stat.uid ||
      unlinkTarget.mode !== stat.mode ||
      unlinkTarget.nlink !== 1
    ) {
      throw new Error("Governess environment file identity changed");
    }
    unlinkSync(path);
    const unlinked = fstatSync(descriptor);
    if (
      unlinked.dev !== stat.dev ||
      unlinked.ino !== stat.ino ||
      unlinked.uid !== stat.uid ||
      unlinked.mode !== stat.mode ||
      unlinked.nlink !== 0
    ) {
      throw new Error("Governess environment file was not consumed once");
    }
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
  const parsed: unknown = JSON.parse(content);
  if (!(parsed && typeof parsed === "object" && !Array.isArray(parsed))) {
    throw new Error("Governess environment payload is invalid");
  }
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!(ENV_KEY_RE.test(key) && typeof value === "string")) {
      throw new Error("Governess environment payload is invalid");
    }
    values[key] = value;
  }
  return values;
};
