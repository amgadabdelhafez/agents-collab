import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUtilityToolBroker } from "../../src/loop/utility-tools";

// Regressions for the run-151 harness defects. Producer evidence is checked in
// under tests/fixtures/utility/run-151-scope-evidence/; see
// specs/utility-scope-evidence-recovery/spec.md.
//
// Defect A: job f155d583 was routed with read and write scope both exactly one
// FILE. `run_check` was still exposed, but no cwd can satisfy a file-only scope
// set — a file path is in scope yet is not a usable working directory, and the
// repository root is a directory yet is out of scope. The helper burned its
// three-rejection budget discovering that and lost a patch it had already
// produced successfully.
//
// The claim under test is deliberately narrow: `run_check` satisfiability only.
// Nothing here asserts that every broker tool is satisfiability-filtered.

const withRepo = async (
  run: (root: string) => Promise<void>
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "utility-scope-evidence-"));
  try {
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(join(root, "scripts", "harness.mjs"), "// fixture\n");
    await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

// The run-151 shape: read and write scope are the same single file, and no
// explicit commandCwds is supplied, so commandCwds falls back to readScopes.
const FILE_SCOPE = "scripts/harness.mjs";

test("run_check is withheld when no declared cwd can satisfy it", async () => {
  await withRepo(async (root) => {
    const broker = await createUtilityToolBroker(
      {
        allowedTools: ["read_file", "run_check"],
        artifactDir: ".utility-artifacts",
        readScopes: [FILE_SCOPE],
        repoRoot: root,
        writeScopes: [FILE_SCOPE],
      },
      {
        runCommand: async () => ({ exitCode: 0, stderr: "", stdout: "" }),
      }
    );

    const capabilities = broker.describeCapabilities();
    // A tool the job's own scopes can never satisfy must not be offered.
    expect(capabilities.tools).not.toContain("run_check");
    expect(capabilities.commandPrefixes ?? []).toEqual([]);
  });
});

test("run_check stays exposed when a declared directory cwd can satisfy it", async () => {
  // Guard against over-fixing: this asserts PRESERVED behaviour and is expected
  // to pass on the unmodified base as well as after the fix.
  await withRepo(async (root) => {
    const broker = await createUtilityToolBroker(
      {
        allowedTools: ["read_file", "run_check"],
        artifactDir: ".utility-artifacts",
        commandCwds: ["."],
        readScopes: [FILE_SCOPE],
        repoRoot: root,
        writeScopes: [FILE_SCOPE],
      },
      {
        runCommand: async () => ({ exitCode: 0, stderr: "", stdout: "" }),
      }
    );

    expect(broker.describeCapabilities().tools).toContain("run_check");
  });
});

test("run_check stays exposed when the readScopes fallback is a directory", async () => {
  // The fallback path with a satisfiable directory scope keeps today's
  // behaviour, so the fix withholds only the impossible case.
  await withRepo(async (root) => {
    const broker = await createUtilityToolBroker(
      {
        allowedTools: ["read_file", "run_check"],
        artifactDir: ".utility-artifacts",
        readScopes: ["scripts"],
        repoRoot: root,
        writeScopes: [],
      },
      {
        runCommand: async () => ({ exitCode: 0, stderr: "", stdout: "" }),
      }
    );

    expect(broker.describeCapabilities().tools).toContain("run_check");
  });
});

test("run_check is withheld when every declared cwd is missing from disk", async () => {
  // Satisfiability requires an existing directory, not merely an in-scope
  // string. A declared directory that does not exist is not satisfiable.
  await withRepo(async (root) => {
    const broker = await createUtilityToolBroker(
      {
        allowedTools: ["read_file", "run_check"],
        artifactDir: ".utility-artifacts",
        commandCwds: ["does-not-exist"],
        readScopes: ["scripts"],
        repoRoot: root,
        writeScopes: [],
      },
      {
        runCommand: async () => ({ exitCode: 0, stderr: "", stdout: "" }),
      }
    );

    expect(broker.describeCapabilities().tools).not.toContain("run_check");
  });
});

test("every exposure surface agrees about a withheld run_check", async () => {
  // A tool withheld from one surface and advertised on another is the same
  // defect in a new place: the offered definitions, the capability map, and the
  // advertised command prefixes must all say the same thing.
  await withRepo(async (root) => {
    const broker = await createUtilityToolBroker(
      {
        allowedTools: ["read_file", "run_check"],
        artifactDir: ".utility-artifacts",
        readScopes: [FILE_SCOPE],
        repoRoot: root,
        writeScopes: [FILE_SCOPE],
      },
      {
        runCommand: async () => ({ exitCode: 0, stderr: "", stdout: "" }),
      }
    );

    const capabilities = broker.describeCapabilities();
    const definitionNames = broker.definitions.map(
      (definition) => definition.function.name
    );

    expect(definitionNames).not.toContain("run_check");
    expect(capabilities.tools).not.toContain("run_check");
    expect(capabilities.commandPrefixes ?? []).toEqual([]);
    expect(definitionNames.sort()).toEqual([...capabilities.tools].sort());
  });
});
