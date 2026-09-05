// Guards the sync's adopt semantics: live visibility and description feed
// the render on purpose (the visibility-gated renders - CONTRIBUTING.md,
// CODE_OF_CONDUCT.md, the CodeQL and dependency-review jobs - must follow
// the repo's real state), so a value changed out-of-band in the GitHub UI
// would ride a clean sync PR into the rendered files and auto-merge into
// declared truth: exactly the drift the nightly settings heal exists to
// revert. This script compares the live values against the answers
// recorded in the target's .github/.copier-answers.yml. On a mismatch it emits
// one ::warning:: per drifted field and writes a PR-body section;
// open_pr.ts prepends that section and keeps auto-merge off, so ratifying
// the change stays a human decision. A field the answers file does not
// record is skipped (nothing to drift from; the sync adopts it), but a
// recorded value of the wrong type fails the step rather than skipping:
// silently comparing nothing is how the ratification bug worked.
//
// Usage:
//   bun .github/scripts/sync/settings_drift.ts --target-dir <checkout>
//     --repo <owner/name>
//     --in-repo-settings <target's .github/settings.yml path>
//     --live-private <true|false> --live-description <text>
//     --summary <out-file>
//
// What merging ratifies depends on whether the repo opts into managed
// settings - the settings-sync module in its .repo-platform.yml, read
// from the registration file at the settings path's repo root - so the
// PR body says something different for managed and unmanaged repos (see
// driftSummary): a managed repo's nightly heal enforces the centrally
// assembled baseline with its own settings.yml merged over it, an
// unmanaged repo has nothing enforcing its settings at all.
//
// The summary file is written empty when nothing drifted, and its size is
// the single source of truth for "this PR needs review" (open_pr.ts tests
// it). Errors print as ::error:: workflow commands (on stdout, where the
// runner parses them) with a nonzero exit.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { selectsSettingsSync } from "../fleet/build_settings_matrix.ts";
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
const OPTIONAL_FLAGS = ["--display", "--hide-details"] as const;

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

export function driftSummary(repo: string, drifts: Drift[], managed: boolean): string {
  if (drifts.length === 0) {
    return "";
  }
  const changes = drifts
    .map((d) => `> - \`${d.field}\`: ${show(d.recorded)} -> ${show(d.live)} (recorded -> live)`)
    .join("\n");
  const revert = managed
    ? `> To revert instead, flip the setting back in the GitHub UI or run
> the settings-repos heal, then re-run the sync for a clean PR.`
    : `> To revert instead, flip the setting back in the GitHub UI, then
> re-run the sync for a clean PR.`;
  const consequence = managed
    ? `> Merging this PR records the live values as the answers and
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
${revert}`
    : `> Merging this PR records the live values as ${repo}'s answers and
> re-renders from them. Nothing enforces them either way: the repo
> does not select the settings-sync module (its \`.repo-platform.yml\`
> is the opt-in to managed settings), so no apply run reverts this.
${revert}`;
  return `> [!WARNING]
> OUT-OF-BAND SETTINGS CHANGE: ${repo}'s live settings no longer
> match the answers recorded in its .github/.copier-answers.yml:
>
${changes}
>
${consequence}
> Auto-merge is off until this is settled.`;
}

// The log line deliberately does not say what merging ratifies: that
// depends on the opt-in, and driftSummary is the one place that decides
// it. Two descriptions would drift apart.
export function driftWarnings(repo: string, drifts: Drift[], hideDetails = false): string[] {
  return drifts.map((d) =>
    hideDetails
      ? `::warning::${escapeData(
          `${repo}: ${d.field} changed out of band (values hidden: private repository; ` +
            "details in the PR body). Auto-merge is disabled; the PR body explains " +
            "what merging does and how to revert.",
        )}`
      : `::warning::${escapeData(
          `${repo}: ${d.field} changed out of band: ${show(d.recorded)} -> ${show(d.live)}. ` +
            "Auto-merge is disabled; the PR body explains what merging does " +
            "and how to revert.",
        )}`,
  );
}

function main(args: string[]): void {
  const flags = parseFlags(args, FLAGS, OPTIONAL_FLAGS);
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
          ? `${display}: a recorded answer is malformed, so drift cannot be detected (detail hidden: private repository). Reproduce the sync locally - see docs/private-repos.md.`
          : `${repo}: ${error}`,
      ),
    );
  }
  // The opt-in signal, read from the registration file at the settings
  // path's repo root (target/.github/settings.yml -> target/
  // .repo-platform.yml): an unreadable or opt-out selection tells the
  // unmanaged story. selectsSettingsSync is the same parse the fleet
  // selector uses, so the two opt-in readings cannot drift apart.
  const registrationPath = join(
    dirname(dirname(flags["--in-repo-settings"])),
    ".repo-platform.yml",
  );
  const managed =
    existsSync(registrationPath) &&
    selectsSettingsSync(readFileSync(registrationPath, "utf-8")) === true;

  writeFileSync(flags["--summary"], driftSummary(repo, drifts, managed));
  if (drifts.length === 0) {
    console.log(`${display}: live settings match the recorded answers; no out-of-band drift.`);
    return;
  }
  for (const warning of driftWarnings(display, drifts, hideDetails)) {
    console.log(warning);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
