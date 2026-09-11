#!/usr/bin/env bun
// Validate a repository the sync writer manages: errors fail the run,
// advisories print and never fail. The CHECKS roster below is the catalogue
// and the run order; each check is a pure function of the Context
// (context.ts) returning Findings (findings.ts).
//
// Usage: bun actions/validate-managed-files/validator/validate_managed_files.ts
//          [--self] [--files <files.yml>] [target-dir]
//
// --self validates repo-platform itself (its own registration against its
// own files.yml, no manifest). --files names the data file whose modules
// are the registration's vocabulary; a managed repository's validation
// needs it (the action passes the build branch's), self mode defaults to
// the target's own. The optional FINDINGS_FILE / ADVISORIES_FILE
// environment variables receive the two streams as markdown (findings.ts).

import { resolve } from "node:path";
import { checkConflictMarkers } from "./checks/conflict_markers.ts";
import { checkManifestParity } from "./checks/manifest_parity.ts";
import { checkManifestShape } from "./checks/manifest_shape.ts";
import { checkRegistration } from "./checks/registration.ts";
import { checkReleasePlease } from "./checks/release_please.ts";
import { checkYaml } from "./checks/yaml.ts";
import { type Context, loadContext } from "./context.ts";
import { type Finding, print, writeReports } from "./findings.ts";

const CHECKS: ((ctx: Context) => Finding[])[] = [
  checkRegistration,
  checkReleasePlease,
  checkYaml,
  checkConflictMarkers,
  checkManifestShape,
  checkManifestParity,
];

function usageError(message: string): never {
  console.error(`error: ${message}`);
  process.exit(2);
}

function main(): number {
  let selfMode = false;
  let filesConfig: string | undefined;
  const positional: string[] = [];
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--self") selfMode = true;
    else if (arg === "--files") {
      i++;
      const value = args[i];
      if (value === undefined || value.startsWith("-")) usageError("--files expects a path");
      filesConfig = value;
    } else if (arg.startsWith("-")) usageError(`unrecognized argument: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1) usageError(`unrecognized argument: ${positional[1]}`);
  const root = resolve(positional[0] ?? ".");
  if (filesConfig === undefined) {
    if (!selfMode) usageError("--files <files.yml> is required outside --self");
    filesConfig = resolve(root, "files.yml");
  }
  const ctx = loadContext(root, selfMode, resolve(filesConfig));
  const findings = CHECKS.flatMap((check) => check(ctx));
  writeReports(findings, process.env);
  return print(findings);
}

process.exit(main());
