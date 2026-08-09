// Guards the sync's adopt semantics: live visibility and description feed
// the render on purpose (the visibility-gated renders - CONTRIBUTING.md,
// CODE_OF_CONDUCT.md, the CodeQL and dependency-review jobs - and
// settings.yml must follow the repo's real state), so a value
// changed out-of-band in the GitHub UI would ride a clean sync PR into
// the rendered files and
// auto-merge into declared truth: exactly the drift the nightly settings
// heal exists to revert. This script compares the live values against the
// answers recorded in the target's .copier-answers.yml. On a mismatch it
// emits one ::warning:: per drifted field and writes a PR-body section;
// open_pr.ts prepends that section and keeps auto-merge off, so ratifying
// the change stays a human decision. A field the answers file does not
// record is skipped (nothing to drift from; the sync adopts it), but a
// recorded value of the wrong type fails the step rather than skipping:
// silently comparing nothing is how the ratification bug worked.
//
// Usage:
//   bun .github/scripts/sync/settings_drift.ts --answers <file>
//     --repo <owner/name> --central-dir <settings/repos dir>
//     --in-repo-settings <target's .github/settings.yml path>
//     --live-private <true|false> --live-description <text>
//     --summary <out-file>
//
// What merging ratifies depends on which settings home the repo has, so
// the PR body says something different for each (see driftSummary): a
// central file outranks the merge, an in-repo settings.yml is what the
// heal enforces afterwards, and a repo with neither home has nothing
// enforcing its settings at all.
//
// The summary file is written empty when nothing drifted, and its size is
// the single source of truth for "this PR needs review" (open_pr.ts tests
// it). Errors go to stderr as ::error:: workflow commands with a nonzero
// exit.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { parseFlags } from "../shared/flags.ts";

const FLAGS = [
  "--answers",
  "--repo",
  "--central-dir",
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

// Which file, if any, an apply run enforces this repo's settings from.
// Central wins over in-repo where both exist (docs/settings.md).
export type SettingsHome = "central" | "in-repo" | "none";

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
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

export function driftSummary(repo: string, drifts: Drift[], home: SettingsHome): string {
  if (drifts.length === 0) {
    return "";
  }
  const name = repo.split("/").pop() ?? repo;
  const changes = drifts
    .map((d) => `> - \`${d.field}\`: ${show(d.recorded)} -> ${show(d.live)} (recorded -> live)`)
    .join("\n");
  const revert =
    home === "none"
      ? `> To revert instead, flip the setting back in the GitHub UI, then
> re-run the sync for a clean PR.`
      : `> To revert instead, flip the setting back in the GitHub UI or run
> the settings-repos heal, then re-run the sync for a clean PR.`;
  const consequence: Record<SettingsHome, string> = {
    central: `> Merging this PR writes the live values into the recorded answers
> and the rendered files, but it does NOT make them the enforced
> settings: ${repo} is centrally homed, and
> \`settings/repos/${name}.yml\` in repo-platform wins regardless.
> Make the change, or the revert, in that central file.`,
    "in-repo": `> Merging this PR RATIFIES the live values: they become the recorded
> answers and are re-rendered into the repo's files. Its own
> \`.github/settings.yml\` is what the nightly settings heal enforces,
> so check that this merge leaves that file saying what you want.
${revert}`,
    none: `> Merging this PR records the live values as ${repo}'s answers and
> re-renders from them. Nothing enforces them either way: the repo
> has no settings home (no \`settings/repos/${name}.yml\` here, no
> \`.github/settings.yml\` of its own), so no apply run reverts this.
${revert}`,
  };
  return `> [!WARNING]
> OUT-OF-BAND SETTINGS CHANGE: ${repo}'s live settings no longer
> match the answers recorded in its .copier-answers.yml:
>
${changes}
>
${consequence[home]}
> Auto-merge is off until this is settled.`;
}

// Workflow-command data is single-line; escape per the runner's rules.
function escapeData(message: string): string {
  return message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

// The log line deliberately does not say what merging ratifies: that
// depends on the settings home, and driftSummary is the one place that
// decides it. Two descriptions would drift apart.
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

  const answersPath = flags["--answers"];
  let answers: unknown;
  try {
    answers = parse(readFileSync(answersPath, "utf-8"));
  } catch (err) {
    // The parser's message can quote target file content; a hidden
    // target gets the detail-free version.
    if (hideDetails) {
      fail(
        `${display}: the recorded answers file cannot be read as YAML (detail hidden: ` +
          "private repository). Reproduce the sync locally - see docs/private-repos.md.",
      );
    }
    const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
    fail(`${answersPath}: cannot read as YAML: ${detail}`);
  }
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) {
    fail(`${answersPath}: top level must be a mapping`);
  }

  const { drifts, errors } = detectDrift(
    answers as Record<string, unknown>,
    flags["--live-private"],
    flags["--live-description"],
  );
  if (errors.length > 0) {
    for (const error of errors) {
      // The error text embeds the malformed recorded value; a hidden
      // target gets the field-free version.
      console.error(
        hideDetails
          ? `::error::${display}: a recorded answer is malformed, so drift cannot be detected (detail hidden: private repository). Reproduce the sync locally - see docs/private-repos.md.`
          : `::error::${repo}: ${error}`,
      );
    }
    process.exit(1);
  }
  const name = repo.split("/").pop() ?? repo;
  const home: SettingsHome = existsSync(join(flags["--central-dir"], `${name}.yml`))
    ? "central"
    : existsSync(flags["--in-repo-settings"])
      ? "in-repo"
      : "none";

  writeFileSync(flags["--summary"], driftSummary(repo, drifts, home));
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
