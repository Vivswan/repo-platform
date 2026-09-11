// Machinery shared by the fleet plan selectors (select_sync_repos.ts,
// select_settings_repos.ts). Their logs, step summaries, and matrices are
// publicly readable, so the privacy-sensitive pieces live here once: a fix
// to the discovery contract, the dispatch-input read, or the slug scrub
// protects every consumer at the same time (docs/sync.md).

import { readFileSync, writeSync } from "node:fs";
import { z } from "zod";
import { env } from "../shared/gha.ts";
import { parseJsonWith } from "../shared/json.ts";
import { capture, type RunResult } from "../shared/proc.ts";
import { classifyEntry, type ScopeSource } from "./sync_scope.ts";

/** Hard deadline for every fleet network subprocess (gh api calls, the curl
 * push probe): a stalled-network backstop, not a latency budget. Single
 * calls answer in seconds; the slowest is discoverWritableRepos' paginated
 * user/repos listing (serial, 100 repos per page), so two minutes covers
 * the fleet growing to several hundred repos. Without it a hung connection
 * blocks the plan job until the runner's job timeout, whose timeout-minutes
 * is sized from this. */
export const NETWORK_TIMEOUT_MS = 120_000;

/** capture() with the fleet network deadline applied; `timeoutMs` is
 * parameterized so tests can exercise the expiry path without waiting out
 * the production deadline. A SIGKILLed child usually dies silently, so an
 * expiry appends a line naming the deadline to the result's stderr. The
 * line names only the program, never the argv tail: the tail can carry a
 * private slug or, for the curl push probe, the PAT itself, and this
 * helper cannot know which call sites let stderr reach a public log. */
export function captureNetwork(command: string[], timeoutMs = NETWORK_TIMEOUT_MS): RunResult {
  const result = capture(command, { timeoutMs });
  if (result.timedOut === true) {
    result.stderr += `${command[0]} timed out after ${timeoutMs}ms (stalled network?)\n`;
  }
  return result;
}

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
  const list = captureNetwork([
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
    // writeSync: an async stream write racing the process.exit below
    // truncates at the pipe buffer (~64 KiB).
    writeSync(2, list.stderr);
    process.exit(list.exitCode);
  }
  const pages = parseJsonWith(userReposPages, list.stdout, label);
  return pages.flat().filter((repo) => !repo.archived && repo.permissions?.push === true);
}

export interface DiscoveredRepo {
  repo: string;
  private: boolean;
}

/** How a private repository is named in a selector's public log. */
export const PRIVATE_DISPLAY = "a private repository";

/** A selector's one line naming what it selected: public repositories by
 *  slug, private ones as a count; `none` when nothing was. */
export function selectedLine(rows: DiscoveredRepo[], prefix: string, none: string): string {
  if (rows.length === 0) return none;
  const publicSlugs = rows.filter((row) => !row.private).map((row) => row.repo);
  const hidden = rows.length - publicSlugs.length;
  const parts = [
    ...(publicSlugs.length > 0 ? [publicSlugs.join(", ")] : []),
    ...(hidden > 0 ? [`${hidden} private ${hidden === 1 ? "repository" : "repositories"}`] : []),
  ];
  return `${prefix}: ${parts.join(" and ")}`;
}

/** The discovered fleet scoped to `owner` and projected to the {repo,
 * private} rows the selection pipeline consumes. Visibility rides along
 * fail-closed - anything but private: false counts as private - because
 * the flag decides what the selectors' public logs may name. */
export function discoverOwnerRepos(owner: string, label: string): DiscoveredRepo[] {
  return discoverWritableRepos(label)
    .filter((repo) => repo.owner.login === owner)
    .map((repo) => ({ repo: repo.full_name, private: repo.private !== false }));
}

// The discovered list a selector reads back. Fail closed at the parse
// already: an entry without an explicit boolean `private` is rejected
// outright rather than defaulted, and one bad entry rejects the whole list
// - a silently dropped row would skip its repo's visibility decision.
// Loose on the rest: extra discovery fields pass through.
const discoveredListSchema = z.array(z.looseObject({ repo: z.string(), private: z.boolean() }));

/** Parse a discovered list at the trust boundary; null when the shape is
 * wrong (the caller then fails without quoting the payload, which can
 * carry private repo names). */
