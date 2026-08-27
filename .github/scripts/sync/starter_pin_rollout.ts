#!/usr/bin/env bun
// One-run sync-side rollout of action-pin flips inside STARTER-class
// files. Starters are rendered once and repo-owned forever
// (_skip_if_exists), so the template edit that moved the fuzz-issue pin
// from the floating `main` branch (and later the retired `actions`
// branch) to the green-gated `build` delivery branch never reaches a repo
// that already rendered its starter - the fleet would keep executing a
// retired pin, outside the delivery gate.
// Per this repo's transition law, the mechanical port ships as this
// one-run sync-side step, not a versioned migration. Invoked by
// reusable-template-sync.yml between the repo-owned preserve step and the
// final manifest stamp (starters carry no hash, but the tree must be
// final before validation), and by rehearse.ts in the same slot.
//
// Rules, in order of importance:
// - BYTE-SURGICAL: only an exact retired pin is replaced -
//   `<github_username>/repo-platform/actions/fuzz-issue@main` or the
//   same stem @actions, with the username taken from the target's own
//   recorded copier answers (the same answer the render interpolated),
//   matched as a whole pin token: a longer owner name that merely ends
//   in the username never matches, and the ref must equal a retired ref
//   exactly (@main-fork and @main/topic are different refs). Every other byte of the repo-owned
//   file is untouched (latin1 in, latin1 out - the byte-faithfulness
//   convention of preserve_local_content.ts).
// - IDEMPOTENT: a rewritten file carries only the new pin, so a second
//   run finds nothing to rewrite.
// - LOUD: every rewritten file and pin lands in the --report file, which
//   open_pr.ts appends to the PR body as the transition note (shared
//   filename constant STARTER_PINS_NAME in section_files.ts). The note
//   must describe the tree that is actually PUSHED: the structured
//   outcomes also land in --outcomes, and commit_push.ts's
//   Workflows-scope withhold - which restores .github/workflows files
//   AFTER this step ran - re-renders the note through
//   withholdWorkflowRewrites so the PR body never claims a port the push
//   withheld.
// - HANDS OFF hand-edited pins: a pin on the same action whose ref is
//   neither the old nor the new one was changed deliberately by the
//   repo; it is left byte-identical and listed as skipped in the report.
//   A starter the repo deleted, replaced with a symlink, or whose pins
//   it removed outright is indistinguishable from one that never
//   referenced the action and stays silent.
//
// Which files are starters comes from the render's ownership manifest,
// never a hardcoded path list: --render-dir's manifest on a normal sync
// (the clean render at the new ref), the working tree's own manifest in
// recopy mode (the recopied tree IS the fresh render, manifest included -
// the same split preserve_local_content.ts makes).
//
// Delete this script - with its workflow step, rehearse.ts leg,
// open_pr.ts section, commit_push.ts reconciliation, tests, and harness
// leg - once the rollout has nothing left to do fleet-wide; the
// measurable condition is one full sync run whose PRs all carry no
// rollout section (equivalently, a verbose per-repo rehearsal -
// bun .github/scripts/sync/rehearse.ts <owner>/<repo> - printing no
// rollout section for any managed repo).
//
// Usage:
//   bun starter_pin_rollout.ts [--root target] [--render-dir DIR]
//     [--report FILE] [--outcomes FILE] [--hide-details true|false]
//
// --report and --outcomes default to RUNNER_TEMP/<STARTER_PINS_NAME> and
// RUNNER_TEMP/<STARTER_PINS_OUTCOMES_NAME> - shared constants open_pr.ts
// and commit_push.ts read from, so the workflow never names the files and
// the pairs cannot drift.

import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { parseFlags } from "../shared/flags.ts";
import { fail, requireEnv } from "../shared/gha.ts";
import { clip, isCleanRelativePath } from "./preserve_local_content.ts";
import { STARTER_PINS_NAME } from "./section_files.ts";
import { MANIFEST_NAME } from "./stamp_manifest.ts";

/** The structured outcomes twin of the markdown report, written under
 * RUNNER_TEMP for commit_push.ts's withhold reconciliation (see the
 * header). Lives here, not section_files.ts: that module pairs writers
 * with open_pr.ts, and this file's consumer is commit_push.ts. */
