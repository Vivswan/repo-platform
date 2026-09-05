import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HEADER_WINDOW } from "../../shared/grammar.ts";
import type { Context } from "../context.ts";
import { error, type Finding } from "../findings.ts";
import { isRegularFile, regexLiteral } from "../readers.ts";

/** Ownership self-declarations: every sync-managed file that supports
 *  comments tells its readers who owns it - the managed header on files
 *  sync wholly overwrites (region files self-declare through their marker
 *  pair, the split-markers check; class-only files have no comment channel
 *  and ride the manifest cross-check alone). Existing files only: a
 *  missing managed file is the manifest parity check's report. Skipped in
 *  self mode - the template repo's files are sources, not renders - and
 *  while the owner pin is unhealed (the registration check's error). */
export function checkHeaders(ctx: Context): Finding[] {
  if (ctx.mode !== "render" || ctx.owner === null) return [];
  const owner = ctx.owner;
  // Anchored on the header sentence's canonical trailing period with no
  // repo-name character (GitHub allows [A-Za-z0-9._-]) after it, so neither
  // a negated look-alike ("is not managed by") nor a longer repo name
  // ("/repo-platform_fork", "/repo-platform.fork") counts.
  const headerRe = new RegExp(
    `This file is managed by ${regexLiteral(owner)}/repo-platform\\.(?![A-Za-z0-9._-])`,
  );
  const findings: Finding[] = [];
  for (const entry of ctx.ownership) {
    if (entry.kind !== "header") continue;
    const path = join(ctx.root, entry.path);
    if (!isRegularFile(path)) continue;
    // latin1, matching the stamper's and sync rebuild's byte-level marker
    // predicate: a UTF-8 decode turns multibyte whitespace into characters
    // trim() strips, counting a line as the marker that the byte-level
    // matchers (and the stamped managed half) do not.
    const content = readFileSync(path).toString("latin1");
    if (!headerRe.test(content.split("\n", HEADER_WINDOW).join("\n"))) {
      findings.push(
        error(
          `${entry.path}: does not open with the managed header ('This file is ` +
            `managed by ${owner}/repo-platform.') - the file is ` +
            "overwritten by template sync and the header is what warns readers " +
            "their local edits get replaced; run a template sync to restore it",
        ),
      );
    }
  }
  return findings;
}
