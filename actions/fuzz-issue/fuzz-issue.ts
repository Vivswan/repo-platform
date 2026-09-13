/**
 * Assembles the text the composite sends on - the issue body to the stock issue action (report mode) or the close comment to gh (resolve mode) -
 * into a file under RUNNER_TEMP named by the `file` output; the gh and issue plumbing is action.yml's.
 * Knows nothing about any repo's fuzzer: the producer writes the replay command, and the failure-report layout it reads
 * is the contract in docs/fuzzer.md ("The failure-report contract (v1)").
 */

import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

const REPORT_LINES = 60;
/** GitHub caps an issue or comment body at 65,536 characters; stay comfortably under it. */
const MAX_BODY = 60_000;
/** Small enough that the header, footer, notice, and one full block always fit inside MAX_BODY. */
const MAX_BLOCK_CHARS = 8_000;
/** Contract v1: failure directory names are plain identifiers. */
const DIR_NAME = /^[A-Za-z0-9._-]+$/;

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
  stream: Stream,
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

/** The fuzz wording hedges on unpinned crashes, which one green night cannot prove. */
export function closeComment(env: NodeJS.ProcessEnv, stream: Stream): string {
  const date = new Date().toISOString().slice(0, 10);
  const url = runUrl(env);
  const run = url ? ` Run: ${url}` : "";
  return stream === "generic"
    ? [
        `Nightly run passed on ${date}.${run}`,
        "",
        "Closing; the next failing night opens a fresh issue.",
      ].join("\n")
    : [
        `Nightly fuzz passed on ${date}.${run}`,
        "",
        "Closing. If the crashing inputs reported here were pinned as regression",
        "seeds, this pass replayed them; for anything not pinned, a green night is",
        "weaker evidence, and the next red night opens a fresh issue.",
      ].join("\n");
}

/** A composite's `required: true` only documents: the runner passes an empty string for an omitted input. */
function requireInput(variable: string, input: string): string {
  const value = process.env[variable];
  if (!value) throw new Error(`the ${input} input is required`);
  return value;
}

/** Consumed by action.yml's label and issue steps like the label itself, checked here before anything is filed. */
const REPORT_INPUTS = [
  ["TITLE", "title"],
  ["LABEL_COLOR", "label-color"],
  ["LABEL_DESCRIPTION", "label-description"],
] as const;

function main(): void {
  const mode = requireInput("MODE", "mode");
  if (mode !== "report" && mode !== "resolve") {
    throw new Error(`unknown MODE '${mode}' (expected report or resolve)`);
  }
  requireInput("LABEL", "label");
  const stream = requireInput("STREAM", "stream");
  if (stream !== "fuzz" && stream !== "generic") {
    throw new Error(`unknown STREAM '${stream}' (expected fuzz or generic)`);
  }
  const runnerTemp = process.env.RUNNER_TEMP;
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!runnerTemp || !outputFile) {
    throw new Error("RUNNER_TEMP and GITHUB_OUTPUT are required (the runner sets both)");
  }
  const artifactsDir = process.env.ARTIFACTS_DIR;
  let text: string;
  if (mode === "resolve") {
    text = closeComment(process.env, stream);
  } else {
    for (const [variable, input] of REPORT_INPUTS) requireInput(variable, input);
    text = artifactsDir
      ? buildBody(failureDirs(artifactsDir), process.env, process.env.ARTIFACT_NAME || "", stream)
      : buildGenericBody(process.env);
  }
  // A fresh directory per run: one job can run the action once per stream.
  const file = join(mkdtempSync(join(runnerTemp, "fuzz-issue-")), `${mode}.md`);
  writeFileSync(file, text);
  appendFileSync(outputFile, `file=${file}\n`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
