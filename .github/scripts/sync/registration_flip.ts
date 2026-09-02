#!/usr/bin/env bun
// One-run transition for the .repo-platform.yml ownership flip. The
// registration file was class `managed`: every sync rewrote it and its
// stamped hash made any repo edit read as drift - contradicting the file's
// whole purpose (module selection and the repo's own `mirrors` declaration
// LIVE there; it exists to be edited repo-side). It is a repo-owned
// STARTER now: generated once, `_skip_if_exists` from then on, no content
// hash - the sync reads it and never rewrites it.
//
// The sync machinery needs no migration: the ownership manifest is itself
// a managed render, so this update's re-render flips the entry to a
// hash-free starter on its own, and copier skips the existing file from
// here on. What the transition owes each repo is VISIBILITY - the manifest
// diff does not explain itself - and an honest header: the old rendered
// header ("This file is managed by ...") now lies about ownership on every
// fleet copy the sync stops rewriting. So, exactly once per repo:
//
// - HEADER REWORD, triggered by the old rendered header TEXT itself (only
//   the pre-flip template rendered those lines and the hash pinning
//   enforced them, so a byte-0 match is proof of the old vintage): the
//   block is replaced with the current template's header, read from the
//   template source so the wording cannot fork (latin1 in, latin1 out -
//   every other byte is untouched). One-run and retrying by construction:
//   a reworded file never matches again, an unreworded one (a failed run)
//   still does on the next sync. The trigger reads the TEXT, not intent:
//   a repository that deliberately restores the exact old block after the
//   flip gets it reworded again (deliberate wording that must survive just
//   has to differ from the retired render - the block states an ownership
//   that no longer holds, so re-rewording it is the honest outcome).
//   Anything else is a hand-edited header the repo owns: hands off, said
//   in the note (starter_pin_rollout's rule).
// - NOTE, triggered by the target HEAD's own manifest still classing the
//   path `managed` (headManifestClass) - the flip moment, true until the
//   repo merges its first post-flip sync. A reword landing later (after a
//   failed run's PR merged) gets the smaller retry note instead.
//   Informational either way, never forces review - nothing the repo
//   declared changes, and enforcement only RELAXES.
//
// Delete this module (with its preserve_repo_owned.ts call, open_pr.ts
// section, rehearse.ts listing, tests, and harness leg) once one full
// sync run's PRs all carry no section - every HEAD manifest then classes
// the path starter, every header is reworded or repo-edited, and both
// triggers are dead fleet-wide.
//
// Invoked by preserve_repo_owned.ts, fail-soft: a failed transition warns
// and leaves the file alone (the next sync retries; the manifest trigger
// is still there).

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hideDetails, notice, warning } from "../shared/gha.ts";
import { headManifestClass } from "./settings_layering.ts";

const REGISTRATION = ".repo-platform.yml";
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const TEMPLATE_SOURCE = join(REPO_ROOT, "templates/base/.repo-platform.yml.jinja");

/** The old rendered header block, anchored at byte 0: the exact lines
 *  every hash-pinned fleet copy carries (any other wording was drift the
 *  pinning itself made impossible to sync). The owner charset matches
 *  GitHub usernames; capturing it from the file keeps this module free of
 *  the answers file. */
const OLD_HEADER_RE =
  /^# This file is managed by ([A-Za-z0-9-]+)\/repo-platform\. Its presence\n# marks this repository as participating in push sync\. `modules` is this\n# repo's module selection - edit it and the next sync applies the change\.\n/;

/** The current template header rendered for `owner`: the template source's
 *  leading comment lines with the one expression substituted - read from
 *  the source so a template reword cannot leave this transition writing a
 *  forked wording. Throws when the source stops looking like a leading
 *  comment block with the owner expression (the fail-soft caller reports
 *  it). */
export function starterHeaderFor(owner: string, templatePath = TEMPLATE_SOURCE): string {
  const source = readFileSync(templatePath, "utf-8");
  const lines: string[] = [];
  for (const line of source.split("\n")) {
    if (!line.startsWith("#")) break;
    lines.push(line);
  }
  const header = lines.join("\n");
  if (lines.length === 0 || !header.includes("{{ github_username }}")) {
    throw new Error(
      `${templatePath}: no leading comment block carrying {{ github_username }} - ` +
        "the header reword cannot be rendered; update registration_flip.ts alongside the template",
    );
  }
  const rendered = `${header.replaceAll("{{ github_username }}", owner)}\n`;
  if (rendered.includes("{{") || rendered.includes("{%") || rendered.includes("{#")) {
    throw new Error(
      `${templatePath}: the header block carries template expressions beyond ` +
        "{{ github_username }} - teach registration_flip.ts the substitution",
    );
  }
  return rendered;
}

/** The header reword applied to one file text (latin1 code units): the new
 *  text when the old rendered block opens the file, null when it does not
 *  (a hand-edited header - the repo's own, left alone). Exported for the
 *  tests. */
