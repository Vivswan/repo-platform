import {
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  type Scalar,
  type YAMLMap,
  type Node as YamlNode,
} from "yaml";
import { stickyCommentHeader } from "../../../actions/shared/platform.ts";
import { escapeRegExp, type Mismatch } from "./comparison.ts";
import { readSource, walkFiles } from "./inputs.ts";
import type { Rule } from "./rule_roster.ts";

export const STICKY_COMMENT_ACTION = "marocchino/sticky-pull-request-comment";

const STICKY_PIN_RE = new RegExp(
  `${escapeRegExp(STICKY_COMMENT_ACTION)}@[0-9a-f]{40}["']? # v\\d+\\.\\d+\\.\\d+\\s*$`,
);

/** A composite action posts under the CALLER's token, which a fork or Dependabot PR grants no pull-requests write,
 *  so its post may fail; a workflow owns its token and a failed post fails its step. */
export interface StickyScope {
  hosts: readonly string[];
  postMayFail: boolean;
}

/** A block file (`<stem>.block.<value>.yml`) counts too: it is spliced into the workflow whose name it carries.
 *    files/base/.github/workflows/auto-assign.codeql.yml -> auto-assign */
export function sourceWorkflowStem(rel: string): string | null {
  const match = /^files\/[^/]+\/\.github\/workflows\/([^/.]+)[^/]*\.ya?ml$/.exec(rel);
  return match?.[1] ?? null;
}

export function stickyScopeOf(rel: string): StickyScope {
  const stem = sourceWorkflowStem(rel);
  if (stem !== null) return { hosts: [stem], postMayFail: false };
  const workflow = /^\.github\/workflows\/([^/]+)\.ya?ml$/.exec(rel)?.[1];
  if (workflow !== undefined) return { hosts: [workflow], postMayFail: false };
  const action = /^actions\/([^/]+)\//.exec(rel)?.[1];
  if (action !== undefined) return { hosts: [action], postMayFail: true };
  return { hosts: [], postMayFail: false };
}

