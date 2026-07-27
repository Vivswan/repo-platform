/**
 * File, update, or resolve the nightly-fuzz tracking issue for a repository.
 * Generalized from repo-settings-as-code's file-fuzz-issue.ts: this version
 * knows nothing about any repo's fuzzer. It reads failure reports from a
 * directory whose layout is a small contract (docs/fuzzer.md, "failure-report
 * contract v1"): each immediate subdirectory is one failure and carries a
 * report.md whose first line is a `# title` heading and whose body contains
 * the replay command. The producer writes the replay command; this script
 * only assembles the issue.
 *
 * Two modes, selected by MODE:
 * - report: build a body from the failure reports and comment on the open
 *   labeled issue, or create it if none is open. One open issue per label.
 * - resolve: after a green run, comment on and close the open labeled issue;
 *   a silent no-op when none is open.
 *
 * Configuration from the environment (set by action.yml): MODE, LABEL,
 * TITLE, ARTIFACTS_DIR, ARTIFACT_NAME. Context: GH_TOKEN (gh auth),
 * GITHUB_SERVER_URL / GITHUB_REPOSITORY / GITHUB_RUN_ID (the run link),
 * GITHUB_OUTPUT (the issue-number step output).
 */

import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/** Report head shown per failure; the body is a summary, not a log. */
const REPORT_LINES = 60;
/**
 * GitHub caps an issue or comment body at 65,536 characters. Stay comfortably
 * under it and let the truncation notice and the uploaded artifacts carry the
 * rest.
 */
const MAX_BODY = 60_000;
/**
 * Hard per-block character cap after line truncation, so one very long single
 * line (which line truncation cannot shorten) cannot dominate the body. Small
 * enough that the fixed header/footer/notice plus at least one full block
 * always fit inside MAX_BODY.
 */
const MAX_BLOCK_CHARS = 8_000;
/** Contract v1: failure directory names are plain identifiers. */
const DIR_NAME = /^[A-Za-z0-9._-]+$/;

/** Runs a `gh` subcommand and returns stdout; throws on a non-zero exit. */
export type GhRunner = (args: string[]) => Promise<string>;

/** Run gh and return stdout; throws with gh's stderr on a non-zero exit. */
const gh: GhRunner = async (args) => {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`gh ${args.join(" ")} failed (${code}): ${stderr.trim()}`);
  }
  return stdout;
};

/**
 * The failure directories under the artifacts dir, oldest first. Only
 * immediate subdirectories with contract-conforming names count; top-level
 * files and oddly named directories are ignored.
 */
