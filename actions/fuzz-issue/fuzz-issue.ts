/**
 * File, update, or resolve a repository's nightly tracking issue.
 * Generalized from github-settings-as-code's file-fuzz-issue.ts: this version
 * knows nothing about any repo's fuzzer - or about fuzzing at all when the
 * stream carries no artifacts. With ARTIFACTS_DIR set it reads failure
 * reports from a directory whose layout is a small contract (docs/fuzzer.md,
 * "failure-report contract v1"): each immediate subdirectory is one failure
 * and carries a report.md whose first line is a `# title` heading and whose
 * body contains the replay command. The producer writes the replay command;
 * this script only assembles the issue. With ARTIFACTS_DIR empty the issue
 * body is a generic nightly-failure report (workflow, date, commit, run
 * link) - the shape the nightly module's plain-CI starter uses.
 *
 * Two modes, selected by MODE:
 * - report: build a body (from the failure reports, or the generic one) and
 *   comment on the open labeled issue, or create it if none is open. One
 *   open issue per label.
 * - resolve: after a green run, comment on and close every open labeled
 *   issue (the release gate blocks on any of them); a silent no-op when
 *   none is open.
 *
 * Configuration from the environment (set by action.yml): MODE, LABEL,
 * TITLE, ARTIFACTS_DIR, ARTIFACT_NAME, LABEL_COLOR, LABEL_DESCRIPTION,
 * STREAM (resolve-comment wording; report bodies key on ARTIFACTS_DIR).
 * Context: GH_TOKEN (gh auth), GITHUB_REPOSITORY (the repo every gh call
 * names via --repo, and part of the run link with GITHUB_SERVER_URL /
 * GITHUB_RUN_ID), GITHUB_WORKFLOW / GITHUB_SHA (the generic body),
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
/** Title for a newly created tracking issue; must match the `title` input
 *  default in action.yml (the test asserts it). */
export const DEFAULT_TITLE = "Nightly fuzz failures";
/** Label tuple used only when report mode has to CREATE the label; each
 *  must match its input default in action.yml (the test asserts it), and
 *  the fuzzer module's settings-labels fragment carries the same values
 *  (check_ssot's labels rule pins that). */
export const DEFAULT_LABEL_COLOR = "B60205";
export const DEFAULT_LABEL_DESCRIPTION = "Automated nightly fuzz failure";

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
 * Truncate `text` to at most `max` characters, appending a marker when cut.
 * The marker is counted, so the return is always <= max.
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

  // Every block (including the first) is character-capped and
  // budget-checked, so no single report can push the body past GitHub's
  // limit and break the filing itself.
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
    // +1 for the "\n" join between blocks.
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

/**
 * The no-artifacts report body: a stream without a failure-report directory
 * (the nightly module's plain-CI starter) gets a generic notice naming the
 * workflow, the date, the failing commit, and the run, and points readers
 * at the run log instead of at artifacts.
 */
export function buildGenericBody(env: NodeJS.ProcessEnv): string {
  const date = new Date().toISOString().slice(0, 10);
  const workflow = env.GITHUB_WORKFLOW ? `\`${env.GITHUB_WORKFLOW}\`` : "The nightly workflow";
  const url = runUrl(env);
  const parts = [
    `${workflow} failed on ${date}.`,
    "",
    "This stream writes no failure reports; the run log names the failing",
    "step(s). Repeat failures update this issue until a green night closes it.",
  ];
  const facts = [
    ...(env.GITHUB_SHA ? [`Commit: ${env.GITHUB_SHA}`] : []),
    ...(url ? [`Run: ${url}`] : []),
  ];
  if (facts.length > 0) {
    parts.push("", ...facts);
  }
  return parts.join("\n");
}

/** gh issue list page size; resolve drains repeated listings, so this only
 * bounds one round trip, not how many issues a green night can close. */
const OPEN_ISSUE_LIMIT = 100;

/** Numbers of the open issues carrying the label (gh's default ordering,
 * newest first); empty when none. Humans can label extra issues into the
 * stream, so one open issue per label is a goal, not an invariant. */
