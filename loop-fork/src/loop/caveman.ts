import cavemanSkillMarkdown from "caveman-installer/skills/caveman/SKILL.md" with {
  type: "text",
};
import type { CavemanMode } from "./types";

export const CAVEMAN_UPSTREAM_SHA = "0d95a81d35a9f2d123a5e9430d1cfc43d55f1bb0";
export const CAVEMAN_UPSTREAM_SHORT_SHA = CAVEMAN_UPSTREAM_SHA.slice(0, 7);
export const DEFAULT_CAVEMAN_MODE: CavemanMode = "lite";
export const DEFAULT_HELPER_CAVEMAN_MODE: CavemanMode = "full";

const CAVEMAN_MODES = new Set<CavemanMode>(["off", "lite", "full", "ultra"]);
const FRONTMATTER_RE = /^---[\s\S]*?---\s*/;
const INTENSITY_TABLE_ROW_RE = /^\|\s*\*\*(\S+?)\*\*\s*\|\s*(.*?)\s*\|\s*$/;
const INTENSITY_EXAMPLE_RE = /^- (\S+?):\s/;

const LOOP_EXACTNESS_OVERLAY = [
  "Loop compatibility boundary:",
  "- Compress explanatory prose and final summaries only.",
  "- Preserve code, commands, paths, URLs, JSON, errors, SHAs, resolver output, bridge identifiers, verdict text, citations, and evidence exactly.",
  "- Use normal clear prose whenever compression could make ordering, authority, scope, or safety ambiguous.",
].join("\n");

export const parseCavemanMode = (
  value: string | undefined,
  source: string
): CavemanMode => {
  const normalized = value?.trim().toLowerCase() as CavemanMode | undefined;
  if (normalized && CAVEMAN_MODES.has(normalized)) {
    return normalized;
  }
  throw new Error(
    `Invalid ${source} value: ${value ?? ""}; expected off, lite, full, or ultra`
  );
};

const stripFrontmatter = (value: string): string =>
  value.replace(FRONTMATTER_RE, "");

// Match Caveman's own SessionStart filtering: retain only the selected
// intensity row/example while keeping its complete safety and exactness rules.
const filteredUpstreamSkill = (mode: Exclude<CavemanMode, "off">): string =>
  stripFrontmatter(cavemanSkillMarkdown)
    .split("\n")
    .reduce<string[]>((lines, line) => {
      const tableRow = line.match(INTENSITY_TABLE_ROW_RE);
      if (tableRow) {
        if (tableRow[1] === mode) {
          lines.push(line);
        }
        return lines;
      }
      const example = line.match(INTENSITY_EXAMPLE_RE);
      if (example) {
        if (example[1] === mode) {
          lines.push(line);
        }
        return lines;
      }
      lines.push(line);
      return lines;
    }, [])
    .join("\n")
    .trim();

const upstreamIntensityRule = (mode: Exclude<CavemanMode, "off">): string => {
  for (const line of stripFrontmatter(cavemanSkillMarkdown).split("\n")) {
    const match = line.match(INTENSITY_TABLE_ROW_RE);
    if (match?.[1] === mode && match[2]) {
      return match[2];
    }
  }
  throw new Error(`Pinned Caveman skill is missing the ${mode} intensity rule`);
};

export const cavemanAgentGuidance = (mode: CavemanMode): string =>
  mode === "off"
    ? ""
    : [
        `CAVEMAN MODE ACTIVE — level: ${mode}`,
        `Upstream: JuliusBrussee/caveman@${CAVEMAN_UPSTREAM_SHORT_SHA}`,
        filteredUpstreamSkill(mode),
        LOOP_EXACTNESS_OVERLAY,
      ].join("\n\n");

// Helpers get the selected upstream intensity row plus the hook's compact
// boundaries once in their system prompt, avoiding the full skill cost on
// every model round while retaining meaningful lite/full/ultra semantics.
export const cavemanHelperReinforcement = (mode: CavemanMode): string =>
  mode === "off"
    ? ""
    : [
        `CAVEMAN MODE ACTIVE (${mode}). ${upstreamIntensityRule(mode)}`,
        "Code/commits/PRs/security: write normal.",
        "Compress final explanatory prose only. Keep commands, paths, JSON, errors, SHAs, citations, evidence, and broker results exact. Use normal prose if brevity creates ambiguity.",
      ].join(" ");
