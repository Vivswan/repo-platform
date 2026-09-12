/**
 * Knows nothing about any repo's fuzzer: the producer writes the replay command and this script only assembles the issue.
 * The failure-report layout it reads is the contract in docs/fuzzer.md ("The failure-report contract (v1)").
 */

import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const REPORT_LINES = 60;
/** GitHub caps an issue or comment body at 65,536 characters; stay comfortably under it. */
const MAX_BODY = 60_000;
/** Small enough that the header, footer, notice, and one full block always fit inside MAX_BODY. */
const MAX_BLOCK_CHARS = 8_000;
/** Contract v1: failure directory names are plain identifiers. */
const DIR_NAME = /^[A-Za-z0-9._-]+$/;
/** Must match the `title` input default in action.yml (the test asserts it). */
export const DEFAULT_TITLE = "Nightly fuzz failures";
/** Each must match its input default in action.yml (the test asserts it)
 *  and the fuzzer module's tracking_label in files.yml (the labels ssot rule pins it). */
export const DEFAULT_LABEL_COLOR = "B60205";
export const DEFAULT_LABEL_DESCRIPTION = "Automated nightly fuzz failure";

/** Runs a `gh` subcommand and returns stdout; throws on a non-zero exit. */
export type GhRunner = (args: string[]) => Promise<string>;

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
 * The first line is kept even when it alone overflows `chars`: capChars cuts an unbreakable line, and a block must never lose all its content.
 * A single trailing newline is not a line, so text of exactly `lines` lines plus a trailing newline is returned whole.
 */
export function head(text: string, lines: number, chars: number): string {
  const all = text.split("\n");
  if (all.length > 0 && all[all.length - 1] === "") {
    all.pop();
  }
  if (all.length <= lines && all.join("\n").length <= chars) {
    return text.trimEnd();
  }
  const marker = (cut: number) => `\n... (${cut} more lines)`;
  // Reserved at the largest count it can name, so the marker never overflows.
  const reserve = marker(all.length).length;
  const kept: string[] = [];
  let used = 0;
  for (const line of all) {
    const next = used + line.length + (kept.length > 0 ? 1 : 0);
    if (kept.length >= lines || (kept.length > 0 && next + reserve > chars)) {
      break;
    }
    kept.push(line);
    used = next;
  }
  return `${kept.join("\n")}${marker(all.length - kept.length)}`;
}

export function capChars(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const marker = "\n... (truncated)";
  const keep = Math.max(0, max - marker.length);
  return text.slice(0, keep) + marker;
}

export function runUrl(env: NodeJS.ProcessEnv): string {
  const server = env.GITHUB_SERVER_URL;
  const repo = env.GITHUB_REPOSITORY;
  const runId = env.GITHUB_RUN_ID;
  if (!server || !repo || !runId) {
    return "";
  }
  return `${server}/${repo}/actions/runs/${runId}`;
}

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

/** The default must stay fuzz: fleet fuzzer starters predate the input and pass nothing. */
export type Stream = "fuzz" | "generic";

const BODY_WORDS: Record<
  Stream,
  {
    run: string;
    report: string;
    artifacts: string;
    artifactsDetail: string;
    noReport: string[];
  }
> = {
  fuzz: {
    run: "Nightly fuzz run",
    report: "failure report",
    artifacts: "failure artifacts",
    artifactsDetail: " (crashing inputs, logs)",
    noReport: [
      "Nothing wrote a report: the failure may sit outside the fuzz step",
      "(setup, cache, artifact upload), or the fuzzer died before it could",
      "write one. See the run log.",
    ],
  },
  generic: {
    run: "Nightly run",
    report: "report",
    artifacts: "reports",
    artifactsDetail: "",
    noReport: [
      "Nothing wrote a report: the failure may sit outside the reporting step",
      "(setup, cache, artifact upload), or the producer died before it could",
      "write one. See the run log.",
    ],
  },
};

