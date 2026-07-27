import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendDelegationEvent,
  classifyDelegationIntent,
  makeDelegationEvent,
  readDelegationEvents,
  recordCodexAppServerDelegationCandidate,
  resolveUtilityDelegationMode,
} from "../../src/loop/delegation-policy";

const ROOT = "/repo";

const classify = (
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd = ROOT
) =>
  classifyDelegationIntent({
    agent: "claude",
    cwd,
    repoRoot: ROOT,
    toolInput,
    toolName,
    toolUseId: "tool-1",
  });

describe("delegation classifier", () => {
  test("routes large safe reads but keeps small and governing reads direct", () => {
    expect(
      classify("Read", { file_path: "/repo/src/parser.ts", limit: 300 })
    ).toMatchObject({
      eligible: true,
      operation: "large-read",
      request: { readScope: ["src/parser.ts"] },
    });
    expect(
      classify("Read", { file_path: "src/parser.ts", limit: 80 })
    ).toMatchObject({ eligible: false, reason: "small-context-read" });
    expect(
      classify("Read", {
        file_path: "specs/lower-agent-adoption/spec.md",
        limit: 300,
      })
    ).toMatchObject({ eligible: false, reason: "governed-or-unsafe-path" });
    expect(
      classify("Read", { file_path: "../outside.txt", limit: 300 })
    ).toMatchObject({ eligible: false, reason: "governed-or-unsafe-path" });
  });

  test.each([
    "AGENTS.md",
    ".aws/config",
    ".claude/settings.json",
    "packages/api/.aws/config",
    "packages/api/.claude/settings.json",
    "fixtures/repo/.git/config",
    "packages/api/specs/auth/spec.md",
    "packages/api/docs/architecture/invariants.md",
    ".github/copilot-instructions.md",
    ".github/copilot/mcp.json",
    ".github/agents/reviewer.agent.md",
    ".cursor/rules/project.mdc",
    ".gemini/settings.json",
    ".windsurfrules",
    ".vscode/mcp.json",
    ".mcp.json",
    ".CLAUDE/settings.json",
    "packages/api/.AWS/config",
    "fixtures/repo/.GIT/config",
    "docs/architecture/system-overview.md",
    ".loop/utility-policy.json",
    ".env.local",
    ".ssh/id_ed25519",
    "package.json",
  ])("keeps protected or governing read direct: %s", (filePath) => {
    expect(classify("Read", { file_path: filePath, limit: 300 })).toMatchObject(
      { eligible: false, reason: "governed-or-unsafe-path" }
    );
  });

  test.each([
    ["Read", { file_path: ".claude/settings.json", limit: 300 }],
    ["Grep", { path: ".aws", pattern: "profile" }],
    ["Glob", { path: ".claude", pattern: ".claude/**/*.json" }],
    ["Bash", { command: "rg profile .aws" }],
    ["Bash", { command: "git diff -- .claude/settings.json" }],
    ["Bash", { command: "sed -n '1,300p' .aws/config" }],
    ["Bash", { command: "bun test .claude/hooks.test.ts" }],
    ["Bash", { command: "rg profile packages/api/.aws" }],
    ["Bash", { command: "sed -n '1,300p' .github/copilot-instructions.md" }],
    ["Bash", { command: "rg rule packages/api/.CURSOR" }],
  ])("rejects protected scope for every enforceable tool grammar: %s", (tool, input) => {
    expect(classify(tool, input)).toMatchObject({ eligible: false });
  });

  test("routes bounded searches but keeps Glob non-delegable", () => {
    expect(
      classify("Grep", { path: "src/loop", pattern: "route_task" })
    ).toMatchObject({
      eligible: true,
      operation: "scoped-search",
      request: { readScope: ["src/loop"] },
    });
    expect(classify("Grep", { pattern: "route_task" })).toMatchObject({
      eligible: false,
      reason: "unbounded-or-sensitive-search",
    });
    // Glob is not delegable: no broker tool (search_repo is text-only;
    // run_check allowlists only bun test / npx vitest) can list files by glob,
    // so a scoped-glob request could never be satisfied. Fails closed.
    expect(classify("Glob", { pattern: "src/loop/**/*.ts" })).toMatchObject({
      eligible: false,
      reason: "tool-not-enforceable",
    });
    expect(classify("Glob", { pattern: "**/*.ts" })).toMatchObject({
      eligible: false,
      reason: "tool-not-enforceable",
    });
  });

  // The native Grep tool carries modal parameters (output_mode, -c/-l, glob,
  // type, head_limit, context) that change the evidence kind or narrow scope.
  // The broker search_repo cannot honor them, so a plain content-search request
  // would misrepresent the query — fail closed instead of quietly dropping them.
  test.each([
    { pattern: "import", path: "src", output_mode: "count" },
    { pattern: "import", path: "src", output_mode: "files_with_matches" },
    { pattern: "import", path: "src", "-c": true },
    { pattern: "import", path: "src", "-l": true },
    { pattern: "import", path: "src", glob: "*.md" },
    { pattern: "import", path: "src", type: "ts" },
    { pattern: "import", path: "src", head_limit: 5 },
    { pattern: "import", path: "src", "-A": 3 },
  ])("keeps modal Grep queries direct: %o", (input) => {
    expect(classify("Grep", input as Record<string, unknown>)).toMatchObject({
      eligible: false,
      reason: "grep-modifier-unsupported",
    });
  });

  test("still routes a plain content Grep (content mode, -i/-n allowed)", () => {
    expect(
      classify("Grep", {
        pattern: "route",
        path: "src/loop",
        output_mode: "content",
        "-n": true,
        "-i": true,
      })
    ).toMatchObject({
      eligible: true,
      operation: "scoped-search",
      request: { readScope: ["src/loop"] },
    });
  });

  test.each([
    ["git status --short", "git-status", ["."]],
    ["git diff -- src/loop/tmux.ts", "git-diff", ["src/loop/tmux.ts"]],
    ["git diff --name-only -- src/loop", "git-diff", ["src/loop"]],
    ["git diff --cached -- src/loop", "git-diff", ["src/loop"]],
    ["rg -n 'route|worker' src/loop", "scoped-search", ["src/loop"]],
    ["sed -n '20,80p' src/loop/tmux.ts", "source-slice", ["src/loop/tmux.ts"]],
  ])("routes exact mechanical command %s", (command, operation, readScope) => {
    expect(classify("Bash", { command })).toMatchObject({
      eligible: true,
      operation,
      request: { readScope },
    });
  });

  // Broker-unsatisfiable shapes are dropped from the grammar and handled
  // natively: run_check can only satisfy a directory-scoped cwd + regular-file
  // target, which the leaf-file focused-check scope never provided; git_diff
  // has no --stat/--name-status/-U capability.
  test.each([
    ["bun test tests/router.test.ts", "command-not-in-delegation-grammar"],
    [
      "npx vitest run tests/router.test.ts",
      "command-not-in-delegation-grammar",
    ],
    ["git diff --stat -- src/loop", "unsupported-git-diff-option"],
    ["git diff --name-status -- src/loop", "unsupported-git-diff-option"],
    ["git diff -U0 -- src/loop", "unsupported-git-diff-option"],
    ["git diff -U40 -- src/loop", "unsupported-git-diff-option"],
  ])("drops broker-unsatisfiable shape %s", (command, reason) => {
    expect(classify("Bash", { command })).toMatchObject({
      eligible: false,
      reason,
    });
  });

  // Inside double quotes bash keeps a backslash before an ordinary character
  // (only $ ` " \ newline escape), so the true path contains a backslash and
  // safeScope must reject it rather than silently drop the backslash and route
  // a different in-repo path.
  test("rejects a double-quoted backslash instead of dropping it", () => {
    expect(classify("Bash", { command: 'rg foo "sr\\c"' })).toMatchObject({
      eligible: false,
    });
  });

  // Unquoted parentheses are shell metacharacters; bash never treats them as a
  // literal path segment, so they must fail closed like ; & | etc.
  test.each([
    ["rg foo (bar)", "compound-or-unsafe-command"],
    ["git diff -- (x)", "compound-or-unsafe-command"],
  ])("rejects unquoted parentheses %s", (command, reason) => {
    expect(classify("Bash", { command })).toMatchObject({
      eligible: false,
      reason,
    });
  });

  test.each([
    ["git diff", "git-diff-without-path-scope"],
    ["git commit -am done", "command-not-in-delegation-grammar"],
    ["rg route src && npm test", "compound-or-unsafe-command"],
    ["npx vitest run", "command-not-in-delegation-grammar"],
    ["sed -n '1,900p' src/loop/tmux.ts", "source-slice-out-of-bounds"],
    ["echo API_KEY=abcdefghijklmnop", "compound-or-unsafe-command"],
  ])("keeps unsafe or ambiguous command direct: %s", (command, reason) => {
    expect(classify("Bash", { command })).toMatchObject({
      eligible: false,
      reason,
    });
  });

  test("uses enforce by default and observe for invalid modes", () => {
    expect(resolveUtilityDelegationMode(undefined)).toBe("enforce");
    expect(resolveUtilityDelegationMode("enforce")).toBe("enforce");
    expect(resolveUtilityDelegationMode("observe")).toBe("observe");
    expect(resolveUtilityDelegationMode("off")).toBe("off");
    expect(resolveUtilityDelegationMode("surprise")).toBe("observe");
  });

  test.each([
    ["rg -n route src/loop | head -50", "scoped-search", ["src/loop"]],
    ["rg -n route src/loop | head -n 50", "scoped-search", ["src/loop"]],
    ["rg -n route src/loop | tail -20", "scoped-search", ["src/loop"]],
    ["git status --short | head -20", "git-status", ["."]],
    ["rg -n route src/loop 2>/dev/null", "scoped-search", ["src/loop"]],
    [
      "sed -n '20,80p' src/loop/tmux.ts 2>/dev/null",
      "source-slice",
      ["src/loop/tmux.ts"],
    ],
    ["cd src/loop && rg -n route .", "scoped-search", ["src/loop"]],
    [
      "cd src && rg -n route . 2>/dev/null | head -50",
      "scoped-search",
      ["src"],
    ],
  ])("routes decomposed safe compound command %s", (command, operation, readScope) => {
    expect(classify("Bash", { command })).toMatchObject({
      eligible: true,
      operation,
      request: { readScope },
    });
  });

  // An output-limiting filter must be carried into the delegated request, never
  // silently dropped: the worker has to honor the same bound the operator asked
  // for, and a degenerate/absent bound must not read as "no limit".
  test.each([
    ["rg -n route src/loop | head -50", "first 50"],
    ["rg -n route src/loop | head -n 50", "first 50"],
    ["rg -n route src/loop | tail -20", "last 20"],
  ])("carries the output-filter bound into the delegated objective for %s", (command, expected) => {
    const classified = classify("Bash", { command });
    expect(classified.eligible).toBe(true);
    if (classified.eligible) {
      expect(classified.request.objective).toContain(expected);
    }
  });

  // A leading in-repo `cd` folds only into an inspect read scope. It never
  // rescues a command the grammar does not delegate, so a folded test-runner
  // (dropped as broker-unsatisfiable) stays native.
  test("does not let a folded cd rescue a non-grammar command", () => {
    expect(
      classify("Bash", {
        command: "cd packages/api && npx vitest run tests/router.test.ts",
      })
    ).toMatchObject({
      eligible: false,
      reason: "command-not-in-delegation-grammar",
    });
  });

  // Bash ignores everything after an unquoted `#`; the classifier must too, or
  // it fabricates read scopes the real command never touches.
  test("stops at an unquoted comment like bash", () => {
    expect(
      classify("Bash", { command: "rg -n route src #note" })
    ).toMatchObject({
      eligible: true,
      operation: "scoped-search",
      request: { readScope: ["src"] },
    });
  });

  test.each([
    ["rg route src | xargs rm", "compound-or-unsafe-command"],
    ["rg route src | head -20 | wc -l", "compound-or-unsafe-command"],
    ["rg route src | head -n many", "compound-or-unsafe-command"],
    ["rg route src | wc -l extra.txt", "compound-or-unsafe-command"],
    // A count/aggregate filter changes the kind of evidence, so it must not
    // reduce to a full content search — it fails closed instead.
    ["rg -n route src/loop | wc -l", "compound-or-unsafe-command"],
    // A degenerate output bound (zero lines) is never a valid filter.
    ["rg route src | head -0", "compound-or-unsafe-command"],
    ["rg route src | head -n 0", "compound-or-unsafe-command"],
    ["rg route src > findings.txt", "compound-or-unsafe-command"],
    ["rg route src 2>/tmp/errors", "compound-or-unsafe-command"],
    ["rg route src 2> /dev/null", "compound-or-unsafe-command"],
    ["rg route src || rg route tests", "compound-or-unsafe-command"],
    ["git add . && git commit -m done", "compound-or-unsafe-command"],
    ["cd src && cd tests && ls", "compound-or-unsafe-command"],
    // `cd -` is $OLDPWD, not a literal in-repo path; it must not fold.
    ["cd - && rg -n route .", "compound-or-unsafe-command"],
    ["cd /tmp && rg route .", "cd-without-safe-scope"],
    ["cd ../elsewhere && ls", "cd-without-safe-scope"],
    ["cd .claude && ls", "cd-without-safe-scope"],
    // A tilde is never expanded by node's path join; it must fail closed, not
    // fold to a literal "~" scope inside the repo.
    ["cd ~ && wc -l .zsh_history", "cd-without-safe-scope"],
    ["cd src && rm -rf .", "command-not-in-delegation-grammar"],
    ["echo hello | head -2", "command-not-in-delegation-grammar"],
    // `ls` has no broker tool that can satisfy it, so it left the grammar.
    ["ls", "command-not-in-delegation-grammar"],
    ["ls src/loop", "command-not-in-delegation-grammar"],
    ["ls -R src", "command-not-in-delegation-grammar"],
    ["ls /etc", "command-not-in-delegation-grammar"],
    // Unquoted glob metacharacters fail closed at the tokenizer (bash expands).
    ["ls src/*.ts", "compound-or-unsafe-command"],
    // `wc -l` left the grammar: line-count on a directory target is
    // unsatisfiable by any broker tool and cannot be told from a file lexically.
    ["wc -l", "command-not-in-delegation-grammar"],
    ["wc -l src", "command-not-in-delegation-grammar"],
    ["wc -c src/loop/tmux.ts", "command-not-in-delegation-grammar"],
    ["wc -l ../outside.txt", "command-not-in-delegation-grammar"],
    // An empty quoted arg must be preserved, not silently dropped: without it
    // `rg '' src` would be misread as `rg src` (pattern "src"); with it the
    // empty pattern is correctly rejected as unbounded.
    ["rg '' src", "unbounded-or-sensitive-search"],
    ["head -n 200 ~/.netrc", "governed-or-unsafe-path"],
    ["rg -n password ~", "search-without-safe-scope"],
    // Brace/glob expansion is not evaluated; unquoted expansion metacharacters
    // fail closed at the tokenizer — including in the rg pattern slot, which
    // safeScope never sees (bash would expand the brace into an out-of-repo arg).
    ["rg -n route src/{loop,../../../etc}", "compound-or-unsafe-command"],
    ["rg {x,/etc/hosts} src", "compound-or-unsafe-command"],
    ["rg {x,.env} src", "compound-or-unsafe-command"],
    // An unknown rg flag (e.g. --pre runs an arbitrary program per file) must
    // be rejected, not treated as the search pattern.
    ["rg --pre tools/evil.sh needle src", "unsupported-rg-option"],
    // git magic pathspec (:(exclude), :!) is not a literal path — it would diff
    // everything *except* the named path, leaking governed files past readScope.
    ["git diff -- :/src", "git-diff-magic-pathspec"],
    ["git diff -- :!src", "git-diff-magic-pathspec"],
    // A no-break space splits under JS \s but not under bash IFS.
    ["rg -n route src\u00a0evil", "compound-or-unsafe-command"],
    ["wc -l src/a.ts\nrm -rf src", "compound-or-unsafe-command"],
    // Backslash-newline must not smuggle a raw newline past the guard.
    ['wc -l "src/a.ts\\\nrm -rf src"', "compound-or-unsafe-command"],
    ["git status --short\rrm -rf .", "compound-or-unsafe-command"],
    [
      "bun test tests/a.test.ts\nrm tests/b.test.ts",
      "compound-or-unsafe-command",
    ],
    ["rg route src \\2>/dev/null", "compound-or-unsafe-command"],
  ])("keeps widened-grammar rejection %s direct with reason %s", (command, reason) => {
    expect(classify("Bash", { command })).toMatchObject({
      eligible: false,
      reason,
    });
  });

  test("keeps repeated tool attempts distinct when hook ids differ", () => {
    const first = classifyDelegationIntent({
      agent: "claude",
      cwd: ROOT,
      repoRoot: ROOT,
      toolInput: { command: "git status --short" },
      toolName: "Bash",
      toolUseId: "tool-1",
    });
    const second = classifyDelegationIntent({
      agent: "claude",
      cwd: ROOT,
      repoRoot: ROOT,
      toolInput: { command: "git status --short" },
      toolName: "Bash",
      toolUseId: "tool-2",
    });
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });
});

