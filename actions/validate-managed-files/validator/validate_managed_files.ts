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
  let selfMode = false;
  const positional: string[] = [];
  for (const arg of process.argv.slice(2)) {
    if (arg === "--self") selfMode = true;
    else if (arg.startsWith("-")) usageError(`unrecognized argument: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1) usageError(`unrecognized argument: ${positional[1]}`);
  const ctx = loadContext(resolve(positional[0] ?? "."), selfMode);
  const findings = CHECKS.flatMap((check) => check(ctx));
  writeReport(findings, process.env);
  return print(findings);
}

process.exit(main());
