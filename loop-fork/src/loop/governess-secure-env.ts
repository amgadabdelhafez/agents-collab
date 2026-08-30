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
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX permission masks require bitwise inspection.
    (pathStat.mode & 0o077) !== 0
  ) {
    throw new Error("Governess environment file is not private and owned");
  }
  let descriptor: number | undefined;
  let content: string;
  try {
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags require bitwise composition.
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!(stat.isFile() && stat.size <= MAX_ENV_FILE_BYTES)) {
      throw new Error("Governess environment file is invalid");
    }
    content = readFileSync(descriptor, "utf8");
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
  unlinkSync(path);
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