export const STARTER_PINS_OUTCOMES_NAME = "starter-pin-rollout.json";

/** The pin flips this rollout ports. A rendered `uses:` value is
 * `<github_username>/<stem>@<ref>`; the flip rewrites each exact old-ref
 * pin to the new-ref pin and reports any OTHER ref on the same stem as a
 * deliberate hand edit to leave alone. One entry per stem, with every
 * retired ref in `from` - two entries sharing a stem would double-report
 * each hand pin. */
export const PIN_FLIPS = [
  // Both retired refs port to the unified build branch: @main predates
  // any delivery branch, @actions is the split-channel era's pin (fresh
  // renders of that era, and repos the @main rollout already ported).
  { stem: "repo-platform/actions/fuzz-issue", from: ["main", "actions"], to: "build" },
] as const;

/** The paths the manifest classes `starter`. Malformed manifest text
 * throws: silently reading zero starters would skip the whole rollout
 * (fail open) on exactly the damaged input that needs a loud stop. The
 * path hygiene matches preserve_local_content.ts's split entries - these
 * keys become filesystem paths under the target root. */
export function starterPaths(manifestText: string, where: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    // Value-free: a SyntaxError's message quotes manifest text (target
    // content) into the public sync log.
    throw new Error(`${where} does not parse as JSON`);
  }
  const files = (parsed as { files?: unknown } | null)?.files;
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    throw new Error(`${where} has no top-level 'files' mapping`);
  }
  const out: string[] = [];
  for (const [path, entry] of Object.entries(files as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`${where}: entry for ${path} is not an object`);
    }
    if ((entry as Record<string, unknown>).class !== "starter") continue;
    if (!isCleanRelativePath(path)) {
      throw new Error(
        `${where}: starter entry path '${path}' is not a clean relative path - it ` +
          "could escape the target root; the manifest is damaged",
      );
    }
    out.push(path);
  }
  return out;
}

export interface DifferingPin {
  /** The full differing pin (stem@ref), for the report. */
  pin: string;
  count: number;
}

export interface FileOutcome {
  rel: string;
  /** Exact old-pin occurrences rewritten, per flip. */
  rewrote: { from: string; to: string; count: number }[];
  /** Same-stem pins on neither the old nor the new ref: hand edits,
   * deliberately left alone. */
  differing: DifferingPin[];
}

/** The ref token after a `...@`, as a workflow `uses:` value delimits it:
 * everything up to whitespace or a quote. Exact-token comparison against
 * the flip's refs is what keeps the rewrite surgical - `@main-fork` and
 * `@main/topic` are different refs, never rewritten. */
