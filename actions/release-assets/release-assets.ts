// Runs with no checkout, so every gh call names the repository. The bundle is deleted from the RELEASE, not a
// checkout, so no later skip path (a non-public repository, a draft left with no other asset) can publish a stale one.
// The draft is read by its id: a release hook may rename its tag after the cut, and the id still names it.

import * as core from "@actions/core";
import {
  capture,
  failureDetail,
  messageOf,
  requireEnv,
  succeeded,
} from "../shared/action_runtime.ts";

/** Runs a `gh` subcommand and returns stdout; throws on a non-zero exit. */
export type GhRunner = (args: string[]) => string;

/** The run's log, @actions/core's own in main; a test hands in a recorder. */
export type Log = Pick<typeof core, "info" | "notice">;

const GH_HANG_BOUND_MS = 120_000;

const gh: GhRunner = (args) => {
  const result = capture(["gh", ...args], { timeoutMs: GH_HANG_BOUND_MS });
  if (!succeeded(result.exit)) {
    throw new Error(`gh ${args.join(" ")} failed: ${failureDetail(result)}`);
  }

  return result.stdout;
};

/** A draft release as the inspection left it. */
export interface Inspection {
  /** The tag the draft wears now. */
  tag: string;

  /** Whether an asset other than the bundle remains once a stale bundle is deleted. */
  present: boolean;
}

/** What the draft with id `releaseId` holds once a stale `bundle` is deleted from it. */
export function inspectAssets(
  run: GhRunner,
  repo: string,
  releaseId: string,
  bundle: string,
  log: Log,
): Inspection {
  const json = run(["api", `repos/${repo}/releases/${releaseId}`]);
  const release = JSON.parse(json) as { tag_name: string; assets: Array<{ name: string }> };
  const tag = release.tag_name;
  let present = false;
  for (const { name } of release.assets) {
    if (name === bundle) {
      run(["release", "delete-asset", tag, name, "--yes", "--repo", repo]);
      log.info(`deleted the stale ${bundle} a prior attempt left on ${tag}`);
    } else {
      present = true;
    }
  }

  if (!present) log.notice("the release has no assets; nothing to attest");

  return { tag, present };
}

function main(): number {
  const repo = requireEnv("GITHUB_REPOSITORY");
  const found = inspectAssets(gh, repo, requireEnv("RELEASE_ID"), requireEnv("BUNDLE_NAME"), core);
  core.setOutput("tag", found.tag);
  core.setOutput("present", String(found.present));
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(main());
  } catch (cause) {
    core.setFailed(messageOf(cause));
  }
}
