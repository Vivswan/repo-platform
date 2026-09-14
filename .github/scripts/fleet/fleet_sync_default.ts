#!/usr/bin/env bun

// A change under these paths reaches the fleet only when a sync runs; a workflow or action change is live at `stable` on the next
// green merge with no sync. So a pull request that touches them gets the public sync by default: the label is added, one sticky
// comment says so, and a human removing it is final for that pull request (docs/all-green.md). Information only: every failure
// is a warning and exit 0, and the job is outside all-green's needs.
//
// Usage: PR_NUMBER=<n> GITHUB_REPOSITORY=<owner/repo> bun .github/scripts/fleet/fleet_sync_default.ts

import { type ZodType, z } from "zod";
import { PLATFORM_NAME, PLATFORM_SLUG } from "../../../actions/shared/platform.ts";
import {
  FLEET_SYNC_OVERLAY,
  type FleetSyncLabels,
  type FleetSyncScope,
  fleetSyncLabels,
  readDirective,
} from "../post-green/fleet_sync_marker.ts";
import { notice, requireEnv, warning } from "../shared/gha.ts";
import { parseJsonWithThrow } from "../shared/json.ts";
import { loadLayer } from "../sync/writer/settings_layers.ts";
import { captureNetwork } from "./discovery.ts";

/** The paths only a sync carries into the fleet: the writer's sources, its code, and the validator the targets run against them. */
export const SYNC_DELIVERED = [
  "files.yml",
  "files/",
  "migrations/",
  ".github/scripts/sync/writer/",
  "actions/validate-managed-files/",
];

export function deliveredBySync(path: string): boolean {
  return SYNC_DELIVERED.some((root) =>
    root.endsWith("/") ? path.startsWith(root) : path === root,
  );
}

/** The actor GITHUB_TOKEN's writes carry; a label event by anyone else is a human's. */
export const BOT_LOGIN = "github-actions[bot]";
export const MARKER = `<!-- ${PLATFORM_NAME}/fleet-sync-default -->`;
/** Enough to see what a sweep touched; the rest is a count. */
export const LISTED_PATHS = 25;
const DOCS = `https://github.com/${PLATFORM_SLUG}/blob/main/docs/all-green.md#opting-a-pr-into-an-immediate-fleet-sync`;

export function labelOf(known: FleetSyncLabels, scope: FleetSyncScope): string {
  for (const [label, labelScope] of known) if (labelScope === scope) return label;
  throw new Error(`no fleet-sync label names the ${scope} scope`);
}

export type Note =
  | { kind: "added" }
  | { kind: "kept-off"; by: string }
  | { kind: "refused"; error: string };

export function noteBody(paths: readonly string[], known: FleetSyncLabels, note: Note): string {
  const publicLabel = `\`${labelOf(known, "public")}\``;
  const [lead, closing] =
    note.kind === "added"
      ? [
          `Added ${publicLabel}: this pull request changes what a fleet sync delivers, so the public repos sync from its merge.`,
          `Remove the label if you do not want that; with no label the weekly schedule carries it. \`${labelOf(known, "all")}\` only when necessary and approved by the repository owner: it bills private minutes.`,
        ]
      : note.kind === "kept-off"
        ? [
            `${publicLabel} was removed by ${note.by}; not re-adding it. This pull request changes what a fleet sync delivers:`,
            "With no label the weekly schedule carries it.",
          ]
        : [
            "This pull request changes what a fleet sync delivers:",
            `Its fleet-sync label would be refused at merge and nothing would sync: ${note.error}.`,
          ];
  const listed = paths.slice(0, LISTED_PATHS).map((path) => `- \`${path}\``);
  if (paths.length > LISTED_PATHS) listed.push(`- and ${paths.length - LISTED_PATHS} more`);
  return [MARKER, lead, "", ...listed, "", `${closing} Details: [all-green.md](${DOCS}).`, ""].join(
    "\n",
  );
}

