// What the pull request is told. Every path and every word of the hook's findings came from code the pull request
// controls, so each is quoted here before it reaches Markdown: a path as a one-line code span, findings as a fenced block.
// FORK_NOTICE is what a fork's pull request is told when it is given the label.

import { codeSpan, fenced } from "../../.github/scripts/shared/markdown_code.ts";
import type { FixEvent } from "./paths.ts";

const SHOWN_PATHS = 20;
const SHOWN_PATH_LENGTH = 200;
const SHOWN_FINDINGS_LENGTH = 2000;
const SHORT_SHA = 7;
const HELD_RUN =
  "GitHub holds the new head's `pull_request` run for approval after a push with the workflow token, so its checks stay unreported. Approve the run from the merge box or the Actions tab, or push a commit to this branch.";

const FAILED_HEADLINE = {
  untouched: "The fix failed before anything was pushed",
  unmoved: "The push failed and the branch has not moved",
  unread: "The push failed, and the branch could not be read back",
} as const;

export const FORK_NOTICE =
  "Forks are not fixed: the workflow token cannot push to a fork's branch. Run the repository's fixer locally and push the result. The `fix-lint` label was removed.";

/** A path named to the reader, with why when the job naming it judged it itself. */
export interface NamedPath {
  /** The path, as git printed it. */
  path: string;

  /** Why it was left out, or null when the unprivileged job reported it. */
  reason: string | null;
}

/** How a run ended. */
export type Outcome =
  | { kind: "pushed"; commit: string; subject: string }
  | { kind: "nothing" }
  | { kind: "superseded" }
  | { kind: "refused"; why: string; refused: NamedPath[] }
  | { kind: "failed"; branch: keyof typeof FAILED_HEADLINE; detail: string };

/** What the unprivileged job reported beside the patch. */
export interface Remarks {
  /** What the hook said its fixer could not fix, empty for none. */
  findings: string;

  /** The changes the label's rule left out of the commit. */
  dropped: NamedPath[];
}

/** `text` with every control character but a line feed and a tab spelled visibly, cut to `limit` characters. */
function visible(text: string, limit: number): string {
  const spelled = text.replaceAll(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are the ones replaced
    /[\x00-\x08\x0b-\x1f\x7f]/g,
    (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );

  return spelled.length > limit ? `${spelled.slice(0, limit)}...` : spelled;
}

function pathLines(paths: readonly NamedPath[]): string[] {
  const lines = paths.slice(0, SHOWN_PATHS).map(({ path, reason }) => {
    const span = codeSpan(visible(path, SHOWN_PATH_LENGTH).replaceAll(/[\n\t]/g, " "));
    return reason === null ? `- ${span}` : `- ${span}: ${reason}`;
  });
  if (paths.length > SHOWN_PATHS) lines.push(`- and ${paths.length - SHOWN_PATHS} more`);

  return lines;
}

function headline(event: FixEvent, outcome: Outcome, remarks: Remarks): string[] {
  if (outcome.kind === "pushed") {
    const commit = outcome.commit.slice(0, SHORT_SHA);
    return [`Pushed ${codeSpan(outcome.subject)} as ${commit}.`, "", HELD_RUN];
  }

  if (outcome.kind === "nothing" && remarks.dropped.length > 0) {
    return ["Nothing was committed: every change the fixer made is one a fix may not carry."];
  }

  if (outcome.kind === "nothing") return ["Nothing to fix: the fixer changed no file."];

  if (outcome.kind === "superseded") {
    const next =
      event === "label" ? "Add the `fix-lint` label again." : "The new head gets its own run.";
    return [`Not pushed: the branch moved while the fix was built. ${next}`];
  }

  if (outcome.kind === "refused") {
    return [`Refused, nothing was committed: ${outcome.why}`, "", ...pathLines(outcome.refused)];
  }

  return [`${FAILED_HEADLINE[outcome.branch]}: ${outcome.detail}`];
}

/**
 * The sticky notice for a run, Markdown; empty when the run has nothing to say, which is a push whose fixer changed
 * nothing.
 */
export function noticeOf(event: FixEvent, outcome: Outcome, remarks: Remarks): string {
  if (event === "push" && outcome.kind === "nothing") return "";

  const lines = headline(event, outcome, remarks);
  if (remarks.dropped.length > 0) {
    lines.push(
      "",
      "Left out of the commit, outside the registration's `autofix` lists or never changed by a fix:",
      "",
      ...pathLines(remarks.dropped),
    );
  }

  const findings = visible(remarks.findings.trim(), SHOWN_FINDINGS_LENGTH);
  if (findings !== "") {
    lines.push("", "The fixer left findings:", "", ...fenced(findings, "text"));
  }

  return lines.join("\n");
}
