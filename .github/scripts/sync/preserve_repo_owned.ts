#!/usr/bin/env bun
// Preserves repo-owned files after an update.
//
// settings.yml is a repo-owned starter (_skip_if_exists) wherever it
// exists: deselecting the settings-sync module de-renders it, but the
// sync must never delete a repo's settings file - repo-platform's
// settings-repos run merges it over the centrally computed managed
// baseline and applies the result. A recovery re-render can de-render the
// file too, so it is restored outright there. This step also runs the
// one-time layering transition (settings_layering.ts): a settings.yml
// still carrying the retired mergeable marker holds the old full
// baseline, and is replaced with the identity starter - the PR body
// lists the dropped overrides and open_pr.ts holds the PR for review.
//
// The license (LICENSE.md, or a custom repo's own spelling) leaves the
// render when a repo selects the custom-license module;
// copier deletes the de-rendered file when it was unmodified, which would
// leave the repo with no license at all, so it is restored from the base
// commit. Unlike settings.yml it is NOT restored on recovery: without the
// module LICENSE is fleet-managed and the recovery re-render's overwrite
// is the correct outcome; with the module the recovery re-render does not
// emit LICENSE (recopy deletes nothing), so the repo's own license
// survives untouched.
//
// A committed LICENSE deletion in a repo still on the fleet license is the
// remaining hole: copier honors the deletion (it re-applies the local
// diff), retired cleanup never lists the path (LICENSE.md is in both
// renders), and there is no HEAD copy to restore -
// but the fleet license is mandatory without the custom-license module, so
// it is re-seeded from the target build ref (which must be resolvable in
// the cwd's git repository).
//
// Last, the removed-split-files hold: every path this update deletes whose
// previous copy HEAD's manifest classes `split` (plus the two license
// spellings pointwise) is reported to open_pr.ts, which keeps the PR on
// the manual-review path with the leaving repository-owned content named
// in the body - see the block at the end of this file.
//
// Invoked by reusable-template-sync.yml's "Preserve repo-owned files" step
// and by ci/upgrade_path_test.sh.
//
// Env: RECOVER; TARGET_DIR (default target); TARGET_REF and MODULES (for
// the fleet-license re-seed); RUNNER_TEMP (the settings-layering and
// removed-splits report files); HIDE_DETAILS; TARGET_DISPLAY / TARGET
// (log label, in that order; defaults to TARGET_DIR).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { MANIFEST_NAME } from "../../../actions/shared/stamp_manifest.ts";
import { env, error, hideDetails, notice, requireEnv } from "../shared/gha.ts";
import { headBytes } from "../shared/git_head.ts";
import { parseModules } from "../shared/modules.ts";
import { clip, fenceFor } from "./preserve_local_content.ts";
import { REMOVED_SPLITS_NAME, SETTINGS_LAYERING_NAME } from "./section_files.ts";
import { transitionSettingsStarter } from "./settings_layering.ts";
import { type HeadSplit, headRepoOwnedHalf, headSplitEntries } from "./tail_tripwire.ts";

const targetDir = env("TARGET_DIR", "target");
const label = env("TARGET_DISPLAY") || env("TARGET") || targetDir;
const recover = env("RECOVER") === "recopy";
const modules = parseModules(env("MODULES")) ?? [];

