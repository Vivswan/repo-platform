// Guards the sync's adopt semantics: live visibility and description feed
// the render on purpose (visibility-gated renders must follow the repo's
// real state), so a value changed out-of-band in the GitHub UI would ride
// a clean sync PR into the rendered files and auto-merge into declared
// truth - the drift the nightly settings heal exists to revert. This
// compares the live values against the recorded answers; a mismatch emits
// one ::warning:: per field and writes a PR-body section that open_pr.ts
// prepends with auto-merge off, so ratifying stays a human decision. An
// unrecorded field is skipped (nothing to drift from), but a recorded value
// of the wrong type fails the step: silently comparing nothing is how the
// ratification bug worked.
//
// Merging ratifies nothing: the nightly heal enforces the baseline with the
// repo's settings.yml merged over it, so driftSummary points there, offered
// only while that file exists (--in-repo-settings). The summary file is
// written empty when nothing drifted, and its size is the single source of
// truth for "this PR needs review" (open_pr.ts tests it).
// Usage: bun .github/scripts/sync/settings_drift.ts --target-dir <checkout>
//   --repo <owner/name> --in-repo-settings <path> --live-private <bool>
//   --live-description <text> --summary <out-file>
//
// --mode branch (a render pushed onto a PR branch) words the section for that
// delivery: no sync PR exists and no auto-merge is disarmed.

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFlags } from "../shared/flags.ts";
import { escapeData, fail } from "../shared/gha.ts";
import {
  ANSWERS_PATH,
  AnswersFileError,
  type CopierAnswers,
  readAnswersFile,
} from "./answers_file.ts";

const FLAGS = [
  "--target-dir",
  "--repo",
  "--in-repo-settings",
  "--live-private",
  "--live-description",
  "--summary",
] as const;

// Optional redaction flags: --display is the name this public log may
// print (the repo's hint when its name is redacted), --hide-details
// suppresses recorded/live VALUES from warnings and errors - the summary
// file keeps them, because it ships in the PR body to the target repo
// itself, whose access control is the right one.
const OPTIONAL_FLAGS = ["--display", "--hide-details", "--mode"] as const;

/** Where the drift report lands: the sync PR's body, or (branch mode) a
 *  comment on the branch's PR when one exists (open_pr.ts looks it up
 *  after this step ran; without a PR the report goes nowhere). */
export type Delivery = "default" | "branch";

export interface Drift {
  field: "private" | "description";
  recorded: string;
  live: string;
}

// GitHub cannot store a real newline in a description, but the value
// arrives through a heredoc-shaped step output, so a trailing newline is
// transport noise, not drift.
function normalizeDescription(value: unknown): string {
  return String(value ?? "").replace(/[\r\n]+$/, "");
}

export function detectDrift(
  answers: Record<string, unknown>,
  livePrivate: string,
  liveDescription: string,
): { drifts: Drift[]; errors: string[] } {
  const drifts: Drift[] = [];
  const errors: string[] = [];
  if (livePrivate !== "true" && livePrivate !== "false") {
    // A malformed live value would otherwise read as drift for every
    // repo at once and block the whole fleet's auto-merge behind a
    // nonsense message.
    errors.push(`--live-private must be "true" or "false", got "${livePrivate}"`);
  } else if (typeof answers.private === "boolean") {
    const recorded = String(answers.private);
    if (recorded !== livePrivate) {
      drifts.push({ field: "private", recorded, live: livePrivate });
    }
  } else if (Object.hasOwn(answers, "private")) {
    errors.push(
      `the recorded private answer must be a boolean, got ${JSON.stringify(answers.private)} - ` +
        "visibility drift cannot be detected until it is fixed",
    );
  }
  if (Object.hasOwn(answers, "description")) {
    const recorded = normalizeDescription(answers.description);
    const live = normalizeDescription(liveDescription);
    if (recorded !== live) {
      drifts.push({ field: "description", recorded, live });
    }
  }
  return { drifts, errors };
}

// JSON.stringify keeps each value single-line and unambiguous (quotes and
// newlines stay escaped), which both the PR body and the single-line
// ::warning:: format need.
function show(value: string): string {
  return JSON.stringify(value);
}

