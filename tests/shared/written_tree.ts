// A checkout whose own .gitignore covers a path the writer manages, left as the writer leaves it, with the summary the
// writer hands the delivery: the tree `git add --all` cannot commit whole. Both delivery tests drive their script over it.

import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildReport, type SyncReport } from "../../.github/scripts/sync/writer/report.ts";
import { MANIFEST_NAME } from "../../actions/shared/platform.ts";
import { fixtureGit } from "./fixture_git";

export const IGNORED_PATH = ".bun-version";

/** What the sync commit changes against the checkout, exactly: the ignored file, the manifest, the mirror, the retired file. */
export const WRITTEN_DIFF = [IGNORED_PATH, MANIFEST_NAME, "CLAUDE.md", "old.yml"].sort();

export const MISSING_PATH = "missing.txt";
/** git's own line when a summary row names a path that is neither on disk nor tracked. */
export const MISSING_PATH_LINE = `fatal: pathspec '${MISSING_PATH}' did not match any files`;

function write(target: string, path: string, text: string): void {
  mkdirSync(dirname(join(target, path)), { recursive: true });
  writeFileSync(join(target, path), text);
}

/** One row per shape the delivery stages (a created ignored file, a retired file, a mirror link) and two it must not:
 *  an unchanged file, and a released record whose file is gone, which git could not stage. The report is built as the
 *  writer builds it, so `hold` follows the rows. */
export function writtenTree(target: string, build: string): SyncReport {
  fixtureGit(target, ["init", "-q", "-b", "main"]);
  write(target, ".gitignore", `${IGNORED_PATH}\n`);
  write(target, MANIFEST_NAME, "{}\n");
  write(target, "old.yml", "retired: soon\n");
  write(target, "AGENTS.md", "# Agents\n");
  write(target, "README.md", "# Readme\n");
  fixtureGit(target, ["add", "--all"]);
  fixtureGit(target, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base"]);

  write(target, IGNORED_PATH, "1.2.3\n");
  write(target, MANIFEST_NAME, `{"${IGNORED_PATH}": {"class": "managed"}}\n`);
  rmSync(join(target, "old.yml"));
  symlinkSync("AGENTS.md", join(target, "CLAUDE.md"));
  return buildReport({
    build,
    modules: [],
    private: false,
    written: [
      { path: IGNORED_PATH, class: "managed", change: "created", detail: "" },
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
