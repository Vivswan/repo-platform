#!/usr/bin/env bun
// Renders the all-modules golden from the sync writer: every module files.yml
// knows except custom-license, the fixture project, an empty checkout. A
// review aid for template-to-files diffs, not a CI comparison.
//
// Usage: bun scripts/render_golden.ts [--dest DIR]
//   (default DIR: tests/golden-renders/all-modules, replaced whole)

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalize } from "../.github/scripts/build-branches/branch_tree.ts";
import { capture } from "../.github/scripts/shared/proc.ts";
import { parseFilesConfig } from "../.github/scripts/sync/writer/files_config.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const DEFAULT_DEST = join(REPO_ROOT, "tests", "golden-renders", "all-modules");
/** The width of a full sha, non-hex so no real commit can read as it. */
const BUILD = "x".repeat(40);
const REPOSITORY = "Vivswan/golden-render";

const REGISTRATION = (modules: string[]) =>
  [
    `modules: ${JSON.stringify(modules)}`,
    "project:",
    "  name: Golden Render",
    "  slug: golden-render",
    "  description: Golden render fixture",
    "  copyright_holder: Vivswan Shah (https://github.com/Vivswan)",
    "",
  ].join("\n");

/** The destination, refused when it is the checkout itself or an ancestor
 *  (both would be removed with it) or when the value is empty (resolve("")
 *  is the working directory). Compared canonically, so a case or symlink
 *  alias of the checkout is still the checkout; "/" gets no second slash. */
function parseDest(argv: string[]): string {
  if (argv.length === 0) return DEFAULT_DEST;
  if (argv.length !== 2 || argv[0] !== "--dest" || argv[1] === "") {
    console.error("usage: bun scripts/render_golden.ts [--dest DIR]");
    process.exit(2);
  }
  const dest = resolve(argv[1]);
  const repo = canonicalize(REPO_ROOT);
  const canonical = canonicalize(dest);
  const prefix = canonical.endsWith("/") ? canonical : `${canonical}/`;
  if (canonical === repo || repo.startsWith(prefix)) {
    console.error(`error: --dest ${dest} is the checkout or one of its ancestors`);
    process.exit(2);
  }
  return dest;
}

function main(argv: string[]): number {
  const dest = parseDest(argv);
  const config = parseFilesConfig(readFileSync(join(REPO_ROOT, "files.yml"), "utf-8"));
  const modules = Object.keys(config.modules).filter((name) => name !== "custom-license");
  const scratch = mkdtempSync(join(tmpdir(), "render-golden-"));
  try {
    const target = join(scratch, "target");
    mkdirSync(target);
    writeFileSync(join(target, ".repo-platform.yml"), REGISTRATION(modules));
    const result = capture([
      "bun",
      join(REPO_ROOT, ".github/scripts/sync/writer/sync.ts"),
      "--files",
      join(REPO_ROOT, "files.yml"),
      "--tree",
      join(REPO_ROOT, "files"),
      "--target",
      target,
      "--build",
      BUILD,
      "--repository",
      REPOSITORY,
      "--private",
      "false",
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`sync.ts exited ${result.exitCode}:\n${result.stderr.trim()}`);
    }
    if (existsSync(dest)) rmSync(dest, { recursive: true });
    cpSync(target, dest, { recursive: true });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(`rendered ${modules.length} modules into ${dest}`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
