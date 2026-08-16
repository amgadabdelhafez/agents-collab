import { expect, test } from "bun:test";
import {
  createUtilityRouteRequest,
  utilityRequestRequiresScopeAudit,
} from "../../src/loop/task-router";
import {
  assertUtilityScopeAuditCollectionForRequest,
  assertUtilityScopeAuditEvidence,
  buildUtilityScopeAuditCollection,
  buildUtilityScopeAuditEvidence,
  parseGitDiffScopeRecords,
  parseGitStatusScopeRecords,
  type UtilityScopeAuditRecord,
} from "../../src/loop/utility-scope-audit";

const modifiedRecord = (path = "src/tracked.ts"): UtilityScopeAuditRecord => ({
  indexStatus: ".",
  kind: "modified",
  path,
  routing: "helper-visible",
  surfaces: ["worktree"],
  worktreeStatus: "M",
});

test("parses porcelain-v2 staged, unstaged, renamed, untracked, and whitespace-safe paths", () => {
  const raw = [
    "1 A. N... 000000 100644 100644 zero index added path.ts",
    "1 .D N... 100644 100644 000000 head index deleted path.ts",
    "2 R. N... 100644 100644 100644 head index R100 renamed path.ts",
    "old path.ts",
    "? specs/d16-fixture/spec.md",
    "",
  ].join("\0");

  expect(parseGitStatusScopeRecords(raw)).toEqual([
    {
      indexStatus: "A",
      kind: "added",
      path: "added path.ts",
      routing: "helper-visible",
      surfaces: ["index"],
      worktreeStatus: ".",
    },
    {
      indexStatus: ".",
      kind: "deleted",
      path: "deleted path.ts",
      routing: "helper-visible",
      surfaces: ["worktree"],
      worktreeStatus: "D",
    },
    {
      indexStatus: "R",
      kind: "renamed",
      path: "renamed path.ts",
      previousPath: "old path.ts",
      routing: "helper-visible",
      surfaces: ["index"],
      worktreeStatus: ".",
    },
    {
      kind: "untracked",
      path: "specs/d16-fixture/spec.md",
      routing: "metadata-only",
      surfaces: ["untracked"],
    },
  ]);
});

test("parses NUL-delimited committed added, deleted, rename, and copy identity", () => {
  const raw = [
    "A",
    "added file.ts",
    "D",
    "deleted file.ts",
    "R100",
    "old name.ts",
    "new name.ts",
    "C075",
    "copy source.ts",
    "copy destination.ts",
    "",
  ].join("\0");

  expect(parseGitDiffScopeRecords(raw, "commit")).toEqual([
    {
      kind: "added",
      path: "added file.ts",
      routing: "helper-visible",
      surfaces: ["commit"],
    },
    {
      kind: "deleted",
      path: "deleted file.ts",
      routing: "helper-visible",
      surfaces: ["commit"],
    },
    {
      kind: "renamed",
      path: "new name.ts",
      previousPath: "old name.ts",
      routing: "helper-visible",
      surfaces: ["commit"],
    },
    {
      kind: "copied",
      path: "copy destination.ts",
      previousPath: "copy source.ts",
      routing: "helper-visible",
      surfaces: ["commit"],
    },
  ]);
});

