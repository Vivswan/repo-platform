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
import { canonicalize, destOverlapsRepo } from "../.github/scripts/build-branches/branch_tree.ts";
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

/** Why `dest` cannot be replaced whole, or null: the golden directory is
 *  the one path inside the checkout the script may remove, so any other
 *  path that is the checkout, an ancestor, or a descendant (`.git`,
 *  `.github`) is refused. Compared canonically, so a symlink alias of the
 *  checkout is still the checkout. */
export function destProblem(dest: string, repoRoot: string, goldenDir: string): string | null {
  const canonical = canonicalize(dest);
  if (canonical === canonicalize(goldenDir)) return null;
  if (destOverlapsRepo(canonical, canonicalize(repoRoot))) {
    return (
      `--dest ${dest} is inside the checkout (or is the checkout or an ancestor) and would be ` +
      "removed; the only destination inside the checkout is the default golden directory"
    );
  }
  return null;
}

/** The destination from argv; an empty value is refused before resolve()
 *  turns it into the working directory. */
function parseDest(argv: string[]): string {
  if (argv.length === 0) return DEFAULT_DEST;
  if (argv.length !== 2 || argv[0] !== "--dest" || argv[1] === "") {
    console.error("usage: bun scripts/render_golden.ts [--dest DIR]");
    process.exit(2);
  }
  const dest = resolve(argv[1]);
  const problem = destProblem(dest, REPO_ROOT, DEFAULT_DEST);
  if (problem !== null) {
    console.error(`error: ${problem}`);
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