describe("safeScope shared hardening covers every classifier", () => {
  // Fixing the shared scope resolver must reject tilde and brace paths for the
  // Read/Grep/Glob tool grammars too, not just Bash.
  test.each([
    ["Read", { file_path: "~/.netrc", limit: 300 }],
    ["Read", { file_path: "~", limit: 300 }],
    ["Grep", { pattern: "secret", path: "~" }],
    ["Grep", { pattern: "route", path: "src/{loop,../../../etc}" }],
  ])("keeps tilde and brace scopes direct for %s", (tool, input) => {
    expect(classify(tool, input as Record<string, unknown>)).toMatchObject({
      eligible: false,
    });
  });

  test("resolves symlinks so an in-repo link pointing outside is rejected", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "deleg-repo-"));
    const outside = mkdtempSync(join(tmpdir(), "deleg-out-"));
    try {
      // A neutral basename: the point is the symlink escape, not a governed
      // secret name (which would be rejected for an unrelated reason).
      writeFileSync(join(outside, "data.txt"), "s".repeat(4096));
      writeFileSync(join(repoRoot, "inside.txt"), "i".repeat(4096));
      symlinkSync(outside, join(repoRoot, "linkout"));
      const read = (filePath: string, toolUseId: string) =>
        classifyDelegationIntent({
          agent: "claude",
          cwd: repoRoot,
          repoRoot,
          toolInput: { file_path: filePath, limit: 300 },
          toolName: "Read",
          toolUseId,
        });
      // Control: a genuine in-repo read stays eligible after canonicalization
      // (root and target are canonicalized together, so /var vs /private/var
      // symlinks on the tmpdir do not cause a false rejection).
      expect(read(join(repoRoot, "inside.txt"), "tool-inside")).toMatchObject({
        eligible: true,
        request: { readScope: ["inside.txt"] },
      });
      // Escape: the symlinked path canonicalizes outside the repo → rejected.
      expect(
        read(join(repoRoot, "linkout", "data.txt"), "tool-escape")
      ).toMatchObject({ eligible: false, reason: "governed-or-unsafe-path" });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("rejects a dangling in-repo symlink whose target is outside the repo", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "deleg-repo-"));
    const outside = mkdtempSync(join(tmpdir(), "deleg-out-"));
    try {
      // danglink -> <outside>/ghost, where ghost does NOT exist. realpathSync
      // throws ENOENT on it, so the canonicalization walk must not treat the
      // symlink as a plain in-repo segment — creating ghost later would make
      // the same approved scope resolve out of the repo (TOCTOU).
      symlinkSync(join(outside, "ghost"), join(repoRoot, "danglink"));
      const read = (filePath: string, id: string) =>
        classifyDelegationIntent({
          agent: "claude",
          cwd: repoRoot,
          repoRoot,
          toolInput: { file_path: filePath, limit: 300 },
          toolName: "Read",
          toolUseId: id,
        });
      expect(read(join(repoRoot, "danglink"), "d1")).toMatchObject({
        eligible: false,
        reason: "governed-or-unsafe-path",
      });
      expect(read(join(repoRoot, "danglink", "child"), "d2")).toMatchObject({
        eligible: false,
        reason: "governed-or-unsafe-path",
      });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("rejects an in-repo symlink followed by .. that escapes the repo", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "deleg-repo-"));
    const outside = mkdtempSync(join(tmpdir(), "deleg-out-"));
    try {
      // link -> <outside>/inner (an in-repo symlink to a dir OUTSIDE the repo).
      // `link/../data.txt` physically resolves to <outside>/data.txt, but
      // node's lexical resolve() would fold `link/..` away and call it in-repo.
      mkdirSync(join(outside, "inner"));
      writeFileSync(join(outside, "data.txt"), "o".repeat(4096));
      symlinkSync(join(outside, "inner"), join(repoRoot, "link"));
      expect(
        classifyDelegationIntent({
          agent: "claude",
          cwd: repoRoot,
          repoRoot,
          toolInput: { file_path: `${repoRoot}/link/../data.txt`, limit: 300 },
          toolName: "Read",
          toolUseId: "s1",
        })
      ).toMatchObject({ eligible: false, reason: "governed-or-unsafe-path" });
      expect(
        classifyDelegationIntent({
          agent: "claude",
          cwd: repoRoot,
          repoRoot,
          toolInput: { command: "sed -n '1,50p' link/../data.txt" },
          toolName: "Bash",
          toolUseId: "s2",
        })
      ).toMatchObject({ eligible: false });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("rejects a directory target for a single-file read (Read and head)", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "deleg-repo-"));
    try {
      // read_file cannot line-read a directory (EISDIR); a large-read /
      // source-slice request over a directory is unsatisfiable.
      mkdirSync(join(repoRoot, "components"));
      expect(
        classifyDelegationIntent({
          agent: "claude",
          cwd: repoRoot,
          repoRoot,
          toolInput: { file_path: `${repoRoot}/components`, limit: 300 },
          toolName: "Read",
          toolUseId: "dir1",
        })
      ).toMatchObject({ eligible: false, reason: "governed-or-unsafe-path" });
      expect(
        classifyDelegationIntent({
          agent: "claude",
          cwd: repoRoot,
          repoRoot,
          toolInput: { command: "head -n 5 components" },
          toolName: "Bash",
          toolUseId: "dir2",
        })
      ).toMatchObject({ eligible: false });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test("never traverses an in-repo symlink, even via a .. hop or a backslash", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "deleg-repo-"));
    const outside = mkdtempSync(join(tmpdir(), "deleg-out-"));
    try {
      writeFileSync(join(outside, "deeper.txt"), "o".repeat(4096));
      symlinkSync(outside, join(repoRoot, "link")); // in-repo link -> outside dir
      const bash = (command: string, id: string) =>
        classifyDelegationIntent({
          agent: "claude",
          cwd: repoRoot,
          repoRoot,
          toolInput: { command },
          toolName: "Bash",
          toolUseId: id,
        });
      // A nonexistent `ghost/..` hops back to repoRoot, then reaches the in-repo
      // symlink — the walk must still refuse it, not treat `link` as literal.
      expect(
        bash("sed -n '1,50p' ghost/../link/deeper.txt", "g1")
      ).toMatchObject({ eligible: false });
      expect(bash("rg foo ghost/../link", "g2")).toMatchObject({
        eligible: false,
      });
      // A literal backslash must not be rewritten into a symlink-traversing
      // scope by normalizedRelative's `\\`->`/`.
      expect(bash("rg foo 'link\\deeper.txt'", "b1")).toMatchObject({
        eligible: false,
      });
      expect(
        classifyDelegationIntent({
          agent: "claude",
          cwd: repoRoot,
          repoRoot,
          toolInput: { file_path: `${repoRoot}/link\\deeper.txt`, limit: 300 },
          toolName: "Read",
          toolUseId: "b2",
        })
      ).toMatchObject({ eligible: false });
      // A direct in-repo symlink is likewise non-delegable.
      expect(bash("rg foo link", "d1")).toMatchObject({ eligible: false });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("rejects a non-regular-file target (FIFO) for a single-file read", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "deleg-repo-"));
    try {
      execFileSync("mkfifo", [join(repoRoot, "datafifo")]);
      expect(
        classifyDelegationIntent({
          agent: "claude",
          cwd: repoRoot,
          repoRoot,
          toolInput: { file_path: `${repoRoot}/datafifo`, limit: 250 },
          toolName: "Read",
          toolUseId: "f1",
        })
      ).toMatchObject({ eligible: false, reason: "governed-or-unsafe-path" });
      expect(
        classifyDelegationIntent({
          agent: "claude",
          cwd: repoRoot,
          repoRoot,
          toolInput: { command: "head -n 200 datafifo" },
          toolName: "Bash",
          toolUseId: "f2",
        })
      ).toMatchObject({ eligible: false });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

test("delegation telemetry is compact, durable, and tolerant of missing files", () => {
  const runDir = mkdtempSync(join(tmpdir(), "delegation-events-"));
  expect(readDelegationEvents(runDir)).toEqual([]);
  appendDelegationEvent(
    runDir,
    makeDelegationEvent(
      {
        agent: "claude",
        disposition: "auto-routed",
        fingerprint: "f".repeat(64),
        operation: "git-status",
        reason: "git-status",
        source: "claude-hook",
        taskId: "job-1",
      },
      "2026-07-26T20:00:00.000Z"
    )
  );
  appendDelegationEvent(
    runDir,
    makeDelegationEvent(
      {
        agent: "claude",
        disposition: "auto-routed",
        fingerprint: "f".repeat(64),
        operation: "git-status",
        reason: "git-status",
        source: "claude-hook",
        taskId: "job-1",
      },
      "2026-07-26T20:00:01.000Z"
    )
  );
  expect(readDelegationEvents(runDir)).toEqual([
    expect.objectContaining({ disposition: "auto-routed", taskId: "job-1" }),
  ]);
  rmSync(runDir, { force: true, recursive: true });
});

test("Codex app-server observation records only exact missed candidates", () => {
  const events: unknown[] = [];
  const append = (_runDir: string, event: unknown) => events.push(event);
  expect(
    recordCodexAppServerDelegationCandidate(
      "/run",
      ROOT,
      {
        item: {
          command: "git status --short",
          cwd: ROOT,
          id: "command-1",
          type: "commandExecution",
        },
      },
      "2026-07-26T20:00:00.000Z",
      append
    )
  ).toBe(true);
  expect(events).toEqual([
    expect.objectContaining({
      agent: "codex",
      disposition: "missed-candidate",
      operation: "git-status",
      source: "codex-app-server",
    }),
  ]);
  expect(
    recordCodexAppServerDelegationCandidate(
      "/run",
      ROOT,
      { item: { command: "npm install", type: "commandExecution" } },
      undefined,
      append
    )
  ).toBe(false);
  expect(events).toHaveLength(1);
});