export function failureDirs(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root)
    .filter((name) => DIR_NAME.test(name))
    .flatMap((name) => {
      const path = join(root, name);
      try {
        // statSync follows symlinks and throws on a dangling one; a broken
        // entry must not abort the filing on a night that already failed.
        const stats = statSync(path);
        return stats.isDirectory() ? [{ path, mtimeMs: stats.mtimeMs }] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .map((entry) => entry.path);
}

/**
 * The first `limit` lines of `text`, with a marker naming how many were cut. A
 * single trailing newline is not counted as a line, so text of exactly `limit`
 * lines plus a trailing newline is returned whole rather than reporting one
 * phantom extra line.
 */
export function head(text: string, limit: number): string {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop(); // a trailing newline splits to an empty final element; drop it
  }
  if (lines.length <= limit) {
    return text.trimEnd();
  }
  return `${lines.slice(0, limit).join("\n")}\n... (${lines.length - limit} more lines)`;
}

/**
 * Truncate `text` to at most `max` characters, appending a marker when cut, so
 * a single very long line (which line truncation cannot shorten) can never blow
 * the body budget. The marker itself is counted, so the return is always <= max.
 */
export function capChars(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const marker = "\n... (truncated)";
  const keep = Math.max(0, max - marker.length);
  return text.slice(0, keep) + marker;
}

/** The run link built from the standard Actions environment variables. */
export function runUrl(env: NodeJS.ProcessEnv): string {
  const server = env.GITHUB_SERVER_URL;
  const repo = env.GITHUB_REPOSITORY;
  const runId = env.GITHUB_RUN_ID;
  if (!server || !repo || !runId) {
    return "";
  }
  return `${server}/${repo}/actions/runs/${runId}`;
}

/**
 * The per-failure section title: the report's first line with its heading
 * markers stripped. A report without a usable first line falls back to the
 * directory name; a missing report says so.
 */
export function blockTitle(dir: string, report: string): string {
  const first = report
    .split("\n")[0]
    ?.replace(/^#+\s*/, "")
    .trim();
  if (first) {
    return first;
  }
  return report ? basename(dir) : `${basename(dir)} (no report.md)`;
}

/** Build the issue/comment body from every failure directory. */
export function buildBody(dirs: string[], env: NodeJS.ProcessEnv, artifactName: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const url = runUrl(env);
  if (dirs.length === 0) {
    const parts = [
      `Nightly fuzz run on ${date} failed with no failure report.`,
      "",
      "Nothing wrote a report: the failure may sit outside the fuzz step",
      "(setup, cache, artifact upload), or the fuzzer died before it could",
      "write one. See the run log.",
    ];
    if (url) {
      parts.push("", `Run: ${url}`);
    }
    return parts.join("\n");
  }

  const header = `Nightly fuzz run on ${date} produced ${dirs.length} failure report(s).\n`;
  const footer = url ? `\nRun: ${url}` : "";
  const artifactsNote = artifactName
    ? `\nThe full failure artifacts (crashing inputs, logs) are attached to the run as \`${artifactName}\`.`
    : "\nThe full failure artifacts are attached to the run; see its artifacts list.";
  // The omission notice is only present when some blocks are dropped, but its
  // length is reserved up front so the running total stays a real character
  // budget whether or not it ends up shown. Padded for the count digits.
  const omissionNotice = (count: number) =>
    `\n${count} more failure report(s) omitted to stay under the GitHub body limit; see the attached artifacts.`;
  const noticeReserve = omissionNotice(dirs.length).length;

  // Append per-failure blocks while each fits the remaining budget; then stop
  // and say how many were omitted. Every block (including the first) is both
  // character-capped and budget-checked, so no single report can push the
  // body past GitHub's limit and break the filing itself.
  const budget = MAX_BODY - header.length - footer.length - artifactsNote.length - noticeReserve;
  const blocks: string[] = [];
  let used = 0;
  let shown = 0;
  for (const dir of dirs) {
    const reportPath = join(dir, "report.md");
    const report = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
    const title = blockTitle(dir, report);
    // The report's own heading is dropped (the block heading replaces it);
    // the rest of the head carries the replay command per the contract.
    const rest = report.split("\n").slice(1).join("\n").trim();
    const block = capChars(
      [`## ${title}`, "", ...(rest ? [head(rest, REPORT_LINES), ""] : [])].join("\n"),
      MAX_BLOCK_CHARS,
    );
    // +1 for the "\n" join between blocks. Stop before overflowing the budget.
    if (used + block.length + 1 > budget) {
      break;
    }
    blocks.push(block);
    used += block.length + 1;
    shown++;
  }

  const omitted = dirs.length - shown;
  const truncation = omitted > 0 ? omissionNotice(omitted) : "";
  return `${header}\n${blocks.join("\n")}${truncation}${artifactsNote}${footer}`;
}

/** The number of the open issue carrying the label, or undefined when none. */
async function openIssueNumber(run: GhRunner, label: string): Promise<number | undefined> {
  const json = await run([
    "issue",
    "list",
    "--label",
    label,
    "--state",
    "open",
    "--limit",
    "1",
    "--json",
    "number",
  ]);
  const issues = JSON.parse(json) as Array<{ number: number }>;
  return issues[0]?.number;
}

/** The trailing issue number from a `gh issue create` URL, or undefined. */
export function issueNumberFromUrl(url: string): number | undefined {
  const match = url.trim().match(/\/(\d+)\s*$/);
  return match ? Number(match[1]) : undefined;
}

/** A label safe to hand to gh as a positional/flag value and to render into
 * YAML unquoted: plain identifier characters plus spaces and colons, never
 * starting with a dash (gh would parse it as a flag), within GitHub's
 * 50-character label limit. */
export const LABEL_RE = /^[A-Za-z0-9._][A-Za-z0-9._: -]{0,49}$/;

/** Whether the repo already has the label (exact name, case-insensitive,
 * the way GitHub deduplicates labels). */
async function labelExists(run: GhRunner, label: string): Promise<boolean> {
  const json = await run(["label", "list", "--search", label, "--json", "name"]);
  const labels = JSON.parse(json) as Array<{ name: string }>;
  return labels.some((entry) => entry.name.toLowerCase() === label.toLowerCase());
}

/**
 * File the failure: comment on the open labeled issue if one exists, else
 * create a new one. Assignment is left to the caller (auto-assign dispatch).
 * Returns the issue number (existing or newly created) so the caller can
 * dispatch auto-assign at it; undefined only if gh's create URL could not be
 * parsed. `run` is injected so this is testable.
 */
export async function fileIssue(
  run: GhRunner,
  body: string,
  label: string,
  title: string,
): Promise<number | undefined> {
  // Create the label only when it is missing (checked by listing, not by
  // sniffing create-failure messages): creating with --force would silently
  // repaint a pre-existing label the repo owns (someone pointing this at
  // `bug`), and any real create failure must propagate.
  if (!(await labelExists(run, label))) {
    await run([
      "label",
      "create",
      label,
      "--color",
      "B60205",
      "--description",
      "Automated nightly fuzz failure",
    ]);
  }

  const existing = await openIssueNumber(run, label);
  if (existing !== undefined) {
    await run(["issue", "comment", String(existing), "--body", body]);
    console.log(`commented on existing #${existing}`);
    return existing;
  }
  const url = await run(["issue", "create", "--label", label, "--title", title, "--body", body]);
  console.log(`opened ${url.trim()}`);
  return issueNumberFromUrl(url);
}

/**
 * After a green run: comment on and close the open labeled issue, or do
 * nothing when none is open. One green night is only evidence for crashes
 * whose inputs were pinned as regression seeds - the comment says so rather
 * than overclaiming.
 */
export async function resolveIssue(
  run: GhRunner,
  label: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const existing = await openIssueNumber(run, label);
  if (existing === undefined) {
    console.log(`no open ${label} issue to resolve`);
    return;
  }
  const date = new Date().toISOString().slice(0, 10);
  const url = runUrl(env);
  const body = [
    `Nightly fuzz passed on ${date}.${url ? ` Run: ${url}` : ""}`,
    "",
    "Closing. If the crashing inputs reported here were pinned as regression",
    "seeds, this pass replayed them; for anything not pinned, a green night is",
    "weaker evidence, and the next red night opens a fresh issue.",
  ].join("\n");
  await run(["issue", "comment", String(existing), "--body", body]);
  await run(["issue", "close", String(existing), "--reason", "completed"]);
  console.log(`closed #${existing}`);
}

async function main(): Promise<number> {
  const mode = process.env.MODE || "report";
  const label = process.env.LABEL;
  if (!label || !LABEL_RE.test(label)) {
    console.error(
      "error: LABEL is required and must be a plain label (letters, digits, ._:- and spaces; no leading dash)",
    );
    return 1;
  }
  if (mode === "resolve") {
    await resolveIssue(gh, label, process.env);
    return 0;
  }
  if (mode !== "report") {
    console.error(`error: unknown MODE '${mode}' (expected report or resolve)`);
    return 1;
  }
  const artifactsDir = process.env.ARTIFACTS_DIR;
  if (!artifactsDir) {
    console.error("error: ARTIFACTS_DIR is required in report mode");
    return 1;
  }
  const title = process.env.TITLE || "Nightly fuzz failures";
  const dirs = failureDirs(artifactsDir);
  const body = buildBody(dirs, process.env, process.env.ARTIFACT_NAME || "");
  const number = await fileIssue(gh, body, label, title);
  const outputFile = process.env.GITHUB_OUTPUT;
  if (number !== undefined && outputFile) {
    appendFileSync(outputFile, `issue-number=${number}\n`);
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
