// The shell this replaces read the asset list one name per line, so an empty release read as one empty name and a
// bundle-only release as "no assets": which names count, that the stale bundle is deleted from the RELEASE before
// anything else, and the output the publish leg keys on are gh's facts and the caller's, not the code's.

import { expect, test } from "bun:test";
import { type GhRunner, inspectAssets } from "../../../actions/release-assets/release-assets.ts";

const REPO = "o/r";
const TAG = "v1.2.0";
const BUNDLE = "attestation.json";

function fakeGh(assets: string[]): { run: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: GhRunner = (args) => {
    calls.push(args);
    if (args[0] === "release" && args[1] === "view") {
      return JSON.stringify({ assets: assets.map((name) => ({ name })) });
    }
    if (args[0] === "release" && args[1] === "delete-asset") return "";
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return { run, calls };
}

// fleet-release-publish.yml runs with no checkout, so every call names the repository.
const VIEW = ["release", "view", TAG, "--repo", REPO, "--json", "assets"];
const DELETE = ["release", "delete-asset", TAG, BUNDLE, "--yes", "--repo", REPO];
const NO_ASSETS = "::notice::the release has no assets; nothing to attest";
const DELETED = `deleted the stale ${BUNDLE} a prior attempt left on ${TAG}`;

test.each<{
  reason: string;
  assets: string[];
  present: boolean;
  lines: string[];
  calls: string[][];
}>([
  {
    reason: "a draft with no assets",
    assets: [],
    present: false,
    lines: [NO_ASSETS],
    calls: [VIEW],
  },
  {
    reason: "a draft carrying only a stale bundle",
    assets: [BUNDLE],
    present: false,
    lines: [DELETED, NO_ASSETS],
    calls: [VIEW, DELETE],
  },
  {
    reason: "a stale bundle beside real assets",
    assets: ["app-linux.tar.gz", BUNDLE, "app-macos.tar.gz"],
    present: true,
    lines: [DELETED],
    calls: [VIEW, DELETE],
  },
  {
    reason: "real assets and no bundle",
    assets: ["app-linux.tar.gz"],
    present: true,
    lines: [],
    calls: [VIEW],
  },
])("$reason", ({ assets, present, lines, calls }) => {
  const gh = fakeGh(assets);
  const out: string[] = [];
  const judged = inspectAssets(gh.run, REPO, TAG, BUNDLE, (line) => out.push(line));
  expect({ present: judged, lines: out, calls: gh.calls }).toEqual({ present, lines, calls });
});
