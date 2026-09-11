#!/usr/bin/env bun
// The integrity leg's FETCH, run from the caller's checkout: the recorded
// build commit must be on the build branch and, when BASE_REF records one,
// at or ahead of it; only then is the compare published for freshness.

import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  capture,
  download,
  env,
  error,
  failureDetail,
  requireEnv,
  succeeded,
} from "../../../shared/action_runtime.ts";
import {
  admitBuildCommit,
  BUILD_RECORD_FILES,
  OPERATOR_REPO,
  recordedBuildSha,
} from "../../../shared/build_sha.ts";
import { writeVerdict } from "../verdict.ts";
import { ACTION_DIR, actionOf, BUN_VERSION_FILE, treeOf, VALIDATOR_SCRIPT } from "./tree.ts";

const NETWORK_TIMEOUT_MS = 60_000;

// Cleared before anything else can exit: a verdict or tree left by an
// earlier run must never read as this one's.
const verdictFile = requireEnv("VERDICT_FILE");
rmSync(verdictFile, { force: true });
const alignedDir = requireEnv("ALIGNED_DIR");
rmSync(alignedDir, { recursive: true, force: true });
const outputFile = requireEnv("GITHUB_OUTPUT");
const root = resolve(".");

const setOutput = (key: string, value: string): void => {
  appendFileSync(outputFile, `${key}=${value}\n`);
};
const refuse: (reason: string) => never = (reason) => {
  error(reason);
  writeVerdict(verdictFile, { kind: "not-judged", reason });
  process.exit(1);
};
const callerRepo = requireEnv("GITHUB_REPOSITORY");
const baseRef = env("BASE_REF");
if (baseRef === "") refuse("no base ref to read the vintage floor from (BASE_REF is empty)");

const recorded = recordedBuildSha(root);
if ("refusal" in recorded) refuse(recorded.refusal);
const { sha } = recorded;

// Only a commit the protected build branch already contains may run here
// (admitBuildCommit states the trust model).
const admitted = admitBuildCommit(sha, NETWORK_TIMEOUT_MS);
if ("refusal" in admitted) refuse(admitted.refusal);
const { status, aheadBy } = admitted;

// The vintage floor: the recorded commit may move forward along the build
// branch, never back to an older validator with fewer rules. The base ref's
// record is the floor, read from the same files in the same order as the
// checkout's; a base ref carrying neither sets none.
const baseRoot = join(alignedDir, "base");
let floorRecorded = false;
for (const file of BUILD_RECORD_FILES) {
  const baseFile = capture(
    [
      "gh",
      "api",
      "--method",
      "GET",
      "-H",
      "Accept: application/vnd.github.raw+json",
      `repos/${callerRepo}/contents/${file}`,
      "-f",
      `ref=${baseRef}`,
    ],
    { timeoutMs: NETWORK_TIMEOUT_MS },
  );
  if (succeeded(baseFile.exit)) {
    mkdirSync(dirname(join(baseRoot, file)), { recursive: true });
    writeFileSync(join(baseRoot, file), baseFile.stdout);
    floorRecorded = true;
    break;
  }
  // Only a normal exit reporting 404 means "no file"; a timeout or a signal
  // death with that text in its stderr is still a failed read.
  if (!(baseFile.exit.kind === "exited" && /\bHTTP 404\b/.test(baseFile.stderr))) {
    refuse(`could not read ${baseRef}'s ${file} on ${callerRepo}: ${failureDetail(baseFile)}`);
  }
}
if (floorRecorded) {
  const base = recordedBuildSha(baseRoot);
  if ("refusal" in base) refuse(`on ${baseRef}, ${base.refusal}`);
  if (base.sha !== sha) {
    const floor = capture(
      ["gh", "api", `repos/${OPERATOR_REPO}/compare/${base.sha}...${sha}`, "--jq", ".status"],
      { timeoutMs: NETWORK_TIMEOUT_MS },
    );
    if (!succeeded(floor.exit)) {
      refuse(
        `could not compare ${baseRef}'s recorded ${base.sha} with ${sha}: ${failureDetail(floor)}`,
      );
    }
    const relation = floor.stdout.trim();
    if (relation !== "identical" && relation !== "ahead") {
      refuse(
        `the recorded build commit moves backwards from ${baseRef}'s ${base.sha} to ${sha} (compare: ${relation})`,
      );
    }
  }
}

// Freshness is the admission's outcome, published only once every part of
// it passed: a refusal above leaves no compare for the report to set
// beside the refusal, and a refusal below (fetch, unpack, layout) keeps a
// distance the build branch did confirm.
setOutput("compare", status);
setOutput("ahead-by", aheadBy);

const tree = treeOf(alignedDir);
mkdirSync(tree, { recursive: true });
const tarball = join(alignedDir, "tree.tgz");
const fetched = download(["gh", "api", `repos/${OPERATOR_REPO}/tarball/${sha}`], tarball, {
  timeoutMs: NETWORK_TIMEOUT_MS,
});
if (!succeeded(fetched.exit)) {
  refuse(`could not fetch ${OPERATOR_REPO} at ${sha}: ${failureDetail(fetched)}`);
}
const unpacked = capture(["tar", "-xzf", tarball, "-C", tree, "--strip-components=1"], {
  timeoutMs: NETWORK_TIMEOUT_MS,
});
if (!succeeded(unpacked.exit)) {
  refuse(`could not unpack ${OPERATOR_REPO} at ${sha}: ${failureDetail(unpacked)}`);
}

// The judge step runs the script; the setup-bun step before it reads the
// tree's own bun pin. Both must be there, or the run stops here.
const action = actionOf(alignedDir);
for (const name of [VALIDATOR_SCRIPT, BUN_VERSION_FILE]) {
  if (!existsSync(join(action, name))) {
    refuse(`${OPERATOR_REPO} at ${sha} ships no ${ACTION_DIR}/${name}`);
  }
}
console.log(`Fetched ${OPERATOR_REPO}'s validator at ${sha}`);
