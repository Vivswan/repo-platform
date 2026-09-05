#!/usr/bin/env bun
// The INTEGRITY leg of the validate-template report: the repository is
// judged by the validator of the template it was rendered from - the
// operator's build tree at the `_commit` its answers record - never by
// whatever the build tip carries today. A newer validator knows rules the
// repository's pending sync PR has not delivered yet; those run as the
// advisory latest pass in action.yml, not here.
//
// Fail-closed: a refused `_commit`, a sha the build branch does not contain,
// or a tree this script cannot install exits 1 with the one-line `reason` output
// (report.ts prints it), which the caller reads as a red integrity
// verdict. Only the aligned validator's own exit code says "clean".
//
// Env: GH_TOKEN, ALIGNED_DIR (scratch for the fetched tree), FINDINGS_FILE and ADVISORIES_FILE (inherited by the validator),
// GITHUB_OUTPUT. Runs from the caller's checkout.

import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { OPERATOR_REPO, recordedBuildSha } from "./build_sha.ts";
import { capture, download, error, requireEnv, run } from "./runtime.ts";

const DOWNLOAD_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 180_000;
const VALIDATE_TIMEOUT_MS = 300_000;

// Cleared before anything else can exit: a pair left by an earlier step
// must never read as this run's verdict (the validator writes both).
for (const name of ["FINDINGS_FILE", "ADVISORIES_FILE"]) rmSync(requireEnv(name), { force: true });
const alignedDir = requireEnv("ALIGNED_DIR");
const outputFile = requireEnv("GITHUB_OUTPUT");
const root = resolve(".");

const refuse: (reason: string) => never = (reason) => {
  error(reason);
  appendFileSync(outputFile, `reason=${reason.replaceAll(/\s*\n\s*/g, " ")}\n`);
  process.exit(1);
};
const firstLine = (text: string): string =>
  text
    .split("\n")
    .find((line) => line.trim() !== "")
    ?.trim() ?? "";
const why = (result: { exitCode: number; stderr: string; timedOut: boolean }): string =>
  result.timedOut ? "timed out" : firstLine(result.stderr) || `exit ${result.exitCode}`;

const recorded = recordedBuildSha(root);
if ("refusal" in recorded) refuse(recorded.refusal);
const { sha } = recorded;

// The tarball endpoint serves any commit in the repository's network, and
// the answers file is PR-editable, so only a commit the protected build
// branch (no force-push, no deletion) already contains may run here: the
// same trust every `@build` action ref already places in that branch.
const onBuild = capture(
  ["gh", "api", `repos/${OPERATOR_REPO}/compare/${sha}...build`, "--jq", ".status"],
  { timeoutMs: DOWNLOAD_TIMEOUT_MS },
);
if (onBuild.exitCode !== 0) {
  refuse(`could not confirm ${sha} is on ${OPERATOR_REPO}'s build branch: ${why(onBuild)}`);
}
const status = onBuild.stdout.trim();
if (status !== "identical" && status !== "ahead") {
  refuse(
    `_commit ${sha} is not a published commit of ${OPERATOR_REPO}'s build branch (compare: ${status})`,
  );
}

const tree = join(alignedDir, "tree");
rmSync(alignedDir, { recursive: true, force: true });
mkdirSync(tree, { recursive: true });
const tarball = join(alignedDir, "tree.tgz");
const fetched = download(["gh", "api", `repos/${OPERATOR_REPO}/tarball/${sha}`], tarball, {
  timeoutMs: DOWNLOAD_TIMEOUT_MS,
});
if (fetched.exitCode !== 0) {
  refuse(`could not fetch ${OPERATOR_REPO} at ${sha}: ${why(fetched)}`);
}
const unpacked = capture(["tar", "-xzf", tarball, "-C", tree, "--strip-components=1"], {
  timeoutMs: DOWNLOAD_TIMEOUT_MS,
});
if (unpacked.exitCode !== 0) {
  refuse(`could not unpack ${OPERATOR_REPO} at ${sha}: ${why(unpacked)}`);
}

const validator = join(tree, "actions", "validate-template");
const script = join(validator, "validate_generated_files.ts");
if (!existsSync(script)) {
  refuse(
    `${OPERATOR_REPO} at ${sha} ships no actions/validate-template/validate_generated_files.ts`,
  );
}
// This action's pinned bun (the one running this script) installs and
// runs the aligned tree: it is at least as new as the bun that wrote that
// tree's lockfile, and a newer bun reads an older lockfile.
const installed = capture([process.execPath, "install", "--frozen-lockfile", "--production"], {
  cwd: validator,
  timeoutMs: INSTALL_TIMEOUT_MS,
});
if (installed.exitCode !== 0) {
  console.log(installed.stdout + installed.stderr);
  refuse(`could not install the validator's dependencies at ${sha}: ${why(installed)}`);
}

console.log(`Judging the tree by ${OPERATOR_REPO}'s validator at ${sha}`);
process.exit(run([process.execPath, script, root], { cwd: root, timeoutMs: VALIDATE_TIMEOUT_MS }));
