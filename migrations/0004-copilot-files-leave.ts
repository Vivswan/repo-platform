#!/usr/bin/env bun
// The platform stopped shipping GitHub Copilot's files. The writer retires a managed file by itself, but a mirror target
// no declaration reaches and a starter it once wrote both stay as the repository's own, so this rung deletes the two:
//
//   .github/copilot-instructions.md            -> deleted when it is the fleet's link to ../AGENTS.md
//   .github/workflows/copilot-setup-steps.yml  -> deleted when it is a regular file
//
// Their manifest records leave in the writer's run that follows, which finds nothing at either path.
// stdout is the runner's (sync/migrate.ts): each path deleted, nothing otherwise.
//
// Usage: bun migrations/0004-copilot-files-leave.ts <checkout>

import { readlinkSync } from "node:fs";
import { join } from "node:path";
import { occupant, removeFile } from "../.github/scripts/sync/writer/target_files.ts";

const LINK = ".github/copilot-instructions.md";
const LINK_TARGET = "../AGENTS.md";
const STARTER = ".github/workflows/copilot-setup-steps.yml";

/** `occupant` refuses a path under a linked ancestor, where a delete could leave the checkout. */
function leaves(checkout: string, path: string): boolean {
  const found = occupant(checkout, path);
  if (path === LINK) {
    return found === "a symbolic link" && readlinkSync(join(checkout, path)) === LINK_TARGET;
  }
  return found === "a regular file";
}

function main(checkout: string | undefined): number {
  if (checkout === undefined) {
    console.error("usage: bun migrations/0004-copilot-files-leave.ts <checkout>");
    return 2;
  }
  try {
    const leaving = [LINK, STARTER].filter((path) => leaves(checkout, path));
    for (const path of leaving) {
      removeFile(checkout, path);
      console.log(path);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exit(main(process.argv[2]));