/** The public label's history on the pull request, from its issue events. */
export interface LabelHistory {
  /** Who added the label the last time it went on, or null when it never did. */
  lastAddedBy: string | null;
  /** The last human to take it off, or null: a bot removal (the default withdrawn) is not a decision. */
  removedBy: string | null;
}

export interface PullRequest {
  open: boolean;
  /** Every path the diff touches, a rename by both names. */
  changed: readonly string[];
  labels: readonly string[];
  base: string;
  defaultBranch: string;
  history: LabelHistory;
}

/** `clear` deletes a comment that exists; `leave` touches nothing. */
export type Wanted =
  | { kind: "comment"; body: string }
  | { kind: "clear"; reason: string }
  | { kind: "leave"; reason: string };
export type LabelAction = "add" | "remove" | "keep";
export interface Plan {
  label: LabelAction;
  comment: Wanted;
}

const clear = (reason: string, label: LabelAction = "keep"): Plan => ({
  label,
  comment: { kind: "clear", reason },
});
const say = (
  label: LabelAction,
  paths: readonly string[],
  known: FleetSyncLabels,
  note: Note,
): Plan => ({
  label,
  comment: { kind: "comment", body: noteBody(paths, known, note) },
});

/** The default yields to a human, and a closed pull request is left as it is: a post-merge label or title edit must change nothing
 *  the merge's own run already read (fleet_sync_marker.ts). */
export function plan(pr: PullRequest, known: FleetSyncLabels): Plan {
  if (!pr.open)
    return { label: "keep", comment: { kind: "leave", reason: "the pull request is closed" } };
  const publicLabel = labelOf(known, "public");
  const own = pr.labels.map((label) => label.toLowerCase());
  const botOwnsPublic = own.includes(publicLabel) && pr.history.lastAddedBy === BOT_LOGIN;
  const withdraw: LabelAction = botOwnsPublic ? "remove" : "keep";
  const paths = [...new Set(pr.changed.filter(deliveredBySync))].sort();
  if (paths.length === 0) return clear("no path here reaches the fleet through a sync", withdraw);
  if (pr.base !== pr.defaultBranch) {
    return clear(`merges into ${pr.base}, not ${pr.defaultBranch}`, withdraw);
  }
  const chosen = botOwnsPublic ? own.filter((label) => label !== publicLabel) : own;
  const directive = readDirective(chosen, known);
  if (directive.kind === "fleet-sync")
    return clear(`fleet-sync:${directive.scope} chosen`, withdraw);
  if (directive.kind === "error") {
    return say(withdraw, paths, known, { kind: "refused", error: directive.error });
  }
  if (botOwnsPublic) return say("keep", paths, known, { kind: "added" });
  if (pr.history.removedBy !== null) {
    return say("keep", paths, known, { kind: "kept-off", by: pr.history.removedBy });
  }
  return say("add", paths, known, { kind: "added" });
}

const pull = z.object({
  state: z.enum(["open", "closed"]),
  labels: z.array(z.object({ name: z.string() })),
  changed_files: z.number(),
  base: z.object({ ref: z.string(), repo: z.object({ default_branch: z.string() }) }),
});
const filesPages = z.array(
  z.array(z.object({ filename: z.string(), previous_filename: z.string().optional() })),
);
const commentsPages = z.array(z.array(z.object({ id: z.number(), body: z.string().optional() })));
// Only label events carry `label`; every other event kind in the listing is skipped by that absence.
const eventsPages = z.array(
  z.array(
    z.object({
      event: z.string(),
      actor: z.object({ login: z.string() }).nullable(),
      label: z.object({ name: z.string() }).optional(),
    }),
  ),
);
export type LabelEvent = z.infer<typeof eventsPages>[number][number];

/** Events arrive oldest first, so the last matching one is the current state's author. */
export function labelHistory(events: readonly LabelEvent[], label: string): LabelHistory {
  const history: LabelHistory = { lastAddedBy: null, removedBy: null };
  for (const event of events) {
    if (event.label?.name.toLowerCase() !== label) continue;
    const actor = event.actor?.login ?? null;
    if (event.event === "labeled") history.lastAddedBy = actor;
    else if (event.event === "unlabeled" && actor !== null && actor !== BOT_LOGIN) {
      history.removedBy = actor;
    }
  }
  return history;
}

