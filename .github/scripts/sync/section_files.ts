// RUNNER_TEMP report filenames shared by each report's WRITER and
// open_pr.ts's PR-body section collection - one constant per pair, so a
// rename on either side fails to compile together instead of silently
// dropping a PR-body section (the reports are flag files: an unread one
// would simply never appear).

/** tail_tripwire.ts's report (written under RUNNER_TEMP by default). */
export const TAIL_SHRANK_NAME = "tail-shrank.md";

/** settings_layering.ts's dropped-overrides report (written by
 * preserve_repo_owned.ts under RUNNER_TEMP). */
export const SETTINGS_LAYERING_NAME = "settings-layering.md";

/** preserve_repo_owned.ts's removed-split-files report: every path this
 * update deletes whose previous copy HEAD's manifest classes `split` (plus
 * the pointwise license spellings a pre-manifest-era HEAD cannot class),
 * with the repository-owned content that leaves. Forces the manual-review
 * path in open_pr.ts. */
export const REMOVED_SPLITS_NAME = "removed-splits.md";

/** starter_pin_rollout.ts's transition note: the starter files whose
 * action pins the one-run rollout rewrote in place, and the hand-set pins
 * it deliberately left alone. Informational, never forces review. */
export const STARTER_PINS_NAME = "starter-pin-rollout.md";

/** gate_rework.ts's transition note: this update deletes the retired
 * verdict wrapper (all-green.yml) and hands the required check to
 * ci.yml's own all-green job - the PR gates itself, so the note is
 * informational and never forces review; self-retires once the fleet has
 * crossed. */
export const GATE_REWORK_NAME = "gate-rework.md";

/** referenced_labels.ts's report: label(s) the target's issue forms or
 * workflows reference that the merged settings label roster does not
 * declare - the apply deletes undeclared labels, so each reference is
 * broken or about to be. Forces the manual-review path. */
export const REFERENCED_LABELS_NAME = "referenced-labels.md";
