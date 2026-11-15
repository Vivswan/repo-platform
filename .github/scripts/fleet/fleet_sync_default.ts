#!/usr/bin/env bun

// A change on the delivered surface (DELIVERED_SURFACE below) moves what a sync delivers, and only a sync carries it; a change
// off the surface is live at `stable` on the next green merge with no sync. So a pull request that touches it gets the public sync
// by default: the label is added, one sticky comment says so, and a human removing it is final for that pull request
// (docs/platform/post-green.md). Information only: every failure is a warning and exit 0, and the job is outside all-green's needs.
//
// Usage: PR_NUMBER=<n> GITHUB_REPOSITORY=<owner/repo> bun .github/scripts/fleet/fleet_sync_default.ts

import { notice, warning } from "@actions/core";
import { z } from "zod";
import { PLATFORM_NAME, PLATFORM_SLUG } from "../../../actions/shared/platform.ts";
import {
  FLEET_SYNC_OVERLAY,
  type FleetSyncLabels,
  type FleetSyncScope,
  fleetSyncLabels,
  readDirective,
} from "../post-green/fleet_sync_marker.ts";
import { requireEnv } from "../shared/gha.ts";
import { GitHubClient, type Read, type Sent, unansweredReason } from "../shared/github.ts";
import { codeSpan } from "../shared/markdown_code.ts";
import { BOT_LOGIN, issueComment, stickyComment } from "../shared/sticky_comment.ts";
import { loadLayer } from "../sync/writer/settings_layers.ts";

// The writer's data, its import closure, and its dependency versions. bun.lock is on it because the settings library's
// version decides the rendered settings.yml's key order; package.json because its postinstall decides which action-local
// dependencies the writer resolves. Whether a sync then moves a repository's judge is the writer's own stamp rule
// (sync/writer/judged_commit.ts).

/** Relative to the platform root, a directory ending in a slash; a test holds each path to the kind its spelling says. */
export const DELIVERED_SURFACE = [
  "files.yml",
  "files/",
  "actions/",
  ".github/scripts/sync/",
  ".github/scripts/shared/",
  "bun.lock",
  "package.json",
] as const;

export function deliveredBySync(path: string): boolean {
  return DELIVERED_SURFACE.some((root) =>
    root.endsWith("/") ? path.startsWith(root) : path === root,
  );
}

/** The first line of the leg's own comment, which it finds again by this. */
export const MARKER = `<!-- ${PLATFORM_NAME}/fleet-sync-default -->`;

/** Enough to see what a sweep touched; the rest is a count. */
export const LISTED_PATHS = 25;

/** The section every comment points the reader to. */
const DOCS = `https://github.com/${PLATFORM_SLUG}/blob/main/docs/all-green.md#opting-a-pr-into-an-immediate-fleet-sync`;

export function labelOf(known: FleetSyncLabels, scope: FleetSyncScope): string {
  for (const [label, labelScope] of known) {
    if (labelScope === scope) return label;
  }
  throw new Error(`no fleet-sync label names the ${scope} scope`);
}

export type Note =
  | { kind: "added" }
  | { kind: "kept-off"; by: string }
  | { kind: "refused"; error: string };

/** The comment's opening line and its closing line, around the listed paths. */
function noteFrame(known: FleetSyncLabels, note: Note): [lead: string, closing: string] {
  const publicLabel = `\`${labelOf(known, "public")}\``;
  if (note.kind === "added") {
    return [
      `Added ${publicLabel}: this pull request changes what a fleet sync delivers, so the public repos sync from its merge.`,
      `Remove the label if you do not want that; with no label the weekly schedule carries it. \`${labelOf(known, "all")}\` only when necessary and approved by the repository owner: it bills private minutes.`,
    ];
  }
  if (note.kind === "kept-off") {
    return [
      `${publicLabel} was removed by ${note.by}; not re-adding it. This pull request changes what a fleet sync delivers:`,
      "With no label the weekly schedule carries it.",
    ];
  }
  return [
    "This pull request changes what a fleet sync delivers:",
    `Its fleet-sync label would be refused at merge and nothing would sync: ${note.error}.`,
  ];
}

