#!/usr/bin/env bun
import { resolve } from "node:path";
import { checkConflictMarkers, conflictMarkedFiles } from "./checks/conflict_markers.ts";
import { checkReleasePlease } from "./checks/release_please.ts";
import { print, writeReport } from "./findings.ts";

function usageError(message: string): never {
  console.error(`error: ${message}`);
  process.exit(2);
}

function main(): number {
  const [target, ...rest] = process.argv.slice(2);
  if (rest.length > 0) usageError(`unrecognized argument: ${rest[0]}`);

  if (target?.startsWith("-")) usageError(`unrecognized argument: ${target}`);

  const root = resolve(target ?? ".");
  const marked = conflictMarkedFiles(root);
  const findings = [...checkReleasePlease(root, marked), ...checkConflictMarkers(marked)];
  writeReport(findings, process.env);
  return print(findings);
}

process.exit(main());
