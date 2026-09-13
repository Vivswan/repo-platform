#!/usr/bin/env bun

// The squash commit carries the PR title alone (the fleet's squash_merge_commit_message is BLANK), so the opt-in rides on the merged
// pull request's labels; a commit no pull request produced (a direct push) carries none (docs/all-green.md).

import { z } from "zod";
import { fail, notice, requireEnv, setOutput, warning } from "../shared/gha.ts";
import { parseJsonWithThrow } from "../shared/json.ts";
import { captureNetwork } from "./discovery.ts";
import {
  type DiffBase,
  judgedRangeEnv,
  rangeCommits,
  rangeLabel,
  resolveBase,
} from "./judged_range.ts";

export type FleetSyncScope = "all" | "public";

const LABEL_PREFIX = "fleet-sync:";
/** This repository's overlay (.github/settings.local.yml) declares these labels; check_ssot's fleet-sync-labels rule holds the two
 *  rosters together. Other scopes (private, slugs, modules: filters) are dispatch-only: sync_scope.ts owns that grammar. */
export const FLEET_SYNC_LABELS: ReadonlyMap<string, FleetSyncScope> = new Map([
  [`${LABEL_PREFIX}all`, "all"],
  [`${LABEL_PREFIX}public`, "public"],
]);

export type Directive =
  | { kind: "none" }
  | { kind: "fleet-sync"; scope: FleetSyncScope }
  | { kind: "error"; error: string };

/** Names fold case (GitHub keeps label names unique that way). A fleet-sync label the platform does not declare, or two scopes on
 *  one pull request, is refused: a mistyped opt-in fails loudly instead of waiting for the weekly sync. */
export function readDirective(labels: readonly string[]): Directive {
  const own = labels
    .map((label) => label.toLowerCase())
    .filter((label) => label.startsWith(LABEL_PREFIX))
    .sort();
  if (own.length === 0) return { kind: "none" };
  const scopes: FleetSyncScope[] = [];
  const unknown: string[] = [];
  for (const label of own) {
    const scope = FLEET_SYNC_LABELS.get(label);
    if (scope === undefined) unknown.push(label);
    else scopes.push(scope);
  }
  if (unknown.length > 0) {
    return {
      kind: "error",
      error: `unknown fleet-sync label${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}; the platform declares ${[...FLEET_SYNC_LABELS.keys()].join(" and ")}`,
    };
  }
  if (scopes.length > 1) {
    return {
      kind: "error",
      error: `${scopes.length} fleet-sync labels (${own.join(", ")}): one scope per merge`,
    };
  }
  return { kind: "fleet-sync", scope: scopes[0] };
}

// repos/{repo}/commits/{sha}/pulls lists every pull request the commit reached. The one whose
// merge_commit_sha IS the commit is the merge that produced it; a closed unmerged pull request,
// or one that merely contained the commit, carries another sha or none.
const associatedPulls = z.array(
  z.object({
    number: z.number(),
    merge_commit_sha: z.string().nullable(),
    labels: z.array(z.object({ name: z.string() })),
  }),
);

/** The merged pull request's label names, or null for a commit no pull request produced. A failed lookup throws: an unreadable pull
 *  request must never read as "no label". */
function mergedPullLabels(repository: string, commit: string): string[] | null {
  const endpoint = `repos/${repository}/commits/${commit}/pulls`;
  const lookup = captureNetwork(["gh", "api", endpoint]);
  if (lookup.exitCode !== 0) {
    const detail = lookup.stderr.trim();
    throw new Error(
      `${endpoint} could not be read (gh api exit ${lookup.exitCode})${detail === "" ? "" : `: ${detail}`}`,
    );
  }
  const merged = parseJsonWithThrow(associatedPulls, lookup.stdout, endpoint).filter(
    (pull) => pull.merge_commit_sha === commit,
  );
  if (merged.length > 1) {
    throw new Error(
      `${endpoint}: ${merged.length} pull requests claim this commit as their merge (${merged.map((pull) => `#${pull.number}`).join(", ")}); refusing to pick one`,
    );
  }
  if (merged.length === 0) return null;
  return merged[0].labels.map((label) => label.name);
}

function main(): number {
  const { sha, before } = judgedRangeEnv();
  const repository = requireEnv("GITHUB_REPOSITORY");
  const cwd = process.cwd();
  let base: DiffBase;
  try {
    base = resolveBase(cwd, sha, before);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  let scope: FleetSyncScope | null = null;
  for (const commit of rangeCommits(cwd, sha, base)) {
    let labels: string[] | null;
    try {
      labels = mergedPullLabels(repository, commit);
    } catch (error) {
      // Every commit's lookup is fatal, the older ones included: a label
      // that cannot be read must fail the leg, never quietly disarm it.
      return fail(
        `${commit.slice(0, 12)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (labels === null) continue;
    const directive = readDirective(labels);
    if (directive.kind === "none") continue;
    if (directive.kind === "error") {
      // Only the judged commit's labels are this run's fault; failing on an
      // older one would poison every range that starts below it.
      if (commit === sha) return fail(`${commit.slice(0, 12)}: ${directive.error}`);
      warning(
        `${commit.slice(0, 12)}: ${directive.error}; the commit contributes nothing to this range, and only the judged commit's labels fail this leg`,
      );
      continue;
    }
    if (scope !== "all") scope = directive.scope;
    notice(`fleet-sync label on ${commit.slice(0, 12)}: ${directive.scope}`);
  }
  const range = rangeLabel(sha, base);
  if (scope === null) {
    notice(`${range} carries no fleet-sync label; the fleet picks it up on the weekly sync`);
    setOutput("armed", "false");
    return 0;
  }
  notice(`${range} opted in: syncing ${scope} now`);
  setOutput("armed", "true");
  setOutput("repos", scope);
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