export function parseDiscovered(data: unknown): DiscoveredRepo[] | null {
  const result = discoveredListSchema.safeParse(data);
  return result.success ? result.data : null;
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

/** The typed `repo` dispatch input off the event payload (empty when the
 * event carries none), read from the runner's disk rather than step env:
 * the value may name a private repository, and step env prints into the
 * public log group. */
function dispatchInput(): string {
  if (env("GITHUB_EVENT_PATH") === "") return "";
  const event = parseJsonWith(
    dispatchEvent,
    readFileSync(env("GITHUB_EVENT_PATH"), "utf-8"),
    "readDispatchRepo: event payload",
  );
  return event.inputs?.repo ?? "";
}

/** The repo scope, case-folded (GitHub identity is case-insensitive, so it
 * must fold before any comparison): one slug or a comma-separated list. A
 * non-empty ONLY_REPO env overrides the event payload's dispatch input
 * (post-green's called sync, the harnesses, and local runs pass it that
 * way). With `owner`, a bare name gets it prefixed, except the scope tokens
 * (all, public, private, modules:...), which are never repo names. The typed
 * dispatch input may be a private slug, so IT never rides in as step env: the
 * runner prints step env into the public log group; the event payload on
 * disk is not logged. */
export function readDispatchRepo(owner?: string): string {
  let repo = env("ONLY_REPO");
  if (repo === "") repo = dispatchInput();
  // Empty entries survive on purpose (",", "a/b,,c/d"): the scope parser
  // rejects them loudly, where dropping one here would silently widen or
  // narrow the scope.
  return repo
    .split(",")
    .map((entry) => entry.trim())
    .map((entry) =>
      owner !== undefined &&
      entry !== "" &&
      classifyEntry(entry) === "invalid" &&
      !entry.includes("/")
        ? `${owner}/${entry}`
        : entry,
    )
    .join(",")
    .toLowerCase();
}

/** Which input readDispatchRepo read: the workflow_call scope rides in as ONLY_REPO, with the
 *  judged commit in `shaEnv` (the writer's own name for the call's sha input). */
export function scopeSource(shaEnv: string): ScopeSource {
  return env("ONLY_REPO") === "" ? { kind: "dispatch" } : { kind: "call", sha: env(shaEnv) };
}

// Case-insensitive replaceAll: GitHub identity is case-insensitive, so a
// scrub keyed to one casing must catch every other. The needle is
// regex-escaped and the replacement is a thunk, so neither is ever
// interpreted as pattern or substitution syntax.
function replaceAllFoldingCase(text: string, needle: string, replacement: string): string {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(escaped, "gi"), () => replacement);
}

/** Scrub a captured error detail of a private repo's identity before it
 * reaches a public log: every occurrence of the slug, then of the bare
 * name, in any casing, becomes the display. A no-op when the display IS
 * the slug (a public row) - the bare-name pass there would EXPAND bare
 * names into slugs instead of hiding anything. Substring-based on
 * purpose: garbling an innocent embedding is cosmetic, printing a private
 * name is not. */
export function scrubSlug(detail: string, slug: string, display: string): string {
  if (display === slug) return detail;
  const scrubbed = replaceAllFoldingCase(detail, slug, display);
  return replaceAllFoldingCase(scrubbed, slug.split("/").pop() ?? slug, display);
}

/** Notice for a discovered repo the token cannot push to. Leaving the fleet
 * = revoking the token's write access: a private repo then disappears from
 * discovery; a public one stays listed, and every plan whose scope selects
 * that repository prints one notice that the token cannot push to it. */
export function pushProbeSkipNotice(display: string): string {
  return `${display}: not in the fleet (the fleet token cannot push to it); grant write access to enroll it, or ignore this line for a repository you have left.`;
}

/** Skip notice for a repo without .repo-platform.yml on its default
 * branch. The settings heal inserts a consequence sentence. */
export function notAdoptedNotice(display: string, consequence?: string): string {
  const inserted = consequence === undefined ? "" : `${consequence} `;
  return `${display}: skipped - no .repo-platform.yml on its default branch, so it has not adopted the platform. ${inserted}Register it (docs/new-repo.md) to opt in, or revoke the fleet token's write access to leave the fleet.`;
}

/** Skip notice for a target whose .github/settings.yml the sync has not
 * rendered yet: the apply reads that file, and a hand-written one applied
 * alone would delete every fleet label it does not list. */
export function notRenderedNotice(display: string): string {
  return `${display}: skipped - its .github/settings.yml is not yet rendered; the sync PR carrying the rendered settings has not merged.`;
}