test("canonical evidence is sorted, hashed, replay-stable, and clean only for zero records", () => {
  const evidence = buildUtilityScopeAuditEvidence(
    { mode: "status", paths: ["src"] },
    [modifiedRecord("src/z.ts"), modifiedRecord("src/a.ts")]
  );

  expect(evidence).toMatchObject({ clean: false, count: 2, schemaVersion: 1 });
  expect(evidence.records.map((record) => record.path)).toEqual([
    "src/a.ts",
    "src/z.ts",
  ]);
  expect(evidence.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(assertUtilityScopeAuditEvidence(evidence)).toEqual(evidence);
  expect(
    buildUtilityScopeAuditEvidence({ mode: "status", paths: ["src"] }, [])
  ).toMatchObject({
    clean: true,
    count: 0,
    records: [],
    sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
});

test("rejects duplicate, malformed, truncated, count, hash, and clean-bit evidence", () => {
  const evidence = buildUtilityScopeAuditEvidence(
    { mode: "status", paths: ["src"] },
    [modifiedRecord()]
  );
  expect(() =>
    buildUtilityScopeAuditEvidence({ mode: "status", paths: ["src"] }, [
      modifiedRecord(),
      modifiedRecord(),
    ])
  ).toThrow("duplicates");

  for (const tampered of [
    { ...evidence, clean: true },
    { ...evidence, count: 2 },
    { ...evidence, records: [] },
    { ...evidence, sha256: "0".repeat(64) },
    {
      ...evidence,
      records: [{ ...evidence.records[0], kind: "invented" }],
    },
    {
      ...evidence,
      records: [{ ...evidence.records[0], path: "../outside.ts" }],
    },
  ]) {
    expect(() => assertUtilityScopeAuditEvidence(tampered)).toThrow();
  }
  expect(() => parseGitDiffScopeRecords("R100\0old.ts\0", "commit")).toThrow(
    "destination"
  );
  expect(() => parseGitDiffScopeRecords("M\0src/tracked.ts", "commit")).toThrow(
    "NUL-terminated"
  );
  expect(() =>
    parseGitStatusScopeRecords(
      "2 R. N... 100644 100644 100644 head index R100 new.ts\0"
    )
  ).toThrow("previous path");
  expect(() =>
    parseGitStatusScopeRecords(
      "1 .M N... 100644 100644 100644 head index src/tracked.ts"
    )
  ).toThrow("NUL-terminated");
});

const BASE_SHA = "1".repeat(40);
const HEAD_SHA = "2".repeat(40);
const OTHER_HEAD_SHA = "3".repeat(40);

const scopeRequest = (
  overrides: Partial<Parameters<typeof createUtilityRouteRequest>[0]> = {}
) =>
  createUtilityRouteRequest({
    acceptanceCriteria: ["return complete Git evidence"],
    authority: {},
    executionProfile: "git-diff",
    kind: "review",
    objective: "Audit declared Git scope",
    readScope: ["src"],
    requester: "codex",
    requiredCapabilities: ["inspect"],
    reviewMode: "utility-audit",
    risk: "low",
    workShape: "separable",
    writeScope: [],
    ...overrides,
  });

const cleanManifest = (
  query: Parameters<typeof buildUtilityScopeAuditEvidence>[0]
) => buildUtilityScopeAuditEvidence(query, []);

test("validates exact Git mode, literal range, and path coverage", () => {
  const request = scopeRequest({
    executionGitDiff: {
      base: BASE_SHA,
      head: HEAD_SHA,
      kind: "range",
      operator: "...",
    },
    readScope: ["src", "tests"],
  });
  const valid = buildUtilityScopeAuditCollection([
    cleanManifest({
      baseRef: BASE_SHA,
      headRef: HEAD_SHA,
      mode: "diff-range",
      paths: ["tests", "src"],
      rangeOperator: "...",
    }),
  ]);

  expect(assertUtilityScopeAuditCollectionForRequest(request, valid)).toEqual(
    valid
  );
  expect(() =>
    assertUtilityScopeAuditCollectionForRequest(
      request,
      buildUtilityScopeAuditCollection([
        cleanManifest({
          baseRef: BASE_SHA,
          headRef: HEAD_SHA,
          mode: "diff-range",
          paths: ["src"],
          rangeOperator: "...",
        }),
      ])
    )
  ).toThrow("scope-audit-paths-narrowed");
  expect(() =>
    assertUtilityScopeAuditCollectionForRequest(
      request,
      buildUtilityScopeAuditCollection([
        cleanManifest({
          baseRef: BASE_SHA,
          headRef: OTHER_HEAD_SHA,
          mode: "diff-range",
          paths: ["src", "tests"],
          rangeOperator: "...",
        }),
      ])
    )
  ).toThrow("scope-audit-range-mismatch");
  expect(() =>
    assertUtilityScopeAuditCollectionForRequest(
      request,
      buildUtilityScopeAuditCollection([
        cleanManifest({ mode: "diff-index", paths: ["src", "tests"] }),
      ])
    )
  ).toThrow("scope-audit-mode-mismatch");
});

test("allows legacy undeclared worktree but rejects orphan range evidence", () => {
  const request = scopeRequest();
  const worktree = buildUtilityScopeAuditCollection([
    cleanManifest({ mode: "diff-worktree", paths: ["src"] }),
  ]);
  expect(
    assertUtilityScopeAuditCollectionForRequest(request, worktree)
  ).toEqual(worktree);

  expect(() =>
    assertUtilityScopeAuditCollectionForRequest(
      request,
      buildUtilityScopeAuditCollection([
        cleanManifest({
          baseRef: BASE_SHA,
          headRef: HEAD_SHA,
          mode: "diff-range",
          paths: ["src"],
          rangeOperator: "...",
        }),
      ])
    )
  ).toThrow("scope-audit-orphan-manifest");
});

test("one union manifest covers same-selection read-plan steps only", () => {
  const request = scopeRequest({
    executionPlan: [
      {
        executionGitDiff: { kind: "worktree" },
        executionProfile: "git-diff",
        objective: "Audit source",
        readScope: ["src"],
      },
      {
        executionGitDiff: { kind: "worktree" },
        executionProfile: "git-diff",
        objective: "Audit tests",
        readScope: ["tests"],
      },
    ],
    executionProfile: "read-plan",
    readScope: ["src", "tests"],
  });
  const union = buildUtilityScopeAuditCollection([
    cleanManifest({ mode: "diff-worktree", paths: ["tests", "src"] }),
  ]);
  expect(assertUtilityScopeAuditCollectionForRequest(request, union)).toEqual(
    union
  );
  expect(() =>
    assertUtilityScopeAuditCollectionForRequest(
      request,
      buildUtilityScopeAuditCollection([
        cleanManifest({ mode: "diff-worktree", paths: ["src", "other"] }),
      ])
    )
  ).toThrow("scope-audit-paths-narrowed");
});

test("distinct ranges coexist canonically while duplicate query keys fail", () => {
  const first = cleanManifest({
    baseRef: BASE_SHA,
    headRef: HEAD_SHA,
    mode: "diff-range",
    paths: ["src"],
    rangeOperator: "...",
  });
  const second = cleanManifest({
    baseRef: BASE_SHA,
    headRef: OTHER_HEAD_SHA,
    mode: "diff-range",
    paths: ["src"],
    rangeOperator: "...",
  });
  const collection = buildUtilityScopeAuditCollection([second, first]);
  expect(
    collection.manifests.map((manifest) => manifest.query.headRef)
  ).toEqual([HEAD_SHA, OTHER_HEAD_SHA]);
  expect(() => buildUtilityScopeAuditCollection([first, first])).toThrow(
    "duplicate queries"
  );
});

test("non-Git requests accept no collection and reject orphan manifests", () => {
  const request = scopeRequest({
    executionProfile: "search",
    readScope: ["src"],
  });
  expect(assertUtilityScopeAuditCollectionForRequest(request, undefined)).toBe(
    undefined
  );
  expect(() =>
    assertUtilityScopeAuditCollectionForRequest(
      request,
      buildUtilityScopeAuditCollection([
        cleanManifest({ mode: "diff-worktree", paths: ["src"] }),
      ])
    )
  ).toThrow("scope-audit-orphan-manifest");
});

test("classifies top-level and read-plan Git scope independent of request kind", () => {
  expect(
    utilityRequestRequiresScopeAudit(
      scopeRequest({ executionProfile: "git-status", kind: "inspect" })
    )
  ).toBe(true);
  expect(
    utilityRequestRequiresScopeAudit(
      scopeRequest({ executionProfile: "git-diff", kind: "command" })
    )
  ).toBe(true);
  expect(
    utilityRequestRequiresScopeAudit(
      scopeRequest({
        executionPlan: [
          {
            executionGitDiff: { kind: "index" },
            executionProfile: "git-diff",
            objective: "Audit the index",
            readScope: ["src"],
          },
        ],
        executionProfile: "read-plan",
        kind: "inspect",
      })
    )
  ).toBe(true);
  expect(
    utilityRequestRequiresScopeAudit(
      scopeRequest({ executionProfile: "search", kind: "review" })
    )
  ).toBe(false);
});
