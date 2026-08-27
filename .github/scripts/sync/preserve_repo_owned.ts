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
import { env, error, hideDetails, notice, requireEnv } from "../shared/gha.ts";
import { headBytes } from "../shared/git_head.ts";
import { parseModules } from "../shared/modules.ts";
import { clip, fenceFor } from "./preserve_local_content.ts";
import { REMOVED_SPLITS_NAME, SETTINGS_LAYERING_NAME } from "./section_files.ts";
import { transitionSettingsStarter } from "./settings_layering.ts";
import { MANIFEST_NAME } from "./stamp_manifest.ts";
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

const fleetLicense = "template/{% if 'custom-license' not in modules %}LICENSE.md{% endif %}.jinja";
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
// deletes retired paths outright - so content in a split file's
// repository-owned half silently leaves the repo while the update can
// otherwise look clean and AUTO-MERGE. The rule is CLASS-level: every
// deleted path HEAD's own manifest classes `split` holds the PR
// (open_pr.ts's section list), with the repository-owned content that
// leaves named in the body. HEAD's manifest, not the post-sync one: a
// path split at HEAD but absent from the new render appears in neither
// the rebuild's manifest walk nor the tail tripwire's. The two license
// spellings stay pointwise candidates ON TOP of the class rule: a
// pre-rename extensionless LICENSE has no manifest entry classing it (and
// a damaged HEAD manifest cannot class anything), yet a license deletion
// must still hold the PR - the restore and re-seed blocks above have
// already put back every license the sync preserves, so anything still
// missing here is a real deletion. Prior licensing needs no notice - git
// history is the record.

/** How much of each leaving repository-owned half the PR body shows.
 * Bounded like tail_tripwire's report: lines per file, characters per
 * line (clip), and one shared byte budget across ALL removed files - the
 * body caps at 64 KiB, gh fails outright past it, and several removals'
 * excerpts must not add up there; git history holds whatever the excerpt
 * omits. */
const MAX_HALF_LINES = 40;
const MAX_HALF_BYTES = 16384;

interface RemovedSplit {
  path: string;
  /** The repository-owned half at HEAD: content when located, null when
   * the previous copy does not split at its declared markers, undefined
   * when HEAD's manifest cannot class the path (the pointwise license
   * candidates without a manifest answer). */
  half: string | null | undefined;
}

/** One removed path's bullet, charging any excerpt against the shared
 * budget; returns the spent bytes with the text. */
function removedSplitBullet(
  { path, half }: RemovedSplit,
  budget: number,
): { text: string; cost: number } {
  if (half === undefined) {
    return {
      text:
        `- \`${path}\`: the previous commit's manifest does not class this file, so its ` +
        "repository-local content (if any) cannot be split out - review the previous copy " +
        "on the base branch before merging.",
      cost: 0,
    };
  }
  if (half === null) {
    return {
      text:
        `- \`${path}\`: its repository-owned half could not be located (the previous copy ` +
        "does not split at its declared marker lines) - review the previous copy on the " +
        "base branch before merging.",
      cost: 0,
    };
  }
  if (half.trim() === "") {
    return {
      text: `- \`${path}\`: its repository-owned section is empty; nothing leaves beyond the managed render.`,
      cost: 0,
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
    if (cost + lineCost > budget) break;
    cost += lineCost;
    shown.push(clipped);
  }
  if (shown.length === 0) {
    return {
      text:
        `- \`${path}\`: ${lines.length} line(s) of repository-owned content leave with the ` +
        "deletion (excerpt omitted: report size limit; see the base branch's copy).",
      cost: 0,
    };
  }
  const fence = fenceFor(shown);
  const omitted = lines.length - shown.length;
  const tail = omitted > 0 ? `\n  (${omitted} more; see the base branch's copy)` : "";
  return {
    text:
      `- \`${path}\`: this repository-owned content leaves with the deletion:\n\n` +
      `  ${fence}text\n${shown.map((line) => `  ${line}`).join("\n")}\n  ${fence}${tail}`,
    cost,
  };
}

const REMOVED_SPLITS_INTRO = [
  "> [!WARNING]",
  "> This update DELETES file(s) whose previous copy carries a",
  "> repository-owned half (ownership class `split`). Copier resolves",
  "> delete-vs-modify by dropping the file, and retired-file cleanup",
  "> deletes retired paths outright, so that repository-owned content is",
  "> NOT in this diff and survives only in git history (see the base",
  "> branch). Move anything that must stay into another file's",
  "> repository-local section on this branch before merging. Prior",
  "> licensing needs no notice - git history is the record.",
  "",
].join("\n");

// HEAD's split declarations, split with HEAD's OWN manifest (a marker
// rename in the update cannot mis-split the previous copy). A missing or
// unusable manifest is a target-state anomaly: the class rule cannot
// answer, the pointwise license candidates still can, and the tail
// tripwire independently routes the run to manual review in that state.
let headSplits: Map<string, HeadSplit> | null = null;
const headManifest = git(["show", `HEAD:${MANIFEST_NAME}`]);
if (headManifest.exitCode === 0) {
  try {
    headSplits = headSplitEntries(headManifest.stdout, `HEAD:${MANIFEST_NAME}`);
  } catch {
    headSplits = null;
  }
}

const candidates = new Map<string, HeadSplit | undefined>();
for (const [path, split] of headSplits ?? []) {
  candidates.set(path, split);
}
for (const name of ["LICENSE", "LICENSE.md"]) {
  if (!candidates.has(name)) candidates.set(name, undefined);
}

const removals: RemovedSplit[] = [];
for (const [path, split] of candidates) {
  if (existsSync(join(targetDir, path)) || !inHead(path)) continue;
  const headCopy = headBytes(targetDir, path);
  // inHead passed but the bytes are unreadable only for a non-blob (a
  // directory at the path); nothing splittable leaves.
  if (headCopy === null) continue;
  removals.push({
    path,
    half: split === undefined ? undefined : headRepoOwnedHalf(headCopy.toString("latin1"), split),
  });
}

let halfBudget = MAX_HALF_BYTES;
const bullets = removals.map((removal) => {
  const bullet = removedSplitBullet(removal, halfBudget);
  halfBudget -= bullet.cost;
  return bullet.text;
});
writeFileSync(
  join(requireEnv("RUNNER_TEMP"), REMOVED_SPLITS_NAME),
  removals.length === 0 ? "" : `${REMOVED_SPLITS_INTRO}\n${bullets.join("\n")}\n`,
);
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
}
