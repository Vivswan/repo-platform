// The shell this replaces read the asset list one name per line, so an empty release read as one empty name and a
// bundle-only release as "no assets": which names count, that the stale bundle is deleted from the RELEASE before
// anything else, and the output the publish leg keys on are GitHub's facts and the caller's, not the code's.
//
// The draft's tag is GitHub's fact too: a release hook may have renamed it since the cut, so the inspection is handed
// the cut's id alone and reads the tag the draft wears from the release.
//
// fleet-release-publish.yml runs with no checkout, so every request names the repository.

import { expect, test } from "bun:test";
import { inspectAssets } from "../../../actions/release-assets/release-assets.ts";
import { clientOver, type FakeReply } from "../../shared/fake_github";

/** A log line as the recorder saw it: core's method, then the message. */
type Line = ["info" | "notice", string];

const REPO = "o/r";
const RELEASE_ID = "4242";
const TAG = "v1.2.0";
const BUNDLE = "attestation.json";
const BUNDLE_ID = 7;
const VIEW = `repos/${REPO}/releases/${RELEASE_ID}`;
const DELETE = `DELETE repos/${REPO}/releases/assets/${BUNDLE_ID}`;
const NO_ASSETS: Line = ["notice", "the release has no assets; nothing to attest"];
const DELETED: Line = ["info", `deleted the stale ${BUNDLE} a prior attempt left on ${TAG}`];
const BAD_GATEWAY: FakeReply = { status: 502 };
const GONE: FakeReply = { status: 204 };

/** The release as GitHub lists it: the bundle wears BUNDLE_ID, every other asset an id of its own. */
function release(names: string[]): FakeReply {
  const assets = names.map((name, index) => ({
    id: name === BUNDLE ? BUNDLE_ID : 100 + index,
    name,
  }));
  return { status: 200, body: { tag_name: TAG, assets } };
}

/** The inspection's whole outcome over a table of replies: what it found or why it threw, its log, and its requests. */
async function inspect(views: FakeReply[], deletes: FakeReply[]) {
  const { client, github } = clientOver({ [VIEW]: views, [DELETE]: deletes });
  const lines: Line[] = [];
  const outcome = await inspectAssets(client, REPO, RELEASE_ID, BUNDLE, {
    info: (message) => lines.push(["info", message]),
    notice: (message) => lines.push(["notice", String(message)]),
  }).then(
    (found) => ({ found }),
    (cause: Error) => ({ threw: cause.message }),
  );

  return { ...outcome, lines, calls: github.calls().map((call) => call.path) };
}

test.each<{
  reason: string;
  views: FakeReply[];
  deletes?: FakeReply[];
  present: boolean;
  lines: Line[];
  calls: string[];
}>([
  {
    reason: "a draft with no assets",
    views: [release([])],
    present: false,
    lines: [NO_ASSETS],
    calls: [VIEW],
  },
  {
    reason: "a draft carrying only a stale bundle",
    views: [release([BUNDLE])],
    present: false,
    lines: [DELETED, NO_ASSETS],
    calls: [VIEW, DELETE],
  },
  {
    reason: "a stale bundle beside real assets",
    views: [release(["app-linux.tar.gz", BUNDLE, "app-macos.tar.gz"])],
    present: true,
    lines: [DELETED],
    calls: [VIEW, DELETE],
  },
  {
    reason: "real assets and no bundle",
    views: [release(["app-linux.tar.gz"])],
    present: true,
    lines: [],
    calls: [VIEW],
  },
  {
    reason: "GitHub's outage on the release read is retried: one 502 does not fail a release",
    views: [BAD_GATEWAY, release(["app-linux.tar.gz"])],
    present: true,
    lines: [],
    calls: [VIEW, VIEW],
  },
  {
    reason:
      "a rerun whose earlier delete landed with its reply lost: the 404 is the bundle already gone",
    views: [release([BUNDLE, "app-linux.tar.gz"])],
    deletes: [{ status: 404 }],
    present: true,
    lines: [DELETED],
    calls: [VIEW, DELETE],
  },
])("$reason", async ({ views, deletes = [GONE], present, lines, calls }) => {
  expect(await inspect(views, deletes)).toEqual({ found: { tag: TAG, present }, lines, calls });
});

// Drifts silently without this: a failure taken for "no bundle" lets the publish leg attest beside a stale bundle, or
// publish a release nobody read.
test.each<{
  reason: string;
  views: FakeReply[];
  deletes?: FakeReply[];
  threw: string;
  calls: string[];
}>([
  {
    reason: "a release id GitHub does not know",
    views: [{ status: 404 }],
    threw: `release ${RELEASE_ID} could not be read: HTTP 404`,
    calls: [VIEW],
  },
  {
    reason: "a delete GitHub refuses",
    views: [release([BUNDLE, "app-linux.tar.gz"])],
    deletes: [{ status: 403 }],
    threw: `the stale ${BUNDLE} on ${TAG} could not be deleted: HTTP 403`,
    calls: [VIEW, DELETE],
  },
])("the inspection fails on $reason", async ({ views, deletes = [GONE], threw, calls }) => {
  expect(await inspect(views, deletes)).toEqual({ threw, lines: [], calls });
});
