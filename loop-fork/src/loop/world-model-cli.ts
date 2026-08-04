import { resolve } from "node:path";
import {
  materializeGitRepository,
  readWorldAssertionFile,
  WorldModelStore,
} from "./world-model";
import {
  WORLD_MODEL_ENTITY_TYPES,
  WORLD_MODEL_ONTOLOGY_VERSION,
  WORLD_MODEL_PREDICATES,
  WORLD_MODEL_STATUSES,
} from "./world-model-ontology";

const WORLD_HELP = `
Usage:
  loop world build --repo <path> --db <path>
  loop world ingest --db <path> --file <assertion.json>
  loop world context --db <path> --seed <term> [--seed <term>] [--depth <n>] [--limit <n>] [--at <iso>]
  loop world ontology

The world model is a local, rebuildable evidence projection. It cannot authorize
routing, permissions, releases, deployments, or lifecycle changes.
`.trim();

interface ParsedWorldArgs {
  at?: string;
  databasePath?: string;
  depth?: number;
  filePath?: string;
  limit?: number;
  repositoryPath?: string;
  seeds: string[];
}

const positiveInteger = (value: string | undefined, flag: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return parsed;
};

const parseWorldArgs = (argv: string[]): ParsedWorldArgs => {
  const parsed: ParsedWorldArgs = { seeds: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--")) {
      throw new Error(`unexpected world argument: ${flag ?? ""}`);
    }
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for ${flag}`);
    }
    index += 1;
    switch (flag) {
      case "--db":
        parsed.databasePath = resolve(value);
        break;
      case "--repo":
        parsed.repositoryPath = resolve(value);
        break;
      case "--file":
        parsed.filePath = resolve(value);
        break;
      case "--seed":
        parsed.seeds.push(value);
        break;
      case "--depth":
        parsed.depth = positiveInteger(value, flag);
        break;
      case "--limit":
        parsed.limit = positiveInteger(value, flag);
        break;
      case "--at":
        parsed.at = value;
        break;
      default:
        throw new Error(`unknown world argument: ${flag}`);
    }
  }
  return parsed;
};

const requireValue = (value: string | undefined, message: string): string => {
  if (!value) {
    throw new Error(message);
  }
  return value;
};

const writeJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

export const runWorldCommand = (argv: string[]): boolean => {
  if (argv[0]?.toLowerCase() !== "world") {
    return false;
  }
  const command = argv[1]?.toLowerCase();
  if (!command || command === "help" || command === "--help") {
    process.stdout.write(`${WORLD_HELP}\n`);
    return true;
  }
  if (command === "ontology") {
    writeJson({
      entityTypes: WORLD_MODEL_ENTITY_TYPES,
      predicates: WORLD_MODEL_PREDICATES,
      statuses: WORLD_MODEL_STATUSES,
      version: WORLD_MODEL_ONTOLOGY_VERSION,
    });
    return true;
  }
  const args = parseWorldArgs(argv.slice(2));
  const databasePath = requireValue(
    args.databasePath,
    `loop world ${command} requires --db <path>`
  );
  const store = new WorldModelStore(databasePath);
  try {
    switch (command) {
      case "build":
        writeJson(
          materializeGitRepository(
            store,
            requireValue(
              args.repositoryPath,
              "loop world build requires --repo <path>"
            )
          )
        );
        return true;
      case "ingest":
        writeJson(
          store.ingestAssertion(
            readWorldAssertionFile(
              requireValue(
                args.filePath,
                "loop world ingest requires --file <assertion.json>"
              )
            )
          )
        );
        return true;
      case "context":
        writeJson(
          store.context({
            ...(args.at ? { at: args.at } : {}),
            ...(args.depth === undefined ? {} : { maxDepth: args.depth }),
            ...(args.limit === undefined ? {} : { maxStatements: args.limit }),
            seeds: args.seeds,
          })
        );
        return true;
      default:
        throw new Error(`unknown world command: ${command}`);
    }
  } finally {
    store.close();
  }
};
