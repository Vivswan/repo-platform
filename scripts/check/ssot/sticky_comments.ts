// The sticky-PR-comment scan: every comment anything repo-platform ships
// posts goes through the one pinned action, judged over YAML step lists.

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
import { escapeRegExp, type Mismatch } from "./comparison.ts";
import { readSource, walkFiles } from "./inputs.ts";
import type { Rule } from "./rule_roster.ts";

/** The one action anything repo-platform ships posts PR comments through
 *  (the writer's workflow sources, its own workflows, its composite actions): one
 *  comment per header key per PR, upserted. Headers are
 *  `repo-platform/<host>`, the host being the workflow stem or the action
 *  name, so two posters can never edit each other's comment. */
export const STICKY_COMMENT_ACTION = "marocchino/sticky-pull-request-comment";

const STICKY_PIN_RE = new RegExp(
  `${escapeRegExp(STICKY_COMMENT_ACTION)}@[0-9a-f]{40}["']? # v\\d+\\.\\d+\\.\\d+\\s*$`,
);

/** What a source's sticky steps may do: the hosts its header may name
 *  (exactly one), and whether a step may carry continue-on-error. A
 *  composite action posts under the CALLER's token, which a fork or
 *  Dependabot PR grants no pull-requests write, so its comment is a
 *  convenience sink beside the step summary; a workflow owns its token and
 *  a failed post fails its step. */
export interface StickyScope {
  hosts: readonly string[];
  postMayFail: boolean;
}

/** The workflow stem a writer source lands as, or null for any other
 *  path: `files/<module>/.github/workflows/<stem>[.<variant>].yml`, block
 *  files (`<stem>.yml.block.<value>`) included, since a block is spliced
 *  into the workflow whose name it carries. The stem is the filename up to
 *  its first dot (`auto-assign.codeql.yml` lands as auto-assign.yml). */
export function sourceWorkflowStem(rel: string): string | null {
  const match =
    /^files\/[^/]+\/\.github\/workflows\/([^/.]+)\.[^/]*\.?ya?ml(?:\.block\.[^/]+)?$/.exec(rel);
  return match?.[1] ?? null;
}

/** A source's scope by where it lives: a writer workflow source hosts the
 *  workflow it lands as, a repo-platform workflow itself, and every file of
 *  a composite action the action; anything else hosts nothing, so a sticky
 *  step there has no header it could carry. */
export function stickyScopeOf(rel: string): StickyScope {
  const stem = sourceWorkflowStem(rel);
  if (stem !== null) return { hosts: [stem], postMayFail: false };
  const workflow = /^\.github\/workflows\/([^/]+)\.ya?ml$/.exec(rel)?.[1];
  if (workflow !== undefined) return { hosts: [workflow], postMayFail: false };
  const action = /^actions\/([^/]+)\//.exec(rel)?.[1];
  if (action !== undefined) return { hosts: [action], postMayFail: true };
  return { hosts: [], postMayFail: false };
}

/** A comment line in YAML or TypeScript. */
const COMMENT_LINE_RE = /^\s*(#|\/\/)/;

/** The command lines of a text, each with the 1-based line it starts on:
 *  a line ending in a shell continuation or an open argv list (`\`, `,`,
 *  `[`, `(`) continues on the next, so a `gh pr close \` with `--comment`
 *  below and a formatter's one-element-per-line `["gh",\n"pr",\n"comment"]`
 *  read whole. Blank and comment lines are dropped, and never end a line
 *  they interrupt. */
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

/** The words of one command line as the shell, or the argv array a
 *  script's gh helper prepends `gh` to, delivers them: an Actions
 *  expression or a shell substitution is one word however many spaces it
 *  holds, then whitespace of any width, commas, and brackets split, and
 *  quoting is shed. */
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

/** Where a folded block scalar's value line sits in the source, searched from
 *  `from`: folding joins each paragraph with spaces and keeps more-indented
 *  lines whole, so every value line begins with the text of exactly one
 *  source line of the block (which ends at the first non-blank line indented
 *  less than its first). `line` is that source line, 1-based; `next` is the
 *  index after the last source line the value line consumed (a joined
 *  paragraph or `\` continuation spans several, blank lines included), where
 *  the following value line's search starts. Null when nothing matches. */
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

/** Whether one command line posts a PR comment by hand: `pr comment`
 *  (the leading `gh` optional, a helper may prepend it), `pr close` with
 *  its comment option, or a comments REST route. `gh issue comment` is
 *  not judged: the issue-tracking actions comment on ISSUES by design,
 *  and the number alone cannot tell an issue from a PR. */
export function postsPrComment(words: readonly string[]): boolean {
  if (words.some((word) => PR_COMMENT_ROUTE_RE.test(word))) return true;
  return words.some((word, index) => {
    if (word !== "pr") return false;
    const next = words[index + 1];
    if (next === "comment") return true;
    return next === "close" && words.slice(index + 2).some(isCloseCommentOption);
  });
}

/** A step of a parsed YAML source: the mapping, and the 1-based line of
 *  each node for reporting. */
interface ParsedSteps {
  steps: YAMLMap[];
  lineOf: (node: YamlNode) => number;
}

/** The steps of a YAML text - every mapping carrying `uses` or `run`
 *  inside a sequence, wherever the sequence sits: a workflow's
 *  `jobs.*.steps` or a composite action's `runs.steps`. Null when the
 *  text is not YAML or holds no steps: the scanner then reads it as text. */
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

/** Every string scalar under a node, depth first. */
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

/** One source judged against its scope. YAML step lists (a workflow, a composite
 *  action, a block file) are read as the runner reads them: keys in any order,
 *  `run` as YAML folds it (`>-` is one shell line, `|` one per line), each command
 *  line's words as the shell splits them; anything else is read as command lines
 *  of text. Everywhere: no hand-rolled PR comment; every sticky step pinned
 *  `@<40-hex sha> # vX.Y.Z` (the version comment is text no parser keeps, so that
 *  check is textual) with one `header:` host and, unless the scope allows it, no
 *  continue-on-error; the sticky action in an unparsable source is a mismatch. */
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
      // A literal block's first line is the one after its `|` indicator; a
      // folded block's value lines are looked up in the source, in order.
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
    if (header !== `repo-platform/${hosts[0]}`) {
      flag(
        line,
        `with.header: repo-platform/${hosts[0]}`,
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

/** The rule over every source under files/, .github/workflows/, and
 *  actions/. Throws when no writer workflow source or no sticky step is
 *  present at all: a scan with nothing to judge has lost its anchor. */
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

/** The rules this module contributes to the checker's run (check_ssot.ts). */
export const stickyCommentRules: Rule[] = [
  {
    // Everything repo-platform ships posts PR comments through the sticky
    // action only (stickyCommentMismatches states the shape): every file
    // under the writer's sources, its own workflows, and its composite
    // actions is the scan.
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
