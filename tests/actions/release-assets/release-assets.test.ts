// The shell this replaces read the asset list one name per line, so an empty release read as one empty name and a
// bundle-only release as "no assets": which names count, that the stale bundle is deleted from the RELEASE before
// anything else, and the output the publish leg keys on are gh's facts and the caller's, not the code's.
//
// The draft's tag is gh's fact too: a release hook may have renamed it since the cut, so the inspection is handed the
// cut's id alone and reads the tag the draft wears from gh.

import { expect, test } from "bun:test";
import { type GhRunner, inspectAssets } from "../../../actions/release-assets/release-assets.ts";

const REPO = "o/r";
const RELEASE_ID = "4242";
const TAG = "v1.2.0";
const BUNDLE = "attestation.json";

function fakeGh(assets: string[]): { run: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: GhRunner = (args) => {
    calls.push(args);
    if (args.join(" ") === `api repos/${REPO}/releases/${RELEASE_ID}`) {
      return JSON.stringify({ tag_name: TAG, assets: assets.map((name) => ({ name })) });
    }
    if (args[0] === "release" && args[1] === "delete-asset" && args[2] === TAG) return "";
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return { run, calls };
}

// fleet-release-publish.yml runs with no checkout, so every call names the repository.

const VIEW = ["api", `repos/${REPO}/releases/${RELEASE_ID}`];
const DELETE = ["release", "delete-asset", TAG, BUNDLE, "--yes", "--repo", REPO];
/** A log line as the recorder saw it: core's method, then the message. */
type Line = ["info" | "notice", string];
const NO_ASSETS: Line = ["notice", "the release has no assets; nothing to attest"];
const DELETED: Line = ["info", `deleted the stale ${BUNDLE} a prior attempt left on ${TAG}`];

test.each<{
  reason: string;
  assets: string[];
  present: boolean;
  lines: Line[];
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
  const out: Line[] = [];
  const found = inspectAssets(gh.run, REPO, RELEASE_ID, BUNDLE, {
    info: (message) => out.push(["info", message]),
    notice: (message) => out.push(["notice", String(message)]),
  });
  expect({ found, lines: out, calls: gh.calls }).toEqual({
    found: { tag: TAG, present },
    lines,
    calls,
  });
});
