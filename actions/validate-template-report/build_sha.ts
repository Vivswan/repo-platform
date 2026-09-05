// The build sha a rendered repository was stamped with: the `_commit`
// copier recorded in .github/.copier-answers.yml, accepted only as the
// FULL 40-hex sha the sync writes. A short sha is refused, never resolved:
// resolving it would take a network round trip whose answer could differ
// from the commit that actually rendered the tree, and the sync PR that
// rewrites the value is the fix in any case.

import { recordedCommit } from "../shared/stamp_manifest.ts";

/** The operator repository whose build branch every leg reads: the same
 *  repository the latest leg's `uses:` names, which no input can follow. */
export const OPERATOR_REPO = "Vivswan/repo-platform";

const BUILD_SHA_RE = /^[0-9a-f]{40}$/;
const REMEDY = "merge this repository's pending template sync PR";

export type BuildSha = { sha: string } | { refusal: string };

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