const COMMENT_LINE_RE = /^\s*(#|\/\/)/;

/** A line ending in `\`, `,`, `[`, or `(` continues on the next, so `gh pr close \` with `--comment` below
 *  and a formatter's one-element-per-line `["gh",\n"pr",\n"comment"]` read whole. */
export function commandLines(text: string): { line: number; text: string }[] {
  const commands: { line: number; text: string }[] = [];
  let open: { line: number; text: string } | null = null;
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (line === "" || COMMENT_LINE_RE.test(line)) continue;
    if (open === null) {
      open = { line: index + 1, text: line };
      commands.push(open);
    } else {
      open.text = `${open.text} ${line}`;
    }
    if (!/[\\,[(]$/.test(open.text)) open = null;
  }
  return commands;
}

export function shellWords(command: string): string[] {
  // A substitution's body is a command line of its own, scanned after the
  // outer words; the outer line sees it as one word.
  const substituted: string[] = [];
  const outer = command
    .replace(/\$\{\{[^}]*\}\}/g, "$EXPR")
    .replace(/\$\(([^()]*)\)/g, (_whole, body: string) => {
      substituted.push(body);
      return "$EXPR";
    });
  const words = outer
    .split(/[\s,()[\]]+/)
    .map((word) => word.replace(/^["'`]+|["'`;]+$/g, ""))
    .filter((word) => word !== "" && word !== "\\");
  return [...words, ...substituted.flatMap(shellWords)];
}

/** YAML folding joins each paragraph with spaces and keeps more-indented lines whole,
 *  so every value line begins with the text of exactly one source line of the block. */
export function foldedSourceLine(
  lines: readonly string[],
  indicatorLine: number,
  valueLine: string,
  from = indicatorLine,
): { line: number; next: number } | null {
  let blockIndent = -1;
  for (let index = indicatorLine; index < lines.length; index += 1) {
    const text = lines[index].trim();
    if (text === "") continue;
    const indent = lines[index].length - lines[index].trimStart().length;
    if (blockIndent === -1) blockIndent = indent;
    if (indent < blockIndent) break;
    if (index < from || !valueLine.startsWith(text)) continue;
    let rest = valueLine.slice(text.length).trimStart();
    let next = index + 1;
    while (next < lines.length && rest !== "") {
      const following = lines[next].trim();
      if (following !== "" && !rest.startsWith(following)) break;
      rest = rest.slice(following.length).trimStart();
      next += 1;
    }
    return { line: index + 1, next };
  }
  return null;
}

/** The REST routes PR comments ride: an issue's comments (list, create)
 *  and one comment by id (edit, delete). */
const PR_COMMENT_ROUTE_RE = /\/issues\/(?:[^/\s]+\/)?comments\b/;

/** `gh pr close`'s comment option in every spelling gh accepts: long,
 *  long with `=`, short, short in a cluster (`-dc`), short with `=`. */
const isCloseCommentOption = (word: string): boolean =>
  word === "--comment" || word.startsWith("--comment=") || /^-[a-zA-Z]*c[a-zA-Z]*(=|$)/.test(word);

/** `gh issue comment` is not judged: the issue-tracking actions comment on issues by design, and the number alone cannot tell an issue from a PR.
 *  The leading `gh` is optional: a script's helper may prepend it. */
export function postsPrComment(words: readonly string[]): boolean {
  if (words.some((word) => PR_COMMENT_ROUTE_RE.test(word))) return true;
  return words.some((word, index) => {
    if (word !== "pr") return false;
    const next = words[index + 1];
    if (next === "comment") return true;
    return next === "close" && words.slice(index + 2).some(isCloseCommentOption);
  });
}

interface ParsedSteps {
  steps: YAMLMap[];
  lineOf: (node: YamlNode) => number;
}

export function parsedSteps(text: string): ParsedSteps | null {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  if (doc.errors.length > 0) return null;
  const steps: YAMLMap[] = [];
  const visit = (node: unknown): void => {
    if (isSeq(node)) {
      for (const item of node.items) {
        if (isMap(item) && (item.has("uses") || item.has("run"))) steps.push(item);
        else visit(item);
      }
    } else if (isMap(node)) {
      for (const pair of node.items) visit(pair.value);
    }
  };
  visit(doc.contents);
  if (steps.length === 0) return null;
  return { steps, lineOf: (node) => lineCounter.linePos(node.range?.[0] ?? 0).line };
}

function stringScalars(node: unknown, out: Scalar<string>[] = []): Scalar<string>[] {
  if (isScalar(node)) {
    if (typeof node.value === "string") out.push(node as Scalar<string>);
  } else if (isMap(node)) {
    for (const pair of node.items) stringScalars(pair.value, out);
  } else if (isSeq(node)) {
    for (const item of node.items) stringScalars(item, out);
  }
  return out;
}

export function stickyCommentMismatches(
  rel: string,
  text: string,
  scope: StickyScope,
): { mismatches: Mismatch[]; stickySteps: number } {
  const { hosts } = scope;
  const lines = text.split("\n");
  const mismatches: Mismatch[] = [];
  const flag = (line: number, expected: string, got: string) =>
    mismatches.push({ file: `${rel}:${line}`, expected, got });
  const handRolled = (line: number, command: string) =>
    flag(line, `a ${STICKY_COMMENT_ACTION} step (one comment per PR, upserted)`, command);
  const namesAction = (line: string) =>
    !COMMENT_LINE_RE.test(line) && line.includes(`${STICKY_COMMENT_ACTION}@`);
  for (const [index, line] of lines.entries()) {
    if (namesAction(line) && !STICKY_PIN_RE.test(line)) {
      flag(
        index + 1,
        `${STICKY_COMMENT_ACTION}@<full 40-hex commit sha> # v<major>.<minor>.<patch>`,
        line.trim(),
      );
    }
  }
  const parsed = parsedSteps(text);
  if (parsed === null) {
    for (const command of commandLines(text)) {
      if (postsPrComment(shellWords(command.text))) handRolled(command.line, command.text);
    }
    const stray = lines.findIndex(namesAction);
    if (stray !== -1) {
      flag(
        stray + 1,
        "the sticky action used by a step in a parseable YAML step list (workflow, composite action, or block file)",
        "the sticky action named in a source with no parseable steps",
      );
    }
    return { mismatches, stickySteps: 0 };
  }
  let stickySteps = 0;
  for (const step of parsed.steps) {
    for (const scalar of stringScalars(step)) {
      // lineOf(scalar) is the block indicator's line, so a literal block's first content line is one below;
      // a folded block's lines are looked up in the source.
      const indicator = parsed.lineOf(scalar);
      const first = indicator + (scalar.type === "BLOCK_LITERAL" ? 1 : 0);
      let cursor = indicator;
      for (const command of commandLines(scalar.value)) {
        let line = first + command.line - 1;
        if (scalar.type === "BLOCK_FOLDED") {
          const found = foldedSourceLine(lines, indicator, command.text, cursor);
          if (found !== null) {
            line = found.line;
            cursor = found.next;
          }
        }
        if (postsPrComment(shellWords(command.text))) handRolled(line, command.text);
      }
    }
    const uses = step.get("uses", true);
    if (!isScalar(uses) || !String(uses.value).includes(`${STICKY_COMMENT_ACTION}@`)) continue;
    stickySteps += 1;
    const line = parsed.lineOf(uses);
    if (hosts.length !== 1) {
      flag(
        line,
        "a source with exactly one host workflow or action (the header names it)",
        `${hosts.length} hosts (${hosts.join(", ")})`,
      );
      continue;
    }
    const inputs = step.get("with");
    const header = isMap(inputs) ? inputs.get("header") : undefined;
    if (header !== stickyCommentHeader(hosts[0])) {
      flag(
        line,
        `with.header: ${stickyCommentHeader(hosts[0])}`,
        typeof header === "string" && header !== ""
          ? `with.header: ${header}`
          : "no header: on the step",
      );
    }
    if (
      !scope.postMayFail &&
      step.has("continue-on-error") &&
      step.get("continue-on-error") !== false
    ) {
      flag(
        line,
        "no continue-on-error on the step (a workflow owns its token; a failed post fails the step)",
        "continue-on-error set",
      );
    }
  }
  return { mismatches, stickySteps };
}

export function stickyTreeMismatches(sources: [rel: string, text: string][]): Mismatch[] {
  if (!sources.some(([rel]) => sourceWorkflowStem(rel) !== null)) {
    throw new Error("no writer workflow sources found - anchor lost");
  }
  const judged = sources.map(([rel, text]) =>
    stickyCommentMismatches(rel, text, stickyScopeOf(rel)),
  );
  if (judged.every((j) => j.stickySteps === 0)) {
    throw new Error(`no ${STICKY_COMMENT_ACTION} step in any source - anchor lost`);
  }
  return judged.flatMap((j) => j.mismatches);
}

export const stickyCommentRules: Rule[] = [
  {
    name: "sticky-pr-comments",
    run: () =>
      stickyTreeMismatches(
        ["files", ".github/workflows", "actions"]
          .flatMap((root) => walkFiles(root))
          .filter((f) => !f.symlink)
          .map((f) => [f.path, readSource(f.path)]),
      ),
  },
];
