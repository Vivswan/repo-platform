// Runs with no checkout, so every request names the repository. The bundle is deleted from the RELEASE, not a
// checkout, so no later skip path (a non-public repository, a draft left with no other asset) can publish a stale one.
// The draft is read by its id: a release hook may rename its tag after the cut, and the id still names it.

import * as core from "@actions/core";
import { z } from "zod";
import { GitHubClient, unansweredReason } from "../github-client/github.ts";
import { messageOf, requireEnv } from "../shared/action_runtime.ts";

/** What the inspection reads of a release: its tag, and each asset's name with the id a removal names it by. */
const Release = z.object({
  tag_name: z.string(),
  assets: z.array(z.object({ id: z.number(), name: z.string() })),
});

/** The run's log, @actions/core's own in main; a test hands in a recorder. */
export type Log = Pick<typeof core, "info" | "notice">;

/** A draft release as the inspection left it. */
export interface Inspection {
  /** The tag the draft wears now. */
  tag: string;

  /** Whether an asset other than the bundle remains once a stale bundle is deleted. */
  present: boolean;
}

/** What the draft with id `releaseId` holds once a stale `bundle` is deleted from it.
 *
 * @throws {Error} the release could not be read, or the bundle could not be deleted
 */
export async function inspectAssets(
  github: GitHubClient,
  repo: string,
  releaseId: string,
  bundle: string,
  log: Log,
): Promise<Inspection> {
  const read = await github.get(`repos/${repo}/releases/${releaseId}`, Release);
  if (read.kind !== "ok") {
    throw new Error(`release ${releaseId} could not be read: ${unansweredReason(read)}`);
  }

  const tag = read.value.tag_name;
  let present = false;
  for (const { id, name } of read.value.assets) {
    if (name !== bundle) {
      present = true;
      continue;
    }

    const removed = await github.remove(`repos/${repo}/releases/assets/${id}`);
    if (removed.kind !== "ok") {
      throw new Error(
        `the stale ${bundle} on ${tag} could not be deleted: ${unansweredReason(removed)}`,
      );
    }

    log.info(`deleted the stale ${bundle} a prior attempt left on ${tag}`);
  }

  if (!present) log.notice("the release has no assets; nothing to attest");

  return { tag, present };
}

async function main(): Promise<number> {
  const repo = requireEnv("GITHUB_REPOSITORY");
  const found = await inspectAssets(
    new GitHubClient(),
    repo,
    requireEnv("RELEASE_ID"),
    requireEnv("BUNDLE_NAME"),
    core,
  );
  core.setOutput("tag", found.tag);
  core.setOutput("present", String(found.present));
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (cause) {
    core.setFailed(messageOf(cause));
  }
}
