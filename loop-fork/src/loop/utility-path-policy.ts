import { posix } from "node:path";

const DRIVE_ABSOLUTE_RE = /^[A-Za-z]:\//;
const LEADING_CURRENT_DIRECTORY_RE = /^\.\//;
const TRAILING_SLASH_RE = /\/$/;
const ARCHITECTURE_PATH_RE = /(?:^|\/)docs\/architecture(?:\/|$)/i;
const CONSTITUTION_PATH_RE = /(?:^|\/)specs\/constitution\.md$/i;
const GOVERNING_BASENAME_RE =
  /^(?:(?:AGENT|AGENTS|CLAUDE|CODEX|COPILOT|GEMINI|SKILL)\.md|copilot-instructions\.md|.*\.(?:agent|instructions|prompt)\.md|\.aider\.conf\.yml|\.aiderignore|\.clinerules|\.cursorrules|\.mcp\.json|\.windsurfrules|mcp\.json)$/i;
const GOVERNING_SPEC_RE =
  /(?:^|\/)specs\/[^/]+\/(?:spec|plan|tasks|verify)\.md$/i;
const UTILITY_POLICY_PATH_RE = /(?:^|\/)\.loop\/utility-policy\.json$/i;
const SECRET_BASENAME_RE =
  /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|credentials(?:\..*)?|id_(?:rsa|ed25519)|secrets?(?:\..*)?|.*\.(?:key|p12|pem))$/i;
const UTILITY_CONTEXT_DOC_RE =
  /^(?:README\.md|docs\/.+\.md|specs\/[^/]+\/(?:spec|plan|tasks|verify)\.md)$/i;

export const UTILITY_PROTECTED_DIRECTORY_SEGMENTS = [
  ".aider",
  ".cline",
  ".agents",
  ".aws",
  ".claude",
  ".codex",
  ".config",
  ".continue",
  ".cursor",
  ".docker",
  ".gemini",
  ".github",
  ".git",
  ".gnupg",
  ".kube",
  ".idea",
  ".opencode",
  ".roo",
  ".ssh",
  ".windsurf",
  ".vscode",
] as const;
const PROTECTED_DIRECTORY_SEGMENTS = new Set<string>(
  UTILITY_PROTECTED_DIRECTORY_SEGMENTS
);

export const DEFAULT_UTILITY_PROTECTED_PATHS = [
  ...UTILITY_PROTECTED_DIRECTORY_SEGMENTS,
  ".loop/utility-policy.json",
  "docs/architecture",
  "specs/constitution.md",
] as const;

export const UTILITY_PROTECTED_GIT_GLOBS = [
  ...UTILITY_PROTECTED_DIRECTORY_SEGMENTS.map((segment) => `**/${segment}/**`),
  "**/docs/architecture/**",
  "**/specs/constitution.md",
  "**/specs/*/spec.md",
  "**/specs/*/plan.md",
  "**/specs/*/tasks.md",
  "**/specs/*/verify.md",
  "**/.loop/utility-policy.json",
  "**/AGENT.md",
  "**/AGENTS.md",
  "**/CLAUDE.md",
  "**/CODEX.md",
  "**/COPILOT.md",
  "**/GEMINI.md",
  "**/SKILL.md",
  "**/copilot-instructions.md",
  "**/*.agent.md",
  "**/*.instructions.md",
  "**/*.prompt.md",
  "**/.aider.conf.yml",
  "**/.aiderignore",
  "**/.clinerules",
  "**/.cursorrules",
  "**/.mcp.json",
  "**/.windsurfrules",
  "**/mcp.json",
] as const;

export const normalizeUtilityPolicyPath = (value: string): string => {
  const portable = value.trim().replaceAll("\\", "/");
  if (!portable) {
    return "";
  }
  const normalized = posix.normalize(portable);
  return normalized === "./"
    ? "."
    : normalized
        .replace(LEADING_CURRENT_DIRECTORY_RE, "")
        .replace(TRAILING_SLASH_RE, "");
};

export const utilityPathWithin = (path: string, parent: string): boolean =>
  path === parent || path.startsWith(`${parent}/`);

export const isUtilityContextRefPath = (value: string): boolean => {
  const portable = value.trim().replaceAll("\\", "/");
  if (
    portable.length > 500 ||
    portable.startsWith("/") ||
    DRIVE_ABSOLUTE_RE.test(portable) ||
    portable.includes("\0") ||
    portable.split("/").includes("..")
  ) {
    return false;
  }
  const normalized = normalizeUtilityPolicyPath(value);
  if (
    !normalized ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    DRIVE_ABSOLUTE_RE.test(normalized) ||
    normalized.includes("\0") ||
    !UTILITY_CONTEXT_DOC_RE.test(normalized)
  ) {
    return false;
  }
  const segments = normalized.split("/").filter(Boolean);
  return !segments.some(
    (segment) =>
      PROTECTED_DIRECTORY_SEGMENTS.has(segment.toLowerCase()) ||
      SECRET_BASENAME_RE.test(segment) ||
      GOVERNING_BASENAME_RE.test(segment)
  );
};

export const isUtilityProtectedPath = (
  value: string,
  configured: readonly string[] = []
): boolean => {
  const normalized = normalizeUtilityPolicyPath(value);
  if (
    !normalized ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    DRIVE_ABSOLUTE_RE.test(normalized) ||
    normalized.includes("\0")
  ) {
    return true;
  }
  const segments = normalized.split("/").filter(Boolean);
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const base = segments.at(-1) ?? "";
  if (
    lowerSegments.some((segment) =>
      PROTECTED_DIRECTORY_SEGMENTS.has(segment)
    ) ||
    segments.some((segment) => SECRET_BASENAME_RE.test(segment)) ||
    GOVERNING_BASENAME_RE.test(base) ||
    GOVERNING_SPEC_RE.test(normalized) ||
    ARCHITECTURE_PATH_RE.test(normalized) ||
    CONSTITUTION_PATH_RE.test(normalized) ||
    UTILITY_POLICY_PATH_RE.test(normalized)
  ) {
    return true;
  }
  return [...DEFAULT_UTILITY_PROTECTED_PATHS, ...configured]
    .map(normalizeUtilityPolicyPath)
    .filter(Boolean)
    .some((protectedPath) =>
      utilityPathWithin(normalized.toLowerCase(), protectedPath.toLowerCase())
    );
};
