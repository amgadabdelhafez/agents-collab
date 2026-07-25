import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "./types";

export interface GovernessHandoffBundle {
  agent: Agent;
  blockers: string[];
  checks: string[];
  dirtyFiles: string[];
  epoch: number;
  gitHead: string;
  next: string;
  status: "ready";
  summary: string;
}

export const governessHandoffDir = (runDir: string, epoch: number): string =>
  join(runDir, "handoff", String(epoch));

export const governessHandoffFile = (
  runDir: string,
  epoch: number,
  agent: Agent
): string => join(governessHandoffDir(runDir, epoch), `${agent}.json`);

export const ensureGovernessHandoffDir = (
  runDir: string,
  epoch: number
): string => {
  const path = governessHandoffDir(runDir, epoch);
  mkdirSync(path, { recursive: true });
  return path;
};
export const readGovernessHandoffBundle = (
  path: string,
  expectedAgent: Agent,
  epoch: number
): GovernessHandoffBundle | undefined => {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<GovernessHandoffBundle>;
    if (
      value.agent !== expectedAgent ||
      value.epoch !== epoch ||
      value.status !== "ready" ||
      typeof value.gitHead !== "string" ||
      typeof value.next !== "string" ||
      typeof value.summary !== "string" ||
      !Array.isArray(value.blockers) ||
      !Array.isArray(value.checks) ||
      !Array.isArray(value.dirtyFiles)
    ) {
      return undefined;
    }
    return value as GovernessHandoffBundle;
  } catch {
    return undefined;
  }
};
