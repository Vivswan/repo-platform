// The selectors' logs and step summaries are public, so every privacy-sensitive piece (discovery,
// the dispatch-input read, the slug scrub) lives here once (docs/sync.md).

import { readFileSync, writeSync } from "node:fs";
import { z } from "zod";
import { env } from "../shared/gha.ts";
import { parseJsonWith } from "../shared/json.ts";
import { capture, type RunResult } from "../shared/proc.ts";
import { classifyEntry, type ScopeSource } from "./sync_scope.ts";

/** A stalled-network backstop, not a latency budget: the slowest call is the paginated user/repos
 * listing, and two minutes covers several hundred repos. The plan jobs' timeout-minutes are sized
 * from this. */
export const NETWORK_TIMEOUT_MS = 120_000;

/** A killed child usually dies silently, so an expiry appends its own stderr line. The line names
 * only the program: the argv tail can carry a private slug or, for the curl push probe, the PAT. */
export function captureNetwork(command: string[], timeoutMs = NETWORK_TIMEOUT_MS): RunResult {
  const result = capture(command, { timeoutMs });
  if (result.timedOut === true) {
    result.stderr += `${command[0]} timed out after ${timeoutMs}ms (stalled network?)\n`;
  }
  return result;
}

// user/repos reports the USER's permissions, not the fine-grained token's grant, so this is only a
// pre-filter: push_probe.ts asks per repo.
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

/** A failed or malformed listing exits: without a trustworthy fleet list nothing downstream may run. */
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

export const PRIVATE_DISPLAY = "a private repository";

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

/** `private !== false` fails closed: the flag decides what the selectors' public logs may name. */
export function discoverOwnerRepos(owner: string, label: string): DiscoveredRepo[] {
  return discoverWritableRepos(label)
    .filter((repo) => repo.owner.login === owner)
    .map((repo) => ({ repo: repo.full_name, private: repo.private !== false }));
}

// One malformed entry rejects the whole list: a silently dropped row would skip its repo's
// visibility decision.
const discoveredListSchema = z.array(z.looseObject({ repo: z.string(), private: z.boolean() }));

/** Null, not a throw: the caller then fails with a fixed message and never echoes the payload,
 * which can carry private repo names. */
export function parseDiscovered(data: unknown): DiscoveredRepo[] | null {
  const result = discoveredListSchema.safeParse(data);
  return result.success ? result.data : null;
}

// nullish: schedule and release events carry no `inputs` key, and an inputs-less API dispatch
// writes `"inputs": null`.
const dispatchEvent = z.object({
  inputs: z.object({ repo: z.string().optional() }).nullish(),
});

/** Read from the event payload on disk, never step env: the value may name a private repository,
 * and the runner prints step env into the public log group. */
function dispatchInput(): string {
  if (env("GITHUB_EVENT_PATH") === "") return "";
  const event = parseJsonWith(
    dispatchEvent,
    readFileSync(env("GITHUB_EVENT_PATH"), "utf-8"),
    "readDispatchRepo: event payload",
  );
  return event.inputs?.repo ?? "";
}

/** Lowercased because GitHub identity is case-insensitive. A non-empty ONLY_REPO wins over the
 * dispatch input: the post-green call, the harnesses, and local runs pass the scope that way. */
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
// scrub keyed to one casing must catch every other. The replacement is a
// thunk, so a `$` in it is never substitution syntax.
function replaceAllFoldingCase(text: string, needle: string, replacement: string): string {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The needle is regex-escaped on the line above, so it is never pattern syntax.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  return text.replace(new RegExp(escaped, "gi"), () => replacement);
}

/** A public row (display IS the slug) is skipped: its bare-name pass would EXPAND bare names into
 * slugs instead of hiding anything. Substring on purpose: garbling an innocent embedding is
 * cosmetic, printing a private name is not. */
export function scrubSlug(detail: string, slug: string, display: string): string {
  if (display === slug) return detail;
  const scrubbed = replaceAllFoldingCase(detail, slug, display);
  return replaceAllFoldingCase(scrubbed, slug.split("/").pop() ?? slug, display);
}

/** A repository that left the fleet stays in discovery when public (a private one disappears), so
 * every plan selecting it prints this. */
export function pushProbeSkipNotice(display: string): string {
  return `${display}: not in the fleet (the fleet token cannot push to it); grant write access to enroll it, or ignore this line for a repository you have left.`;
}

export function notAdoptedNotice(display: string, consequence?: string): string {
  const inserted = consequence === undefined ? "" : `${consequence} `;
  return `${display}: skipped - no .repo-platform.yml on its default branch, so it has not adopted the platform. ${inserted}Register it (docs/new-repo.md) to opt in, or revoke the fleet token's write access to leave the fleet.`;
}

/** A hand-written settings.yml applied alone would delete every fleet label it does not list, so
 * the apply waits for the render. */
export function notRenderedNotice(display: string): string {
  return `${display}: skipped - its .github/settings.yml is not yet rendered; the sync PR carrying the rendered settings has not merged.`;
}