function git(args: string[]): { exitCode: number; stdout: string } {
  const proc = Bun.spawnSync(["git", "-C", targetDir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode ?? 1, stdout: proc.stdout.toString() };
}

function inHead(path: string): boolean {
  return git(["cat-file", "-e", `HEAD:${path}`]).exitCode === 0;
}

function restoreFromHead(path: string): void {
  const proc = Bun.spawnSync(["git", "-C", targetDir, "checkout", "HEAD", "--", path], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1);
}

if (inHead(".github/settings.yml")) {
  if (recover) {
    restoreFromHead(".github/settings.yml");
    notice(
      `${label}: .github/settings.yml is repo-owned; restored as-is after the recovery re-render.`,
    );
  } else if (!existsSync(join(targetDir, ".github/settings.yml"))) {
    restoreFromHead(".github/settings.yml");
    notice(
      `${label}: .github/settings.yml left the template render but is repo-owned; kept as-is.`,
    );
  }
}

// The one-time layering transition (see the header): after the restore
// above, so a de-rendered-then-restored legacy file transitions in the
// same sync instead of waiting a round.
transitionSettingsStarter(
  targetDir,
  join(requireEnv("RUNNER_TEMP"), SETTINGS_LAYERING_NAME),
  label,
);

// Only on the custom-license module: there the repo's own license is
// repo-owned - LICENSE.md by convention, with the extensionless spelling
// tolerated until every repo's rename lands. Without the module the
// license is template-managed, and a de-rendered old spelling (the
// extensionless LICENSE before the LICENSE.md rename) must stay deleted.
if (!recover && modules.includes("custom-license")) {
  for (const name of ["LICENSE", "LICENSE.md"]) {
    if (inHead(name) && !existsSync(join(targetDir, name))) {
      restoreFromHead(name);
      notice(
        `${label}: ${name} left the template render (custom-license module) but is repo-owned; kept as-is.`,
      );
    }
  }
}

const fleetLicense = "template/LICENSE.md.jinja";
if (
  !recover &&
  !existsSync(join(targetDir, "LICENSE.md")) &&
  !inHead("LICENSE.md") &&
  !modules.includes("custom-license")
) {
  const targetRef = env("TARGET_REF");
  if (
    targetRef !== "" &&
    Bun.spawnSync(["git", "cat-file", "-e", `${targetRef}:${fleetLicense}`]).exitCode === 0
  ) {
    const show = Bun.spawnSync(["git", "show", `${targetRef}:${fleetLicense}`], {
      stderr: "inherit",
    });
    if (show.exitCode !== 0) process.exit(show.exitCode ?? 1);
    // The template carries the Required Notice as a jinja variable; render
    // it from the repo's recorded answer rather than seeding template text.
    const answersPath = join(targetDir, ".copier-answers.yml");
    let answers: Record<string, unknown> = {};
    if (existsSync(answersPath)) {
      let doc: unknown;
      try {
        doc = parse(readFileSync(answersPath, "utf-8"));
      } catch {
        doc = undefined;
      }
      if (doc === undefined || doc === null || typeof doc !== "object" || Array.isArray(doc)) {
        error(`${label}: cannot re-seed the fleet license; .copier-answers.yml is unreadable`);
        process.exit(1);
      }
      answers = doc as Record<string, unknown>;
    }
    const holder = answers.copyright_holder;
    if (typeof holder !== "string" || holder === "") {
      error(
        `${label}: cannot re-seed the fleet license; .copier-answers.yml records no copyright_holder`,
      );
      process.exit(1);
    }
    // The managed-marker comment line names the owner via github_username;
    // render it from the same recorded answers, shape-checked the way the
    // validator's owner pin is (a malformed non-empty value would pass the
    // unrendered-expression check below yet seed a wrong owner).
    const username = answers.github_username;
    if (typeof username !== "string" || !/^[A-Za-z0-9-]+$/.test(username)) {
      error(
        `${label}: cannot re-seed the fleet license; .copier-answers.yml records no github_username`,
      );
      process.exit(1);
    }
    // Callback replacement: a literal holder string would have its $
    // sequences expanded. latin1 throughout (the byte-faithfulness
    // convention shared with preserve_local_content.ts): the template
    // bytes round-trip verbatim instead of folding onto U+FFFD, and each
    // substituted answer is spliced in as its UTF-8 bytes viewed as
    // latin1 code units, so the final write emits real UTF-8 for it.
    const asLatin1 = (value: string) => Buffer.from(value, "utf-8").toString("latin1");
    const rendered = show.stdout
      .toString("latin1")
      .replaceAll("{{ copyright_holder }}", () => asLatin1(holder))
      .replaceAll("{{ github_username }}", () => asLatin1(username));
    if (rendered.includes("{{") || rendered.includes("{%")) {
      error(`${label}: cannot re-seed the fleet license; unrendered template expressions remain`);
      process.exit(1);
    }
    writeFileSync(join(targetDir, "LICENSE.md"), Buffer.from(rendered, "latin1"));
    notice(
      `${label}: LICENSE.md was deleted but the fleet license is mandatory without the custom-license module; re-seeded from ${targetRef}.`,
    );
  }
}

// A file this update deletes never reaches the PR as a conflict: copier
// resolves delete-vs-modify by dropping the file, and retired-file cleanup
// deletes retired paths outright - so a split file's repository-owned half
// silently leaves while the update looks clean enough to AUTO-MERGE. The
// rule is CLASS-level: every deleted path HEAD's own manifest classes
// `split` holds the PR (open_pr.ts's section list) with the leaving content
// named. HEAD's manifest, not the post-sync one: a path split at HEAD but
// absent from the new render is in neither the rebuild's walk nor the tail
// tripwire's. The two license spellings are pointwise candidates on top - a
// pre-rename extensionless LICENSE has no manifest entry, yet its deletion
// must still hold the PR.
//
// FAIL CLOSED when HEAD's manifest cannot be classified (missing or damaged
// past parsing): the split map is unknown, so every deleted tracked path
// becomes an unclassifiable candidate that forces review. The tail tripwire
// cannot backstop this - it iterates the POST-sync manifest and skips paths
// absent at HEAD before it reads HEAD's manifest, so a sync whose retained
// split files are all new at HEAD leaves the wire silent while a retired
// split file's half departs unseen.

/** Per-file excerpt bound (lines) and the byte budget for the WHOLE
 * rendered section - intro, bullets, fences, and the omission item, not
 * just excerpt lines. The PR body caps at 64 KiB (gh fails past it,
 * stranding the branch), and open_pr caps the aggregate body too. */
const MAX_HALF_LINES = 40;
const MAX_SECTION_BYTES = 16384;
/** Reserved within the budget so the omission item always fits. */
const OMISSION_HEADROOM = 240;

interface RemovedSplit {
  path: string;
  /** The repository-owned half at HEAD: content when located, null when
   * the previous copy does not split at its declared markers, undefined
   * when the manifest does not classify the path (a pointwise license
   * candidate, or any deleted path when HEAD's manifest is unreadable). */
  half: string | null | undefined;
}

/** One removed path's bullet. The excerpt is bounded by MAX_HALF_LINES and
 * by `excerptBudget` bytes (whatever is left of the section budget), so a
 * single file cannot consume the whole section; the caller charges the
 * bullet's full rendered size against that budget. */
function removedSplitBullet({ path, half }: RemovedSplit, excerptBudget: number): { text: string } {
  if (half === undefined) {
    return {
      text:
        `- \`${path}\`: the previous commit's manifest does not class this file, so its ` +
        "repository-local content (if any) cannot be split out - review the previous copy " +
        "on the base branch before merging.",
    };
  }
  if (half === null) {
    return {
      text:
        `- \`${path}\`: its repository-owned half could not be located (the previous copy ` +
        "does not split at its declared marker lines) - review the previous copy on the " +
        "base branch before merging.",
    };
  }
  if (half.trim() === "") {
    return {
      text: `- \`${path}\`: its repository-owned section is empty; nothing leaves beyond the managed render.`,
    };
  }
  const lines = half.split("\n").filter(
    (line, index, all) =>
      // Drop only a trailing empty line (the split's newline artifact).
      line !== "" || index < all.length - 1,
  );
  const shown: string[] = [];
  let cost = 0;
  for (const line of lines) {
    if (shown.length >= MAX_HALF_LINES) break;
    const clipped = clip(line);
    const lineCost = Buffer.byteLength(clipped, "utf-8") + 3;
    if (cost + lineCost > excerptBudget) break;
    cost += lineCost;
    shown.push(clipped);
  }
  if (shown.length === 0) {
    return {
      text:
        `- \`${path}\`: ${lines.length} line(s) of repository-owned content leave with the ` +
        "deletion (excerpt omitted: report size limit; see the base branch's copy).",
    };
  }
  const fence = fenceFor(shown);
  const omitted = lines.length - shown.length;
  const tail = omitted > 0 ? `\n  (${omitted} more; see the base branch's copy)` : "";
  return {
    text:
      `- \`${path}\`: this repository-owned content leaves with the deletion:\n\n` +
      `  ${fence}text\n${shown.map((line) => `  ${line}`).join("\n")}\n  ${fence}${tail}`,
  };
}

const REMOVED_SPLITS_INTRO = [
  "> [!WARNING]",
  "> This update DELETES file(s) whose previous copy may carry a",
  "> repository-owned half (ownership class `split` at the previous commit,",
  "> or a file that commit's manifest does not classify). Copier resolves",
  "> delete-vs-modify by dropping the file, and retired-file cleanup deletes",
  "> retired paths outright, so that content is NOT in this diff and",
  "> survives only in git history (see the base branch). Move anything that",
  "> must stay into another file's repository-local section on this branch",
  "> before merging. Prior licensing needs no notice - git history is the",
  "> record.",
  "",
].join("\n");

/** The report for a run whose HEAD manifest AND deletion list could both
 * not be read: nothing can be enumerated, so hold the PR generically. */
const REMOVED_SPLITS_UNVERIFIABLE = [
  "> [!WARNING]",
  "> This update's split-file deletions could not be verified: the previous",
  "> commit's ownership manifest could not be read and its deleted-file list",
  "> could not be computed. Review this update's full diff against the base",
  "> branch before merging.",
  "",
].join("\n");

/** The removed-splits section, bounded as a WHOLE by MAX_SECTION_BYTES:
 * the fixed framing (intro, rejection preface, reserved omission item) is
 * subtracted up front, bullets are added until the next would overflow,
 * and the rest collapse into one omission item. Empty when nothing left. */
function renderRemovedSplits(removals: RemovedSplit[], manifestProblem: string | null): string {
  if (removals.length === 0) return "";
  const preface =
    manifestProblem === null
      ? ""
      : `The previous commit's ownership manifest was rejected (${manifestProblem}), so the ` +
        "deleted files below cannot be classified and each one is held for review.\n\n";
  let budget =
    MAX_SECTION_BYTES -
    Buffer.byteLength(REMOVED_SPLITS_INTRO, "utf-8") -
    Buffer.byteLength(preface, "utf-8") -
    OMISSION_HEADROOM -
    2;
  const rendered: string[] = [];
  let omitted = 0;
  for (let i = 0; i < removals.length; i++) {
    const bullet = removedSplitBullet(removals[i], Math.max(0, budget));
    const cost = Buffer.byteLength(bullet.text, "utf-8") + 1; // the joining newline
    if (cost > budget) {
      omitted = removals.length - i;
      break;
    }
    budget -= cost;
    rendered.push(bullet.text);
  }
  if (omitted > 0) {
    rendered.push(
      `- (${omitted} more deleted file(s) omitted to keep this PR body under GitHub's size ` +
        "limit; inspect the base branch's copies before merging.)",
    );
  }
  return `${REMOVED_SPLITS_INTRO}\n${preface}${rendered.join("\n")}\n`;
}

/** Paths present at HEAD and gone from the working tree - the deletion axis
 * for the unreadable-manifest fail-closed path. `--no-renames` so a staged
 * delete/add pair cannot be reclassified `R` and escape the D filter. Null
 * (not empty) when git itself fails, so the caller can fail closed rather
 * than read a git error as "nothing deleted". */
function deletedTrackedPaths(): string[] | null {
  const proc = git(["diff", "--diff-filter=D", "--no-renames", "--name-only", "-z", "HEAD"]);
  if (proc.exitCode !== 0) return null;
  return proc.stdout.split("\0").filter((path) => path !== "");
}

// HEAD's split declarations, split with HEAD's OWN manifest (a marker
// rename in the update cannot mis-split the previous copy). Null when the
// manifest is missing or damaged past parsing - both target-state
// anomalies the fully-migrated fleet manifest should never present, both
// handled fail closed below.
let headSplits: Map<string, HeadSplit> | null = null;
// WHY the manifest was rejected, for the PR body only (the message can
// name manifest paths, so it never reaches a log line). Clipped: the
// rejection message embeds decoded manifest keys, which are
// target-controlled - unbounded text would blow the section budget and a
// NUL would kill gh's --body argv (clip escapes control bytes).
let manifestProblem: string | null = null;
const headManifest = git(["show", `HEAD:${MANIFEST_NAME}`]);
if (headManifest.exitCode !== 0) {
  manifestProblem = "it could not be read from the previous commit";
} else {
  try {
    headSplits = headSplitEntries(headManifest.stdout, `HEAD:${MANIFEST_NAME}`);
  } catch (err) {
    manifestProblem = clip(err instanceof Error ? err.message : String(err));
  }
}

const candidates = new Map<string, HeadSplit | undefined>();
let scanUnavailable = false;
if (headSplits !== null) {
  for (const [path, split] of headSplits) candidates.set(path, split);
} else {
  // The split map is unknown; fall back to the deletion axis. When even
  // that cannot be read, hold the PR generically rather than fail open.
  const deleted = deletedTrackedPaths();
  if (deleted === null) scanUnavailable = true;
  else for (const path of deleted) candidates.set(path, undefined);
}
for (const name of ["LICENSE", "LICENSE.md"]) {
  if (!candidates.has(name)) candidates.set(name, undefined);
}

const removals: RemovedSplit[] = [];
for (const [path, split] of candidates) {
  if (existsSync(join(targetDir, path))) continue; // still present: not a deletion
  // headBytes is null only for a path genuinely absent at HEAD and throws
  // on a real git failure, so a broken repo fails the step loudly rather
  // than silently skip a candidate - inHead's `cat-file -e` cannot tell
  // absence from failure and would re-open the fail-open hole.
  const headCopy = headBytes(targetDir, path);
  if (headCopy === null) continue;
  removals.push({
    path,
    half: split === undefined ? undefined : headRepoOwnedHalf(headCopy.toString("latin1"), split),
  });
}

const section = renderRemovedSplits(removals, manifestProblem);
// The generic unverifiable notice forces review even when no removal could
// be enumerated - the whole point of failing closed on an unreadable scan.
const report = scanUnavailable ? `${REMOVED_SPLITS_UNVERIFIABLE}\n${section}` : section;
writeFileSync(join(requireEnv("RUNNER_TEMP"), REMOVED_SPLITS_NAME), report);
if (removals.length > 0) {
  // Paths are target file data: a hide-details target gets a count here
  // and the names only in the PR body, which lives in the private repo.
  notice(
    hideDetails()
      ? `${label}: this update deletes ${removals.length} split-classed file(s); the PR stays ` +
          "manual-review so a human can restore the repository-owned content that leaves " +
          "(paths hidden: private repository; named in the PR body)."
      : `${label}: this update deletes ${removals.map(({ path }) => path).join(" and ")}; the ` +
          "PR stays manual-review so a human can restore the repository-owned content that " +
          "leaves with the deletion (named in the PR body; git history is the record).",
  );
} else if (scanUnavailable) {
  notice(
    `${label}: the previous commit's ownership manifest and deleted-file list could not be ` +
      "read, so split-file deletions cannot be verified; the PR stays manual-review.",
  );
}