export function driftSummary(
  repo: string,
  drifts: Drift[],
  settingsPresent: boolean,
  delivery: Delivery = "default",
): string {
  if (drifts.length === 0) {
    return "";
  }
  const branch = delivery === "branch";
  const changes = drifts
    .map((d) => `> - \`${d.field}\`: ${show(d.recorded)} -> ${show(d.live)} (recorded -> live)`)
    .join("\n");
  const revert = settingsPresent
    ? `> To revert instead, flip the setting back in the GitHub UI or run
> the settings-repos heal, then re-run the sync for a clean PR.`
    : `> To revert instead, flip the setting back in the GitHub UI, then
> re-run the sync for a clean PR (the heal skips this repository until it
> has a \`.github/settings.yml\`).`;
  const consequence = `> Merging ${branch ? "the PR this branch belongs to" : "this PR"} records the live values as the answers and
> re-renders the answer-derived files - but it does NOT decide the
> enforced settings. What the nightly heal does next depends on the
> \`.github/settings.yml\` this branch leaves behind (the sync may have
> created it here from the live values):
>
> - it declares the drifted key: the heal enforces THAT value, so a
>   declaration of the old value reverts the live change.
> - it omits the key: the heal leaves the live value alone; the key
>   stays unmanaged.
> - the branch has no settings.yml at all: the apply skips this
>   repository entirely until one exists.
>
> So check that file on this branch and declare the value you want
> enforced.
${revert}`;
  return `> [!WARNING]
> OUT-OF-BAND SETTINGS CHANGE: ${repo}'s live settings no longer
> match the answers recorded in its .github/.copier-answers.yml:
>
${changes}
>
${consequence}
${
  branch
    ? "> This render was pushed onto the branch; its PR's own auto-merge is untouched, so settle this before merging."
    : "> Auto-merge is off until this is settled."
}`;
}

// The log line deliberately does not say what merging ratifies:
// driftSummary is the one place that spells that out, and two
// descriptions would drift apart.
export function driftWarnings(
  repo: string,
  drifts: Drift[],
  hideDetails = false,
  delivery: Delivery = "default",
): string[] {
  const line = (d: Drift, detail: string, tail: string) =>
    `::warning::${escapeData(`${repo}: ${d.field} changed out of band${detail}. ${tail}`)}`;
  const values = (d: Drift) => `: ${show(d.recorded)} -> ${show(d.live)}`;
  if (delivery === "branch") {
    // Whether the branch has a PR is only known once open_pr.ts runs, so
    // the comment is promised conditionally and the no-PR reader is told
    // what this run leaves them: the values here, or (hidden) the render
    // commit, whose answers-file hunk shows recorded -> live.
    const comment =
      "The sync's comment on the branch's open PR, when there is one, " +
      `${hideDetails ? "carries the values and " : ""}explains what merging does and how to revert; ` +
      "a branch without a PR receives no comment";
    return hideDetails
      ? drifts.map((d) =>
          line(
            d,
            " (values hidden: private repository)",
            `${comment}, so read both values off the render commit's diff of .github/.copier-answers.yml.`,
          ),
        )
      : drifts.map((d) => line(d, values(d), `${comment}, and this line is the run's record.`));
  }
  const tail = "Auto-merge is disabled; the PR body explains what merging does and how to revert.";
  return hideDetails
    ? drifts.map((d) =>
        line(d, " (values hidden: private repository; details in the PR body)", tail),
      )
    : drifts.map((d) => line(d, values(d), tail));
}

function main(args: string[]): void {
  const flags = parseFlags(args, FLAGS, OPTIONAL_FLAGS);
  const mode = flags["--mode"] ?? "default";
  if (mode !== "default" && mode !== "branch") {
    fail(`--mode must be default or branch, got ${mode}`);
  }
  const repo = flags["--repo"];
  const display = flags["--display"] ?? repo;
  const hideDetails = flags["--hide-details"] === "true";

  const targetDir = flags["--target-dir"];
  let answers: CopierAnswers;
  try {
    answers = readAnswersFile(targetDir);
  } catch (err) {
    if (!(err instanceof AnswersFileError)) throw err;
    // The parser's message can quote target file content; a hidden
    // target gets the detail-free version.
    if (hideDetails) {
      fail(
        `${display}: the recorded answers file cannot be read (detail ` +
          "hidden: private repository). Reproduce the sync locally - see docs/private-repos.md.",
      );
    }
    fail(`${join(targetDir, ANSWERS_PATH)}: ${err.message}`);
  }

  const { drifts, errors } = detectDrift(
    answers.fields,
    flags["--live-private"],
    flags["--live-description"],
  );
  if (errors.length > 0) {
    // The error text embeds the malformed recorded value; a hidden
    // target gets the field-free version.
    fail(
      errors.map((error) =>
        hideDetails
          ? `${display}: a recorded answer is malformed, so drift cannot be detected ` +
            "(detail hidden: private repository). Reproduce the sync locally - see docs/private-repos.md."
          : `${repo}: ${error}`,
      ),
    );
  }
  writeFileSync(
    flags["--summary"],
    driftSummary(repo, drifts, existsSync(flags["--in-repo-settings"]), mode),
  );
  if (drifts.length === 0) {
    console.log(`${display}: live settings match the recorded answers; no out-of-band drift.`);
    return;
  }
  for (const warning of driftWarnings(display, drifts, hideDetails, mode)) {
    console.log(warning);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