export function rewordedRegistration(
  text: string,
  headerFor: (owner: string) => string = starterHeaderFor,
): string | null {
  const match = OLD_HEADER_RE.exec(text);
  if (match === null) return null;
  // The substituted owner is ASCII by the capture's charset, so splicing
  // UTF-8 template bytes as latin1 code units round-trips byte-for-byte.
  const header = Buffer.from(headerFor(match[1]), "utf-8").toString("latin1");
  return header + text.slice(match[0].length);
}

/** The PR-body note. `reworded` distinguishes the two honest outcomes;
 *  the flip itself reads the same either way. */
export function flipSummary(reworded: boolean): string {
  const headerLine = reworded
    ? 'The stale header comment inside the file ("This file is managed by ...") was reworded to the starter wording in this update - the one byte-level change here, and the last one any sync makes to this file.'
    : "The file's header comment was NOT rewritten: it does not open with the exact old rendered header (this repository edited it), so it is left as the repository's own - reword it at your leisure.";
  return `### .repo-platform.yml is repo-owned now

Ownership flip in this update: \`.repo-platform.yml\` (module selection, the optional \`mirrors\` declaration) was class \`managed\` - every sync rewrote it and its stamped hash flagged any repo edit as drift, contradicting the file's whole purpose. It is a \`starter\` now: generated once, repo-owned from then on. The sync reads it and never rewrites it, the ownership manifest entry drops its content hash (the manifest diff in this PR), and edits to it are no longer drift.

${headerLine}
`;
}

/** The retry note: the flip is not this PR's news (HEAD's manifest already
 *  classes the path starter, or cannot answer) but the file still opened
 *  with the exact old rendered header, and this sync's reword landed. */
export function retrySummary(): string {
  return `### .repo-platform.yml header reworded

\`.repo-platform.yml\` flipped from class \`managed\` to a repo-owned \`starter\` in an earlier update, but the file still opened with the exact old "This file is managed by ..." header. This update rewords just those header lines to the starter wording (the old block states an ownership that no longer holds) - byte-level, nothing else in the file changes, and the sync still never rewrites the file's content.
`;
}

/** Run the one-run transition for a synced target; writes the PR-body
 *  section (empty once the flip and the reword have both landed). Fail-soft
 *  by contract (see the header). */
export function transitionRegistrationStarter(
  targetDir: string,
  outPath: string,
  label: string,
  templatePath = TEMPLATE_SOURCE,
): void {
  let section = "";
  try {
    // The REWORD's trigger is the old rendered header text itself, like
    // starter_pin_rollout's retired-pin trigger: only the pre-flip template
    // ever rendered those lines and the hash pinning enforced them, so a
    // match is proof of the old vintage; a reworded (or hand-edited) file
    // never matches again, which is what makes the rewrite one-run AND
    // what makes a failed run retry on the next sync - the old header is
    // still there to match.
    let reworded = false;
    const path = join(targetDir, REGISTRATION);
    // latin1 in, latin1 out: the reword must leave every byte outside
    // the matched header verbatim (the byte-faithfulness convention of
    // preserve_local_content.ts).
    const text = readFileSync(path).toString("latin1");
    const next = rewordedRegistration(text, (owner) => starterHeaderFor(owner, templatePath));
    if (next !== null) {
      writeFileSync(path, Buffer.from(next, "latin1"));
      reworded = true;
    }
    // The NOTE's trigger is HEAD's own manifest still classing the path
    // managed - the flip moment, which explains this PR's manifest diff.
    // Afterwards (starter at HEAD, or a manifest that cannot answer) the
    // only thing left to say is a reword that landed late.
    const head = headManifestClass(targetDir, REGISTRATION);
    if (head.kind === "read" && head.class === "managed") {
      section = flipSummary(reworded);
      notice(
        `${label}: .repo-platform.yml flipped managed -> starter (repo-owned; the sync ` +
          `reads it and never rewrites it); the stale header was ${
            reworded ? "reworded to the starter wording" : "left alone (repo-edited)"
          }. The transition note is in the PR body.`,
      );
    } else if (reworded) {
      section = retrySummary();
      notice(
        `${label}: reworded .repo-platform.yml's stale pre-flip header to the starter ` +
          "wording (the file still opened with the exact old rendered header). The note is in the PR body.",
      );
    }
  } catch (error) {
    // The detail can quote target-repo content; a hidden target's warning
    // keeps only the error class (settings_layering's guard).
    const detail = hideDetails()
      ? `${error instanceof Error ? error.constructor.name : "error"}; detail hidden: private repository`
      : error instanceof Error
        ? error.message.split("\n")[0]
        : String(error);
    warning(
      `${label}: the .repo-platform.yml ownership-flip transition failed (${detail}); ` +
        "the file is left alone and the next sync retries (the old header still matches).",
    );
    section = `### .repo-platform.yml ownership flip did not complete

The one-run transition (header reword + this note) failed: ${detail}. The flip itself still lands - the manifest entry in this update classes the file as a repo-owned starter and the sync no longer rewrites it - but the file may still open with the stale "managed by" header. The next sync retries the reword (the old header is its trigger); merging is safe.
`;
  }
  writeFileSync(outPath, section);
}
