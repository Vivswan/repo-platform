// Runs with no checkout, so every gh call names the repository. The bundle is deleted from the RELEASE, not a
// checkout, so no later skip path (a non-public repository, a draft left with no other asset) can publish a stale one.

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

/** Whether an asset other than the bundle remains once a stale bundle is deleted. */
export function inspectAssets(
  run: GhRunner,
  repo: string,
  tag: string,
  bundle: string,
  log: Log,
): boolean {
  const json = run(["release", "view", tag, "--repo", repo, "--json", "assets"]);
  const names = (JSON.parse(json) as { assets: Array<{ name: string }> }).assets.map(
    (asset) => asset.name,
  );
  let present = false;
  for (const name of names) {
    if (name === bundle) {
      run(["release", "delete-asset", tag, name, "--yes", "--repo", repo]);
      log.info(`deleted the stale ${bundle} a prior attempt left on ${tag}`);
    } else {
      present = true;
    }
  }

  if (!present) log.notice("the release has no assets; nothing to attest");

  return present;
}

function main(): number {
  const repo = requireEnv("GITHUB_REPOSITORY");
  const present = inspectAssets(gh, repo, requireEnv("TAG"), requireEnv("BUNDLE_NAME"), core);
  core.setOutput("present", String(present));
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(main());
  } catch (cause) {
    core.setFailed(messageOf(cause));
  }
}
