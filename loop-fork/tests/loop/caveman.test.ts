import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import cavemanSkillMarkdown from "caveman-installer/skills/caveman/SKILL.md" with {
  type: "text",
};
import {
  CAVEMAN_UPSTREAM_SHA,
  cavemanAgentGuidance,
  cavemanHelperReinforcement,
  parseCavemanMode,
} from "../../src/loop/caveman";

test("Caveman integration stays pinned and keeps upstream safety rules", () => {
  expect(CAVEMAN_UPSTREAM_SHA).toBe("0d95a81d35a9f2d123a5e9430d1cfc43d55f1bb0");
  expect(createHash("sha256").update(cavemanSkillMarkdown).digest("hex")).toBe(
    "5e30bb56afbd0b01bd736f2da84180e76f18db4a64de8e124525d5c8dc2e8605"
  );
  const guidance = cavemanAgentGuidance("lite");
  expect(guidance).toContain("CAVEMAN MODE ACTIVE — level: lite");
  expect(guidance).toContain("## Auto-Clarity");
  expect(guidance).toContain("Security warnings");
  expect(guidance).toContain(
    "| **lite** | No filler/hedging. Keep articles + full sentences. Professional but tight |"
  );
  expect(guidance).not.toContain("| **full** | Drop articles");
});

test("Loop exactness overlay protects machine-readable artifacts", () => {
  const guidance = cavemanAgentGuidance("ultra");
  expect(guidance).toContain(
    "Preserve code, commands, paths, URLs, JSON, errors, SHAs, resolver output, bridge identifiers, verdict text, citations, and evidence exactly."
  );
  expect(guidance).toContain(
    "Use normal clear prose whenever compression could make ordering, authority, scope, or safety ambiguous."
  );
});

test("helper reinforcement is compact and off is an exact opt-out", () => {
  expect(cavemanHelperReinforcement("full")).toContain(
    "CAVEMAN MODE ACTIVE (full). Drop articles, fragments OK, short synonyms."
  );
  expect(cavemanHelperReinforcement("lite")).toContain(
    "Keep articles + full sentences. Professional but tight"
  );
  expect(cavemanHelperReinforcement("lite")).not.toContain("Fragments OK");
  expect(cavemanHelperReinforcement("ultra")).toContain(
    "Strip conjunctions when cause-then-effect stay unambiguous."
  );
  expect(cavemanHelperReinforcement("ultra")).toContain(
    "State each fact once."
  );
  expect(cavemanAgentGuidance("off")).toBe("");
  expect(cavemanHelperReinforcement("off")).toBe("");
});

test("Caveman modes reject unknown values", () => {
  expect(parseCavemanMode("FULL", "test")).toBe("full");
  expect(() => parseCavemanMode("wenyan-full", "test")).toThrow(
    "Invalid test value: wenyan-full; expected off, lite, full, or ultra"
  );
});