export function noteBody(paths: readonly string[], known: FleetSyncLabels, note: Note): string {
  const [lead, closing] = noteFrame(known, note);
  const listed = paths.slice(0, LISTED_PATHS).map((path) => `- ${codeSpan(path)}`);
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

/** The pull request as the leg reads it; `changed` is every path the diff touches, a rename by both names. */
export interface PullRequest {
  open: boolean;
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
  if (!pr.open) {
    return { label: "keep", comment: { kind: "leave", reason: "the pull request is closed" } };
  }
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
  if (directive.kind === "fleet-sync") {
    return clear(`fleet-sync:${directive.scope} chosen`, withdraw);
  }
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
const changedFile = z.object({ filename: z.string(), previous_filename: z.string().optional() });
const issueEvent = z.object({
  event: z.string(),
  actor: z.object({ login: z.string() }).nullable(),
  // Only label events carry `label`; every other event kind in the listing is skipped by that absence.
  label: z.object({ name: z.string() }).optional(),
});
export type LabelEvent = z.infer<typeof issueEvent>;

/** Events arrive oldest first, so the last matching one is the current state's author. A label event by anyone but the
 *  bot is a human's. */
export function labelHistory(events: readonly LabelEvent[], label: string): LabelHistory {
  const history: LabelHistory = { lastAddedBy: null, removedBy: null };
  for (const event of events) {
    if (event.label?.name.toLowerCase() !== label) continue;
    const actor = event.actor?.login ?? null;
    if (event.event === "labeled") {
      history.lastAddedBy = actor;
    } else if (event.event === "unlabeled" && actor !== null && actor !== BOT_LOGIN) {
      history.removedBy = actor;
    }
  }
  return history;
}

/** The value of a read that must answer.
 *
 * @throws {Error} GitHub did not answer it, the endpoint and the client's reason for the warning
 */
async function answer<T>(endpoint: string, read: Promise<Read<T>>): Promise<T> {
  const outcome = await read;
  if (outcome.kind !== "ok") throw new Error(`${endpoint}: ${unansweredReason(outcome)}`);

  return outcome.value;
}

/** One write that must land.
 *
 * @throws {Error} GitHub refused or did not answer it
 */
async function write(endpoint: string, sent: Promise<Sent<undefined>>): Promise<void> {
  const outcome = await sent;
  if (outcome.kind !== "ok") throw new Error(`${endpoint}: ${unansweredReason(outcome)}`);
}

async function applyLabel(
  github: GitHubClient,
  issue: string,
  publicLabel: string,
  action: LabelAction,
): Promise<string> {
  if (action === "add") {
    const labels = `${issue}/labels`;
    await write(labels, github.send("POST", labels, { labels: [publicLabel] }));
    return `added ${publicLabel}`;
  }
  if (action === "remove") {
    const label = `${issue}/labels/${encodeURIComponent(publicLabel)}`;
    await write(label, github.remove(label));
    return `removed ${publicLabel}`;
  }
  return "label kept";
}

async function applyComment(
  github: GitHubClient,
  repository: string,
  issue: string,
  wanted: Wanted,
): Promise<string> {
  if (wanted.kind === "leave") return `comment left as it is (${wanted.reason})`;

  const comments = `${issue}/comments`;
  const listed = await answer(comments, github.paginate(comments, issueComment));
  const existing = stickyComment(listed, MARKER);
  const own = (id: number) => `repos/${repository}/issues/comments/${id}`;
  if (wanted.kind === "clear") {
    if (existing === null) return `nothing to say (${wanted.reason})`;

    await write(own(existing.id), github.remove(own(existing.id)));
    return `removed the comment: ${wanted.reason}`;
  }
  if (existing === null) {
    await write(comments, github.send("POST", comments, { body: wanted.body }));
    return "posted the comment";
  }
  if (existing.body === wanted.body) return "the comment is current";

  await write(own(existing.id), github.send("PATCH", own(existing.id), { body: wanted.body }));
  return "updated the comment";
}

/** A file moved out of files/ changes the delivery as much as an edit, so a rename counts by both names. */
async function changedPaths(
  github: GitHubClient,
  endpoint: string,
  changedFiles: number,
): Promise<string[]> {
  const listing = `${endpoint}/files`;
  const files = await answer(listing, github.paginate(listing, changedFile));
  // The listing stops at 3,000 files while changed_files counts them all; a short listing must never read as "nothing delivered".
  if (files.length !== changedFiles) {
    throw new Error(`${listing} lists ${files.length} of ${changedFiles} changed files`);
  }

  return files.flatMap((file) =>
    file.previous_filename === undefined
      ? [file.filename]
      : [file.filename, file.previous_filename],
  );
}

async function main(): Promise<number> {
  const repository = requireEnv("GITHUB_REPOSITORY");
  const number = requireEnv("PR_NUMBER");
  try {
    const github = new GitHubClient();
    const known = fleetSyncLabels(loadLayer(FLEET_SYNC_OVERLAY).doc, FLEET_SYNC_OVERLAY);
    const publicLabel = labelOf(known, "public");
    const endpoint = `repos/${repository}/pulls/${number}`;
    const issue = `repos/${repository}/issues/${number}`;
    const events = `${issue}/events`;
    const request = await answer(endpoint, github.get(endpoint, pull));
    const pr: PullRequest = {
      open: request.state === "open",
      changed: await changedPaths(github, endpoint, request.changed_files),
      labels: request.labels.map((label) => label.name),
      base: request.base.ref,
      defaultBranch: request.base.repo.default_branch,
      history: labelHistory(await answer(events, github.paginate(events, issueEvent)), publicLabel),
    };
    const decided = plan(pr, known);
    const label = await applyLabel(github, issue, publicLabel, decided.label);
    notice(`${label}; ${await applyComment(github, repository, issue, decided.comment)}`);
  } catch (error) {
    warning(
      `fleet-sync default skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
