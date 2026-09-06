#!/usr/bin/env bun
// The integrity leg's FETCH of the build tree at the recorded `_commit`. Its
// build-branch compare both admits the sha and feeds freshness; a second
// holds `_commit` at or ahead of the base ref's (the vintage floor). The
// compare's outputs are published only once both have passed.
//
// Env: GH_TOKEN, ALIGNED_DIR (cleared here), VERDICT_FILE (cleared here),
// GITHUB_OUTPUT, GITHUB_REPOSITORY, BASE_REF (the vintage floor's ref).
// Runs from the caller's checkout.

import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BUN_VERSION_FILE,
  treeOf,
  VALIDATOR_DIR,
  VALIDATOR_SCRIPT,
  validatorOf,
} from "./aligned_tree.ts";
import { OPERATOR_REPO, recordedBuildSha } from "./build_sha.ts";
import { capture, download, env, error, failureDetail, requireEnv, succeeded } from "./runtime.ts";
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
const callerRepo = requireEnv("GITHUB_REPOSITORY");
const baseRef = env("BASE_REF");
if (baseRef === "") refuse("no base ref to read the vintage floor from (BASE_REF is empty)");

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
if (!succeeded(compared.exit)) {
  refuse(
    `could not confirm ${sha} is on ${OPERATOR_REPO}'s build branch: ${failureDetail(compared)}`,
  );
}
const [status = "", aheadBy = ""] = compared.stdout.trim().split(" ");
if (status !== "identical" && status !== "ahead") {
  refuse(
    `_commit ${sha} is not a published commit of ${OPERATOR_REPO}'s build branch (compare: ${status})`,
  );
}

// The vintage floor: `_commit` may move forward along the build branch,
// never back to an older validator with fewer rules. The base ref's
// recorded `_commit` is the floor; no answers file there sets none.
const baseAnswers = capture(
  [
    "gh",
    "api",
    "--method",
    "GET",
    "-H",
    "Accept: application/vnd.github.raw+json",
    `repos/${callerRepo}/contents/.github/.copier-answers.yml`,
    "-f",
    `ref=${baseRef}`,
  ],
  { timeoutMs: NETWORK_TIMEOUT_MS },
);
if (!succeeded(baseAnswers.exit)) {
  // Only a normal exit reporting 404 means "no file"; a timeout or a signal
  // death with that text in its stderr is still a failed read.
  if (!(baseAnswers.exit.kind === "exited" && /\bHTTP 404\b/.test(baseAnswers.stderr))) {
    refuse(
      `could not read ${baseRef}'s .github/.copier-answers.yml on ${callerRepo}: ${failureDetail(baseAnswers)}`,
    );
  }
} else {
  const baseRoot = join(alignedDir, "base");
  mkdirSync(join(baseRoot, ".github"), { recursive: true });
  writeFileSync(join(baseRoot, ".github", ".copier-answers.yml"), baseAnswers.stdout);
  const base = recordedBuildSha(baseRoot);
  if ("refusal" in base) refuse(`on ${baseRef}, ${base.refusal}`);
  if (base.sha !== sha) {
    const floor = capture(
      ["gh", "api", `repos/${OPERATOR_REPO}/compare/${base.sha}...${sha}`, "--jq", ".status"],
      { timeoutMs: NETWORK_TIMEOUT_MS },
    );
    if (!succeeded(floor.exit)) {
      refuse(
        `could not compare ${baseRef}'s _commit ${base.sha} with ${sha}: ${failureDetail(floor)}`,
      );
    }
    const relation = floor.stdout.trim();
    if (relation !== "identical" && relation !== "ahead") {
      refuse(
        `_commit moves backwards from ${baseRef}'s ${base.sha} to ${sha} (compare: ${relation})`,
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
const validator = validatorOf(alignedDir);
for (const name of [VALIDATOR_SCRIPT, BUN_VERSION_FILE]) {
  if (!existsSync(join(validator, name))) {
    refuse(`${OPERATOR_REPO} at ${sha} ships no ${VALIDATOR_DIR}/${name}`);
  }
}
console.log(`Fetched ${OPERATOR_REPO}'s validator at ${sha}`);
