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