function refAt(content: string, index: number): string {
  const match = /^[^\s"']*/.exec(content.slice(index));
  return match === null ? "" : match[0];
}

/** GitHub owner-name charset: a stem match preceded by one of these bytes
 * sits inside a LONGER owner name that merely ends in the username - that
 * is someone else's pin, never this rollout's. */
const OWNER_CHAR = /[A-Za-z0-9-]/;

/** One file's rollout: the rewritten content plus what changed and what
 * was deliberately skipped. Pure - the caller owns I/O. `username` must be
 * ASCII-validated (the caller pins the copier answer's shape) so the pin
 * strings are byte-identical under latin1 and utf-8. Matching is by whole
 * pin token (owner boundary before, exact ref token after), so the report
 * and the delivered bytes can never disagree about a near-miss pin. */
export function rolloutContent(
  content: string,
  username: string,
): { content: string; rewrote: FileOutcome["rewrote"]; differing: DifferingPin[] } {
  let current = content;
  const rewrote: FileOutcome["rewrote"] = [];
  const differing = new Map<string, number>();
  for (const flip of PIN_FLIPS) {
    const stemAt = `${username}/${flip.stem}@`;
    let result = "";
    let cursor = 0;
    const counts = new Map<string, number>();
    for (
      let i = current.indexOf(stemAt);
      i !== -1;
      i = current.indexOf(stemAt, i + stemAt.length)
    ) {
      if (i > 0 && OWNER_CHAR.test(current[i - 1])) continue;
      const refStart = i + stemAt.length;
      const ref = refAt(current, refStart);
      if ((flip.from as readonly string[]).includes(ref)) {
        result += current.slice(cursor, refStart) + flip.to;
        cursor = refStart + ref.length;
        counts.set(ref, (counts.get(ref) ?? 0) + 1);
      } else if (ref !== flip.to) {
        // Neither a retired nor the new ref: a hand-set pin, reported with
        // its actual ref and left alone (already-new pins are the silent
        // idempotent case).
        const pin = `${stemAt}${ref}`;
        differing.set(pin, (differing.get(pin) ?? 0) + 1);
      }
    }
    if (counts.size > 0) {
      for (const from of flip.from) {
        const count = counts.get(from);
        if (count !== undefined) {
          rewrote.push({ from: `${stemAt}${from}`, to: `${stemAt}${flip.to}`, count });
        }
      }
      current = result + current.slice(cursor);
    }
  }
  return {
    content: current,
    rewrote,
    differing: [...differing.entries()].map(([pin, count]) => ({ pin, count })),
  };
}

/** Outcomes with every `.github/workflows/` rewrite claim dropped, for
 * commit_push.ts's Workflows-scope withhold: the withhold restores those
 * files to the base revision AFTER the rollout ran, so a "rewrote" claim
 * would be false in the delivered PR (the withheld-workflows section
 * already lists the files, and the next sync with a scoped token ports
 * the pins again). Left-alone listings stay - true either way. */
export function withholdWorkflowRewrites(outcomes: FileOutcome[]): FileOutcome[] {
  return outcomes
    .map((outcome) =>
      outcome.rel.startsWith(".github/workflows/") ? { ...outcome, rewrote: [] } : outcome,
    )
    .filter(({ rewrote, differing }) => rewrote.length > 0 || differing.length > 0);
}

// The intro claims nothing about what changed - the per-file lines carry
// every claim of a rewrite or a skip, so the note stays truthful when
// commit_push.ts's withhold drops the rewrite lines and only left-alone
// listings remain.
const REPORT_INTRO =
  "One-run starter pin rollout: repo-platform's composite actions now ship on the green-gated `build` delivery branch instead of floating on `main` or the retired `actions` branch, but starter workflows are rendered once and repo-owned, so template sync cannot re-render their pins. This sync checked each starter for the retired fuzz-issue pins; a `rewrote` line below is a byte-surgical port (only the exact pin token changed, every other byte is untouched), a `left alone` line is a hand-set pin this rollout never touches:";

/** The PR-body transition note. Pins ride through clip (bounded,
 * control bytes escaped): the differing refs are target-controlled. */
export function renderRolloutReport(outcomes: FileOutcome[]): string {
  if (outcomes.length === 0) return "";
  const lines = [REPORT_INTRO, ""];
  for (const { rel, rewrote, differing } of outcomes) {
    for (const { from, to, count } of rewrote) {
      lines.push(`- \`${rel}\`: rewrote ${count} occurrence(s) of \`${from}\` to \`${to}\``);
    }
    for (const { pin, count } of differing) {
      lines.push(
        `- \`${rel}\`: left alone - carries ${count} occurrence(s) of \`${clip(pin)}\`, a hand-set pin on none of the retired \`@main\`/\`@actions\` refs; repoint it at \`@build\` for green-gated delivery, or keep your own pin`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

/** The recorded github_username, shape-checked the way the license
 * re-seed pins it (preserve_repo_owned.ts): the answers file is
 * target-controlled, and a malformed value would assemble a pin string
 * that can never have been rendered. Fail closed - a tree copier just
 * updated always carries a well-formed answers file, so damage here is
 * a broken input, not a skippable nicety. */
function recordedUsername(root: string): string {
  const answersPath = join(root, ".copier-answers.yml");
  let doc: unknown;
  try {
    doc = parse(readFileSync(answersPath, "utf-8"));
  } catch {
    doc = undefined;
  }
  if (doc === undefined || doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    fail(`starter pin rollout: ${answersPath} is missing or unreadable`);
  }
  const username = (doc as Record<string, unknown>).github_username;
  if (typeof username !== "string" || !/^[A-Za-z0-9-]+$/.test(username)) {
    fail(
      "starter pin rollout: .copier-answers.yml records no well-formed github_username, " +
        "so the rendered pin strings cannot be reconstructed",
    );
  }
  return username;
}

/** A starter's byte content as latin1 text, probed FAIL-CLOSED: ENOENT
 * and ENOTDIR mean the path is genuinely absent (the repo deleted its
 * starter - nothing to port), a symlink at the final component is skipped
 * (a repo-owned replacement this step must neither follow nor rewrite,
 * like a removed pin), and any OTHER lstat error throws - a permission
 * failure reading as "deleted starter" would silently skip the port. A
 * symlinked ANCESTOR throws too: reads and writes through it land outside
 * the checkout's own tree, so the rollout could neither port nor honestly
 * report the path (preserve_local_content.ts refuses the same shape). */
function starterContent(root: string, rel: string): string | null {
  for (
    let ancestor = dirname(rel);
    ancestor !== "." && ancestor !== "/";
    ancestor = dirname(ancestor)
  ) {
    let stat: ReturnType<typeof lstatSync> | null = null;
    try {
      stat = lstatSync(join(root, ancestor));
    } catch {
      // An absent ancestor is the absent-path case; the final probe below
      // classifies it.
      stat = null;
    }
    if (stat?.isSymbolicLink()) {
      throw new Error(
        `refusing to touch ${rel}: its ancestor '${ancestor}' is a symbolic link, ` +
          "so reads and writes would land outside the checkout's own tree",
      );
    }
  }
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(join(root, rel));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
  if (!stat.isFile()) return null;
  return readFileSync(join(root, rel)).toString("latin1");
}

function main(argv: string[]): number {
  const flags = parseFlags(
    argv,
    [] as const,
    ["--root", "--render-dir", "--report", "--outcomes", "--hide-details"] as const,
  );
  const root = flags["--root"] ?? "target";
  const report = flags["--report"] ?? join(requireEnv("RUNNER_TEMP"), STARTER_PINS_NAME);
  const outcomesPath =
    flags["--outcomes"] ?? join(requireEnv("RUNNER_TEMP"), STARTER_PINS_OUTCOMES_NAME);
  const hideDetails = flags["--hide-details"] === "true";
  const renderDir = flags["--render-dir"];

  // Normal sync: the clean render at the new ref owns the starter roster.
  // Recopy mode (no --render-dir): the recopied working tree is the fresh
  // render, manifest included.
  const manifestPath = join(renderDir ?? root, MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    throw new Error(
      `${manifestPath} is missing; the starter pin rollout needs the render's manifest to know which files are starters`,
    );
  }
  const username = recordedUsername(root);

  const outcomes: FileOutcome[] = [];
  for (const rel of starterPaths(readFileSync(manifestPath, "utf-8"), manifestPath)) {
    const previous = starterContent(root, rel);
    if (previous === null) continue;
    const { content, rewrote, differing } = rolloutContent(previous, username);
    // latin1 round-trips every byte and the pins are ASCII, so the token
    // swap leaves every other byte verbatim.
    if (content !== previous) writeFileSync(join(root, rel), Buffer.from(content, "latin1"));
    if (rewrote.length > 0 || differing.length > 0) outcomes.push({ rel, rewrote, differing });
  }

  writeFileSync(report, renderRolloutReport(outcomes), "utf-8");
  writeFileSync(outcomesPath, `${JSON.stringify(outcomes, null, 2)}\n`, "utf-8");

  if (outcomes.length === 0) {
    console.log("starter pin rollout: nothing to port (no old or hand-set pins in any starter)");
    return 0;
  }
  // Paths and pin values are target file data: a hide-details target gets
  // counts here and the detail only in the PR body, which lives in the
  // private repo.
  if (!hideDetails) {
    for (const { rel, rewrote, differing } of outcomes) {
      for (const { from, to, count } of rewrote) {
        console.log(`${rel}: rewrote ${count} pin(s) ${from} -> ${to}`);
      }
      for (const { pin, count } of differing) {
        console.log(`${rel}: left alone (${count} hand-set pin(s) ${clip(pin)})`);
      }
    }
  } else {
    console.log(
      `starter pin rollout touched or skipped ${outcomes.length} starter file(s) ` +
        "(paths hidden: private repository; listed in the PR body)",
    );
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
