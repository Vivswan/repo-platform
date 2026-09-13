#!/usr/bin/env bun

// A package without a tsconfig.json fails here rather than typechecking nothing.
//
// Usage: bun scripts/typecheck.ts

import { join, resolve } from "node:path";
import { must } from "../.github/scripts/shared/proc.ts";
import { bunLockDirs } from "./bootstrap.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

if (import.meta.main) {
  for (const dir of bunLockDirs(REPO_ROOT)) {
    console.log(`typecheck: ${dir}`);
    must(["bun", "x", "tsc", "-p", "."], { cwd: join(REPO_ROOT, dir) });
  }
}
