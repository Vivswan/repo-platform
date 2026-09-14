// A checkout left as the migrations and the writer leave it, with the summary the writer hands the delivery and the
// runner's migrated list: the tree `git add --all` cannot commit whole, and one a glob pathspec would over-stage. Both
// delivery tests drive their script over it.

import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildReport, type SyncReport } from "../../.github/scripts/sync/writer/report.ts";
import { MANIFEST_NAME } from "../../actions/shared/platform.ts";
import { boundedSpawnSync } from "./bounded_spawn";
import { fixtureGit, fixtureGitEnv } from "./fixture_git";

const MIGRATE = join(import.meta.dir, "../../.github/scripts/sync/migrate.ts");

export const IGNORED_PATH = ".bun-version";
/** A written path git reads as a character class, beside the sibling that class matches. */
export const BRACKETED_PATH = "docs/[x].md";
export const SIBLING_PATH = "docs/x.md";
/** The one path the fixture rung edits and reports. */
export const MIGRATED_PATH = "notes.md";

/** What the sync commit changes against the checkout, exactly. */
export const WRITTEN_DIFF = [
  IGNORED_PATH,
  MANIFEST_NAME,
  BRACKETED_PATH,
  "CLAUDE.md",
  MIGRATED_PATH,
  "old.yml",
].sort();

export const MISSING_PATH = "missing.txt";
/** git's own line when a summary row names a path that is neither on disk nor tracked. */
export const MISSING_PATH_LINE = `fatal: pathspec ':(literal)${MISSING_PATH}' did not match any files`;

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** `root/target` is the checkout and `root/temp` is RUNNER_TEMP, as both delivery tests lay them out. One row per
 *  shape the delivery stages (a created ignored file, a bracketed file, a retired file, a mirror link, a rung's
 *  edit) and three it must not: an unchanged file, a released record whose file is gone (git could not stage it),
 *  and the sibling the bracketed path's glob form matches, edited on disk and reported by nothing. The report is
 *  built as the writer builds it, so `hold` follows the rows. */
export function writtenTree(root: string, build: string): SyncReport {
  const target = join(root, "target");
  fixtureGit(target, ["init", "-q", "-b", "main"]);
  write(target, ".gitignore", `${IGNORED_PATH}\n`);
  write(target, MANIFEST_NAME, "{}\n");
  write(target, "old.yml", "retired: soon\n");
  write(target, "AGENTS.md", "# Agents\n");
  write(target, "README.md", "# Readme\n");
  write(target, SIBLING_PATH, "x\n");
  write(target, MIGRATED_PATH, "before\n");
  fixtureGit(target, ["add", "--all"]);
  fixtureGit(target, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base"]);

  write(
    root,
    "migrations/0001-note.ts",
    [
      'import { writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      `writeFileSync(join(process.argv[2], "${MIGRATED_PATH}"), "after\\n");`,
      `console.log("${MIGRATED_PATH}");`,
      "",
    ].join("\n"),
  );
  const migrate = boundedSpawnSync([process.execPath, MIGRATE, join(root, "migrations"), target], {
    env: { ...fixtureGitEnv(), RUNNER_TEMP: join(root, "temp") },
  });
  if (migrate.exitCode !== 0) throw new Error(`migrate.ts failed: ${migrate.stderr}`);

  write(target, IGNORED_PATH, "1.2.3\n");
  write(target, MANIFEST_NAME, `{"${IGNORED_PATH}": {"class": "managed"}}\n`);
  write(target, BRACKETED_PATH, "bracketed\n");
  write(target, SIBLING_PATH, "edited by nothing the report names\n");
  rmSync(join(target, "old.yml"));
  symlinkSync("AGENTS.md", join(target, "CLAUDE.md"));
  return buildReport({
    build,
    modules: [],
    private: false,
    written: [
      { path: IGNORED_PATH, class: "managed", change: "created", detail: "" },
      { path: BRACKETED_PATH, class: "managed", change: "created", detail: "" },
      { path: "README.md", class: "managed", change: "unchanged", detail: "" },
    ],
    replaced: [],
    retired: [
      { path: "old.yml", outcome: "deleted", detail: "no longer selected" },
      { path: "gone.md", outcome: "released", detail: "excepted by the registration" },
    ],
    notes: [],
    mirrors: [{ source: "AGENTS.md", target: "CLAUDE.md", outcome: "written", detail: "" }],
  });
}

/** The paths one commit changed against its parent, sorted. */
export function committedDiff(target: string): string[] {
  return fixtureGit(target, ["diff", "--name-only", "HEAD~1", "HEAD"]).split("\n").sort();
}
