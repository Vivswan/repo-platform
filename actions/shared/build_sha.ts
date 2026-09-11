// The build sha a rendered repository was written from, accepted only as
// the FULL 40-hex sha the sync writes. A short sha is refused, never
// resolved: resolving it would take a network round trip whose answer could
// differ from the commit that actually rendered the tree, and the sync PR
// that rewrites the value is the fix in any case.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { capture, failureDetail, succeeded } from "./action_runtime.ts";
import { MANIFEST_NAME, parseManifestFiles } from "./manifest.ts";
import { ANSWERS_FILE, recordedCommit } from "./stamp_manifest.ts";

/** The operator repository whose build branch every leg reads: the same
 *  repository the latest leg's `uses:` names, which no input can follow. */
export const OPERATOR_REPO = "Vivswan/repo-platform";

const BUILD_SHA_RE = /^[0-9a-f]{40}$/;
const REMEDY = "merge this repository's pending template sync PR";

export type BuildSha = { sha: string } | { refusal: string };

/** A recorded sha admitted as a commit the protected build branch already
 *  contains (the compare status and the branch's distance ahead), or the
 *  one-line refusal. The tarball and clone endpoints serve any commit in
 *  the repository's network and the recording files are PR-editable, so a
 *  leg runs that commit's code (a validator, a render's --trust hooks)
 *  only past this: the same trust every `@build` action ref places in
 *  the branch. Needs gh on PATH with a token that reads OPERATOR_REPO. */
export type Admission = { status: "identical" | "ahead"; aheadBy: string } | { refusal: string };

export function admitBuildCommit(sha: string, timeoutMs: number): Admission {
  const compared = capture(
    [
      "gh",
      "api",
      `repos/${OPERATOR_REPO}/compare/${sha}...build`,
      "--jq",
      '"\\(.status) \\(.ahead_by)"',
    ],
    { timeoutMs },
  );
  if (!succeeded(compared.exit)) {
    return {
      refusal: `could not confirm ${sha} is on ${OPERATOR_REPO}'s build branch: ${failureDetail(compared)}`,
    };
  }
  const [status = "", aheadBy = ""] = compared.stdout.trim().split(" ");
  if (status !== "identical" && status !== "ahead") {
    return {
      refusal: `_commit ${sha} is not a published commit of ${OPERATOR_REPO}'s build branch (compare: ${status})`,
    };
  }
  return { status, aheadBy };
}

/** The two files a tree records its build commit in, in the order they
 *  are consulted: the answers file while it exists (copier's record, which
 *  the stamp hook mirrors into the manifest), the manifest's own entry once
 *  the sync writer has retired the answers file (the writer's only record). */
export const BUILD_RECORD_FILES = [ANSWERS_FILE, MANIFEST_NAME] as const;
export type BuildRecordFile = (typeof BUILD_RECORD_FILES)[number];

/** Which file under `root` records the build commit and what it says:
 *  null when neither file exists. A file that exists but names no commit
 *  is reported as that file's empty record, never skipped for the other. */
export function recordedBuild(
  root: string,
): { file: BuildRecordFile; value: string | null } | null {
  if (existsSync(join(root, ANSWERS_FILE))) {
    return { file: ANSWERS_FILE, value: recordedCommit(root) };
  }
  if (!existsSync(join(root, MANIFEST_NAME))) return null;
  const parsed = parseManifestFiles(readFileSync(join(root, MANIFEST_NAME), "utf-8"));
  const commit = parsed.files?.[MANIFEST_NAME]?.commit;
  return {
    file: MANIFEST_NAME,
    value: typeof commit === "string" && commit !== "" ? commit : null,
  };
}

/** The full build sha recorded under `root`, or the one-line refusal
 *  (no trailing period; the renderer punctuates). */
export function recordedBuildSha(root: string): BuildSha {
  const record = recordedBuild(root);
  if (record === null) {
    return {
      refusal: `neither ${ANSWERS_FILE} nor ${MANIFEST_NAME} records a build commit; ${REMEDY}`,
    };
  }
  if (record.value === null) {
    return { refusal: `${record.file} records no build commit; ${REMEDY}` };
  }
  if (!BUILD_SHA_RE.test(record.value)) {
    return {
      refusal: `${record.file} records '${record.value}', which is not a full build sha; ${REMEDY}`,
    };
  }
  return { sha: record.value };
}
