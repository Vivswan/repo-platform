#!/usr/bin/env bun
import { resolve } from "node:path";
import { checkConflictMarkers } from "./checks/conflict_markers.ts";
import { checkReleasePlease } from "./checks/release_please.ts";
import { checkYaml } from "./checks/yaml.ts";
import { type Context, loadContext } from "./context.ts";
import { type Finding, print, writeReport } from "./findings.ts";

const CHECKS: ((ctx: Context) => Finding[])[] = [
  checkReleasePlease,
  checkYaml,
  checkConflictMarkers,
];

function usageError(message: string): never {
  console.error(`error: ${message}`);
  process.exit(2);
}

function main(): number {
  const [root, ...rest] = process.argv.slice(2);
  if (rest.length > 0) usageError(`unrecognized argument: ${rest[0]}`);
  if (root?.startsWith("-")) usageError(`unrecognized argument: ${root}`);
  const ctx = loadContext(resolve(root ?? "."));
  const findings = CHECKS.flatMap((check) => check(ctx));
  writeReport(findings, process.env);
  return print(findings);
}

process.exit(main());
