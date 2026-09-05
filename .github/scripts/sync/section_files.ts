// RUNNER_TEMP report filenames shared by each report's WRITER and
// open_pr.ts's PR-body section collection - one constant per pair, so a
// rename on either side fails to compile together instead of silently
// dropping a PR-body section (the reports are flag files: an unread one
// would simply never appear).

/** tail_tripwire.ts's report (written under RUNNER_TEMP by default). */
export const TAIL_SHRANK_NAME = "tail-shrank.md";

/** preserve_repo_owned.ts's removed-split-files report: every path this
 * update deletes whose previous copy HEAD's manifest classes `split` (plus
 * the pointwise license spellings a pre-manifest-era HEAD cannot class),
 * with the repository-owned content that leaves. Forces the manual-review
 * path in open_pr.ts. */
export const REMOVED_SPLITS_NAME = "removed-splits.md";

/** relocate_security_policy.ts's transition note: the one-time
 * byte-for-byte move of SECURITY.md from the repository root to
 * .github/SECURITY.md, its repository-owned half riding the rename.
 * Informational, never forces review (nothing leaves the repository);
 * self-retires once the fleet has crossed. */
export const SECURITY_MOVE_NAME = "security-move.md";

/** referenced_labels.ts's report: label(s) the target's issue forms or
 * workflows reference that the merged settings label roster does not
 * declare - the apply deletes undeclared labels, so each reference is
 * broken or about to be. Forces the manual-review path. */
export const REFERENCED_LABELS_NAME = "referenced-labels.md";

/** materialize_mirrors.ts's listing: every mirror copy this update
 * materialized from the repo's own .repo-platform.yml `mirrors`
 * declaration (plus patterns that matched nothing). Informational - the
 * declaration is repo-owned consent and the listing explains the diff -
 * so it never forces review. */
export const MIRRORS_NOTE_NAME = "mirrors.md";

/** materialize_mirrors.ts's refusals: declared mirrors the sync would not
 * write (unrendered source, escaping or template-owned target, two
 * writers). The refused copies are stale in the delivered tree, so this
 * forces the manual-review path. */
export const MIRRORS_REVIEW_NAME = "mirrors-review.md";
