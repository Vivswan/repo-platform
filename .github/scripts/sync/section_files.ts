// The PR-body sections fed by report files: the RUNNER_TEMP filename each
// report's WRITER shares with the roster (one constant per pair, so a rename
// fails to compile instead of silently dropping a section - an unread flag
// file simply never appears), and PR_BODY_SECTIONS, the one roster
// open_pr.ts collects the body from and rehearse.ts prints it from.

/** tail_tripwire.ts's report (written under RUNNER_TEMP by default). */
export const TAIL_SHRANK_NAME = "tail-shrank.md";

/** preserve_repo_owned.ts's removed-split-files report: every path this
 * update deletes whose previous copy HEAD's manifest classes `split` (plus
 * LICENSE.md pointwise, which no manifest classes under custom-license),
 * with the repository-owned content that leaves. Forces the manual-review
 * path in open_pr.ts. */
export const REMOVED_SPLITS_NAME = "removed-splits.md";

/** run_migrations.ts's informational notes: what each pending migration
 * rung did to the target ahead of copier (a file moved byte-for-byte, say)
 * when the rung says nothing leaves the repository. Never forces review.
 * A rung's note lands here or in MIGRATIONS_REVIEW_NAME, never both. */
export const MIGRATIONS_NAME = "migrations.md";

/** run_migrations.ts's review notes: the migration rungs whose verdict
 * needs a human before the PR merges. Forces the manual-review path. */
export const MIGRATIONS_REVIEW_NAME = "migrations-review.md";

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

/** new_starters.ts's hold: starters new to the template at paths the target already owns a file
 * at (copier keeps the repository's copy without a conflict). Names each file, its template
 * callers, and the template's starter; forces the manual-review path. */
export const NEW_STARTERS_REVIEW_NAME = "new-starters-review.md";

/** One PR-body section fed by a report file. */
export interface PrBodySection {
  /** The reusable-template-sync.yml env var carrying the file's path when a
   * workflow step names the file; null when the writer and the roster share
   * one of the fixed RUNNER_TEMP names above. */
  env: string | null;
  /** The RUNNER_TEMP basename: the fixed name, or the one the workflow's env
   * var points at (rehearse.ts writes each report's twin under it). */
  file: string;
  /** rehearse.ts's heading over the would-be section. */
  title: string;
  /** Renders the section from the file's content (trailing newline
   * stripped; called only on a non-empty file). null marks a review-only
   * flag with no body section. */
  render: ((text: string) => string) | null;
  /** A present file forces the manual-review path. */
  forcesReview: boolean;
}

const verbatim = (text: string): string => text;
const lines = (text: string): string[] => text.split("\n").filter((line) => line !== "");
const bulleted = (text: string): string =>
  lines(text)
    .map((rel) => `- ${rel}`)
    .join("\n");

/** The PR-body sections in body order; an absent or empty file is no
 * section. A non-empty dropped-hunks summary is also what the workflow's
 * `resolved` output means. */
export const PR_BODY_SECTIONS: readonly PrBodySection[] = [
  {
    env: "CARRIED_FILE",
    file: "local-carryover.md",
    title: "Split-file carry summary (rebuilt structurally)",
    render: verbatim,
    forcesReview: false,
  },
  {
    env: null,
    file: TAIL_SHRANK_NAME,
    title: "Tail tripwire report (a trip is a sync bug)",
    render: verbatim,
    forcesReview: true,
  },
  {
    env: "REMOVED_PATHS_FILE",
    file: "removed-paths.txt",
    title: "Retired template files this update deletes",
    render: (text) =>
      `The template retired these files; this update deletes them:\n\n${bulleted(text)}`,
    forcesReview: false,
  },
  {
    env: null,
    file: MIGRATIONS_NAME,
    title: "Migration rungs that acted ahead of copier",
    render: verbatim,
    forcesReview: false,
  },
  {
    env: null,
    file: MIGRATIONS_REVIEW_NAME,
    title: "Migration rungs whose verdict needs a human",
    render: verbatim,
    forcesReview: true,
  },
  {
    env: "MANIFEST_LICENSE_FILE",
    file: "manifest-license-warnings.md",
    title: "Registry metadata conflicting with the fleet license",
    render: verbatim,
    forcesReview: false,
  },
  {
    env: null,
    file: MIRRORS_NOTE_NAME,
    title: "Mirror copies materialized from the repo's own `mirrors` declaration",
    render: verbatim,
    forcesReview: false,
  },
  {
    env: null,
    file: MIRRORS_REVIEW_NAME,
    title: "Refused mirror declarations (nothing written for them)",
    render: verbatim,
    forcesReview: true,
  },
  {
    env: null,
    file: REFERENCED_LABELS_NAME,
    title:
      "Labels referenced by issue forms or workflows but missing from the merged settings roster",
    render: verbatim,
    forcesReview: true,
  },
  {
    env: null,
    file: REMOVED_SPLITS_NAME,
    title: "Deleted files whose previous copy carried a repository-owned half",
    render: verbatim,
    forcesReview: true,
  },
  {
    env: null,
    file: NEW_STARTERS_REVIEW_NAME,
    title: "Starters new to the template at paths this repository already owns a file at",
    render: verbatim,
    forcesReview: true,
  },
  {
    env: "CARRY_REVIEW_FILE",
    file: "carry-review.txt",
    title: "Carries that need a human (the carry summary names the files)",
    render: null,
    forcesReview: true,
  },
  {
    env: "SUMMARY_FILE",
    file: "dropped-local-hunks.md",
    title: "Merge conflicts resolved toward the template (review the dropped local lines)",
    render: (text) => `> [!WARNING]
> copier hit merge conflicts, resolved below in favor of the
> template where possible. Restore any dropped local lines that
> should stay, and hand-edit anything marked unresolved, before
> merging.

${text}`,
    forcesReview: true,
  },
];