async function openIssueNumbers(
  run: GhRunner,
  repo: string,
  label: string,
  limit: number = OPEN_ISSUE_LIMIT,
): Promise<number[]> {
  // The nightly module's report job runs this action without a checkout,
  // so gh has no working tree to infer a repository from; every invocation
  // names it (same rule as release-health.ts).
  const json = await run([
    "issue",
    "list",
    "--repo",
    repo,
    "--label",
    label,
    "--state",
    "open",
    "--limit",
    String(limit),
    "--json",
    "number",
  ]);
  const issues = JSON.parse(json) as Array<{ number: number }>;
  return issues.map((issue) => issue.number);
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
async function labelExists(run: GhRunner, repo: string, label: string): Promise<boolean> {
  // --search is best-match ordered but not contractually so; a high limit
  // keeps an exact match from hiding past the default 30 in a label-heavy
  // repo (a miss would send fileIssue into a doomed duplicate create).
  const json = await run([
    "label",
    "list",
    "--repo",
    repo,
    "--search",
    label,
    "--limit",
    "1000",
    "--json",
    "name",
  ]);
  const labels = JSON.parse(json) as Array<{ name: string }>;
  return labels.some((entry) => entry.name.toLowerCase() === label.toLowerCase());
}

/**
 * Comment on the open labeled issue if one exists, else create it. Returns
 * the issue number so the caller can dispatch auto-assign at it (assignment
 * never happens here); undefined only when gh's create URL fails to parse.
 */
export async function fileIssue(
  run: GhRunner,
  repo: string,
  body: string,
  label: string,
  title: string,
  labelColor: string = DEFAULT_LABEL_COLOR,
  labelDescription: string = DEFAULT_LABEL_DESCRIPTION,
): Promise<number | undefined> {
  // Create the label only when it is missing (checked by listing, not by
  // sniffing create-failure messages): creating with --force would silently
  // repaint a pre-existing label the repo owns (someone pointing this at
  // `bug`), and any real create failure must propagate.
  if (!(await labelExists(run, repo, label))) {
    await run([
      "label",
      "create",
      label,
      "--repo",
      repo,
      "--color",
      labelColor,
      "--description",
      labelDescription,
    ]);
  }

  const existing = (await openIssueNumbers(run, repo, label, 1))[0];
  if (existing !== undefined) {
    await run(["issue", "comment", String(existing), "--repo", repo, "--body", body]);
    console.log(`commented on existing #${existing}`);
    return existing;
  }
  const url = await run([
    "issue",
    "create",
    "--repo",
    repo,
    "--label",
    label,
    "--title",
    title,
    "--body",
    body,
  ]);
  console.log(`opened ${url.trim()}`);
  return issueNumberFromUrl(url);
}

/** Which nightly stream an issue tracks. Only resolve-comment wording keys
 *  on it (report bodies key on ARTIFACTS_DIR); the default must stay fuzz -
 *  fleet fuzzer starters predate the input and pass nothing. */
export type Stream = "fuzz" | "generic";

/**
 * After a green run: comment on and close every open labeled issue, or do
 * nothing when none is open. Closing all of them matters because the
 * release-health gate blocks while ANY open issue carries the label, so
 * leaving extras open (a human labeling a related issue) would keep
 * releases blocked with a log that says everything was resolved. The
 * fuzz-stream comment (the default - fleet fuzzer starters predate the
 * STREAM input and must keep seeing the exact wording they always got; a
 * test pins it verbatim) hedges on unpinned crashes: one green night is
 * only evidence for inputs pinned as regression seeds. The generic-stream
 * comment carries no fuzz notions.
 */
export async function resolveIssue(
  run: GhRunner,
  repo: string,
  label: string,
  env: NodeJS.ProcessEnv,
  stream: Stream = "fuzz",
): Promise<void> {
  const closed = new Set<number>();
  let page = await openIssueNumbers(run, repo, label);
  if (page.length === 0) {
    console.log(`no open ${label} issue to resolve`);
    return;
  }
  const date = new Date().toISOString().slice(0, 10);
  const url = runUrl(env);
  const body =
    stream === "generic"
      ? [
          `Nightly run passed on ${date}.${url ? ` Run: ${url}` : ""}`,
          "",
          "Closing; the next failing night opens a fresh issue.",
        ].join("\n")
      : [
          `Nightly fuzz passed on ${date}.${url ? ` Run: ${url}` : ""}`,
          "",
          "Closing. If the crashing inputs reported here were pinned as regression",
          "seeds, this pass replayed them; for anything not pinned, a green night is",
          "weaker evidence, and the next red night opens a fresh issue.",
        ].join("\n");
  // One listing is a single page, so drain until the listing comes back
  // empty. A lagging listing can re-serve just-closed issues; retrying a
  // few stale rounds keeps that lag from stranding issues on later pages,
  // while the bound keeps a permanently stale listing from looping forever.
  let staleRounds = 0;
  while (page.length > 0) {
    const fresh = page.filter((number) => !closed.has(number));
    if (fresh.length === 0) {
      staleRounds += 1;
      if (staleRounds >= 3) {
        console.log(
          `::warning::issue listing for '${label}' kept re-serving already-closed issues; ` +
            "some open issues may remain (the next green night retries)",
        );
        break;
      }
    } else {
      staleRounds = 0;
      for (const number of fresh) {
        await run(["issue", "comment", String(number), "--repo", repo, "--body", body]);
        await run(["issue", "close", String(number), "--repo", repo, "--reason", "completed"]);
        closed.add(number);
      }
    }
    page = await openIssueNumbers(run, repo, label);
  }
  console.log(`closed ${[...closed].map((number) => `#${number}`).join(", ")}`);
}

async function main(): Promise<number> {
  const mode = process.env.MODE || "report";
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error("error: GITHUB_REPOSITORY is required");
    return 1;
  }
  const label = process.env.LABEL;
  if (!label || !LABEL_RE.test(label)) {
    console.error(
      "error: LABEL is required and must be a plain label (letters, digits, ._:- and spaces; no leading dash)",
    );
    return 1;
  }
  // Validated in every mode, symmetric with MODE itself; only resolve
  // wording consumes it (report bodies key on ARTIFACTS_DIR).
  const stream = process.env.STREAM || "fuzz";
  if (stream !== "fuzz" && stream !== "generic") {
    console.error(`error: unknown STREAM '${stream}' (expected fuzz or generic)`);
    return 1;
  }
  if (mode === "resolve") {
    await resolveIssue(gh, repo, label, process.env, stream);
    return 0;
  }
  if (mode !== "report") {
    console.error(`error: unknown MODE '${mode}' (expected report or resolve)`);
    return 1;
  }
  const title = process.env.TITLE || DEFAULT_TITLE;
  // An artifacts directory means the fuzz stream's failure-report contract;
  // without one the stream is plain nightly CI and gets the generic body.
  const artifactsDir = process.env.ARTIFACTS_DIR;
  const body = artifactsDir
    ? buildBody(failureDirs(artifactsDir), process.env, process.env.ARTIFACT_NAME || "")
    : buildGenericBody(process.env);
  const number = await fileIssue(
    gh,
    repo,
    body,
    label,
    title,
    process.env.LABEL_COLOR || DEFAULT_LABEL_COLOR,
    process.env.LABEL_DESCRIPTION || DEFAULT_LABEL_DESCRIPTION,
  );
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
