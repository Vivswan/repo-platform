// The selectors' logs and step summaries are public, so every privacy-sensitive piece (discovery,
// the dispatch-input read, the slug scrub) lives here once (docs/platform/sync/private-repositories.md).

import { readFileSync } from "node:fs";
import { error } from "@actions/core";
import { z } from "zod";
import { REGISTRATION_PATH, SETTINGS_PATH } from "../../../actions/shared/platform.ts";
import { env } from "../shared/gha.ts";
import { type GitHubClient, REQUEST_DEADLINE_MS, unansweredReason } from "../shared/github.ts";
import { parseJsonWith } from "../shared/json.ts";
import { capture, type RunResult } from "../shared/proc.ts";

/** The spawned git probes stall on the same network as the API client's requests, so they share its backstop. */
export const NETWORK_TIMEOUT_MS = REQUEST_DEADLINE_MS;

/** A killed child usually dies silently, so an expiry appends its own stderr line. The line names
 * only the program: the argv tail can carry a private slug. */
export function captureNetwork(command: string[], timeoutMs = NETWORK_TIMEOUT_MS): RunResult {
  const result = capture(command, { timeoutMs });
  if (result.timedOut === true) {
    result.stderr += `${command[0]} timed out after ${timeoutMs}ms (stalled network?)\n`;
  }
  return result;
}

// user/repos reports the USER's permissions, not the fine-grained token's grant, so this is only a pre-filter: push_probe.ts asks per repo.
const userRepo = z.object({
  full_name: z.string(),
  archived: z.boolean(),
  private: z.boolean(),
  owner: z.object({ login: z.string() }),
  permissions: z.object({ push: z.boolean().optional() }).optional(),
});

/** A failed or malformed listing exits: without a trustworthy fleet list nothing downstream may run. */
export async function discoverWritableRepos(github: GitHubClient, label: string) {
  const listing = await github.paginate("user/repos", userRepo);
  if (listing.kind !== "ok") {
    error(`${label} could not be read (${unansweredReason(listing)})`);
    process.exit(1);
  }
  return listing.value.filter((repo) => !repo.archived && repo.permissions?.push === true);
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
export async function discoverOwnerRepos(
  github: GitHubClient,
  owner: string,
  label: string,
): Promise<DiscoveredRepo[]> {
  const repos = await discoverWritableRepos(github, label);
  return repos
    .filter((repo) => repo.owner.login === owner)
    .map((repo) => ({ repo: repo.full_name, private: repo.private !== false }));
}

// One malformed entry rejects the whole list: a silently dropped row would skip its repo's visibility decision.
const discoveredListSchema = z.array(z.looseObject({ repo: z.string(), private: z.boolean() }));

/** Null, not a throw: the caller then fails with a fixed message and never echoes the payload,
 * which can carry private repo names. */
export function parseDiscovered(data: unknown): DiscoveredRepo[] | null {
  const result = discoveredListSchema.safeParse(data);
  return result.success ? result.data : null;
}

// nullish: schedule and release events carry no `inputs` key, and an inputs-less API dispatch writes `"inputs": null`.
const dispatchEvent = z.object({
  inputs: z
    .object({
      repo: z.string().optional(),
      branch: z.string().optional(),
      add_modules: z.string().optional(),
    })
    .nullish(),
});

/** Read from the event payload on disk, never step env: the values may name a private repository
 * and its work, and the runner prints step env into the public log group. */
function dispatchInputs(): { repo: string; branch: string; addModules: string } {
  if (env("GITHUB_EVENT_PATH") === "") return { repo: "", branch: "", addModules: "" };
  const event = parseJsonWith(
    dispatchEvent,
    readFileSync(env("GITHUB_EVENT_PATH"), "utf-8"),
    "dispatch inputs: event payload",
  );
  return {
    repo: event.inputs?.repo ?? "",
    branch: event.inputs?.branch ?? "",
    addModules: event.inputs?.add_modules ?? "",
  };
}

/** Per entry trimmed and case-folded; empty entries survive on purpose (",", "a,,b"): the parsers reject them loudly,
 * where dropping one here would silently widen or narrow the list. */
function foldedList(value: string): string {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .join(",")
    .toLowerCase();
}

/** The branch a dispatch syncs onto (docs/platform/sync/operator.md, "Syncing a branch"); empty on every other run. Verbatim: git forbids
 * ASCII whitespace in a refname, so a padded value is a typo the resolve probe refuses, and a name ending in a no-break
 * space is its own branch, which trimming would send to the one it resembles. */
export function readDispatchBranch(): string {
  return dispatchInputs().branch;
}

/** Lowercased because GitHub identity is case-insensitive. A non-empty ONLY_REPO wins over the
 * dispatch input: the post-green call, the harnesses, and local runs pass the scope that way. */
export function readDispatchRepo(): string {
  const repo = env("ONLY_REPO");
  return foldedList(repo === "" ? dispatchInputs().repo : repo);
}

/** The module names a dispatch adds to the target's registration (docs/platform/sync/operator.md, "Adding modules");
 * empty on every other run. Folded like the scope: module names are kebab-case. */
export function readDispatchAddModules(): string {
  return foldedList(dispatchInputs().addModules);
}

/** A repository that left the fleet stays in discovery when public (a private one disappears), so
 * every plan selecting it prints this. */
export function pushProbeSkipNotice(display: string): string {
  return `${display}: not in the fleet (the fleet token cannot push to it); grant write access to enroll it, or ignore this line for a repository you have left.`;
}

export function notAdoptedNotice(display: string, consequence?: string): string {
  const inserted = consequence === undefined ? "" : `${consequence} `;
  return `${display}: skipped - no ${REGISTRATION_PATH} on its default branch, so it has not adopted the platform. ${inserted}Register it (docs/new-repo.md) to opt in, or revoke the fleet token's write access to leave the fleet.`;
}

/** A new repository before its first sync PR merges: the sync writes the file. */
export function notRenderedNotice(display: string): string {
  return `${display}: skipped - it has no ${SETTINGS_PATH} yet; the sync PR that renders it has not merged.`;
}
