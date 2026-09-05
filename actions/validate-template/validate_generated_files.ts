#!/usr/bin/env bun
// Validate a repo generated/managed by Vivswan/repo-platform: errors fail
// the run, advisories print and never fail. The CHECKS roster below is the
// catalogue and the run order; each check is a pure function of the
// Context (context.ts) returning Findings (findings.ts).
//
// Usage: bun actions/validate-template/validate_generated_files.ts [--self] [target-dir]
//
// --self validates repo-platform itself (SelfContext in context.ts). The
// optional FINDINGS_FILE / ADVISORIES_FILE environment variables receive
// the two streams as markdown (findings.ts).

import { resolve } from "node:path";
import { checkCiGate } from "./checks/ci_gate.ts";
import { checkConflictMarkers } from "./checks/conflict_markers.ts";
import { checkHeaders } from "./checks/headers.ts";
import { checkLicense } from "./checks/license.ts";
import { checkManifestParity } from "./checks/manifest_parity.ts";
import { checkManifestShape } from "./checks/manifest_shape.ts";
import { checkRegistration } from "./checks/registration.ts";
import { checkReleasePlease } from "./checks/release_please.ts";
import { checkSplitMarkers } from "./checks/split_markers.ts";
import { checkYaml } from "./checks/yaml.ts";
import { type Context, loadContext } from "./context.ts";
import { type Finding, print, writeReports } from "./findings.ts";

const CHECKS: ((ctx: Context) => Finding[])[] = [
  checkRegistration,
  checkLicense,
  checkReleasePlease,
  checkYaml,
  checkConflictMarkers,
  checkCiGate,
  checkSplitMarkers,
  checkHeaders,
  checkManifestShape,
  checkManifestParity,
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
  writeReports(findings, process.env);
  return print(findings);
}

process.exit(main());