export function buildBody(
  dirs: string[],
  env: NodeJS.ProcessEnv,
  artifactName: string,
  stream: Stream = "fuzz",
): string {
  const words = BODY_WORDS[stream];
  const date = new Date().toISOString().slice(0, 10);
  const url = runUrl(env);
  if (dirs.length === 0) {
    const parts = [
      `${words.run} on ${date} failed with no ${words.report}.`,
      "",
      ...words.noReport,
    ];
    if (url) {
      parts.push("", `Run: ${url}`);
    }
    return parts.join("\n");
  }

  const header = `${words.run} on ${date} produced ${dirs.length} ${words.report}(s).\n`;
  const footer = url ? `\nRun: ${url}` : "";
  // Without an artifact the body is the only record, so every report rides whole, cut only at its share of the body limit.
  const summary = artifactName !== "";
  const artifactsNote = summary
    ? `\nThe full ${words.artifacts}${words.artifactsDetail} are attached to the run as \`${artifactName}\`.`
    : "";
  // Reserved up front at its largest count, whether or not it is shown.
  const omissionNotice = (count: number) =>
    `\n${count} more ${words.report}(s) omitted to stay under the GitHub body limit${summary ? "; see the attached artifacts" : ""}.`;
  const noticeReserve = omissionNotice(dirs.length).length;

  // Every block (including the first) is character-capped and
  // budget-checked, so no single report can push the body past GitHub's
  // limit and break the filing itself.
  const budget = MAX_BODY - header.length - footer.length - artifactsNote.length - noticeReserve;
  const lineCap = summary ? REPORT_LINES : Number.POSITIVE_INFINITY;
  // Each report's share of the budget, never below the summary cap: many
  // small reports keep their content and the omission notice counts the rest.
  // -1 for the "\n" join between blocks.
  const blockCap = summary
    ? MAX_BLOCK_CHARS
    : Math.max(MAX_BLOCK_CHARS, Math.floor(budget / dirs.length) - 1);
  const blocks: string[] = [];
  let used = 0;
  let shown = 0;
  for (const dir of dirs) {
    const reportPath = join(dir, "report.md");
    const report = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
    const heading = `## ${blockTitle(dir, report)}\n`;
    // The contract asks producers to keep the replay block near the top: only the head survives when an artifact carries the rest.
    const rest = report.split("\n").slice(1).join("\n").trim();
    const block = capChars(
      rest ? `${heading}\n${head(rest, lineCap, blockCap - heading.length - 2)}\n` : heading,
      blockCap,
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

/** gh lists newest first, so fileIssue's limit-1 read is the newest open issue.
 * Humans can label extra issues into the stream, so one open issue per label is a goal, not an invariant. */
async function openIssues(
  run: GhRunner,
  repo: string,
  label: string,
  limit: number = OPEN_ISSUE_LIMIT,
): Promise<Array<{ number: number; assignees: Array<{ login: string }> }>> {
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
    "number,assignees",
  ]);
  return JSON.parse(json) as Array<{ number: number; assignees: Array<{ login: string }> }>;
}

/**
 * An issue created with a workflow token fires no issues:opened event, so the auto-assign module cannot catch it.
 * An org owner is not assignable, and the nightly pipeline must not gain a failure path over assignment,
 * so a failed assignment logs a notice and the filing stands.
 */
export async function assignOwner(run: GhRunner, repo: string, issueNumber: number): Promise<void> {
  const owner = repo.split("/")[0];
  try {
    await run(["issue", "edit", String(issueNumber), "--repo", repo, "--add-assignee", owner]);
    console.log(`assigned @${owner} to #${issueNumber}`);
  } catch {
    console.log(
      `::notice::could not assign @${owner} to #${issueNumber} (best-effort: an org owner is not assignable); the issue filing itself succeeded`,
    );
  }
}

export function issueNumberFromUrl(url: string): number | undefined {
  const match = url.trim().match(/\/(\d+)\s*$/);
  return match ? Number(match[1]) : undefined;
}

/** No leading dash (gh would parse it as a flag), within GitHub's 50-character label limit.
 * Hand-copied into actions/plan/registration.ts and actions/release-health/release-health.ts; the tracking-label-regex ssot rule pins the copies. */
export const LABEL_RE = /^[A-Za-z0-9._][A-Za-z0-9._: -]{0,49}$/;

/** Case-insensitive, the way GitHub deduplicates labels. */
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

/** An already-assigned open issue is left alone: a human may have deliberately reassigned it. */
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

  const existing = (await openIssues(run, repo, label, 1))[0];
  if (existing !== undefined) {
    await run(["issue", "comment", String(existing.number), "--repo", repo, "--body", body]);
    console.log(`commented on existing #${existing.number}`);
    if (existing.assignees.length === 0) {
      await assignOwner(run, repo, existing.number);
    }
    return existing.number;
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
  const number = issueNumberFromUrl(url);
  if (number !== undefined) {
    await assignOwner(run, repo, number);
  } else {
    // Same best-effort rule as a failed assignment: the filing succeeded,
    // so an unparsable create URL must not become a failure - but it must
    // not be silent either (the issue stays unassigned and the caller's
    // issue-number output stays empty).
    console.log(
      "::notice::could not parse the created issue's number from gh's create URL; owner assignment skipped",
    );
  }
  return number;
}

/**
 * Every open labeled issue is closed: the release-health gate blocks while any carries the label, so one left open
 * (a human labeling a related issue) would keep releases blocked under a log saying all was resolved.
 * The fuzz wording hedges on unpinned crashes, which one green night cannot prove; a test pins it for the fleet fuzzer starters that pass no STREAM.
 */
export async function resolveIssue(
  run: GhRunner,
  repo: string,
  label: string,
  env: NodeJS.ProcessEnv,
  stream: Stream = "fuzz",
): Promise<void> {
  const closed = new Set<number>();
  let page = (await openIssues(run, repo, label)).map((issue) => issue.number);
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
    page = (await openIssues(run, repo, label)).map((issue) => issue.number);
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
  // Validated in every mode, symmetric with MODE itself.
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
  const artifactsDir = process.env.ARTIFACTS_DIR;
  const body = artifactsDir
    ? buildBody(failureDirs(artifactsDir), process.env, process.env.ARTIFACT_NAME || "", stream)
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
