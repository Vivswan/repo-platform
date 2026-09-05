#!/usr/bin/env bun
// Preserves repo-owned files after an update.
//
// settings.yml is a repo-owned starter (_skip_if_exists) wherever it
// exists: deselecting the settings-sync module de-renders it, but the
// sync must never delete a repo's settings file - repo-platform's
// settings-repos run merges it over the centrally computed managed
// baseline and applies the result. A recovery re-render can de-render the
// file too, so it is restored outright there.
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
// the fleet-license re-seed); RUNNER_TEMP (the removed-splits report
// file); HIDE_DETAILS; TARGET_DISPLAY / TARGET
// (log label, in that order; defaults to TARGET_DIR).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { MANIFEST_NAME } from "../../../actions/shared/manifest.ts";
import { env, error, hideDetails, notice, requireEnv } from "../shared/gha.ts";
import { type HeadNonBlobKind, headEntry } from "../shared/git_head.ts";
import { parseModules } from "../shared/modules.ts";
import {
  capture,
  DEFAULT_HANG_BOUND_MS,
  exitCodeOf,
  must,
  timeoutExitCode,
} from "../shared/proc.ts";
import { type HeadSplit, headSplitEntries, repoOwnedText } from "./head_manifest.ts";
import { clip, fenceFor } from "./preserve_local_content.ts";
import { REMOVED_SPLITS_NAME } from "./section_files.ts";

const targetDir = env("TARGET_DIR", "target");
const label = env("TARGET_DISPLAY") || env("TARGET") || targetDir;
const recover = env("RECOVER") === "recopy";
const modules = parseModules(env("MODULES")) ?? [];

/** Run a git probe against the target checkout. A deadline expiry aborts
 * loudly here, at the one probe owner, because every consumer reads
 * nonzero as a benign answer (inHead skips a restore, the manifest read
 * downgrades to held-for-review) - a hung git is a broken step, never an
 * answer. Subcommand only in the message: args can carry target paths.
 * Exported, with `timeoutMs` as the tests' injection seam, so the
 * fail-closed contract is behaviorally testable without waiting out the
 * production bound; production callers pass no timeout and get proc.ts's
 * default hang bound. */
export function git(args: string[], timeoutMs?: number): { exitCode: number; stdout: string } {
  const proc = capture(["git", "-C", targetDir, ...args], { timeoutMs });
  if (proc.timedOut) {
    error(`${label}: git ${args[0]} timed out; aborting rather than reading it as an answer`);
    process.exit(proc.exitCode);
  }
  return proc;
}

function inHead(path: string): boolean {
  return git(["cat-file", "-e", `HEAD:${path}`]).exitCode === 0;
}

function restoreFromHead(path: string): void {
  must(["git", "-C", targetDir, "checkout", "HEAD", "--", path]);
}

const fleetLicense = "template/LICENSE.md.jinja";

/** Whether `ref` carries the fleet license template, probed in
 * repo-platform's own checkout (no -C targetDir, so it cannot ride the
 * git() owner above); same fail-closed rule - a deadline expiry aborts
 * loudly, since read as "absent" it would skip the mandatory re-seed.
 * Exported with the same test-only `timeoutMs` seam as git(). */
export function fleetLicenseAt(ref: string, timeoutMs?: number): boolean {
  const probe = capture(["git", "cat-file", "-e", `${ref}:${fleetLicense}`], { timeoutMs });
  if (probe.timedOut) {
    error(`${label}: git cat-file timed out probing the fleet license at ${ref}`);
    process.exit(probe.exitCode);
  }
  return probe.exitCode === 0;
}

/** The fleet license template's bytes at `ref`. Raw Bun.spawnSync, not
 * capture(): the license bytes must round-trip via latin1 (see the
 * callback-replacement comment at the call site), and capture's string
 * result is a utf-8 decode that folds non-utf-8 bytes onto U+FFFD. The
 * hang bound still applies, carried inline with proc.ts's constant and
 * timeout-is-failure mapping; a raw spawn reports expiry as
 * exitedDueToTimeout, not the timedOut flag the other guards read.
 * Exported with the same test-only `timeoutMs` seam as git(). */
