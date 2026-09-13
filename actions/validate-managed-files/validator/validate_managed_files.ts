#!/usr/bin/env bun
import { resolve } from "node:path";
import { checkConflictMarkers } from "./checks/conflict_markers.ts";
import { checkManifestParity } from "./checks/manifest_parity.ts";
import { checkManifestShape } from "./checks/manifest_shape.ts";
import { checkRegistration } from "./checks/registration.ts";
import { checkReleasePlease } from "./checks/release_please.ts";
import { checkYaml } from "./checks/yaml.ts";
import { type Context, loadContext, type Target } from "./context.ts";
import { type Finding, print, writeReport } from "./findings.ts";

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
  let privateRepo: boolean | undefined;
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
    } else if (arg === "--private") {
      i++;
      const value = args[i];
      if (value !== "true" && value !== "false") usageError("--private expects true or false");
      privateRepo = value === "true";
    } else if (arg.startsWith("-")) usageError(`unrecognized argument: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1) usageError(`unrecognized argument: ${positional[1]}`);
  const root = resolve(positional[0] ?? ".");
  if (filesConfig === undefined) {
    if (!selfMode) usageError("--files <files.yml> is required outside --self");
    filesConfig = resolve(root, "files.yml");
  }
  const target: Target = selfMode
    ? { mode: "self" }
    : {
        mode: "render",
        private:
          privateRepo ??
          usageError(
            "--private <true|false> (the repository's visibility) is required outside --self",
          ),
      };
  const ctx = loadContext(root, resolve(filesConfig), target);
  const findings = CHECKS.flatMap((check) => check(ctx));
  writeReport(findings, process.env);
  return print(findings);
}

process.exit(main());
