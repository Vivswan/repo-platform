// The build sha a rendered repository was stamped with: the `_commit`
// copier recorded in .github/.copier-answers.yml, accepted only as the
// FULL 40-hex sha the sync writes. A short sha is refused, never resolved:
// resolving it would take a network round trip whose answer could differ
// from the commit that actually rendered the tree, and the sync PR that
// rewrites the value is the fix in any case.

import { capture, failureDetail, succeeded } from "./action_runtime.ts";
import { recordedCommit } from "./stamp_manifest.ts";

/** The operator repository whose build branch every leg reads: the same
 *  repository the latest leg's `uses:` names, which no input can follow. */
export const OPERATOR_REPO = "Vivswan/repo-platform";

const BUILD_SHA_RE = /^[0-9a-f]{40}$/;
const REMEDY = "merge this repository's pending template sync PR";

export type BuildSha = { sha: string } | { refusal: string };

/** A recorded sha admitted as a commit the protected build branch already
 *  contains (the compare status and the branch's distance ahead), or the
 *  one-line refusal. The tarball and clone endpoints serve any commit in
 *  the repository's network and the answers file is PR-editable, so a
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

/** The full build sha recorded under `root`, or the one-line refusal
 *  (no trailing period; the renderer punctuates). */
export function recordedBuildSha(root: string): BuildSha {
  const recorded = recordedCommit(root);
  if (recorded === null) {
    return { refusal: `.github/.copier-answers.yml records no _commit; ${REMEDY}` };
  }
  if (!BUILD_SHA_RE.test(recorded)) {
    return { refusal: `_commit '${recorded}' is not a full build sha; ${REMEDY}` };
  }
  return { sha: recorded };
}