export function showFleetLicense(ref: string, timeoutMs = DEFAULT_HANG_BOUND_MS): Buffer {
  const show = Bun.spawnSync(["git", "show", `${ref}:${fleetLicense}`], {
    stderr: "inherit",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  if (show.exitedDueToTimeout === true) {
    error(`${label}: reading the fleet license from ${ref} timed out`);
    process.exit(timeoutExitCode(show));
  }
  if (show.exitCode !== 0) process.exit(exitCodeOf(show));
  return Buffer.from(show.stdout);
}

/** The restore/re-seed half: repo-owned settings.yml, custom-license
 * restores, and the fleet-license re-seed. */
function restoreRepoOwned(): void {
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

  if (
    !recover &&
    !existsSync(join(targetDir, "LICENSE.md")) &&
    !inHead("LICENSE.md") &&
    !modules.includes("custom-license")
  ) {
    const targetRef = env("TARGET_REF");
    if (targetRef !== "" && fleetLicenseAt(targetRef)) {
      const show = showFleetLicense(targetRef);
      // The template carries the Required Notice as a jinja variable; render
      // it from the repo's recorded answer rather than seeding template text.
      const answersPath = join(targetDir, ".github/.copier-answers.yml");
      let answers: Record<string, unknown> = {};
      if (existsSync(answersPath)) {
        let doc: unknown;
        try {
          doc = parse(readFileSync(answersPath, "utf-8"));
        } catch {
          doc = undefined;
        }
        if (doc === undefined || doc === null || typeof doc !== "object" || Array.isArray(doc)) {
          error(
            `${label}: cannot re-seed the fleet license; .github/.copier-answers.yml is unreadable`,
          );
          process.exit(1);
        }
        answers = doc as Record<string, unknown>;
      }
      const holder = answers.copyright_holder;
      if (typeof holder !== "string" || holder === "") {
        error(
          `${label}: cannot re-seed the fleet license; .github/.copier-answers.yml records no copyright_holder`,
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
          `${label}: cannot re-seed the fleet license; .github/.copier-answers.yml records no github_username`,
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
      const rendered = show
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

type RemovedSplit = { path: string } & (
  | {
      /** The previous copy is a regular file, so its repository-owned half
       * was looked for: content when located, null when the copy does not
       * split at its declared markers, undefined when the manifest does
       * not classify the path (a pointwise license candidate, or any
       * deleted path when HEAD's manifest is unreadable). */
      previous: "content";
      half: string | null | undefined;
    }
  | {
      /** HEAD carries a directory/symlink/submodule at the path: there is
       * no file content to split, and the bullet says so instead of a
       * marker-mismatch diagnosis. */
      previous: "non-blob";
      object: HeadNonBlobKind;
    }
  | {
      /** The deleted tracked name is not valid UTF-8: it cannot round-trip
       * through the string probes (a lossy decode mangles it onto U+FFFD
       * and headEntry then reads the wrong path as absent), so nothing
       * about the previous copy can be read - held outright. `path` then
       * carries the byte-escaped rendering, not the on-disk name. */
      previous: "undecodable";
    }
);

/** One removed path's bullet. The excerpt is bounded by MAX_HALF_LINES and
 * by `excerptBudget` bytes (whatever is left of the section budget), so a
 * single file cannot consume the whole section; the caller charges the
 * bullet's full rendered size against that budget. */
function removedSplitBullet(removal: RemovedSplit, excerptBudget: number): { text: string } {
  const { path } = removal;
  if (removal.previous === "undecodable") {
    return {
      text:
        `- \`${path}\` (name shown byte-escaped; the tracked name is not valid UTF-8): its ` +
        "previous copy cannot be probed or classified - review it on the base branch before " +
        "merging.",
    };
  }
  if (removal.previous === "non-blob") {
    return {
      text:
        `- \`${path}\`: the previous commit carries a ${removal.object} at this path, not a ` +
        "regular file, so no repository-owned content can be split out - review the previous " +
        "copy on the base branch before merging.",
    };
  }
  const { half } = removal;
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

/** `git ... -z` path output split on NUL and decoded STRICTLY: an entry
 * that is not valid UTF-8 cannot round-trip through a JS string (a lossy
 * decode folds it onto U+FFFD, and the mangled name then probes as
 * absent-at-HEAD), so it comes back as raw bytes for the caller to hold
 * rather than probe. A name that legitimately CONTAINS U+FFFD is valid
 * UTF-8 and stays a path - the discriminant is validity, not the
 * replacement character. Exported for the decode-boundary tests. */
export function decodeTrackedPathBytes(raw: Buffer): { paths: string[]; undecodable: Buffer[] } {
  // ignoreBOM: the default decoder SILENTLY DROPS a leading U+FEFF, and a
  // name starting with one is a different path - the probe would then read
  // the BOM-less spelling as absent and skip the hold.
  const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const paths: string[] = [];
  const undecodable: Buffer[] = [];
  let start = 0;
  while (start < raw.length) {
    let end = raw.indexOf(0, start);
    if (end === -1) end = raw.length;
    if (end > start) {
      const entry = raw.subarray(start, end);
      try {
        paths.push(strict.decode(entry));
      } catch {
        undecodable.push(Buffer.from(entry));
      }
    }
    start = end + 1;
  }
  return { paths, undecodable };
}

/** A non-UTF-8 name rendered loggable and PR-body-safe: printable ASCII
 * verbatim, every other byte as \xNN - including space (CommonMark strips
 * a code span's boundary spaces, silently changing the shown name),
 * backslash, and backtick (so the escapes stay unambiguous and the
 * bullet's code span survives). */
function escapePathBytes(raw: Buffer): string {
  let out = "";
  for (const byte of raw) {
    out +=
      byte > 0x20 && byte <= 0x7e && byte !== 0x5c && byte !== 0x60
        ? String.fromCharCode(byte)
        : `\\x${byte.toString(16).padStart(2, "0")}`;
  }
  return out;
}

/** Paths present at HEAD and gone from the working tree - the deletion axis
 * for the unreadable-manifest fail-closed path. `--no-renames` so a staged
 * delete/add pair cannot be reclassified `R` and escape the D filter. Null
 * (not empty) when git itself fails, so the caller can fail closed rather
 * than read a git error as "nothing deleted". Raw Bun.spawnSync, not the
 * git() owner: capture()'s string result is a utf-8 decode that folds a
 * non-UTF-8 tracked name onto U+FFFD - the bytes are split and strictly
 * decoded instead, with undecodable names returned raw. Same fail-closed
 * deadline rule as git(), with the same test-only `timeoutMs` seam. */
export function deletedTrackedPaths(
  timeoutMs = DEFAULT_HANG_BOUND_MS,
): { paths: string[]; undecodable: Buffer[] } | null {
  const argv = [
    "git",
    "-C",
    targetDir,
    "diff",
    "--diff-filter=D",
    "--no-renames",
    "--name-only",
    "-z",
    "HEAD",
  ];
  const proc = Bun.spawnSync(argv, {
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  if (proc.exitedDueToTimeout === true) {
    error(`${label}: git diff timed out; aborting rather than reading it as an answer`);
    process.exit(timeoutExitCode(proc));
  }
  if (proc.exitCode !== 0) return null;
  return decodeTrackedPathBytes(proc.stdout);
}

/** The removed-splits hold: HEAD's split declarations, split with HEAD's
 * OWN manifest (a marker rename in the update cannot mis-split the
 * previous copy - head_manifest.ts). headSplits is null when the manifest
 * is missing, damaged past parsing, or of a vintage headSplitEntries
 * refuses loudly (pre-grammar, a retired grammar, anything unknown) - all
 * target-state anomalies the fully-converted fleet manifest should never
 * present, all handled fail closed below with the refusal's message (its
 * recover=recopy advice included) in the PR body. */
function holdRemovedSplits(): void {
  let headSplits: Map<string, HeadSplit> | null = null;
  // WHY the manifest was rejected, for the PR body only (the message can
  // name manifest paths, so it never reaches a log line). Clipped: the
  // rejection message embeds decoded manifest keys, which are
  // target-controlled - unbounded text would blow the section budget and a
  // NUL would kill gh's --body argv (clip escapes control bytes).
  let manifestProblem: string | null = null;
  // headEntry, not a bare `git show`: `git show` answers a symlinked
  // manifest with its TARGET TEXT (which could parse as JSON) and a
  // directory with a tree listing - only a real blob is ever parsed.
  const headManifest = headEntry(targetDir, MANIFEST_NAME);
  if (headManifest.kind === "absent") {
    manifestProblem = "it could not be read from the previous commit";
  } else if (headManifest.kind === "non-blob") {
    manifestProblem = `the previous commit carries a ${headManifest.object} at the manifest path, not a regular file`;
  } else {
    try {
      headSplits = headSplitEntries(headManifest.bytes.toString("utf-8"), `HEAD:${MANIFEST_NAME}`);
    } catch (err) {
      manifestProblem = clip(err instanceof Error ? err.message : String(err));
    }
  }

  const removals: RemovedSplit[] = [];
  const candidates = new Map<string, HeadSplit | undefined>();
  let scanUnavailable = false;
  if (headSplits !== null) {
    for (const [path, split] of headSplits) candidates.set(path, split);
  } else {
    // The split map is unknown; fall back to the deletion axis. When even
    // that cannot be read, hold the PR generically rather than fail open.
    const deleted = deletedTrackedPaths();
    if (deleted === null) scanUnavailable = true;
    else {
      for (const path of deleted.paths) candidates.set(path, undefined);
      // A non-UTF-8 name never enters `candidates`: the string probes
      // below would re-mangle it and headEntry would read the wrong path
      // as absent. The diff already established it is at HEAD and gone
      // from the tree, so it is held outright, byte-escaped.
      for (const raw of deleted.undecodable) {
        removals.push({ path: escapePathBytes(raw), previous: "undecodable" });
      }
    }
  }
  for (const name of ["LICENSE", "LICENSE.md"]) {
    if (!candidates.has(name)) candidates.set(name, undefined);
  }

  for (const [path, split] of candidates) {
    if (existsSync(join(targetDir, path))) continue; // still present: not a deletion
    // headEntry reads absent only for a path genuinely absent at HEAD and
    // throws on a real git failure, so a broken repo fails the step loudly
    // rather than silently skip a candidate - inHead's `cat-file -e` cannot
    // tell absence from failure and would re-open the fail-open hole. A
    // non-blob entry (directory/symlink/submodule) has no file content to
    // split, so it is held with its own bullet instead of being fed to the
    // marker parser as if `git show`'s answer were the previous copy.
    const headCopy = headEntry(targetDir, path);
    if (headCopy.kind === "absent") continue;
    if (headCopy.kind === "non-blob") {
      removals.push({ path, previous: "non-blob", object: headCopy.object });
      continue;
    }
    removals.push({
      path,
      previous: "content",
      half:
        split === undefined ? undefined : repoOwnedText(headCopy.bytes.toString("latin1"), split),
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
            "manual-review so a human can review the repository-owned content (if any) that " +
            "leaves (paths hidden: private repository; named in the PR body)."
        : `${label}: this update deletes ${removals.map(({ path }) => path).join(" and ")}; the ` +
            "PR stays manual-review so a human can review the repository-owned content (if " +
            "any) that leaves with the deletion (named in the PR body; git history is the record).",
    );
  } else if (scanUnavailable) {
    notice(
      `${label}: the previous commit's ownership manifest and deleted-file list could not be ` +
        "read, so split-file deletions cannot be verified; the PR stays manual-review.",
    );
  }
}

if (import.meta.main) {
  restoreRepoOwned();
  holdRemovedSplits();
}