function api(endpoint: string, ...flags: string[]): string {
  const result = captureNetwork(["gh", "api", endpoint, ...flags]);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim();
    throw new Error(
      `${endpoint}: gh api exit ${result.exitCode}${detail === "" ? "" : `: ${detail}`}`,
    );
  }
  return result.stdout;
}

function readPages<T>(schema: ZodType<T[][]>, endpoint: string): T[] {
  return parseJsonWithThrow(schema, api(endpoint, "--paginate", "--slurp"), endpoint).flat();
}

function applyLabel(issue: string, publicLabel: string, action: LabelAction): string {
  if (action === "add") {
    api(`${issue}/labels`, "-X", "POST", "-f", `labels[]=${publicLabel}`);
    return `added ${publicLabel}`;
  }
  if (action === "remove") {
    api(`${issue}/labels/${encodeURIComponent(publicLabel)}`, "-X", "DELETE");
    return `removed ${publicLabel}`;
  }
  return "label kept";
}

function applyComment(repository: string, issue: string, wanted: Wanted): string {
  if (wanted.kind === "leave") return `comment left as it is (${wanted.reason})`;
  const comments = `${issue}/comments`;
  // startsWith, not includes: a reply quoting the comment carries the marker mid-text.
  const existing =
    readPages(commentsPages, comments).find((comment) => comment.body?.startsWith(MARKER)) ?? null;
  if (wanted.kind === "clear") {
    if (existing === null) return `nothing to say (${wanted.reason})`;
    api(`repos/${repository}/issues/comments/${existing.id}`, "-X", "DELETE");
    return `removed the comment: ${wanted.reason}`;
  }
  if (existing === null) {
    api(comments, "-X", "POST", "-f", `body=${wanted.body}`);
    return "posted the comment";
  }
  if (existing.body === wanted.body) return "the comment is current";
  api(
    `repos/${repository}/issues/comments/${existing.id}`,
    "-X",
    "PATCH",
    "-f",
    `body=${wanted.body}`,
  );
  return "updated the comment";
}

/** A file moved out of files/ changes the delivery as much as an edit, so a rename counts by both names. */
function changedPaths(endpoint: string, changedFiles: number): string[] {
  const files = readPages(filesPages, `${endpoint}/files`);
  // The listing stops at 3,000 files while changed_files counts them all; a short listing must never read as "nothing delivered".
  if (files.length !== changedFiles) {
    throw new Error(`${endpoint}/files lists ${files.length} of ${changedFiles} changed files`);
  }
  return files.flatMap((file) =>
    file.previous_filename === undefined
      ? [file.filename]
      : [file.filename, file.previous_filename],
  );
}

function main(): number {
  const repository = requireEnv("GITHUB_REPOSITORY");
  const number = requireEnv("PR_NUMBER");
  try {
    const known = fleetSyncLabels(loadLayer(FLEET_SYNC_OVERLAY).doc, FLEET_SYNC_OVERLAY);
    const publicLabel = labelOf(known, "public");
    const endpoint = `repos/${repository}/pulls/${number}`;
    const issue = `repos/${repository}/issues/${number}`;
    const request = parseJsonWithThrow(pull, api(endpoint), endpoint);
    const pr: PullRequest = {
      open: request.state === "open",
      changed: changedPaths(endpoint, request.changed_files),
      labels: request.labels.map((label) => label.name),
      base: request.base.ref,
      defaultBranch: request.base.repo.default_branch,
      history: labelHistory(readPages(eventsPages, `${issue}/events`), publicLabel),
    };
    const decided = plan(pr, known);
    const label = applyLabel(issue, publicLabel, decided.label);
    notice(`${label}; ${applyComment(repository, issue, decided.comment)}`);
  } catch (error) {
    warning(
      `fleet-sync default skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
