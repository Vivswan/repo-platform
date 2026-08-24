// Machinery shared by the fleet plan selectors (select_sync_repos.ts,
// select_settings_repos.ts) and the per-repo leg resolver
// (resolve_private_repo.ts). Their logs, step summaries, and matrices are
// publicly readable, so the redaction-sensitive pieces live here once: a
// fix to the discovery contract, the dispatch-input read, or the slug
// scrub protects every consumer at the same time (docs/private-repos.md).

import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { env } from "../shared/gha.ts";
import { parseWith } from "../shared/json.ts";
import { capture } from "../shared/proc.ts";

// user/repos with the fleet PAT sees every repo the USER can reach, and
// its permissions field reflects the user, not the token: discovery only
// pre-filters to non-archived, user-writable repos - the token's actual
// grant is probed per repo (push_probe.ts). Visibility rides along for
// the fail-closed private decision (anything but private: false counts
// as private), and owner for callers that scope to the fleet owner.
const userReposPages = z.array(
  z.array(
    z.object({
      full_name: z.string(),
      archived: z.boolean(),
      private: z.boolean(),
      owner: z.object({ login: z.string() }),
      permissions: z.object({ push: z.boolean().optional() }).optional(),
    }),
  ),
);

/** Every non-archived repo the user can push to, all owners included. A
 * failed listing or a malformed payload exits the process: without a
 * trustworthy fleet list nothing downstream may run. `label` names the
 * caller in the malformed-shape diagnostic. */
export function discoverWritableRepos(label: string) {
  // -F alone would flip gh api to POST; this is a read. --paginate emits
  // concatenated page arrays, so --slurp makes one array of pages first.
  const list = capture([
    "gh",
    "api",
    "user/repos",
    "--method",
    "GET",
    "--paginate",
    "--slurp",
    "-F",
    "per_page=100",
  ]);
  if (list.exitCode !== 0) {
    process.stderr.write(list.stderr);
    process.exit(list.exitCode);
  }
  const pages = parseWith(userReposPages, JSON.parse(list.stdout), label);
  return pages.flat().filter((repo) => !repo.archived && repo.permissions?.push === true);
}

// Only the dispatch input's slot is pinned; unrelated event fields pass
// through unchecked. An absent input is valid - schedule and release
// events carry no `inputs` key, and an inputs-less API dispatch writes
// `"inputs": null` - but a present slot of the wrong type fails loudly
// (parseWith's diagnostic names paths only, never the value, which may be
// a private slug).
const dispatchEvent = z.object({
  inputs: z.object({ repo: z.string().optional() }).nullish(),
});

/** The repo dispatch input, case-folded (GitHub identity is
 * case-insensitive, so it must fold before any comparison). A non-empty
 * ONLY_REPO env overrides the event payload - the test harnesses and
 * local runs use that. When `owner` is given, a bare name gets it
 * prefixed. The typed input may be a private slug, so it must never ride
 * in as step env: the runner prints step env values into the public log
 * group; the event payload on the runner's disk is not logged. */
export function readDispatchRepo(owner?: string): string {
  let repo = env("ONLY_REPO");
  if (repo === "" && env("GITHUB_EVENT_PATH") !== "") {
    const event = parseWith(
      dispatchEvent,
      JSON.parse(readFileSync(env("GITHUB_EVENT_PATH"), "utf-8")),
      "readDispatchRepo: event payload",
    );
    repo = event.inputs?.repo ?? "";
  }
  repo = repo.trim();
  if (owner !== undefined && repo !== "" && !repo.includes("/")) repo = `${owner}/${repo}`;
  return repo.toLowerCase();
}

/** Run one selection-pipeline stage, teeing its stdout to `outFile`;
 * stderr stays inherited. A failing stage exits this process with the
 * stage's own code, first writing the captured stdout through: the runner
 * only parses workflow commands (::error::) from stdout, and the stages'
 * own diagnostics already follow the redaction discipline this public log
 * requires - they never print an undisclosed private name. */
export function runStage(command: string[], outFile: string): void {
  const proc = Bun.spawnSync(command, { stdout: "pipe", stderr: "inherit" });
  if (proc.exitCode !== 0) {
    process.stdout.write(proc.stdout.toString());
    process.exit(proc.exitCode ?? 1);
  }
  writeFileSync(outFile, proc.stdout);
}

// Case-insensitive replaceAll: GitHub identity is case-insensitive, so a
// scrub keyed to one casing must catch every other. The needle is
// regex-escaped and the replacement is a thunk, so neither is ever
// interpreted as pattern or substitution syntax.
function replaceAllFoldingCase(text: string, needle: string, replacement: string): string {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(escaped, "gi"), () => replacement);
}

/** Scrub a captured error detail of a redacted repo's identity before it
 * reaches a public log: every occurrence of the slug, then of the bare
 * name, in any casing, becomes the display. A no-op when the display IS
 * the slug (an unredacted row) - the bare-name pass there would EXPAND
 * bare names into slugs instead of hiding anything. Substring-based on
 * purpose: garbling an innocent embedding is cosmetic, printing a private
 * name is not. */
export function scrubSlug(detail: string, slug: string, display: string): string {
  if (display === slug) return detail;
  const scrubbed = replaceAllFoldingCase(detail, slug, display);
  return replaceAllFoldingCase(scrubbed, slug.split("/").pop() ?? slug, display);
}

/** Skip notice for a repo the fleet token cannot push to; `code` is the
 * probe's definitive-negative HTTP status (401/403/404). */
export function pushProbeSkipNotice(display: string, code: number): string {
  return `${display}: skipped - the fleet token has no write access (push probe HTTP ${code}). Grant the REPO_PLATFORM_TOKEN access to this repository to enroll it, or add it to repos.yml's exclude list to silence this.`;
}

/** Skip notice for a repo without .repo-platform.yml on its default
 * branch. The settings heal inserts a consequence sentence; that sentence
 * introduces ".github/settings.yml" as a nearer referent, so the closing
 * clause switches from "it" to "the repo". */
export function notAdoptedNotice(display: string, consequence?: string): string {
  const inserted = consequence === undefined ? "" : `${consequence} `;
  const subject = consequence === undefined ? "it" : "the repo";
  return `${display}: skipped - no .repo-platform.yml on its default branch, so it has not adopted the template. ${inserted}Generate it with copier (see the repo-platform README) to opt in, or add ${subject} to repos.yml's exclude list to silence this.`;
}
