#!/usr/bin/env bun
// The integrity leg's FETCH: the operator's build tree at the `_commit`
// the repository's answers record - the template it was rendered from -
// laid out under ALIGNED_DIR for the judge step, so that the tree, not the
// build tip, judges the repository. The one compare call made here does
// double duty: it proves the protected build branch contains the sha
// before anything is fetched, and its status and distance are the
// freshness leg's whole input (the `compare` and `ahead-by` outputs). The
// `bun` output names this bun for the judge step.
//
// Every refusal writes a `not-judged` verdict with its reason and exits 1,
// which the caller reads as a red integrity result; the judge step is
// skipped behind a failed fetch.
//
// Env: GH_TOKEN, ALIGNED_DIR (scratch, cleared here), VERDICT_FILE
// (cleared here, written on refusal), GITHUB_OUTPUT. Runs from the
// caller's checkout.

import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BUN_VERSION_FILE,
  treeOf,
  VALIDATOR_DIR,
  VALIDATOR_SCRIPT,
  validatorOf,
} from "./aligned_tree.ts";
import { OPERATOR_REPO, recordedBuildSha } from "./build_sha.ts";
import { capture, download, error, failureDetail, requireEnv } from "./runtime.ts";
import { writeVerdict } from "./verdict.ts";

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
const recorded = recordedBuildSha(root);
if ("refusal" in recorded) refuse(recorded.refusal);
const { sha } = recorded;

// The tarball endpoint serves any commit in the repository's network, and
// the answers file is PR-editable, so only a commit the protected build
// branch (no force-push, no deletion) already contains may run here: the
// same trust every `@build` action ref already places in that branch.
const compared = capture(
  [
    "gh",
    "api",
    `repos/${OPERATOR_REPO}/compare/${sha}...build`,
    "--jq",
    '"\\(.status) \\(.ahead_by)"',
  ],
  { timeoutMs: NETWORK_TIMEOUT_MS },
);
if (compared.exitCode !== 0) {
  setOutput("compare", "error");
  refuse(
    `could not confirm ${sha} is on ${OPERATOR_REPO}'s build branch: ${failureDetail(compared)}`,
  );
}
const [status = "", aheadBy = ""] = compared.stdout.trim().split(" ");
setOutput("compare", status);
setOutput("ahead-by", aheadBy);
if (status !== "identical" && status !== "ahead") {
  refuse(
    `_commit ${sha} is not a published commit of ${OPERATOR_REPO}'s build branch (compare: ${status})`,
  );
}

const tree = treeOf(alignedDir);
mkdirSync(tree, { recursive: true });
const tarball = join(alignedDir, "tree.tgz");
const fetched = download(["gh", "api", `repos/${OPERATOR_REPO}/tarball/${sha}`], tarball, {
  timeoutMs: NETWORK_TIMEOUT_MS,
});
if (fetched.exitCode !== 0) {
  refuse(`could not fetch ${OPERATOR_REPO} at ${sha}: ${failureDetail(fetched)}`);
}
const unpacked = capture(["tar", "-xzf", tarball, "-C", tree, "--strip-components=1"], {
  timeoutMs: NETWORK_TIMEOUT_MS,
});
if (unpacked.exitCode !== 0) {
  refuse(`could not unpack ${OPERATOR_REPO} at ${sha}: ${failureDetail(unpacked)}`);
}

// The judge step runs the script; the setup-bun step before it reads the
// tree's own bun pin. Both must be there, or the run stops here.
const validator = validatorOf(alignedDir);
for (const name of [VALIDATOR_SCRIPT, BUN_VERSION_FILE]) {
  if (!existsSync(join(validator, name))) {
    refuse(`${OPERATOR_REPO} at ${sha} ships no ${VALIDATOR_DIR}/${name}`);
  }
}
// The judge step keeps running on THIS bun after setup-bun puts the
// tree's on PATH; only the tree's install and validator run on that one.
setOutput("bun", process.execPath);
console.log(`Fetched ${OPERATOR_REPO}'s validator at ${sha}`);
