#!/usr/bin/env bun
// Single-source-of-truth drift checker: facts this repo intentionally states
// in more than one INDEPENDENTLY-authored place (the
// hand-written module-roster sites, dogfooded template counterparts,
// settings/label rosters, doc-quoted constants) are compared here so drift
// fails CI instead of rotting silently. Copies GENERATED from the module
// manifests (copier.yml's regions, KNOWN_MODULES, the docs regions, the
// dogfood copies) are NOT compared here: `bun run generate:check` and
// `bun run dogfood:check` prove the generators ran, and re-checking
// generator output against generator input would pass vacuously.
//
// Structure: a flat list of named rules, each returning mismatches. Every
// grep-shaped extraction goes through mustMatch(), so a rule whose anchor
// text disappears fails loudly instead of passing vacuously; structure
// pulled out of TypeScript SOURCES (pinned consts, argv arrays, spawn and
// stream-write call shapes) is read from the AST via scripts/ts_extract.ts
// under the same loud-anchor contract, so a comment, string, or template
// decoy can neither satisfy an anchor nor hide the real declaration.
// Template
// (.jinja) inputs are compared modulo jinja via normalizeJinja() (from
// scripts/jinja_subset.ts, shared with scripts/render_dogfood.ts);
// recorded, intentional divergences live in RECORDED_DIVERGENCES with a
// reason.
//
// Usage:
//   bun scripts/check_ssot.ts   # prints "rule: file -> expected X, got Y"
//                               # lines and exits 1 on any mismatch

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type CallExpression,
  type Expression,
  Node,
  type PropertyAccessExpression,
  SyntaxKind,
} from "ts-morph";
import { parse as parseYaml } from "yaml";
import { EXCLUDED_DIRS as EXCLUDED_ACTION_DIRS } from "../.github/scripts/build-branches/branch_tree.ts";
import {
  identityKeyIssues,
  loadOverrideLayer,
} from "../.github/scripts/fleet/merge_settings_layers.ts";
import { allLayerLabels, loadLayer } from "../.github/scripts/fleet/render_managed_settings.ts";
import { CHECK_NAME } from "../.github/scripts/shared/all_green.ts";
import { capture } from "../.github/scripts/shared/proc.ts";
import { stageComposedTreeArgv } from "../.github/scripts/shared/stage_tree.ts";
import { captureName } from "../.github/scripts/sync/run_hidden.ts";
import { PIN_FLIPS } from "../.github/scripts/sync/starter_pin_rollout.ts";
import { TOOLCHAIN_SETUP_FRAGMENT, TOOLCHAIN_SETUP_TARGETS } from "./compose_template.ts";
import { MARKER_TOKENS, trackingStreams } from "./generate.ts";
import { type JinjaVars, normalizeJinja, placeholderJinja } from "./jinja_subset.ts";
import { loadManifests as loadManifestsFresh, type ModuleManifest } from "./module_manifests.ts";
import { landedPathAndGates, loadBaseOwnership } from "./ownership.ts";
import { ANSWERS_FILE, parseAnswers } from "./render_dogfood.ts";
import {
  argvFlagLeads,
  argvStringAfter,
  constNumberValue,
  constRegexSource,
  constStringValue,
  intersectionCarriesType,
  literalMatches,
  parseTs,
  propertyAssignmentCarries,
  rootIdentifier,
  syntaxErrorCount,
  templateCarries,
  unwrapExpression,
  wrappedArgvLabels,
} from "./ts_extract.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

export interface Mismatch {
  file: string;
  expected: string;
  got: string;
}

interface Rule {
  /** Typed as the roster union, so an unrostered name is a tsc error
   *  before it is a runtime mismatch (an unrepresentable invalid state
   *  for typechecked edits); ruleRosterMismatches still owns dropped and
   *  duplicated rules at run time. */
  name: (typeof RULE_ROSTER)[number];
  run: () => Mismatch[];
}

// Intentional, recorded divergences between a repo file and its templates/
// counterpart. A divergence means exactly one thing: the OPERATOR copy
// carries a line the template lacks. Each entry excuses, from the operator
// side only, AT MOST ONE line matching `skip` sitting immediately before a
// line matching `before` (both matched against trimmed lines, after
// semanticLines dropped comments and blanks): a second copy, or the same
// line migrated elsewhere, still mismatches. A template side that carries
// the same anchored line makes the entry stale - reported, with nothing
// excused - so the excuse can never mask the template catching up. Honored
// only by the semantic-mode dogfood-parity pairs - the prefix-mode pairs
// compare their template prefix verbatim and cannot skip lines - and
// subset rules already tolerate repo-side additions without an entry.
// Every entry must say why the divergence is deliberate; an entry that
// excused nothing anywhere is reported as stale.
export const RECORDED_DIVERGENCES: {
  file: string;
  reason: string;
  skip: RegExp;
  before: RegExp;
}[] = [];

// Actions allowed to be pinned at more than one ref, with the full expected
// ref set. Record any intentional split here with a comment. Empty since
// the delivery channels converged on the one green-gated `build` ref.
export const ALLOWED_MULTI_REFS: Record<string, string[]> = {};

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf-8");
}

interface WorkflowStep {
  id?: string;
  name?: string;
  uses?: string;
  if?: string;
}

/** Every step of every job in a workflow, parsed. Rules about step
 *  conditions read this rather than the file's text: a matching string in
 *  a comment, or on some other step, must not satisfy them. */
function workflowSteps(rel: string): WorkflowStep[] {
  const doc = asRecord(parseYaml(read(rel)), rel);
  const jobs = asRecord(doc.jobs ?? {}, `${rel} jobs`);
  const steps: WorkflowStep[] = [];
  for (const job of Object.values(jobs)) {
    const list = asRecord(job ?? {}, `${rel} job`).steps;
    if (!Array.isArray(list)) continue;
    for (const step of list) steps.push(asRecord(step, `${rel} step`) as WorkflowStep);
  }
  return steps;
}

/** The unsafe term of a step condition, or null when every term is safe.
 *  A step that did not run publishes an EMPTY output, so a test that an
 *  absent output can SATISFY - `!= 'true'`, `!x`, `== ''`, `== false` -
 *  opens the gate exactly when the step it guards on never happened.
 *  Rather than enumerate those shapes, this admits only the one that
 *  cannot: equality against a non-empty literal. Terms that mention no
 *  step output (`success()`, `env.X != ''`, `needs.*`) are not this
 *  hazard - a failed dependency blocks the job outright - and pass. */
export function unsafeStepCondition(condition: string): string | null {
  const OUTPUT = /steps\.[\w-]+\.outputs\./;
  if (!OUTPUT.test(condition)) return null;
  // A negated GROUP inverts terms this check reads term by term, so it
  // cannot be proven safe here. `!cancelled()` and friends do not match:
  // the parenthesis has to follow the `!` directly.
  if (/!\s*\(/.test(condition)) return `a negated group: ${condition.trim()}`;
  for (const raw of condition.split(/&&|\|\|/)) {
    const term = raw.replaceAll(/[()]/g, "").trim();
    if (!OUTPUT.test(term)) continue;
    if (!/^steps\.[\w-]+\.outputs\.[\w-]+ == '[^']+'$/.test(term)) return term;
  }
  return null;
}

/** A markdown doc with its generated regions removed (and how many), so a
 *  doc-quoted constant must live in HAND prose to satisfy a rule: a value
 *  inside a generated region has the manifests as its author
 *  (generate:check polices those). The marker grammar is built from
 *  scripts/generate.ts's MARKER_TOKENS, so renaming the marker text there
 *  cannot leave this stripper matching nothing. Markers are parsed
 *  pairwise - a duplicate BEGIN, a mismatched name, a dangling END, or an
 *  unclosed region all throw. */
export function stripGeneratedRegions(
  text: string,
  where: string,
): { prose: string; regions: number } {
  const marker = new RegExp(
    `<!-- (${MARKER_TOKENS.begin}|${MARKER_TOKENS.end}) ([a-z0-9-]+)[^>]*-->`,
    "g",
  );
  let out = "";
  let cursor = 0;
  let regions = 0;
  let open: { name: string; at: number } | null = null;
  for (const match of text.matchAll(marker)) {
    const [full, kind, name] = match;
    if (kind === MARKER_TOKENS.begin) {
      if (open) {
        throw new Error(
          `${where}: generated region '${open.name}' is still open where '${name}' begins`,
        );
      }
      open = { name, at: match.index };
      out += text.slice(cursor, match.index);
      cursor = match.index;
    } else {
      if (!open) throw new Error(`${where}: END marker for '${name}' has no matching BEGIN`);
      if (open.name !== name) {
        throw new Error(`${where}: region '${open.name}' is closed by END '${name}'`);
      }
      open = null;
      regions++;
      cursor = match.index + full.length;
    }
  }
  if (open) throw new Error(`${where}: generated region '${open.name}' is never closed`);
  out += text.slice(cursor);
  if (out.includes(MARKER_TOKENS.begin) || out.includes(MARKER_TOKENS.end)) {
    throw new Error(`${where}: malformed generated-region markers remain after stripping`);
  }
  return { prose: out, regions };
}

// The docs generate.ts targets with markdown regions. A strip over one of
// these that removes nothing means the marker grammar drifted and every
// stripped-prose rule is silently checking unstripped text.
const DOCS_WITH_REGIONS = new Set([
  "README.md",
  "docs/new-repo.md",
  "docs/settings.md",
  "docs/pages.md",
]);

function handProse(rel: string): string {
  const { prose, regions } = stripGeneratedRegions(read(rel), rel);
  if (regions === 0 && DOCS_WITH_REGIONS.has(rel)) {
    throw new Error(
      `${rel}: stripping removed no generated regions from a doc known to ` +
        "carry them - the marker grammar drifted from scripts/generate.ts",
    );
  }
  return prose;
}

/** Anchor extraction that fails loudly: a missing match means the fact this
 *  rule keys on moved or was deleted, which must never pass silently. */
export function mustMatch(text: string, re: RegExp, where: string, what: string): RegExpExecArray {
  const match = re.exec(text);
  if (!match) throw new Error(`${where}: anchor for ${what} not found (pattern ${re})`);
  return match;
}

/** The all-green-name rule's text anchors into executable YAML wiring,
 *  exported so the suite can prove BOTH directions on the exact patterns
 *  the rule runs. Line-anchored (^\s*...): a commented-out copy of the
 *  wiring starts its line with the comment marker, which the anchor
 *  rejects - dead wiring must never satisfy the rule. (The TS-source
 *  anchors - CHECK_NAME's declaration, the check-run lookup, the
 *  validator's REQUIRED_GATE_JOB - are AST queries via ts_extract.ts,
 *  where a commented or string-embedded decoy is not a node at all.) */
export const ALL_GREEN_WIRING = {
  /** The verdict's check-run POST names the check. */
  created: /^\s*-f "name=([^"]+)"/m,
  /** The fleet wrapper template pins the verdict's anchor job. */
  anchor: /^\s*require-job: (\S[^\n#]*?)\s*$/m,
  /** The reusable wires the anchor input into the judging step. */
  anchorWired: /^\s*REQUIRE_JOB: \$\{\{ inputs\.require-job \}\}$/m,
  /** The bot stand-down's author LOGIN must be wired from the PULL
   *  REQUEST'S AUTHOR - the exact, COMPLETE env line. The bash harness
   *  injects PR_AUTHOR_* itself and tests only the extracted run block,
   *  so this workflow-level mapping is otherwise unguarded: rewired to
   *  github.actor (or any reviewer-shaped source), a bot-submitted
   *  review wake - Copilot's own submission - at a human PR's head
   *  would read as bot-author, skip the copilot_state read, and mint
   *  success over a FAILED copilot check. */
  authorLoginWired:
    /^\s*PR_AUTHOR_LOGIN: \$\{\{ github\.event_name == 'pull_request_review' && github\.event\.pull_request\.user\.login \|\| '' \}\}$/m,
  /** The author TYPE half of the same wiring, same hazard: either line
   *  alone rewired to a reviewer-shaped source disarms the stand-down's
   *  author key. */
  authorTypeWired:
    /^\s*PR_AUTHOR_TYPE: \$\{\{ github\.event_name == 'pull_request_review' && github\.event\.pull_request\.user\.type \|\| '' \}\}$/m,
};

/** The check-run lookup template's leading text, backtick included: the
 *  green gates must key their lookup on the shared CHECK_NAME constant.
 *  Matched against string/template literals only (templateCarries), so a
 *  commented-out copy of the wiring is not a literal and never counts. */
export const CHECK_RUN_LOOKUP =
  "`repos/${repository}/commits/${sha}/check-runs?check_name=${CHECK_NAME}";

// The two Actions expressions the heal's sha plumbing routes through,
// pinned as data so the structural checks below and the workflow can
// never drift apart silently.
// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal Actions expression under pin
const GATE_SHA_EXPR = "${{ steps.gate.outputs.sha }}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal Actions expression under pin
const SELECT_SHA_EXPR = "${{ needs.select.outputs.sha }}";
const FALLBACK_IF = "steps.gate.outputs.fallback == 'true'";

/** The settings heal's sha plumbing, judged STRUCTURALLY on the parsed
 *  workflow (exported so the forcing tests run the exact judgment the
 *  rule runs): the green gate resolves the one commit the run may write
 *  from, and every link that carries it to a checkout is validated on
 *  the owning YAML node, never by a floating text match - a matching
 *  line on a decoy step must not stand in for the real wiring. Links:
 *  the gate step carries `id: gate` (the outputs' key - renamed, every
 *  reference silently reads empty; found by its exact command, exactly
 *  once), the select job's `sha` output republishes it, the fallback
 *  trio (re-checkout + setup-bun + reinstall, each conditioned on the
 *  fallback output, in that order) lands the SELECT job on it with the
 *  re-checkout as the job's LAST checkout, and the apply job's ONLY
 *  checkout pins to the select output - "only" and
 *  "last" because a later unpinned checkout would silently replace the
 *  vouched tree with the trigger ref, which is also why every absent
 *  link fails: actions/checkout treats a missing or empty ref as the
 *  default (probe C: deleting the apply ref line was invisible to every
 *  local gate). */
export function settingsHealShaPlumbingMismatches(text: string): Mismatch[] {
  const rel = ".github/workflows/settings-repos.yml";
  const mismatches: Mismatch[] = [];
  const mapping = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const steps = (job: Record<string, unknown>): Record<string, unknown>[] =>
    Array.isArray(job.steps) ? (job.steps as unknown[]).map(mapping) : [];
  const isCheckout = (step: Record<string, unknown>): boolean =>
    String(step.uses ?? "").startsWith("actions/checkout@");
  const jobs = mapping(mapping(parseYaml(text)).jobs);
  const select = mapping(jobs.select);
  const selectSteps = steps(select);
  if (selectSteps.length === 0) throw new Error(`${rel}: no select job steps - anchor lost`);

  // The gate step by its EXACT command (trim-equal, never a substring:
  // an echo decoy carrying the command in its text must not be the step
  // found while the real gate, renamed, keeps running), and exactly one
  // of it - two would make "the" gate ambiguous.
  const gates = selectSteps.filter(
    (step) => String(step.run ?? "").trim() === "bun .github/scripts/fleet/require_green_commit.ts",
  );
  if (gates.length !== 1) {
    throw new Error(
      `${rel}: expected exactly one green-gate step (run: bun .github/scripts/fleet/require_green_commit.ts), found ${gates.length} - anchor lost`,
    );
  }
  const gate = gates[0];
  if (String(gate.id ?? "") !== "gate") {
    mismatches.push({
      file: rel,
      expected: "the green-gate step carrying `id: gate` (the sha/fallback outputs' key)",
      got:
        gate.id === undefined
          ? "no id - every steps.gate.* read is silently empty"
          : `id: ${String(gate.id)}`,
    });
  }

  const outputSha = String(mapping(select.outputs).sha ?? "");
  if (outputSha !== GATE_SHA_EXPR) {
    mismatches.push({
      file: rel,
      expected: `the select job output sha: ${GATE_SHA_EXPR}`,
      got:
        outputSha === "" ? "no sha output - the apply job's checkout ref reads empty" : outputSha,
    });
  }

  const trio = selectSteps.filter((step) => String(step.if ?? "") === FALLBACK_IF);
  const trioCheckouts = trio.filter(isCheckout);
  const trioSetups = trio.filter((step) =>
    String(step.uses ?? "").startsWith("oven-sh/setup-bun@"),
  );
  // Trim-equal like the gate match: an `echo bun install ...` shaped run
  // contains the command without running it, so a substring read would
  // pass a fallback that never reinstalls.
  const trioInstalls = trio.filter(
    (step) => String(step.run ?? "").trim() === "bun install --frozen-lockfile",
  );
  if (
    trio.length !== 3 ||
    trioCheckouts.length !== 1 ||
    trioSetups.length !== 1 ||
    trioInstalls.length !== 1
  ) {
    mismatches.push({
      file: rel,
      expected: `a fallback trio conditioned on ${FALLBACK_IF}: one re-checkout, one setup-bun, one dependency reinstall`,
      got: `${trio.length} conditioned step(s) (${trioCheckouts.length} checkout, ${trioSetups.length} setup-bun, ${trioInstalls.length} reinstall)`,
    });
  } else if (
    // The trio in STRICT order: checkout, then setup-bun, then
    // reinstall (>= so one step matching two roles can never satisfy
    // "precedes" by being itself). Membership alone would pass a
    // reordering that pins the toolchain or installs dependencies
    // BEFORE the green tree lands - red-tip toolchain and deps running
    // over green-commit files, the exact hybrid the re-checkout exists
    // to prevent.
    selectSteps.indexOf(trioCheckouts[0]) >= selectSteps.indexOf(trioSetups[0]) ||
    selectSteps.indexOf(trioSetups[0]) >= selectSteps.indexOf(trioInstalls[0])
  ) {
    mismatches.push({
      file: rel,
      expected:
        "the fallback trio in order - re-checkout, then setup-bun, then reinstall - so toolchain and dependencies are pinned FROM the green tree",
      got: "a trio step runs before the tree it must read from lands",
    });
  } else if (String(mapping(trioCheckouts[0].with).ref ?? "") !== GATE_SHA_EXPR) {
    // Validated on the OWNING step: a decoy checkout elsewhere carrying
    // the right ref must never vouch for a rewired fallback checkout.
    mismatches.push({
      file: rel,
      expected: `the fallback re-checkout pinned to ref: ${GATE_SHA_EXPR}`,
      got:
        String(mapping(trioCheckouts[0].with).ref ?? "") === ""
          ? "no ref - the re-checkout lands on the trigger ref again, a silent no-op fallback"
          : `ref: ${String(mapping(trioCheckouts[0].with).ref)}`,
    });
  } else {
    const selectCheckouts = selectSteps.filter(isCheckout);
    if (selectCheckouts.length !== 2 || selectCheckouts[1] !== trioCheckouts[0]) {
      mismatches.push({
        file: rel,
        expected:
          "exactly two select-job checkouts, the fallback re-checkout LAST (a later checkout would silently replace the vouched tree)",
        got: `${selectCheckouts.length} checkout step(s)`,
      });
    }
  }

  const applySteps = steps(mapping(jobs.apply));
  if (applySteps.length === 0) throw new Error(`${rel}: no apply job steps - anchor lost`);
  const applyCheckouts = applySteps.filter(isCheckout);
  if (applyCheckouts.length !== 1) {
    mismatches.push({
      file: rel,
      expected:
        "exactly one apply-job checkout (a second one could silently replace the pinned tree)",
      got: `${applyCheckouts.length} checkout step(s)`,
    });
  } else {
    const applyRef = String(mapping(applyCheckouts[0].with).ref ?? "");
    if (applyRef !== SELECT_SHA_EXPR) {
      mismatches.push({
        file: rel,
        expected: `the apply job's checkout pinned to ref: ${SELECT_SHA_EXPR}`,
        got:
          applyRef === ""
            ? "no ref - the apply silently checks out the trigger ref, unpinning the fallback path"
            : `ref: ${applyRef}`,
      });
    }
  }
  return mismatches;
}

/** The predicate's declared check name, read from the AST: the single
 *  top-level `export const CHECK_NAME` declaration whose value is a
 *  plain string literal. A look-alike inside a comment, a string, or a
 *  multiline template is not a declaration node and can never be the one
 *  found; a declaration rewritten to any non-literal shape (a
 *  concatenation, a join) throws anchor-lost rather than passing on a
 *  value the pin cannot see whole. */
export function declaredCheckName(source: string): string {
  return constStringValue(source, "CHECK_NAME", {
    where: "all_green.ts",
    what: "verdict check name",
    exported: true,
  });
}

// --- comparison shaping ----------------------------------------------------

/** Non-blank, non-comment lines (right-trimmed) - the shape compared for
 *  workflow/dotfile parity, where comments are where copies legitimately
 *  tell their own story. */
export function semanticLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
}

/** Every `async function <name>() { ... }` block in `text`, matched from
 *  the declaration to the closing brace at the declaration's own indent,
 *  raw bytes included - for rules that pin inline script copies
 *  byte-identical. */
export function inlineFunctionCopies(text: string, name: string): string[] {
  const block = new RegExp(`^( *)async function ${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\1\\}`, "gm");
  return [...text.matchAll(block)].map((match) => match[0]);
}

const usedDivergences = new Set<number>();

/** Excuse recorded divergences for one parity pair: drop, from the ACTUAL
 *  (operator) side only, at most one line per entry matching `skip` that
 *  sits immediately before a line matching `before`. When the EXPECTED
 *  (template) side carries the same anchored line, the entry is stale -
 *  returned as a mismatch with nothing excused, so both sides keep the
 *  line and the drift is named instead of silently excused twice. Entries
 *  and the used-set are injectable for tests. */
export function applyDivergences(
  file: string,
  expected: string[],
  actual: string[],
  entries: typeof RECORDED_DIVERGENCES = RECORDED_DIVERGENCES,
  used: Set<number> = usedDivergences,
): { expected: string[]; actual: string[]; mismatches: Mismatch[] } {
  const mismatches: Mismatch[] = [];
  const drop = new Set<number>();
  const findAnchored = (lines: string[], entry: (typeof entries)[number], taken?: Set<number>) =>
    lines.findIndex(
      (line, i) =>
        !taken?.has(i) &&
        entry.skip.test(line.trim()) &&
        entry.before.test(lines[i + 1]?.trim() ?? ""),
    );
  for (const [index, entry] of entries.entries()) {
    if (entry.file !== file) continue;
    if (findAnchored(expected, entry) !== -1) {
      used.add(index);
      mismatches.push({
        file,
        expected: `no template line matching ${entry.skip} before ${entry.before}`,
        got: "the template now carries this line - drop the RECORDED_DIVERGENCES entry",
      });
      continue;
    }
    const at = findAnchored(actual, entry, drop);
    if (at === -1) continue;
    drop.add(at);
    used.add(index);
  }
  return {
    expected,
    actual: drop.size === 0 ? actual : actual.filter((_, i) => !drop.has(i)),
    mismatches,
  };
}

// --- generic comparison helpers ------------------------------------------

/** JSON with recursively sorted object keys, for order-insensitive
 *  deep-equality messages. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function sortedSet(values: string[]): string {
  return [...new Set(values)].sort().join(", ");
}

/** One mismatch when `got` is not exactly the same set as `expected`. */
export function setMismatch(file: string, expected: string[], got: string[]): Mismatch[] {
  if (sortedSet(expected) === sortedSet(got)) return [];
  return [{ file, expected: sortedSet(expected), got: sortedSet(got) }];
}

/** First index where two line sequences differ, or -1 when equal. */
export function firstDiff(expected: string[], got: string[]): number {
  const max = Math.max(expected.length, got.length);
  for (let i = 0; i < max; i++) {
    if (expected[i] !== got[i]) return i;
  }
  return -1;
}

function lineDiffMismatch(
  file: string,
  source: string,
  expected: string[],
  got: string[],
): Mismatch[] {
  const index = firstDiff(expected, got);
  if (index === -1) return [];
  return [
    {
      file,
      expected: `${JSON.stringify(expected[index] ?? "<end of file>")} (line ${index + 1} vs ${source})`,
      got: JSON.stringify(got[index] ?? "<end of file>"),
    },
  ];
}

// --- shared parsed inputs -------------------------------------------------

/** Rules re-derive these shared inputs dozens of times per run and the
 *  underlying files never change mid-run; memoize the parse, not the
 *  callers. */
function memoize<T>(compute: () => T): () => T {
  let cached = false;
  let value: T | undefined;
  return () => {
    if (!cached) {
      value = compute();
      cached = true;
    }
    return value as T;
  };
}

const loadManifests = memoize(loadManifestsFresh);

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where}: expected a mapping`);
  }
  return value as Record<string, unknown>;
}

const copierConfig = memoize(
  (): Record<string, unknown> => asRecord(parseYaml(read("copier.yml")), "copier.yml"),
);

/** The manifests' tracking_label streams (fuzzer, nightly, ...): the single
 *  source the hand-written copier questions and doc constants are anchored
 *  to. The list comes from generate.ts's trackingStreams (which throws when
 *  no manifest declares one), so every rule keyed on it fails loudly rather
 *  than passing vacuously and can never disagree with the generated
 *  tracking-labels regions. */
function trackingManifests(): {
  module: string;
  tracking: NonNullable<ModuleManifest["tracking_label"]>;
}[] {
  return trackingStreams(loadManifests()).map((m) => ({
    module: m.module,
    tracking: m.tracking_label,
  }));
}

function jinjaVars(): JinjaVars {
  const username = asRecord(copierConfig().github_username, "copier.yml github_username").default;
  if (typeof username !== "string" || username === "") {
    throw new Error("copier.yml: github_username has no string default");
  }
  const holder = asRecord(copierConfig().copyright_holder, "copier.yml copyright_holder").default;
  if (typeof holder !== "string" || holder === "") {
    throw new Error("copier.yml: copyright_holder has no string default");
  }
  const pkg = asRecord(JSON.parse(read("package.json")), "package.json");
  return { username, slug: String(pkg.name), copyrightHolder: holder };
}

function packageScripts(): Record<string, string> {
  const pkg = asRecord(JSON.parse(read("package.json")), "package.json");
  return asRecord(pkg.scripts, "package.json scripts") as Record<string, string>;
}

function repoCi(): Record<string, unknown> {
  return asRecord(parseYaml(read(".github/workflows/ci.yml")), "ci.yml");
}

function templateCi(): Record<string, unknown> {
  // The collapsed template carries no private-conditioned branches (the
  // job shapes live in fleet-ci.yml), so no boolean context applies;
  // unresolved jinja expressions (the fleet-ci input values) are
  // placeholder-substituted so the skeleton parses as YAML.
  const text = placeholderJinja(
    normalizeJinja(read("templates/base/.github/workflows/ci.yml.jinja"), jinjaVars()),
  );
  return asRecord(parseYaml(text), "ci.yml.jinja");
}

function ciJobs(ci: Record<string, unknown>, where: string): Record<string, unknown> {
  return asRecord(ci.jobs, `${where} jobs`);
}

/** The named smoke-generate matrix row; a missing row throws (a rule keyed
 *  on a row must fail loudly when the row is renamed or deleted). */
function smokeMatrixRow(name: string): Record<string, unknown> {
  const smoke = asRecord(ciJobs(repoCi(), "ci.yml")["smoke-generate"], "smoke-generate");
  const matrix = asRecord(asRecord(smoke.strategy, "strategy").matrix, "matrix");
  const rows = (matrix.include as Record<string, unknown>[]) ?? [];
  const row = rows.find((r) => r.name === name);
  if (!row) throw new Error(`ci.yml: smoke-generate has no '${name}' matrix row`);
  return row;
}

/** A row's `modules` value (a YAML list serialized as a string). */
function smokeRowModules(row: Record<string, unknown>): string[] {
  return (parseYaml(String(row.modules)) as unknown[]).map(String);
}

/** All non-directory paths below `rel` (repo-relative), sorted; skips
 *  node_modules. Symlinks are returned but flagged. */
function walkFiles(rel: string): { path: string; symlink: boolean }[] {
  const found: { path: string; symlink: boolean }[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(join(REPO_ROOT, dir)).sort()) {
      if (name === "node_modules") continue;
      const childRel = `${dir}/${name}`;
      const stat = lstatSync(join(REPO_ROOT, childRel));
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(childRel);
      else found.push({ path: childRel, symlink: stat.isSymbolicLink() });
    }
  };
  visit(rel);
  return found;
}

// --- labels ---------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
  description: string;
}

/** Every label tuple any settings LAYER can emit for ANY selection and
 *  either visibility - tracking labels excluded (they render from
 *  per-repo answers). The single roster the doc-constant and issue-form
 *  rules key on. */
function managedLabelRoster(): Label[] {
  return allLayerLabels(loadManifests());
}

/** The identity keys the settings-sync starter seeds (description,
 *  homepage, topics, private); the key list lives with the merge dialect
 *  (identityKeyIssues) - this wrapper applies the same contract to
 *  repo-platform's own .github/settings.yml so the two checkers cannot
 *  drift apart. */
export function settingsIdentityMismatches(repository: Record<string, unknown>): Mismatch[] {
  return identityKeyIssues(repository).map((issue) => ({
    file: `.github/settings.yml repository.${issue.key}`,
    expected: issue.expected,
    got: issue.got,
  }));
}

/** True when verify_smoke_gating.sh CONDITIONS on the module through its
 *  `has` helper - an executable shell-condition use (`if has X`, `elif has
 *  X`, `&& has X`, `|| has X`, `{ has X`, `! has X`). Comment lines and
 *  trailing comments are stripped first, and a condition keyword/operator
 *  must immediately precede `has`, so a mention in a comment or an
 *  unrelated substring (e.g. "bun" inside setup-bun) cannot satisfy it. */
export function gatesOnModule(script: string, module: string): boolean {
  const executable = script
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .map((line) => line.replace(/\s#.*$/, ""))
    .join("\n");
  const escaped = module.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const condition = new RegExp(
    `(?:^|[\\s;{])(?:if|elif|&&|\\|\\||\\{|!|;)\\s+has\\s+${escaped}(?=$|[\\s;])`,
    "m",
  );
  return condition.test(executable);
}

// --- label-preflight invocation grammar --------------------------------------

/** The preflight script's path stem, the token the invocation grammar
 *  and the settings-label-preflight rule key on. */
export const PREFLIGHT_SCRIPT = "fleet/label_preflight.ts";

/** A run block's executable shell command segments: heredoc BODIES
 *  dropped (they are text fed to a command, not commands - openers
 *  stay), backslash continuations joined onto their command's line,
 *  then one quote-aware sweep splits at unquoted newlines, `;`, `&&`,
 *  and `||`, with an unquoted word-start `#` commenting out the rest
 *  of its line. Text inside quotes stays segment text, so quoted data
 *  can neither split into a phantom command nor truncate a real one.
 *  Still textual, not a shell: `$(...)` substitution and quotes
 *  spanning lines are not modeled, and a `<<` inside a quoted string
 *  opens a phantom heredoc - each degrades toward dropped lines, a
 *  FALSE MISMATCH against the exact pinned shapes, never toward
 *  reading non-command text as a command. */
export function shellSegments(run: string): string[] {
  // Pass 1, line-wise: every heredoc opener on a non-comment line
  // queues its terminator (POSIX order for multiple heredocs on one
  // line); body lines are dropped until each closes - at an EXACT
  // terminator line for <<WORD (an indented look-alike is still body),
  // with leading TABS stripped for <<-WORD. Bare delimiters are any
  // unquoted-word characters, not just \w; quoted and backslashed
  // spellings are covered.
  const lines: string[] = [];
  const pending: { terminator: string; dashed: boolean }[] = [];
  for (const line of run.split("\n")) {
    if (pending.length > 0) {
      const head = pending[0];
      if ((head.dashed ? line.replace(/^\t+/, "") : line) === head.terminator) pending.shift();
      continue;
    }
    if (!line.trimStart().startsWith("#")) {
      const opener = /<<(-?)\s*(?:"([^"]+)"|'([^']+)'|\\?([^\s;&|<>()'"\\]+))/g;
      for (const match of line.matchAll(opener)) {
        pending.push({ terminator: match[2] ?? match[3] ?? match[4], dashed: match[1] === "-" });
      }
    }
    lines.push(line);
  }
  // Pass 2: the quote-aware sweep.
  const text = lines.join("\n").replaceAll("\\\n", " ");
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote !== null) {
      if (quote === '"' && ch === "\\" && i + 1 < text.length) {
        current += ch + text[++i];
        continue;
      }
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < text.length) {
      current += ch + text[++i];
      continue;
    }
    if (ch === "\n" || ch === ";") {
      segments.push(current);
      current = "";
      continue;
    }
    if ((ch === "&" && text[i + 1] === "&") || (ch === "|" && text[i + 1] === "|")) {
      segments.push(current);
      current = "";
      i++;
      continue;
    }
    if (ch === "#" && (current === "" || /\s$/.test(current))) {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.filter((segment) => segment.trim() !== "");
}

/** How a segment RUNS the preflight at command position: 'direct'
 *  (`bun <...>fleet/label_preflight.ts` opens the segment), 'hidden'
 *  (it is the command run_hidden.ts executes after one closed
 *  double-quoted capture-name argument and its `--` separator - the
 *  landed shape, anchored so text INSIDE the quoted label, or a label
 *  left unterminated by comment truncation, never reads as the wrapped
 *  command), or null. An echoed or argument-position token, a quoted
 *  script path, and an inline `VAR=x bun ...` env prefix are all null -
 *  not invocations - so a spoof or an unrecognized form fails the
 *  invocation count loudly instead of satisfying the pin. EXECUTION is
 *  not proven at this level - dead-code short-circuits
 *  (`false && bun ...`) and `|| true` suppression pass the grammar;
 *  the rule's EXPECTED_RUN byte pin owns those. */
export function preflightInvocation(segment: string): "direct" | "hidden" | null {
  // The path stems carry a path-segment boundary: a stem glued to ANY
  // preceding non-separator character (not-sync/, my.fleet/) is a
  // DIFFERENT tree's file merely ending in the expected name, which
  // must not read as the wrapper or the script - only a fresh token or
  // a parent directory's `/` may precede the stem.
  const direct = /^\s*bun\s+\S*?(?<![^\s/])fleet\/label_preflight\.ts(?=\s|$)/;
  const hidden =
    /^\s*bun\s+\S*?(?<![^\s/])sync\/run_hidden\.ts\s+"[^"]*"\s+--\s+bun\s+\S*?(?<![^\s/])fleet\/label_preflight\.ts(?=\s|$)/;
  if (hidden.test(segment)) return "hidden";
  if (direct.test(segment)) return "direct";
  return null;
}

/** An invocation segment's argument text, whitespace-normalized - the
 *  shape the settings-label-preflight rule's argument allowlist
 *  compares exactly, so an extra, missing, drifted, or repeated flag
 *  is visible rather than merely "present". */
export function preflightArgs(segment: string): string {
  return segment
    .slice(segment.indexOf(PREFLIGHT_SCRIPT) + PREFLIGHT_SCRIPT.length)
    .replace(/\s+/g, " ")
    .trim();
}

/** Lenient mapping view of parsed YAML for the preflight judge; a
 *  non-mapping reads as empty, so shape checks mismatch instead of
 *  throwing on malformed steps. */
function asMapping(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The terminal backstop: each preflight step's run block,
 *  byte-for-byte. The invocation grammar names WHICH facet drifted for
 *  ordinary edits, but a textual parser cannot prove EXECUTION, and
 *  each reviewer-built smuggle (heredoc bodies, quoted-label text,
 *  quoted-data splits, exotic delimiters) needed another refinement -
 *  this pin ends the class: ANY deviation mismatches, and a deliberate
 *  edit to the step updates this constant in the same change. Exported
 *  so the suite can build a green synthetic step and prove each
 *  comparison fires on its own mutation. */
export const PREFLIGHT_EXPECTED_RUN: Record<string, string> = {
  ".github/workflows/settings-repos.yml":
    'if [ "$TARGET" = "$GITHUB_REPOSITORY" ]; then\n' +
    '  bun .github/scripts/sync/run_hidden.ts "settings labels" -- \\\n' +
    "    bun .github/scripts/fleet/label_preflight.ts \\\n" +
    '    --merged "$RUNNER_TEMP/merged-settings.yml" \\\n' +
    '    --repo "$TARGET" --target-dir . --mode "$MODE"\n' +
    "else\n" +
    '  bun .github/scripts/sync/run_hidden.ts "settings labels" -- \\\n' +
    "    bun .github/scripts/fleet/label_preflight.ts \\\n" +
    '    --merged "$RUNNER_TEMP/merged-settings.yml" \\\n' +
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal GitHub Actions expression, pinned byte-for-byte
    '    --repo "$TARGET" --ref "${{ steps.render.outputs.ref }}" --mode "$MODE"\n' +
    "fi\n",
  ".github/workflows/reusable-apply-settings.yml":
    "bun platform/.github/scripts/fleet/label_preflight.ts \\\n" +
    '  --merged "$RUNNER_TEMP/merged-settings.yml" \\\n' +
    '  --repo "$GITHUB_REPOSITORY" --target-dir . \\\n' +
    '  --sections "$SECTIONS" --required-sections "$REQUIRED_SECTIONS" \\\n' +
    '  --mode "$MODE" --on-missing-permission "$ON_MISSING_PERMISSION"\n',
};

// The exact argument lists the invocations may carry, whitespace-
// normalized: an ALLOWLIST, not a presence test. label_preflight.ts
// stands down or re-scopes on flags a presence test would never look
// at (--sections, --target-dir, a repeated --mode's last value wins),
// so anything but an exact match is a stood-down guard. The multiset
// also pins the COUNT: a gutted if/else branch is a missing
// invocation, not a surviving step.
const PREFLIGHT_EXPECTED_ARGS: Record<string, string[]> = {
  ".github/workflows/settings-repos.yml": [
    '--merged "$RUNNER_TEMP/merged-settings.yml" --repo "$TARGET" --target-dir . --mode "$MODE"',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal GitHub Actions expression, pinned byte-for-byte
    '--merged "$RUNNER_TEMP/merged-settings.yml" --repo "$TARGET" --ref "${{ steps.render.outputs.ref }}" --mode "$MODE"',
  ],
  ".github/workflows/reusable-apply-settings.yml": [
    '--merged "$RUNNER_TEMP/merged-settings.yml" --repo "$GITHUB_REPOSITORY" --target-dir . --sections "$SECTIONS" --required-sections "$REQUIRED_SECTIONS" --mode "$MODE" --on-missing-permission "$ON_MISSING_PERMISSION"',
  ],
};

/** One apply input's expectation in the census below: mirrored from a
 *  preflight env var AND pinned to one expected expression (comparing
 *  the two sides' text alone is not enough - the same expression
 *  string can EVALUATE differently in a run step's env and a uses
 *  step's with, e.g. via github.action, so the census pins the one
 *  context-stable expression both sides must carry), a fixed literal,
 *  or presence-only because another rule owns the value
 *  (settings-apply-merged-input pins settings-file for both files -
 *  re-pinning it here would double-report one edit). */
export type ApplyWithExpectation =
  | { parity: string; value: string }
  | { literal: string }
  | { pinnedElsewhere: true };

// The COMPLETE census of each apply step's with: inputs - key set and
// values. Every input either mirrors a preflight env var (the guard
// must judge under exactly the configuration the apply runs with,
// with both sides pinned to the census's context-stable expression),
// is a fixed literal, or is value-pinned by another rule; a with: key
// outside the census is an input the guard cannot mirror and fails
// outright. This is what makes the mirrored-input class CLOSED: adding
// or changing any apply input goes loud here, not silently past a
// partial parity list. The parity env names double as the preflight's
// env-key ALLOWLIST - an env var outside the census (BASH_ENV) can
// inject execution the run pin cannot see. Exported (with the
// companion allowlists) so the suite can assert its own copy of each
// table and mutation-test every entry - a dropped entry breaks the
// suite's table equality, not just the live files' luck.
export const PREFLIGHT_APPLY_WITH: Record<string, Record<string, ApplyWithExpectation>> = {
  ".github/workflows/settings-repos.yml": {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal GitHub Actions expression, pinned byte-for-byte
    token: { parity: "GH_TOKEN", value: "${{ secrets.REPO_PLATFORM_TOKEN }}" },
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal GitHub Actions expression, pinned byte-for-byte
    mode: { parity: "MODE", value: "${{ inputs.check_only && 'check' || 'apply' }}" },
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal GitHub Actions expression, pinned byte-for-byte
    repository: { parity: "TARGET", value: "${{ steps.resolve.outputs.repo }}" },
    "settings-file": { pinnedElsewhere: true },
    "private-repos": { literal: "redact" },
    "private-report": { literal: "issue" },
    "on-missing-permission": { literal: "fail" },
  },
  ".github/workflows/reusable-apply-settings.yml": {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal GitHub Actions expression, pinned byte-for-byte
    token: { parity: "GH_TOKEN", value: "${{ secrets.REPO_PLATFORM_TOKEN }}" },
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal GitHub Actions expression, pinned byte-for-byte
    mode: { parity: "MODE", value: "${{ inputs.check_only && 'check' || 'apply' }}" },
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal GitHub Actions expression, pinned byte-for-byte
    repository: { literal: "${{ github.repository }}" },
    "settings-file": { pinnedElsewhere: true },
    "on-missing-permission": {
      parity: "ON_MISSING_PERMISSION",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal GitHub Actions expression, pinned byte-for-byte
      value: "${{ inputs.on_missing_permission }}",
    },
    "required-sections": {
      parity: "REQUIRED_SECTIONS",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal GitHub Actions expression, pinned byte-for-byte
      value: "${{ inputs.required_sections }}",
    },
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal GitHub Actions expression, pinned byte-for-byte
    sections: { parity: "SECTIONS", value: "${{ inputs.sections }}" },
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal GitHub Actions expression, pinned byte-for-byte
    "api-version": { literal: "${{ inputs.api_version }}" },
  },
};

/** The mirrored env names per file - the preflight's env-key allowlist. */
function preflightParityEnvNames(rel: string): Set<string> {
  return new Set(
    Object.values(PREFLIGHT_APPLY_WITH[rel]).flatMap((expectation) =>
      "parity" in expectation ? [expectation.parity] : [],
    ),
  );
}

// Job-level env keys the apply job may carry (workflow-level env is
// rejected outright): a job or workflow env var reaches the preflight's
// shell exactly like a step one, so BASH_ENV smuggled one level up is
// the same injection the step-level allowlist closes.
export const PREFLIGHT_JOB_ENV_KEYS: Record<string, ReadonlySet<string>> = {
  ".github/workflows/settings-repos.yml": new Set(["HIDE_DETAILS", "SETTINGS_REPORT_TITLE"]),
  ".github/workflows/reusable-apply-settings.yml": new Set([]),
};

// The job-level EXECUTION-CONTEXT census (decision: a rule, not an
// accepted residual - the class is in-file and closable the same way
// the step-key allowlist closes its level). The whole job runs WHERE
// its keys say: `container:` re-homes every step into an arbitrary
// image whose env (BASH_ENV again) and PATH arrive underneath the
// step- and job-level env allowlists' sight, `services:` attaches
// containers, and runner keys keep being added - so the apply job's
// keys are ALLOWLISTED rather than enumerated as hazards, and runs-on
// is value-pinned to the hosted runner the byte-pinned run blocks
// assume (a self-hosted label is a different machine wearing the same
// workflow text). `defaults:` is deliberately absent here AND skipped
// by the census: its dedicated check above owns it, and double-listing
// would double-report one edit. `env:` is allowlisted as a KEY because
// PREFLIGHT_JOB_ENV_KEYS judges its content.
export const PREFLIGHT_APPLY_JOB_KEYS: Record<string, ReadonlySet<string>> = {
  ".github/workflows/settings-repos.yml": new Set([
    "name",
    "needs",
    "if",
    "strategy",
    "env",
    "runs-on",
    "timeout-minutes",
    "steps",
  ]),
  ".github/workflows/reusable-apply-settings.yml": new Set(["runs-on", "timeout-minutes", "steps"]),
};

/** The one hosted runner the apply jobs may request. */
export const PREFLIGHT_APPLY_RUNS_ON = "ubuntu-latest";

// The persisted-environment class: a PRIOR step's run block can write
// `BASH_ENV=<hook> >> $GITHUB_ENV` (bash sources the hook before the
// pinned run block executes - `exit 0` there skips the guard green) or
// prepend a counterfeit bun via GITHUB_PATH. No landed step in either
// apply job touches these, so ANY mention in a run block mismatches.
// Two recorded residuals bound what a textual scan can prove: the
// scripts those steps call are this repository's own reviewed,
// CI-gated code (the rule's trust boundary is the WORKFLOW FILE, not
// the .ts sources behind it), and the scan catches LITERAL spellings -
// the honest-drift class; a write obfuscated through fragment-built
// variable names is deliberately adversarial code in a reviewed file,
// outside any textual rule's reach, and stays review's.
export const PREFLIGHT_FORBIDDEN_RUN_TOKENS = ["GITHUB_ENV", "BASH_ENV", "GITHUB_PATH"] as const;

// The steps strictly BETWEEN the preflight and the apply, byte-pinned
// like the run block itself: the guard's verdict is only as good as
// the merged document staying untouched until the apply reads it, so
// the gap is part of the guarded shape (an intervening step could
// rewrite $RUNNER_TEMP/merged-settings.yml after validation). The
// operator's gap is exactly the stood-down notice
// settings-hidden-step-notices requires; the reusable's is empty.
const PREFLIGHT_GAP_STEPS: Record<string, { if: string; run: string }[]> = {
  ".github/workflows/settings-repos.yml": [
    {
      if: "steps.labels.outputs.not_applicable == 'true'",
      run:
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal GitHub Actions expression, pinned byte-for-byte
        'echo "::notice::label preflight stood down for ${{ matrix.repo }}: ${{ steps.labels.outputs.reason }}"\n',
    },
  ],
  ".github/workflows/reusable-apply-settings.yml": [],
};

// Step keys the preflight may carry - an ALLOWLIST, because the
// reroute class is open-ended: `shell: true {0}` runs `true <script>`
// (the script never executes), and working-directory:,
// continue-on-error:, or a future runner key softens or reroutes the
// guard the same way while the byte-pinned run block reads intact.
export const PREFLIGHT_STEP_KEYS: Record<string, ReadonlySet<string>> = {
  ".github/workflows/settings-repos.yml": new Set(["name", "id", "if", "env", "run"]),
  ".github/workflows/reusable-apply-settings.yml": new Set(["name", "if", "env", "run"]),
};

/** The whole per-job judgment for the settings-label-preflight rule,
 *  pure over a parsed job (and its workflow document, for the
 *  inherited-state checks) so the suite can prove every comparison
 *  fires on a synthetic mutation (the live-file mutations cannot
 *  isolate them). Returns the number of settings-apply steps seen (the
 *  rule's anchor count) alongside the mismatches. */
export function labelPreflightJobMismatches(
  rel: string,
  jobName: string,
  job: Record<string, unknown>,
  workflow: Record<string, unknown> = {},
): { applies: number; mismatches: Mismatch[] } {
  if (!(rel in PREFLIGHT_EXPECTED_RUN)) {
    throw new Error(`labelPreflightJobMismatches: no pinned preflight shape for ${rel}`);
  }
  const mismatches: Mismatch[] = [];
  const raw = job.steps;
  if (!Array.isArray(raw)) return { applies: 0, mismatches };
  const steps = raw.map(asMapping);
  const applyAts = steps.flatMap((step, index) =>
    String(step.uses ?? "").includes("github-settings-as-code") ? [index] : [],
  );
  if (applyAts.length === 0) return { applies: 0, mismatches };
  // Exactly ONE apply step: the gap pin below guards the stretch from
  // the preflight to THE apply, and a second invocation of the settings
  // action would sit outside that guarded stretch by construction.
  if (applyAts.length > 1) {
    mismatches.push({
      file: rel,
      expected: `exactly one settings apply step in job '${jobName}'`,
      got: `${applyAts.length} steps use the action - a second apply escapes the pinned preflight-to-apply gap`,
    });
  }
  // Inherited execution state: a workflow- or job-level defaults.run
  // reroutes every run step exactly like a step-level shell:, and a
  // workflow/job env var (BASH_ENV) injects like a step one - the
  // step-level allowlists alone would miss both.
  if ("defaults" in workflow) {
    mismatches.push({
      file: rel,
      expected:
        "no workflow-level defaults: (a defaults.run shell or working-directory reroutes every run step around the byte-pinned run block)",
      got: "a defaults: key on the workflow",
    });
  }
  const workflowEnvKeys = Object.keys(asMapping(workflow.env));
  if (workflowEnvKeys.length > 0) {
    mismatches.push({
      file: rel,
      expected:
        "no workflow-level env: (a workflow env var - BASH_ENV - reaches the preflight's shell like a step one)",
      got: `workflow env key(s) '${workflowEnvKeys.join("', '")}'`,
    });
  }
  if ("defaults" in job) {
    mismatches.push({
      file: rel,
      expected: `no defaults: on job '${jobName}' (a job-level shell or working-directory reroutes every run step around the byte-pinned run block)`,
      got: "a defaults: key on the job",
    });
  }
  for (const key of Object.keys(asMapping(job.env))) {
    if (!PREFLIGHT_JOB_ENV_KEYS[rel].has(key)) {
      mismatches.push({
        file: rel,
        expected:
          `only the pinned job-level env keys [${[...PREFLIGHT_JOB_ENV_KEYS[rel]].join(", ")}] on ` +
          `job '${jobName}' - a job env var (BASH_ENV) reaches the preflight's shell like a step one`,
        got: `job env key '${key}'`,
      });
    }
  }
  for (const key of Object.keys(job)) {
    if (key === "defaults") continue; // the dedicated defaults check above owns it
    if (!PREFLIGHT_APPLY_JOB_KEYS[rel].has(key)) {
      mismatches.push({
        file: rel,
        expected:
          `only the pinned job keys [${[...PREFLIGHT_APPLY_JOB_KEYS[rel]].join(", ")}] on job ` +
          `'${jobName}' - any other key (container:, services:, a future runner key) re-homes ` +
          "the execution context underneath every step-level pin",
        got: `job key '${key}'`,
      });
    }
  }
  const runsOn = String(job["runs-on"] ?? "").trim();
  if (runsOn !== PREFLIGHT_APPLY_RUNS_ON) {
    mismatches.push({
      file: rel,
      expected:
        `runs-on: ${PREFLIGHT_APPLY_RUNS_ON} on job '${jobName}' (the pinned hosted runner - a ` +
        "self-hosted label is a different machine wearing the same workflow text)",
      got: runsOn === "" ? "no runs-on" : `runs-on: ${runsOn}`,
    });
  }
  for (const [index, step] of steps.entries()) {
    const runText = String(step.run ?? "");
    for (const token of PREFLIGHT_FORBIDDEN_RUN_TOKENS) {
      if (runText.includes(token)) {
        mismatches.push({
          file: rel,
          expected:
            `no ${token} in any run block of job '${jobName}' (persisted environment poisons later ` +
            "steps: a BASH_ENV hook or a counterfeit PATH entry reroutes the guard while its pinned run block reads intact)",
          got: `step ${index + 1} ('${String(step.name ?? step.id ?? "unnamed")}') mentions ${token}`,
        });
      }
    }
  }
  const segments = (step: Record<string, unknown>): string[] =>
    shellSegments(String(step.run ?? ""));
  const invokes = (segment: string) => preflightInvocation(segment) !== null;
  const preflightAts = steps.flatMap((step, index) =>
    segments(step).some(invokes) ? [index] : [],
  );
  if (preflightAts.length === 0) {
    const mentioned = steps.some((step) => String(step.run ?? "").includes(PREFLIGHT_SCRIPT));
    mismatches.push({
      file: rel,
      expected: `a fleet/label_preflight.ts step in job '${jobName}' before its settings apply`,
      got: mentioned
        ? "a mention, but no recognized command-position invocation - an unexpected invocation form does not satisfy the pin; use the landed shape"
        : "no such step - the apply would delete labels the target still references, unchecked",
    });
    return { applies: applyAts.length, mismatches };
  }
  if (preflightAts.length > 1) {
    mismatches.push({
      file: rel,
      expected: `exactly one label-preflight step in job '${jobName}'`,
      got: `${preflightAts.length} steps invoke it - a second site escapes the pinned guard shape`,
    });
  }
  const preflight = steps[preflightAts[0]];
  const preflightIf = String(preflight.if ?? "").trim();
  const preflightEnv = asMapping(preflight.env);
  const invocations = segments(preflight).filter(invokes);
  // The gap between the preflight and the apply is part of the guarded
  // shape: the verdict is only as good as the merged document staying
  // untouched until the apply reads it.
  const firstApply = Math.min(...applyAts);
  if (preflightAts[0] < firstApply) {
    const gap = steps.slice(preflightAts[0] + 1, firstApply);
    const expectedGap = PREFLIGHT_GAP_STEPS[rel];
    if (gap.length !== expectedGap.length) {
      mismatches.push({
        file: rel,
        expected:
          `exactly ${expectedGap.length} step(s) between the preflight and the apply (the pinned ` +
          "gap - an intervening step could rewrite the merged document after the guard validated it)",
        got: `${gap.length} step(s)`,
      });
    } else {
      gap.forEach((step, index) => {
        const pinned = expectedGap[index];
        const keys = Object.keys(step).sort().join(", ");
        if (keys !== "if, name, run") {
          mismatches.push({
            file: rel,
            expected: `gap step ${index + 1} carrying exactly the keys [if, name, run] (the pinned notice shape)`,
            got: `keys [${keys}]`,
          });
        } else if (
          String(step.if ?? "").trim() !== pinned.if ||
          String(step.run ?? "") !== pinned.run
        ) {
          mismatches.push({
            file: rel,
            expected: `gap step ${index + 1} matching the pinned stood-down notice (PREFLIGHT_GAP_STEPS: run byte-for-byte, if compared after trimming)`,
            got: "a drifted gap step",
          });
        }
      });
    }
  }
  for (const key of Object.keys(preflight)) {
    if (!PREFLIGHT_STEP_KEYS[rel].has(key)) {
      mismatches.push({
        file: rel,
        expected:
          `only the pinned step keys [${[...PREFLIGHT_STEP_KEYS[rel]].join(", ")}] on the preflight ` +
          "step - any other key (shell:, working-directory:, continue-on-error:) reroutes or softens " +
          "the guard while the byte-pinned run block reads intact",
        got: `step key '${key}'`,
      });
    }
  }
  const allowedEnv = preflightParityEnvNames(rel);
  for (const key of Object.keys(preflightEnv)) {
    if (!allowedEnv.has(key)) {
      mismatches.push({
        file: rel,
        expected:
          `only the mirrored env keys [${[...allowedEnv].join(", ")}] on the preflight step - ` +
          "an env var outside the census (BASH_ENV) can inject execution the run pin cannot see",
        got: `env key '${key}'`,
      });
    }
  }
  // EVERY apply step, like the skip-gate rule: a second invocation of
  // the settings action must not borrow the first one's guard.
  for (const applyAt of applyAts) {
    if (preflightAts[0] > applyAt) {
      mismatches.push({
        file: rel,
        expected: `the label preflight BEFORE the settings apply step (job '${jobName}')`,
        got: "the preflight runs after the apply - the deletions it exists to refuse have already happened",
      });
    }
    const applyIf = String(steps[applyAt].if ?? "").trim();
    // TEXT parity only, deliberately: this check proves the guard and
    // the apply share ONE condition; the condition's pinned VALUE is the
    // sibling settings-apply-skip-gate rule's job (it pins every apply
    // step's if: in both files), so a JOINT drift of both sides fires
    // there, not here - re-pinning the value here would double-report
    // every legitimate condition edit. That split is load-bearing
    // defense in depth: retiring the sibling rule (its roster entry
    // makes that loud) would leave this parity satisfiable by any
    // condition, agreed or wrong.
    if (preflightIf !== applyIf) {
      mismatches.push({
        file: rel,
        expected:
          `the label preflight's condition identical (after trimming) to the apply step's ` +
          `(${JSON.stringify(applyIf)}) - the guard must run exactly when the guarded apply runs`,
        got: preflightIf === "" ? "no condition at all" : preflightIf,
      });
    }
    const applyWith = asMapping(steps[applyAt].with);
    const census = PREFLIGHT_APPLY_WITH[rel];
    for (const key of Object.keys(applyWith)) {
      if (!(key in census)) {
        mismatches.push({
          file: rel,
          expected:
            `only the pinned apply inputs [${Object.keys(census).join(", ")}] - an input outside ` +
            "the census changes what the apply does in a way the guard cannot mirror",
          got: `with key '${key}'`,
        });
      }
    }
    for (const [key, expectation] of Object.entries(census)) {
      const withValue = String(applyWith[key] ?? "").trim();
      if ("pinnedElsewhere" in expectation) {
        if (!(key in applyWith)) {
          mismatches.push({
            file: rel,
            expected: `the apply input with.${key} present (its value is pinned by another rule)`,
            got: "no such input",
          });
        }
        continue;
      }
      if ("literal" in expectation) {
        if (withValue !== expectation.literal) {
          mismatches.push({
            file: rel,
            expected: `the apply input with.${key}: ${JSON.stringify(expectation.literal)} (the pinned census value)`,
            got: withValue === "" ? "no such input" : withValue,
          });
        }
        continue;
      }
      const envValue = String(preflightEnv[expectation.parity] ?? "").trim();
      if (withValue !== expectation.value) {
        mismatches.push({
          file: rel,
          expected:
            `the apply input with.${key}: ${JSON.stringify(expectation.value)} (the census's ` +
            "context-stable expression - text parity alone can evaluate differently between a run step's env and a uses step's with)",
          got: withValue === "" ? "no such input" : withValue,
        });
      }
      if (envValue !== expectation.value) {
        mismatches.push({
          file: rel,
          expected:
            `preflight env ${expectation.parity}: ${JSON.stringify(expectation.value)} (the same ` +
            `pinned expression the apply's with.${key} carries - the guard must judge under exactly the configuration the apply runs with)`,
          got: envValue === "" ? "no such env value" : envValue,
        });
      }
    }
  }
  const expectedArgs = [...PREFLIGHT_EXPECTED_ARGS[rel]].sort();
  const actualArgs = invocations.map(preflightArgs).sort();
  if (firstDiff(expectedArgs, actualArgs) !== -1) {
    mismatches.push({
      file: rel,
      expected:
        `exactly ${PREFLIGHT_EXPECTED_ARGS[rel].length} preflight invocation(s) carrying the pinned ` +
        `argument lists [${PREFLIGHT_EXPECTED_ARGS[rel].join("] [")}] - an extra, missing, or drifted ` +
        "flag stands the guard down at runtime while every pinned flag still reads present",
      got: actualArgs.length === 0 ? "none" : `[${actualArgs.join("] [")}]`,
    });
  }
  if (String(preflight.run ?? "") !== PREFLIGHT_EXPECTED_RUN[rel]) {
    mismatches.push({
      file: rel,
      expected:
        "the preflight step's run block byte-identical to the landed shape (the PREFLIGHT_EXPECTED_RUN pin) - " +
        "anything else is unauditable by a textual rule; a deliberate edit updates the pin in the same change",
      got: "a drifted run block",
    });
  }
  if (rel === ".github/workflows/settings-repos.yml") {
    if (invocations.some((segment) => preflightInvocation(segment) === "direct")) {
      mismatches.push({
        file: rel,
        expected:
          "every label-preflight invocation wrapped in run_hidden.ts (label names and referencing file paths are target content a hide-details log may not carry)",
        got: "an unwrapped invocation",
      });
    }
    if (String(preflight.id ?? "") !== "labels") {
      mismatches.push({
        file: rel,
        expected:
          "id: labels on the preflight step (the stood-down notice reads steps.labels.outputs.*)",
        got: preflight.id === undefined ? "no id" : `id: ${String(preflight.id)}`,
      });
    }
  }
  return { applies: applyAts.length, mismatches };
}

/** One workflow file's whole judgment: every job through
 *  labelPreflightJobMismatches, plus the anchor-lost throw - a parsed
 *  document with no settings-apply step anywhere means the rule's
 *  subject vanished, which must never pass silently. Exported so the
 *  suite can prove the throw fires on an apply-free document. */
export function labelPreflightFileMismatches(
  rel: string,
  workflow: Record<string, unknown>,
): Mismatch[] {
  const mismatches: Mismatch[] = [];
  let applies = 0;
  for (const [jobName, job] of Object.entries(asMapping(workflow.jobs))) {
    const result = labelPreflightJobMismatches(rel, jobName, asMapping(job), workflow);
    applies += result.applies;
    mismatches.push(...result.mismatches);
  }
  if (applies === 0) throw new Error(`${rel}: no github-settings-as-code step - anchor lost`);
  return mismatches;
}

// --- check-chain expansion --------------------------------------------------

/** Transitively expand a package.json script through its `bun run X` calls;
 *  returns the concatenated bodies and every script name reached. */
export function expandCheckChain(
  scripts: Record<string, string>,
  entry: string,
): { text: string; names: Set<string> } {
  const names = new Set<string>();
  const bodies: string[] = [];
  const visit = (name: string) => {
    if (names.has(name) || !(name in scripts)) return;
    names.add(name);
    const body = scripts[name];
    bodies.push(body);
    for (const match of body.matchAll(/bun run ([A-Za-z0-9:_-]+)/g)) visit(match[1]);
  };
  visit(entry);
  return { text: bodies.join("\n"), names };
}

// --- the smoke recipe's staging pin -------------------------------------------

/** AGENTS.md's smoke-generate recipe stages a scratch build tree by hand;
 *  its staging command is a mirror of shared/stage_tree.ts's hermetic
 *  argv with no code twin the wiring tests can see (they pin call SITES,
 *  and a doc line is not one). Decision: a rule, not an accepted
 *  residual - a drifted recipe re-opens for the human's scratch tree the
 *  exact producer-vs-verifier skew the shared argv closed, so the doc
 *  command is derived FROM stageComposedTreeArgv and compared exactly.
 *  Anchored between the recipe's init and commit legs, so a staging
 *  command that vanished or moved fails loudly rather than vacuously. */
export function agentsStagingMismatches(agents: string): Mismatch[] {
  const argv = stageComposedTreeArgv("/tmp/bt");
  // Joining argv with spaces is only an exact shell rendering while
  // every element is a bare word; a helper argv that ever grows an
  // element needing quoting must fail HERE, not derive a doc
  // expectation that would break a human's shell.
  for (const word of argv) {
    if (!/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) {
      throw new Error(
        `stageComposedTreeArgv: '${word}' is not a bare shell word - the recipe pin cannot render it`,
      );
    }
  }
  const expected = argv.join(" ");
  // Anchored to the smoke bullet itself (markdown bullets are one
  // source line by repo convention) and LAZY up to the first
  // staging-shaped span, so neither a staging command quoted elsewhere
  // in the doc nor a second copy later on the same bullet line can
  // stand in for the recipe's own leg.
  const recipe = mustMatch(
    agents,
    /^- Smoke-generate locally[^\n]*?`git -C \/tmp\/bt init -b build && ([^`]+?) && git -C \/tmp\/bt commit -m build`/m,
    "AGENTS.md",
    "the smoke recipe's staging command",
  )[1];
  if (recipe === expected) return [];
  return [
    {
      file: "AGENTS.md",
      expected: `the staging command '${expected}' (stageComposedTreeArgv - the recipe must stage the same bytes the producers publish)`,
      got: `'${recipe}'`,
    },
  ];
}

// --- action pins -------------------------------------------------------------

export interface Pin {
  file: string;
  action: string;
  ref: string;
}

/** `uses: <owner>/<action>@<ref>` pins in a file, commented examples
 *  included; `uses: ./...` locals and jinja-ref lines are skipped. The
 *  action key is owner/repo (subpaths like codeql-action/init collapse). */
export function extractUsesPins(text: string, file: string): Pin[] {
  const pins: Pin[] = [];
  for (const rawLine of text.split("\n")) {
    // Substitute jinja expressions with a sentinel that cannot be part of a
    // valid owner/action or ref: a line can carry BOTH a real pin and
    // unrelated jinja, so skipping the whole line would drop the pin.
    const line = rawLine.replace(/\{\{[^}]*\}\}/g, "<JINJA>");
    const match = line.match(/uses:\s*['"]?([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)@([^\s'"]+)/);
    if (!match) continue;
    if (match[2].includes("<JINJA>")) continue;
    const action = match[1].split("/").slice(0, 2).join("/");
    pins.push({ file, action, ref: match[2] });
  }
  return pins;
}

export function pinMismatches(pins: Pin[], allowed: Record<string, string[]>): Mismatch[] {
  const byAction = new Map<string, Pin[]>();
  for (const pin of pins) {
    byAction.set(pin.action, [...(byAction.get(pin.action) ?? []), pin]);
  }
  const mismatches: Mismatch[] = [];
  for (const [action, actionPins] of [...byAction.entries()].sort()) {
    const refs = [...new Set(actionPins.map((p) => p.ref))].sort();
    // An allowlisted action must match its declared split exactly, so a
    // stale entry (split collapsed back to one ref) is flagged for removal.
    if (action in allowed) {
      if (sortedSet(allowed[action]) !== refs.join(", ")) {
        mismatches.push({
          file: action,
          expected: `the allowlisted refs [${sortedSet(allowed[action])}]`,
          got: refs.join(", "),
        });
      }
      continue;
    }
    if (refs.length === 1) continue;
    const sites = refs
      .map(
        (ref) =>
          `${ref} (${sortedSet(actionPins.filter((p) => p.ref === ref).map((p) => p.file))})`,
      )
      .join("; ");
    mismatches.push({ file: action, expected: "a single pinned ref", got: sites });
  }
  for (const action of Object.keys(allowed).sort()) {
    if (!byAction.has(action)) {
      mismatches.push({
        file: action,
        expected: "an action still pinned somewhere (allowlisted)",
        got: "no uses: pins found (stale allowlist entry - remove it)",
      });
    }
  }
  return mismatches;
}

// --- starter delivery pins ----------------------------------------------------

/** The green-gated branch every rendered self-pin executes from. A twin of
 *  publish.ts's BRANCH constant (build-branches.yml's one delivery
 *  channel), pinned against it by the starter-pin-rollout rule; a
 *  delivery-branch rename updates both, plus a PIN_FLIPS rollout entry for
 *  every starter pin the rename moves (the reverse coverage direction is
 *  what makes forgetting the entry loud). */
export const DELIVERY_REF = "build";

export interface StarterPin {
  file: string;
  /** The rendered pin's stem after the username: repo-platform/<path>. */
  stem: string;
  ref: string;
}

/** The self-delivery pins in one template source, matched the way the
 *  rollout's own rewriter matches them (rolloutContent in
 *  sync/starter_pin_rollout.ts): every
 *  `{{ github_username }}/repo-platform/<path>@<ref>` token anywhere in
 *  the text - uses: lines, folded scalars, comments alike - so this rule
 *  and the rewrite can never disagree about what is a pin. The rewriter's
 *  owner boundary is mirrored too: a token glued to a preceding owner-name
 *  character renders as a LONGER owner that merely ends in the username -
 *  someone else's pin. Third-party pins (actions/checkout@vN) are each
 *  rendered repo's own dependabot's to bump and are not delivery pins. The
 *  ref token is taken verbatim (up to whitespace or a quote, the rollout's
 *  own ref grammar), so a non-literal ref fails coverage rather than
 *  escaping the check. */
export function starterSelfPins(text: string, file: string): StarterPin[] {
  const token =
    /(?<![A-Za-z0-9-])\{\{\s*github_username\s*\}\}\/(repo-platform\/[A-Za-z0-9_./-]+)@([^\s"']*)/g;
  return [...text.matchAll(token)].map((match) => ({
    file,
    stem: match[1],
    ref: match[2],
  }));
}

/** The compose-anchor names a shared template carries, in the composer's
 *  lenient hint spelling (compose_template.ts's ANCHOR_HINT_RE; the
 *  composer itself then rejects non-canonical variants, so lenient here is
 *  over-coverage, never under). */
export function composeAnchorNames(text: string): string[] {
  return [...text.matchAll(/\{#-?[ \t]*compose:([a-z0-9][a-z0-9-]*)/g)].map((match) => match[1]);
}

/** Anchor names expanded with the composer's generator-input fragment:
 *  toolchain-setup.jinja is no anchor's fragment, but the composer
 *  prepends its bytes into each module's contributions to the
 *  TOOLCHAIN_SETUP_TARGETS anchors (applyToolchainSetup), so it reaches
 *  every starter those anchors feed. */
export function withToolchainSetup(anchors: ReadonlySet<string>): Set<string> {
  const out = new Set(anchors);
  if (TOOLCHAIN_SETUP_TARGETS.some((target) => out.has(target))) {
    out.add(TOOLCHAIN_SETUP_FRAGMENT);
  }
  return out;
}

/** The fragment sources spliced into the given anchors:
 *  templates/<module>/fragments/<name>.jinja. A free-form anchor in a
 *  starter splices these into the rendered starter, so a pin in one is a
 *  starter pin - the rollout rule scans them alongside the starter's own
 *  source. */
export function fragmentFilesFor(
  anchorNames: ReadonlySet<string>,
  templateFiles: string[],
): string[] {
  return templateFiles.filter((rel) => {
    const match = /^templates\/[^/]+\/fragments\/([^/]+)\.jinja$/.exec(rel);
    return match !== null && anchorNames.has(match[1]);
  });
}

/** The template sources that land starter-classed paths: repo-relative
 *  `templates/<source>/...` paths filtered by their LANDED path (the
 *  .jinja suffix and filename gates stripped), so a gated starter counts
 *  and a managed or split template never does. */
export function starterTemplateFiles(
  templateFiles: string[],
  starterPaths: ReadonlySet<string>,
): string[] {
  return templateFiles.filter((rel) => {
    const inner = rel.split("/").slice(2).join("/");
    if (inner === "") return false;
    return starterPaths.has(landedPathAndGates(inner.replace(/\.jinja$/, "")).path);
  });
}

interface PinFlip {
  stem: string;
  from: readonly string[];
  to: string;
}

/** Both directions of the starter-pin/rollout coupling, plus the flip
 *  list's own shape. Forward: every starter self-pin must be the delivery
 *  ref or the `to` of a PIN_FLIPS entry for its stem - starters render
 *  ONCE (_skip_if_exists), so a template pin edit alone never reaches a
 *  repo that already rendered, and the one-run rollout
 *  (sync/starter_pin_rollout.ts) is the only carrier; a pin change without
 *  its rollout entry goes loud here. Reverse: every flip's `to` must be
 *  some starter's actual pin - a flip porting the fleet to a ref fresh
 *  renders do not get is the same fork in the other direction, and a stale
 *  flip left after the template moved on surfaces the same way. Shape:
 *  a flip with no retired refs, one whose `from` carries its own target,
 *  or a second entry for a stem ports nothing or double-reports
 *  (PIN_FLIPS' own contract), so those mismatch outright. The residual is
 *  history: a change that retires PIN_FLIPS and renames the delivery ref
 *  in the same commit satisfies a point-in-time check by construction. */
export function starterPinCoverage(
  pins: StarterPin[],
  flips: readonly PinFlip[],
  deliveryRef: string,
): Mismatch[] {
  const mismatches: Mismatch[] = [];
  for (const [index, flip] of flips.entries()) {
    if (flips.findIndex((other) => other.stem === flip.stem) !== index) {
      mismatches.push({
        file: ".github/scripts/sync/starter_pin_rollout.ts",
        expected: `one PIN_FLIPS entry for stem ${flip.stem} (two would double-report hand pins)`,
        got: "a second entry for the stem",
      });
    }
    if (flip.from.length === 0) {
      mismatches.push({
        file: ".github/scripts/sync/starter_pin_rollout.ts",
        expected: `retired refs in the ${flip.stem} flip's from list`,
        got: "an empty from list - the flip ports nothing",
      });
    }
    if (flip.from.includes(flip.to)) {
      mismatches.push({
        file: ".github/scripts/sync/starter_pin_rollout.ts",
        expected: `the ${flip.stem} flip's target outside its own from list`,
        got: `'${flip.to}' as both a retired ref and the target`,
      });
    }
  }
  for (const pin of pins) {
    const covered =
      pin.ref === deliveryRef ||
      flips.some((flip) => flip.stem === pin.stem && flip.to === pin.ref);
    if (!covered) {
      mismatches.push({
        file: pin.file,
        expected:
          `${pin.stem}@${deliveryRef}, or a sync/starter_pin_rollout.ts PIN_FLIPS entry ` +
          `with to: '${pin.ref}' (starters render once, so only the rollout can carry a pin change to the fleet)`,
        got: `@${pin.ref} with no rollout entry`,
      });
    }
  }
  for (const flip of flips) {
    if (!pins.some((pin) => pin.stem === flip.stem && pin.ref === flip.to)) {
      mismatches.push({
        file: ".github/scripts/sync/starter_pin_rollout.ts",
        expected: `a starter template pinning ${flip.stem}@${flip.to} (a flip's target is what a fresh render gets)`,
        got: "no starter carries that pin - the flip ports the fleet to a ref the template does not ship",
      });
    }
  }
  return mismatches;
}

// --- bun types/runtime coupling -----------------------------------------------

/** MAJOR.MINOR of a plain version or a single caret/tilde range - the only
 *  grammars the coupled manifests use. Anything else (compound ranges,
 *  prerelease tags, trailing junk) throws rather than reading a prefix: a
 *  half-parsed range passing vacuously is exactly the silent drift the
 *  rule exists to stop. */
export function majorMinor(version: string, where: string): [number, number] {
  const match = /^[\^~]?(\d+)\.(\d+)(?:\.\d+)?$/.exec(version);
  if (!match) throw new Error(`${where}: cannot read MAJOR.MINOR from '${version}'`);
  return [Number(match[1]), Number(match[2])];
}

/** Mismatches where an installed @types/bun MAJOR.MINOR is AHEAD of the
 *  pinned bun runtime's. One direction on purpose: the two sides have
 *  two updaters that each move only their own (dependabot bumps the types,
 *  refresh-toolchains bumps the runtime pin), so symmetric equality would
 *  make their PRs mutually blocking - each red until the other lands.
 *  Types ahead means typechecking against APIs the pinned runtime does not
 *  have, so that direction holds until the runtime catches up; a runtime
 *  ahead of the types is dependabot's next cycle and passes. */
export function bunTypesAheadMismatches(
  runtimeVersion: string,
  types: { file: string; version: string }[],
): Mismatch[] {
  const [runtimeMajor, runtimeMinor] = majorMinor(runtimeVersion, "bun runtime pin");
  const mismatches: Mismatch[] = [];
  for (const { file, version } of types) {
    const [major, minor] = majorMinor(version, file);
    if (major > runtimeMajor || (major === runtimeMajor && minor > runtimeMinor)) {
      mismatches.push({
        file,
        expected: `@types/bun at MAJOR.MINOR ${runtimeMajor}.${runtimeMinor} or older (templates/bun/module.yml pins the runtime at ${runtimeVersion})`,
        got: `${version} - types ahead of the runtime; bump the toolchain pin first (refresh-toolchains owns it)`,
      });
    }
  }
  return mismatches;
}

/** The resolved @types/bun version a bun.lock INSTALLS: the packages
 *  section's top-level `"@types/bun"` entry, whose first tuple element is
 *  `@types/bun@<version>`. The lock is what typechecking actually runs
 *  against - a caret range in package.json admits a lock resolving a
 *  newer MINOR, so the declared floor alone cannot vouch for the
 *  installed version. mustMatch keeps a lockfile that stops carrying the
 *  entry loud instead of vacuous; nested per-package resolutions
 *  ("x/@types/bun") are not the version the root typecheck sees and do
 *  not match the anchored key. */
export function lockedTypesBunVersion(lockText: string, where: string): string {
  return mustMatch(
    lockText,
    /^\s*"@types\/bun": \["@types\/bun@([^"]+)",/m,
    where,
    "the resolved @types/bun lock entry",
  )[1];
}

// --- spawnSync hang bounds ------------------------------------------------

/** The single expression `text` parses to (wrapping parentheses
 *  unwrapped), or null when it is not a lone, clean expression - the
 *  shared entry for reading option and stdio literals structurally. */
function parsedExpression(text: string): Expression | null {
  const wrapped = `(${text});`;
  if (syntaxErrorCount(wrapped) > 0) return null; // recovered nodes are unauditable
  const statements = parseTs(wrapped).getStatements();
  const statement = statements.length === 1 ? statements[0] : undefined;
  if (statement === undefined || !Node.isExpressionStatement(statement)) return null;
  return unwrapExpression(statement.getExpression());
}

/** The top-level properties of an options OBJECT LITERAL: property name
 *  -> initializer text (a shorthand property maps to its own name),
 *  read off the parsed literal, so a comma or colon inside a nested
 *  value or a string can never split or fake a property. Null when the
 *  text is not an auditable literal - a variable, a call result, a
 *  top-level spread, a method, a computed or non-identifier-shaped key
 *  - which the caller treats as a hazard, so the unreadable shapes fail
 *  closed. */
export function topLevelProperties(options: string): Map<string, string> | null {
  const text = options.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return null;
  const literal = parsedExpression(text);
  if (literal === null || !Node.isObjectLiteralExpression(literal)) return null;
  const props = new Map<string, string>();
  for (const property of literal.getProperties()) {
    if (Node.isShorthandPropertyAssignment(property)) {
      props.set(property.getName(), property.getName());
      continue;
    }
    if (!Node.isPropertyAssignment(property)) return null; // a spread, a method - unauditable
    const nameNode = property.getNameNode();
    const name = Node.isStringLiteral(nameNode) ? nameNode.getLiteralValue() : nameNode.getText();
    if (
      !(Node.isIdentifier(nameNode) || Node.isStringLiteral(nameNode)) ||
      !/^[A-Za-z_$][\w$]*$/.test(name)
    ) {
      return null; // a computed or exotic key - unauditable
    }
    const value = property.getInitializer()?.getText().trim();
    if (value === undefined || value === "") return null;
    props.set(name, value);
  }
  return props;
}

/** A stdio value's shape, decided on the PARSED expression (wrapping
 *  parentheses and type dressing unwrap first, so `(["pipe"])` is still
 *  the array it is): slot texts for a spread-free array literal (an
 *  elided slot reads as empty), unauditable for a spread-carrying array
 *  or unparseable text (a spread can shift or inject stream slots), and
 *  scalar for everything else (a named constant, trusted by its key
 *  like other variable values). */
function stdioShape(
  text: string,
): { kind: "slots"; slots: string[] } | { kind: "unauditable" } | { kind: "scalar" } {
  const literal = parsedExpression(text);
  if (literal === null) return { kind: "unauditable" };
  if (!Node.isArrayLiteralExpression(literal)) return { kind: "scalar" };
  const elements = literal.getElements();
  if (elements.some(Node.isSpreadElement)) return { kind: "unauditable" };
  return {
    kind: "slots",
    slots: elements.map((element) =>
      Node.isOmittedExpression(element) ? "" : element.getText().trim(),
    ),
  };
}

// A GLOBAL receiver (Bun, process), shared by the spawn and stream-write
// scans and hardened against decorative spellings: parentheses, the TS
// non-null `!`, and type-only wrappers unwrap to the same receiver, and a
// property access ENDING in the global's name (globalThis.Bun,
// globalThis.process - like the old scans' token boundary) counts too -
// over-matching someone else's `.Bun`/`.process` is the loud direction.
// Identifier names match EXACTLY: a look-alike like `fakeprocess` is not
// the global (the retired stream-write regex over-flagged it for want of
// a left boundary - a recorded precision delta, not a lost guard).
// The recorded residual: an alias of the global itself
// (`const b = Bun; b.spawnSync(...)`) - nothing in house style writes
// that, and the proc.ts helpers are the sanctioned route.
function isGlobalReceiver(expression: Expression, name: string): boolean {
  const node = unwrapExpression(expression);
  if (Node.isIdentifier(node)) return node.getText() === name;
  return Node.isPropertyAccessExpression(node) && node.getName() === name;
}

/** Whether a property-name text names spawnSync as a whole word - the
 *  destructure scans' test, so a computed spelling (["spawnSync"], or a
 *  variable named spawnSync) fails closed exactly like the plain key. */
function namesSpawnSync(nameText: string): boolean {
  return /(^|[^\w$])spawnSync([^\w$]|$)/.test(nameText) || nameText === "spawnSync";
}

/** The CallExpression `node` is the callee of (parentheses and non-null
 *  wrappers between them unwrapped), or null when the access is not
 *  directly called - `f(Bun.spawnSync)` passes it as a value, and
 *  `Bun.spawnSync.call(...)` calls a DIFFERENT member off it. */
function enclosingCall(node: Node): CallExpression | null {
  let current: Node = node;
  for (;;) {
    const parent = current.getParent();
    if (parent === undefined) return null;
    if (Node.isParenthesizedExpression(parent) || Node.isNonNullExpression(parent)) {
      current = parent;
      continue;
    }
    return Node.isCallExpression(parent) && parent.getExpression() === current ? parent : null;
  }
}

/** A spawnSync occurrence in parsed source: a direct `Bun.spawnSync`
 *  call with its options text, or any other reference - an alias, a
 *  destructure pulling spawnSync off Bun, bracket access - a sum, so
 *  the rule cannot forget to judge the non-call shapes. */
export type SpawnSyncSite =
  | { line: number; kind: "call"; options: string | null }
  | { line: number; kind: "reference" };

/** The options argument's text for a direct spawnSync call: the second
 *  argument, the whole argument list for the object-form overload
 *  (whose options ride beside `cmd`; extra arguments keep riding along
 *  so topLevelProperties refuses the unauditable shape), or null when
 *  the call passes the command alone. */
function spawnOptionsText(call: CallExpression): string | null {
  const args = call.getArguments();
  if (args.length === 0) return null;
  if (Node.isObjectLiteralExpression(args[0])) {
    return args.map((argument) => argument.getText()).join(", ");
  }
  if (args.length === 1) return null;
  return args
    .slice(1)
    .map((argument) => argument.getText())
    .join(", ");
}

/** Every spawnSync site in a source file, read off the AST (a mention
 *  in a comment, a string, or a regex body is not a node; a template
 *  INTERPOLATION is code and is). A direct call - plain, optional, or
 *  re-punctuated - carries its options argument's text. Everything else
 *  is a reference the rule fails closed: a bare `Bun.spawnSync` (an
 *  alias binding, `.call`), a destructure pulling spawnSync off Bun (a
 *  binding pattern or an assignment target), and ANY computed access
 *  directly on Bun - the property expression can spell spawnSync any
 *  way it likes, so every such access is unauditable. */
export function spawnSyncSites(source: string, where: string): SpawnSyncSite[] {
  // A file the parser had to RECOVER must not be judged: a truncated
  // call's recovered options can read as a benign shape, so the scan
  // throws instead of passing vacuously (the old lexer's contract).
  if (syntaxErrorCount(source) > 0) {
    throw new Error(`${where}: source has syntax errors - the spawn scan cannot audit it`);
  }
  const sites: SpawnSyncSite[] = [];
  for (const node of parseTs(source).forEachDescendantAsArray()) {
    if (
      Node.isPropertyAccessExpression(node) &&
      node.getName() === "spawnSync" &&
      isGlobalReceiver(node.getExpression(), "Bun")
    ) {
      const line = node.getStartLineNumber();
      const call = enclosingCall(node);
      if (call === null) sites.push({ line, kind: "reference" });
      else sites.push({ line, kind: "call", options: spawnOptionsText(call) });
      continue;
    }
    if (Node.isElementAccessExpression(node) && isGlobalReceiver(node.getExpression(), "Bun")) {
      sites.push({ line: node.getStartLineNumber(), kind: "reference" });
      continue;
    }
    // The destructure shapes: `const { spawnSync } = Bun` (a binding
    // pattern, parameter defaults included) and `({ spawnSync } = Bun)`
    // (an assignment target). The initializer counts when its ROOT
    // identifier is Bun (`= Bun.anything` fails closed too) or when it
    // is the global receiver itself in any spelling (globalThis.Bun).
    if (Node.isObjectBindingPattern(node)) {
      const owner = node.getParent();
      const initializer =
        Node.isVariableDeclaration(owner) || Node.isParameterDeclaration(owner)
          ? owner.getInitializer()
          : undefined;
      const pulls = node
        .getElements()
        .some((element) =>
          namesSpawnSync((element.getPropertyNameNode() ?? element.getNameNode()).getText()),
        );
      if (
        pulls &&
        initializer !== undefined &&
        (rootIdentifier(initializer) === "Bun" || isGlobalReceiver(initializer, "Bun"))
      ) {
        sites.push({ line: node.getStartLineNumber(), kind: "reference" });
      }
      continue;
    }
    if (
      Node.isBinaryExpression(node) &&
      node.getOperatorToken().getKind() === SyntaxKind.EqualsToken
    ) {
      const left = unwrapExpression(node.getLeft());
      const pulls =
        Node.isObjectLiteralExpression(left) &&
        left
          .getProperties()
          .some(
            (property) =>
              (Node.isShorthandPropertyAssignment(property) ||
                Node.isPropertyAssignment(property)) &&
              namesSpawnSync(property.getNameNode().getText()),
          );
      if (
        pulls &&
        (rootIdentifier(node.getRight()) === "Bun" || isGlobalReceiver(node.getRight(), "Bun"))
      ) {
        sites.push({ line: node.getStartLineNumber(), kind: "reference" });
      }
    }
  }
  return sites.sort((a, b) => a.line - b.line);
}

/** Why a spawnSync call is an unbounded piped hazard, or null when safe.
 *  Measured on the pinned bun runtime (templates/bun/module.yml, 1.4.0):
 *  a PIPED synchronous spawn without an effective `timeout` returns at
 *  pipe EOF, not child exit, so a descendant holding the inherited pipe
 *  fds wedges the caller indefinitely - and a bare call pipes BOTH
 *  output streams by default (proc.ts's header records the semantics;
 *  its helpers carry the bound already). Safe shapes: a top-level
 *  `timeout` that is a positive finite numeric literal (any spelling of
 *  zero, and Infinity, measured or reasoned as no bound) or a plain
 *  identifier/member path (a named constant like DEFAULT_HANG_BOUND_MS -
 *  trusted, the stated residual), or every output stream explicitly
 *  shaped - a `stdio:` array whose slots 1 and 2 are each present and
 *  not undefined/null, or `stdout:`/`stderr:` values likewise - with no
 *  "pipe" literal among them (inherit/ignore/file fds have no EOF to
 *  wait on). Any other timeout value (an expression like `1 - 1`) is unprovable and fails closed. Properties
 *  are read structurally at the object literal's top level
 *  (topLevelProperties), so a nested `timeout` (say inside `env:`) never
 *  reads as a bound, and options the parser cannot audit are hazards
 *  outright. The residual of staying text-level: variable VALUES are
 *  trusted by their key - a variable smuggling "pipe" into a stream, or
 *  zero into `timeout`, escapes - and the fix for any flagged or
 *  doubtful site is the same: a proc.ts helper. */
export function spawnSyncHazard(options: string | null): string | null {
  if (options === null) {
    return "no options - stdout and stderr pipe by default, and nothing bounds a pipe-holding descendant";
  }
  const props = topLevelProperties(options);
  if (props === null) {
    return "options the scanner cannot audit (a variable, a spread, or a non-literal shape)";
  }
  const timeout = props.get("timeout");
  let bounded = false;
  if (timeout !== undefined && !["undefined", "null", "NaN", "Infinity"].includes(timeout)) {
    // Numeric-separator spellings (10_000) are literals too - strip the
    // separators before folding, so a bounded call does not misread as
    // unprovable (and every separator spelling of zero still folds to 0).
    const n = Number(timeout.replaceAll("_", ""));
    // Number() folds every numeric spelling of zero (0, 0.0, 0x0, 0e0,
    // -0, +0) onto 0; a non-numeric value only counts when it is a plain
    // identifier or member path - an expression can evaluate to zero
    // (`1 - 1`) and is unprovable, so it fails closed.
    bounded = Number.isNaN(n)
      ? /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(timeout)
      : Number.isFinite(n) && n > 0;
  }
  if (bounded) return null;
  const why = timeout === undefined ? "no timeout" : `timeout: ${timeout} is not a provable bound`;
  const pipes = (value: string | undefined) => value !== undefined && /["'`]pipe["'`]/.test(value);
  if (pipes(props.get("stdio")) || pipes(props.get("stdout")) || pipes(props.get("stderr"))) {
    return `explicitly piped stdio with ${why}`;
  }
  const unset = (value: string | undefined) =>
    value === undefined || value === "" || value === "undefined" || value === "null";
  // A stdio ARRAY literal shapes each stream through its own slot
  // (1 = stdout, 2 = stderr): an omitted, elided, or undefined/null slot
  // leaves that stream on the piped default. A non-array stdio value (a
  // named constant) is trusted by its key, like other variable values.
  const stdio = props.get("stdio");
  const stdioTrimmed = stdio?.trim();
  const shape = stdioTrimmed === undefined ? { kind: "scalar" as const } : stdioShape(stdioTrimmed);
  if (shape.kind === "unauditable") {
    return `a stdio value the scanner cannot audit (a spread or non-literal shape) with ${why}`;
  }
  const slots = shape.kind === "slots" ? shape.slots : null;
  const shaped = (stream: "stdout" | "stderr", slot: number) => {
    const viaStdio = slots !== null ? slots[slot] : stdioTrimmed;
    return !unset(viaStdio) || !unset(props.get(stream));
  };
  const unshaped = (["stdout", "stderr"] as const).filter(
    (stream, index) => !shaped(stream, index + 1),
  );
  if (unshaped.length > 0) {
    return `${unshaped.join(" and ")} left to the piped default with ${why}`;
  }
  return null;
}

// ASYNC Bun.spawn is a different hazard model, judged as an EXACT-SET
// enumeration rather than by the sync rule's bounded-or-unpiped bar:
// an async site draining both pipes under Promise.all has no pipe-EOF
// deadlock to bound, and the async Subprocess type has no `timeout`
// option to pin - so every file calling Bun.spawn must appear here
// with the rationale that bounds it (a manual deadline, or an outer
// bound like the GitHub job timeout). The set pins NAMES, not a count:
// a bounded spawnSync rewritten as async would EXIT the sync gate
// silently - reading as an improvement - so the laundering must fail
// by introducing a name this pin does not carry, a diagnostic that
// names the offending file. The async scan's residual: an alias of Bun
// escapes both scans, and a computed access (Bun["spawn"]) escapes THIS
// one (the sync scan fails computed access closed as a reference).
export const ASYNC_SPAWN_FILES: Record<string, string> = {
  ".github/scripts/sync/rehearse_fleet.ts":
    "implements its own manual deadline: the async Subprocess type has no built-in timeout, so a timer SIGKILLs an overrunning lane (the comment at its Bun.spawn call is the reference statement of why async needs one)",
  "actions/fuzz-issue/fuzz-issue.ts":
    "gh runner draining both pipes concurrently under Promise.all; bounded by the GitHub job timeout",
  "actions/release-health/release-health.ts":
    "gh runner draining both pipes concurrently under Promise.all; bounded by the GitHub job timeout",
};

/** The exact-set judgment for one file's async Bun.spawn mentions
 *  (property accesses on the Bun receiver, read off the AST, so
 *  comments and strings never count, `spawn` cannot match inside
 *  spawnSync, and a re-punctuated callee - `(Bun).spawn`, `Bun!.spawn`
 *  - is still a site). An unenumerated file with any site fails per
 *  site; an enumerated file with none left is a stale entry - the set
 *  stays exact in both directions. */
export function asyncSpawnMismatches(rel: string, source: string, enumerated: boolean): Mismatch[] {
  if (syntaxErrorCount(source) > 0) {
    throw new Error(`${rel}: source has syntax errors - the spawn scan cannot audit it`);
  }
  const lines = parseTs(source)
    .forEachDescendantAsArray()
    .filter(
      (node): node is PropertyAccessExpression =>
        Node.isPropertyAccessExpression(node) &&
        node.getName() === "spawn" &&
        isGlobalReceiver(node.getExpression(), "Bun"),
    )
    .map((node) => node.getStartLineNumber());
  if (!enumerated) {
    return lines.map((line) => ({
      file: `${rel}:${line}`,
      expected:
        "no async Bun.spawn outside ASYNC_SPAWN_FILES (async sites are deadline-or-enumerated: " +
        "no timeout option exists there, so each site's bound is a recorded rationale; a sync " +
        "site rewritten async exits the sync gate and must land here, by name)",
      got: "an unenumerated async Bun.spawn",
    }));
  }
  if (lines.length === 0) {
    return [
      {
        file: rel,
        expected: "an async Bun.spawn call (the ASYNC_SPAWN_FILES entry's subject)",
        got: "none - stale enumeration entry; remove it",
      },
    ];
  }
  return [];
}

// --- local runtime pin -------------------------------------------------------

/** Mismatch when the LOCAL bun runtime's MAJOR.MINOR differs from the
 *  pinned one - injectable versions so the failing pair is testable
 *  without downgrading the real runtime. Exactly one direction exists:
 *  a local gate run under a runtime the pin does not name proves nothing
 *  about CI's behavior in either direction (semantics moved BOTH ways
 *  across 1.3/1.4 - spawnSync pipe-EOF waits, pipe-buffer sizes). */
export function bunRuntimeMismatches(runtimeVersion: string, pinnedVersion: string): Mismatch[] {
  const [runtimeMajor, runtimeMinor] = majorMinor(runtimeVersion, "the local bun runtime");
  const [pinnedMajor, pinnedMinor] = majorMinor(pinnedVersion, ".bun-version");
  if (runtimeMajor === pinnedMajor && runtimeMinor === pinnedMinor) return [];
  return [
    {
      file: ".bun-version",
      expected: `a local bun runtime at MAJOR.MINOR ${pinnedMajor}.${pinnedMinor} (the pinned toolchain)`,
      got: `local bun ${runtimeMajor}.${runtimeMinor} does not match the pinned ${pinnedMajor}.${pinnedMinor} - bun upgrade / install the pin; local greens under a different runtime are unreliable`,
    },
  ];
}

// --- async stream writes ----------------------------------------------------

/** Async stream-write call sites - `process.stdout.write(...)` and the
 *  stderr twin, optional chaining and decorative wrappers tolerated -
 *  read off the AST, so a mention in a comment, a string, or a regex
 *  body never fires while a template INTERPOLATION's call does. The
 *  residual: an alias of the stream or the method
 *  (`const out = process.stdout; out.write(x)`) escapes - nothing in
 *  house style writes that, and writeSync is the sanctioned route. */
function asyncStreamWriteCalls(source: string): CallExpression[] {
  return parseTs(source)
    .forEachDescendantAsArray()
    .filter((node): node is CallExpression => {
      if (!Node.isCallExpression(node)) return false;
      const callee = unwrapExpression(node.getExpression());
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "write") return false;
      const stream = unwrapExpression(callee.getExpression());
      if (
        !Node.isPropertyAccessExpression(stream) ||
        (stream.getName() !== "stdout" && stream.getName() !== "stderr")
      ) {
        return false;
      }
      return isGlobalReceiver(stream.getExpression(), "process");
    });
}

/** Whether anything exit-capable sits at or after `at`: process.exit
 *  itself (a reference suffices), an uncaught `throw` (the abort path
 *  drains no queued writes either), and calls to the helpers that exit
 *  (gha's fail/requireEnv, proc's must/mustCapture). Lexical order over
 *  a roster, not control-flow proof: a locally defined wrapper around
 *  process.exit called after the write stays a reviewable residual. */
function exitCapableAfter(source: string, at: number): boolean {
  const EXIT_CALLEES = new Set(["fail", "requireEnv", "must", "mustCapture"]);
  return parseTs(source)
    .forEachDescendantAsArray()
    .some((node) => {
      if (node.getStart() < at) return false;
      if (Node.isThrowStatement(node)) return true;
      if (Node.isPropertyAccessExpression(node) && node.getName() === "exit") {
        return isGlobalReceiver(node.getExpression(), "process");
      }
      if (!Node.isCallExpression(node)) return false;
      const callee = unwrapExpression(node.getExpression());
      const name = Node.isIdentifier(callee)
        ? callee.getText()
        : Node.isPropertyAccessExpression(callee)
          ? callee.getName()
          : null;
      return name !== null && EXIT_CALLEES.has(name);
    });
}

/** Files allowed to keep async stream writes because every exit-capable
 *  call precedes the first async write, so the writes ride to a natural
 *  exit, which drains. The reason is EXECUTABLE, not prose:
 *  asyncStreamWriteMismatches re-proves it per entry (nothing exit-capable
 *  may follow the first write) and flags an entry whose file has no async
 *  write left as stale. Empty since open_pr.ts converted its auto-merge
 *  re-emission to writeSync; the mechanism stays fixture-tested in
 *  tests/scripts/check_ssot.test.ts. */
export const NATURAL_EXIT_WRITE_FILES: ReadonlySet<string> = new Set([]);

/** How `source` violates the stream-write-sync contract. An unlisted
 *  file may carry no async stream write at all; an allowlisted file must
 *  still carry one (else the entry is stale) with nothing exit-capable
 *  after the first. */
export function asyncStreamWriteMismatches(
  rel: string,
  source: string,
  allowlisted: boolean,
): Mismatch[] {
  if (syntaxErrorCount(source) > 0) {
    throw new Error(`${rel}: source has syntax errors - the stream-write scan cannot audit it`);
  }
  const first = asyncStreamWriteCalls(source).reduce(
    (earliest: CallExpression | null, call) =>
      earliest === null || call.getStart() < earliest.getStart() ? call : earliest,
    null,
  );
  if (!allowlisted) {
    if (first === null) return [];
    return [
      {
        file: `${rel}:${first.getStartLineNumber()}`,
        expected:
          "writeSync for stream writes (bun's async stream writes truncate at the pipe buffer when any later path exits), or a NATURAL_EXIT_WRITE_FILES entry whose reason holds",
        got: "an async stream write",
      },
    ];
  }
  if (first === null) {
    return [
      {
        file: rel,
        expected: "an async stream write (the NATURAL_EXIT_WRITE_FILES entry's reason)",
        got: "none - stale allowlist entry; remove it",
      },
    ];
  }
  if (exitCapableAfter(source, first.getStart())) {
    return [
      {
        file: rel,
        expected:
          "nothing exit-capable after the first async stream write (the natural-exit reason NATURAL_EXIT_WRITE_FILES encodes)",
        got: "an exit-capable call after it - the write can truncate; convert it to writeSync and drop the entry",
      },
    ];
  }
  return [];
}

// --- rules --------------------------------------------------------------------

/** The pinned-toolchain setup actions and the version-file input each must
 *  carry (matched against a trimmed `uses:` line, commented or not). */
export const SETUP_VERSION_FILES: [action: RegExp, input: string][] = [
  [/^-? ?uses: oven-sh\/setup-bun@/, "bun-version-file:"],
  [/^-? ?uses: actions\/setup-node@/, "node-version-file:"],
  [/^-? ?uses: denoland\/setup-deno@/, "deno-version-file:"],
];

/** Whether the workflow step whose `uses:` line sits at `usesAt` carries
 *  `key` as a DIRECT child of its OWN with: block. Structural,
 *  indentation-scoped: the step's keys live two columns inside the `- `
 *  item start, the scan stops where the step ends (a non-blank line left
 *  of the key column), and the key only counts at the with: block's
 *  direct-child level - the first child fixes that level, and anything
 *  deeper (a nested mapping, a block scalar body that merely LOOKS like
 *  the key) is a value, not an input. A comment, a neighbouring step's
 *  input, or a look-alike elsewhere never matches. */
export function stepCarriesWithKey(lines: string[], usesAt: number, key: string): boolean {
  const usesLine = lines[usesAt];
  const usesIndent = usesLine.length - usesLine.trimStart().length;
  // `- uses:` starts the item; a bare `uses:` sits under `- name:` two
  // columns in. Either way the step's sibling keys share one column.
  const keyIndent = usesLine.trimStart().startsWith("- ") ? usesIndent + 2 : usesIndent;
  let inWith = false;
  let withChildIndent: number | null = null;
  for (let i = usesAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent < keyIndent) return false;
    if (indent === keyIndent) {
      if (line.trimStart().startsWith("- ")) return false;
      inWith = line.trim() === "with:";
      withChildIndent = null;
      continue;
    }
    if (!inWith) continue;
    // The first line inside with: is necessarily a direct child (block
    // scalar bodies and nested values always sit deeper than their key).
    if (withChildIndent === null) withChildIndent = indent;
    if (indent !== withChildIndent) continue;
    if (line.trim().startsWith(key)) return true;
  }
  return false;
}

// --- all-green verdict roster -----------------------------------------------

/** Every gating job in this repository's ci.yml, by job id - the authored
 *  roster behind the all-green verdict. The runtime verdict judges whatever
 *  jobs actually ran, so it cannot notice a gate that was DELETED from
 *  ci.yml; this roster is where that deletion becomes loud. Adding a gating
 *  job means adding it here; removing one means removing its entry here in
 *  the same change, deliberately. Jobs named `info-*` are the opt-out and
 *  never appear here. */
export const ALL_GREEN_ROSTER = [
  "actionlint",
  "actionlint-binary",
  "gitleaks",
  "dependency-review",
  "shellcheck",
  "verdict-judgment",
  "yamllint",
  "biome",
  "typography",
  "commit-names",
  "typecheck",
  "action-refs",
  "compose",
  "validate-template",
  "golden-renders",
  "script-tests",
  "validate-skills",
  "skills-discovery",
  "smoke-generate",
  "upgrade-path",
  "rehearse-fleet",
  "pr-title",
  "codeql-javascript",
];

/** Set comparison between the authored roster and ci.yml's job ids.
 *  Both directions are load-bearing: a ci.yml gating job missing from the
 *  roster is a gate the roster never vouched for, and a roster entry with
 *  no ci.yml job is a REMOVED gate - the sneaky case, where deleting the
 *  job would otherwise change nothing the verdict can see. `info-*` jobs
 *  are the deliberate opt-out and are skipped. A job named `all-green` is
 *  an error outright: the verdict CHECK RUN owns that name now, and a
 *  job's own check would collide with it in the merge box. */
export function verdictRosterMismatches(
  roster: string[],
  jobs: string[],
  site: { jobsFile: string; rosterName: string } = {
    jobsFile: ".github/workflows/ci.yml",
    rosterName: "ALL_GREEN_ROSTER",
  },
): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const duplicate = roster.find((job, index) => roster.indexOf(job) !== index);
  if (duplicate !== undefined) {
    mismatches.push({
      file: `scripts/check_ssot.ts ${site.rosterName}`,
      expected: "each gating job listed once",
      got: `'${duplicate}' is listed more than once`,
    });
  }
  if (jobs.includes("all-green")) {
    mismatches.push({
      file: site.jobsFile,
      expected: "no job named 'all-green' (the verdict check run owns the name)",
      got: "a job whose check would collide with the verdict's",
    });
  }
  const gating = jobs.filter((job) => !job.startsWith("info-") && job !== "all-green");
  const expected = new Set(roster);
  for (const job of gating) {
    if (!expected.has(job)) {
      mismatches.push({
        file: site.jobsFile,
        expected: `job '${job}' in check_ssot.ts's ${site.rosterName} (every non-info-* job there gates the all-green verdict)`,
        got: "not in the roster - add it there, or name the job info-* to opt it out of gating",
      });
    }
  }
  const present = new Set(gating);
  for (const job of roster) {
    if (!present.has(job)) {
      mismatches.push({
        file: `scripts/check_ssot.ts ${site.rosterName}`,
        expected: `a ${site.jobsFile} job '${job}'`,
        got: "no such job - removing a gate is a roster edit too; delete the entry in the same change, deliberately",
      });
    }
  }
  return mismatches;
}

/** Every gating job in fleet-ci.yml, by job id - the fleet counterpart of
 *  ALL_GREEN_ROSTER. The verdict judges whatever jobs ran, and fleet-ci's
 *  jobs legitimately carry module/visibility conditions, so a job DELETED
 *  here would stop gating the entire fleet with no per-repo diff to see
 *  it; this roster is where that deletion becomes loud. */
export const FLEET_CI_ROSTER = [
  "validate-template",
  "base-checks",
  "typography",
  "commit-names",
  "actionlint",
  "yamllint",
  "gitleaks",
  "dependency-review",
  "codeql",
  "pr-title",
  "validate-skills",
  "release-freshness",
  "release-health",
];

/** The fleet wrapper TEMPLATE's exact-line pins: the wrapper is the
 *  fleet's only trigger surface for the verdict, so its shape is pinned
 *  at the source the way the repo's own workflows are (the
 *  settings-label-preflight rule is the house pattern) - one loud diff
 *  here instead of ten drifted sync PRs. Each entry is a FULL line of
 *  templates/base/.github/workflows/all-green.yml.jinja with its reason. */
export const WRAPPER_TEMPLATE_PINS: readonly [string, string][] = [
  ["    workflows: [CI]", "the verdict must fire on CI completions"],
  ["    types: [completed]", "only finished runs may be judged"],
  [
    "  pull_request_review:",
    "the review-submission wake that replaced the retired copilot poll - without it a pending verdict never hears the review land",
  ],
  ["    types: [submitted]", "only submitted reviews re-judge"],
  ["  workflow_dispatch:", "the unwedge trigger for a lost wake"],
  [
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal template line under pin
    "  group: {% raw %}${{ github.workflow }}-${{ github.event.workflow_run.head_sha || github.event.pull_request.head.sha || inputs.sha }}{% endraw %}",
    "per-sha serialization must cover every wake, the review wake included, or judgments' POSTs can interleave",
  ],
  [
    "  cancel-in-progress: false",
    "a cancelled verdict between judging and posting is a lost check",
  ],
  ["      checks: write", "the check-run POST's grant"],
  ["      actions: read", "the judgment's run reads"],
  [
    "    uses: {{ github_username }}/repo-platform/.github/workflows/reusable-all-green.yml@build",
    "the shared judgment at the green-gated build ref - any other target is not the fleet's verdict",
  ],
  [
    "      require-copilot-review: {{ (not private) | tojson }}",
    "the verdict-owned review expectation, visibility-split: Copilot reviews are disabled on private repositories, so only public renders may expect one (an unconditional true would pend every private PR forever) - and this input is the review gate's ONLY home since the ruleset's copilot context was retired",
  ],
  [
    "{# compose:conditional-workflows #}",
    "the manifest-derived conditional roster anchor (renders the conditional-workflows input in every selection)",
  ],
  [
    "{# compose:all-green-release #}",
    "the release-please leg's anchor (splices the verdict-gated release job on selecting repos; fleet-ci-render-roster pins the fragment's shape)",
  ],
];

/** The wrapper template's shape against the reusable's declared inputs,
 *  pure over the two texts so the suite can force every branch: the
 *  exact-line pins above, a ban on the retired copilot-wait-minutes
 *  input everywhere in the template, and the input census BOTH ways -
 *  every input the reusable declares is passed (three textually, the
 *  conditional roster through the compose anchor) and nothing the
 *  reusable does not declare is passed, so a retired input lingering in
 *  the wrapper (a workflow_call refuses unknown inputs, failing every
 *  fleet verdict at once) or a new input silently unpassed both go red
 *  here. */
export function wrapperTemplateMismatches(templateText: string, reusableText: string): Mismatch[] {
  const rel = "templates/base/.github/workflows/all-green.yml.jinja";
  const mismatches: Mismatch[] = [];
  const lines = templateText.split("\n");
  // The SOURCE wrapper is jinja-minimal by construction: beyond
  // {% raw %}-wrapped expressions and {{ }} substitutions, its only
  // jinja is the compose anchor (selection-conditional content arrives
  // through the anchor's GENERATOR into the composed copy, never here).
  // So ANY other {% tag (if, for, set, macro, block, anything newer) and
  // ANY jinja comment is banned outright - that is what keeps every pin
  // below honest: without the ban, a pinned line inside a dead branch, a
  // macro body, or a {# ... #} comment (single- or multi-line) would
  // satisfy the textual check while rendering to nothing.
  for (const [index, line] of lines.entries()) {
    if (line === "{# compose:conditional-workflows #}") continue;
    if (line === "{# compose:all-green-release #}") continue;
    // raw/endraw must pair ON the line: the wrapper's only raw use is
    // inline expression-wrapping, and a multiline raw block would let
    // text ride through the ban below unexamined.
    if (line.split("{% raw %}").length !== line.split("{% endraw %}").length) {
      mismatches.push({
        file: `${rel}:${index + 1}`,
        expected:
          "raw/endraw paired on one line (inline expression wrapping only - a multiline raw block smuggles text past the jinja ban)",
        got: line.trim(),
      });
      continue;
    }
    const stripped = line.replaceAll("{% raw %}", "").replaceAll("{% endraw %}", "");
    if (stripped.includes("{%") || stripped.includes("{#") || stripped.includes("#}")) {
      mismatches.push({
        file: `${rel}:${index + 1}`,
        expected:
          "no jinja tags or comments in the wrapper source beyond {% raw %} pairs and the compose anchor (conditional content belongs to the anchor's generator; a tag-wrapped or commented copy would satisfy the textual pins while rendering to nothing)",
        got: line.trim(),
      });
    }
    // Quoted keys parse identically in YAML but evade every bare-key
    // census below ('"contents": write' is a grant the regex never
    // sees), so a line whose content OPENS with a quote is refused -
    // nothing in this file legitimately starts one.
    if (/^\s*["']/.test(line)) {
      mismatches.push({
        file: `${rel}:${index + 1}`,
        expected:
          "no leading-quote lines (a quoted YAML key parses identically but evades the bare-key censuses)",
        got: line.trim(),
      });
    }
  }
  // Exactly ONE job, the verdict, and one with: block: the census below
  // reads the FIRST with:, so a decoy job carrying compliant pins next
  // to a gutted real job must be unrepresentable.
  const jobsHeaderAt = lines.indexOf("jobs:");
  if (jobsHeaderAt === -1) {
    throw new Error(`${rel}: no jobs: section - anchor lost`);
  }
  const jobIds = lines
    .slice(jobsHeaderAt + 1)
    .map((line) => /^ {2}([A-Za-z0-9_-]+):(?: |$)/.exec(line)?.[1])
    .filter((id): id is string => id !== undefined);
  if (canonical(jobIds) !== canonical(["verdict"])) {
    mismatches.push({
      file: rel,
      expected:
        "exactly one job, 'verdict' (a second job could carry compliant-looking pins while the real call is gutted)",
      got: jobIds.join(", ") || "no job ids",
    });
  }
  const withCount = lines.filter((line) => line === "    with:").length;
  if (withCount !== 1) {
    mismatches.push({
      file: rel,
      expected: "exactly one with: block (the input census below reads the first)",
      got: `${withCount} with: blocks`,
    });
  }
  // Additive-closed trigger and grant sets: the pins below prove the
  // required members PRESENT, and these censuses refuse extras - an
  // added trigger (a push: judging events the verdict never designed
  // for) or an added grant would ride to every fleet repository
  // silently. Both blocks are scoped by indent: the on: block's 2-space
  // keys until the next column-0 key, the permissions block's 6-space
  // keys until the first non-6-space line.
  const onAt = lines.indexOf("on:");
  if (onAt === -1) throw new Error(`${rel}: no on: block - anchor lost`);
  const triggers: string[] = [];
  for (const line of lines.slice(onAt + 1)) {
    if (/^[A-Za-z]/.test(line)) break;
    const key = /^ {2}([A-Za-z_]+):/.exec(line)?.[1];
    if (key !== undefined) triggers.push(key);
  }
  mismatches.push(
    ...setMismatch(
      `${rel} on: triggers`,
      ["workflow_run", "pull_request_review", "workflow_dispatch"],
      triggers,
    ),
  );
  const permissionsAt = lines.indexOf("    permissions:");
  if (permissionsAt === -1) throw new Error(`${rel}: no job permissions block - anchor lost`);
  const grants: string[] = [];
  for (const line of lines.slice(permissionsAt + 1)) {
    // Blanks and comments continue the block in YAML - at ANY indent, a
    // comment is not content - so a grant hiding behind one must still
    // be censused; only a real dedent ends the block.
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const key = /^ {6}([a-z-]+):/.exec(line)?.[1];
    if (key === undefined) break;
    grants.push(key);
  }
  mismatches.push(...setMismatch(`${rel} verdict permissions`, ["checks", "actions"], grants));
  for (const [line, why] of WRAPPER_TEMPLATE_PINS) {
    const count = lines.filter((candidate) => candidate === line).length;
    if (count !== 1) {
      mismatches.push({
        file: rel,
        expected: `the line ${JSON.stringify(line)} exactly once (${why})`,
        got:
          count === 0
            ? "missing"
            : `${count} occurrences - the LAST one wins in YAML, so duplicates can silently override`,
      });
    }
  }
  if (templateText.includes("copilot-wait-minutes")) {
    mismatches.push({
      file: rel,
      expected:
        "no copilot-wait-minutes anywhere (the input is retired with the poll; a wrapper passing it fails the workflow_call outright, fleet-wide)",
      got: "a copilot-wait-minutes mention",
    });
  }
  // The census: keys the wrapper passes textually inside the verdict
  // job's with: block (6-space keys until the block's indent ends; the
  // column-0 anchor line belongs to the block), plus the anchor's
  // generated conditional-workflows input, against the reusable's
  // declared inputs - exact set equality, both directions, duplicates
  // refused (YAML lets the last duplicate win silently).
  const withAt = lines.indexOf("    with:");
  if (withAt === -1) {
    throw new Error(
      "templates/base/.github/workflows/all-green.yml.jinja: no with: block - anchor lost",
    );
  }
  const passed: string[] = [];
  for (const line of lines.slice(withAt + 1)) {
    if (!/^( {6}|\{[#%])/.test(line) && line.trim() !== "") break;
    const key = /^ {6}([a-z][a-z-]*):/.exec(line)?.[1];
    if (key !== undefined) passed.push(key);
    if (line === "{# compose:conditional-workflows #}") passed.push("conditional-workflows");
  }
  const duplicate = passed.find((key, index) => passed.indexOf(key) !== index);
  if (duplicate !== undefined) {
    mismatches.push({
      file: rel,
      expected: "each with: input passed once (YAML's last duplicate wins silently)",
      got: `'${duplicate}' is passed more than once`,
    });
  }
  const reusable = asRecord(parseYaml(reusableText), "reusable-all-green.yml");
  const call = asRecord(asRecord(reusable.on, "reusable on").workflow_call, "workflow_call");
  const declared = Object.keys(asRecord(call.inputs ?? {}, "workflow_call inputs"));
  for (const key of new Set(passed)) {
    if (!declared.includes(key)) {
      mismatches.push({
        file: rel,
        expected: `every passed input declared by reusable-all-green.yml (a workflow_call refuses unknown inputs, failing every fleet verdict at once)`,
        got: `'${key}' is passed but not declared`,
      });
    }
  }
  for (const key of declared) {
    if (!passed.includes(key)) {
      mismatches.push({
        file: rel,
        expected: `the wrapper passing the reusable's '${key}' input (an unpassed input silently rides its default fleet-wide)`,
        got: "not passed",
      });
    }
  }
  return mismatches;
}

/** The fleet release leg's render shape at the SOURCE. The template
 *  ci.yml.jinja may carry exactly the `checks` and `ci` caller jobs and
 *  no fragment anchor beyond the with-block data anchors - the retired
 *  info-release job must not return there; the release fires from the
 *  all-green wrapper's verdict-gated leg now. That leg (the release-please
 *  all-green-release fragment) must keep `needs: [verdict]` plus the
 *  verdict-conclusion condition scoped to push-to-main workflow_run
 *  events (dropping any clause releases off unjudged or red commits),
 *  must pass the judged sha (github.sha on a workflow_run event is the
 *  tip, which can be a NEWER unjudged commit), and must hold a
 *  concurrency group no job inside the called release.yml takes (a
 *  shared name self-deadlocks: the caller would hold the group its
 *  called job waits for). release.yml must declare the sha input and
 *  read it in the head gate, or the pass rots into a silent
 *  release-from-tip. Pure over the three texts for the suite's forcing
 *  cases. */
export function fleetCiRenderMismatches(
  ciTemplateText: string,
  releaseLegText: string,
  releaseWorkflowText: string,
): Mismatch[] {
  const ciRel = "templates/base/.github/workflows/ci.yml.jinja";
  const legRel = "templates/release-please/fragments/all-green-release.jinja";
  const releaseRel = "templates/release-please/.github/workflows/release.yml.jinja";
  const mismatches: Mismatch[] = [];
  const jobsAt = ciTemplateText.indexOf("\njobs:\n");
  if (jobsAt === -1) throw new Error(`${ciRel}: no jobs: section - anchor lost`);
  const jobIds = [...ciTemplateText.slice(jobsAt).matchAll(/^ {2}([A-Za-z0-9_-]+):(?: |$)/gm)].map(
    (match) => match[1],
  );
  if (canonical(jobIds) !== canonical(["checks", "ci"])) {
    mismatches.push({
      file: ciRel,
      expected:
        "exactly the 'checks' and 'ci' caller jobs (every fleet gate lives inside those calls; the release leg lives in the all-green wrapper, and a job added here would gate every repo with no roster to make it loud)",
      got: jobIds.join(", ") || "no job ids",
    });
  }
  // No job-level name: or if: on the caller jobs: the verdict judges
  // DISPLAY names (a name: info-checks silently opts a caller out) and
  // reads a skipped job as standing down (an if: fails open at run
  // time) - the same bans all-green-roster holds over this repo's own
  // ci.yml.
  for (const line of ciTemplateText.slice(jobsAt).split("\n")) {
    if (/^ {4}(name|if):/.test(line)) {
      mismatches.push({
        file: ciRel,
        expected:
          "no job-level name: or if: on the caller jobs (a rename can opt a gate out of the verdict; a condition skips it and skipped stands down)",
        got: line.trim(),
      });
    }
    // Quoted job ids parse identically but evade the bare-key census.
    if (/^ {2}["']/.test(line)) {
      mismatches.push({
        file: ciRel,
        expected: "no quoted job ids (a quoted key parses identically but evades the job census)",
        got: line.trim(),
      });
    }
    // The job census reads the template's own text, so a fragment anchor
    // after jobs: could splice a job the census never sees; only the
    // with-block data anchor may stand.
    if (line.startsWith("{# compose:") && line !== "{# compose:codeql-languages #}") {
      mismatches.push({
        file: ciRel,
        expected:
          "no fragment anchor in ci.yml's jobs beyond the codeql-languages data anchor (a spliced job would evade the job census; module jobs live in fleet-ci, the release leg in the all-green wrapper)",
        got: line.trim(),
      });
    }
  }
  // The release leg is jinja-minimal by design: inline {% raw %} pairs
  // wrap the one judged-sha expression, and everything else is banned -
  // a multi-line {# ... #} or an if-tag could otherwise hide a pinned
  // line while rendering without it (the composer supplies the module
  // gate around the whole fragment).
  for (const [index, line] of releaseLegText.split("\n").entries()) {
    if (line.split("{% raw %}").length !== line.split("{% endraw %}").length) {
      mismatches.push({
        file: `${legRel}:${index + 1}`,
        expected:
          "raw/endraw paired on one line (inline expression wrapping only - a multiline raw block smuggles text past the jinja ban)",
        got: line.trim(),
      });
      continue;
    }
    const stripped = line.replaceAll("{% raw %}", "").replaceAll("{% endraw %}", "");
    if (stripped.includes("{%") || stripped.includes("{#") || stripped.includes("#}")) {
      mismatches.push({
        file: `${legRel}:${index + 1}`,
        expected:
          "no jinja tags or comments in the fragment beyond {% raw %} pairs (the composer supplies the module gate; a tag-wrapped or commented copy would satisfy the textual pins while rendering to nothing)",
        got: line.trim(),
      });
    }
    // An expression outside raw is jinja to copier: it renders mangled
    // or empty instead of reaching GitHub.
    if (line.includes("${{") && !line.includes("{% raw %}")) {
      mismatches.push({
        file: `${legRel}:${index + 1}`,
        expected: "every ${{ }} expression wrapped in {% raw %} (jinja eats a bare one)",
        got: line.trim(),
      });
    }
    // Quoted job ids parse identically but evade the bare-key census.
    if (/^ {2}["']/.test(line)) {
      mismatches.push({
        file: legRel,
        expected: "no quoted job ids (a quoted key parses identically but evades the job census)",
        got: line.trim(),
      });
    }
  }
  const legJobs = [...releaseLegText.matchAll(/^ {2}([A-Za-z0-9_-]+):(?: |$)/gm)].map(
    (match) => match[1],
  );
  if (legJobs.length === 0) {
    throw new Error(`${legRel}: no job id - anchor lost`);
  }
  // Exactly ONE job, by design: with a second job in the fragment, a
  // decoy could carry the pinned lines while the release job lost them.
  if (canonical(legJobs) !== canonical(["release"])) {
    mismatches.push({
      file: legRel,
      expected:
        "exactly one spliced job, 'release' (a decoy second job could carry the pinned lines while the release job lost them)",
      got: legJobs.join(", "),
    });
  }
  // One if: only - YAML lets a duplicate key win silently, so a second
  // condition could shadow the pinned block below.
  const ifCount = releaseLegText.split("\n").filter((line) => /^ {4}if:/.test(line)).length;
  if (ifCount !== 1) {
    mismatches.push({
      file: legRel,
      expected: "exactly one job-level if: (a duplicate key could shadow the verdict gate)",
      got: `${ifCount} if: lines`,
    });
  }
  // The verdict gate, pinned as one ADJACENT block: released only by a
  // posted green verdict (the reusable's conclusion output - never the
  // triggering run's conclusion) on a push-to-main workflow_run event.
  const verdictGate = [
    "    if: >-",
    "      needs.verdict.result == 'success' &&",
    "      needs.verdict.outputs.conclusion == 'success' &&",
    "      github.event_name == 'workflow_run' &&",
    "      github.event.workflow_run.event == 'push' &&",
    "      github.event.workflow_run.head_branch == 'main'",
  ].join("\n");
  if (!releaseLegText.includes(verdictGate)) {
    mismatches.push({
      file: legRel,
      expected:
        "the release job carrying the verbatim verdict gate block (needs.verdict.result and .outputs.conclusion both 'success', event workflow_run, run event push, head branch main) - dropping any clause releases off unjudged or red commits",
      got: "missing or reshaped",
    });
  }
  // The per-line pins: each exactly once (YAML's last duplicate wins
  // silently, so a compliant copy next to a gutted one must be loud).
  const legPins: [string, string][] = [
    ["    needs: [verdict]", "the release leg runs downstream of the verdict job, nothing else"],
    [
      "    concurrency:",
      "releases serialize in their own lane; an unserialized pair can double-publish",
    ],
    [
      "      group: post-green-release",
      "the caller's lane, deliberately no group the called release.yml takes (sharing self-deadlocks)",
    ],
    ["      cancel-in-progress: false", "a cancelled half-finished release is a wedged draft"],
    [
      "    uses: ./.github/workflows/release.yml",
      "the leg calls the managed release pipeline by local path",
    ],
    [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal fragment line under pin
      "      sha: {% raw %}${{ github.event.workflow_run.head_sha }}{% endraw %}",
      "the JUDGED commit - github.sha on a workflow_run event is the tip, which can be a newer unjudged commit",
    ],
    ["    secrets: inherit", "publish steps need the repo's secrets"],
  ];
  const legLines = releaseLegText.split("\n");
  for (const [line, why] of legPins) {
    const count = legLines.filter((candidate) => candidate === line).length;
    if (count !== 1) {
      mismatches.push({
        file: legRel,
        expected: `the line ${JSON.stringify(line)} exactly once (${why})`,
        got: count === 0 ? "missing" : `${count} occurrences`,
      });
    }
  }
  // The permissions ceiling, additive-closed: the pins prove the needed
  // grants present, this census refuses extras riding to every
  // release-selecting repository silently.
  const permissionsAt = legLines.indexOf("    permissions:");
  if (permissionsAt === -1) {
    mismatches.push({
      file: legRel,
      expected: "a job-level permissions: ceiling for the called release pipeline",
      got: "missing",
    });
  } else {
    const grants: string[] = [];
    for (const line of legLines.slice(permissionsAt + 1)) {
      if (line.trim() === "" || line.trim().startsWith("#")) continue;
      const grant = /^ {6}([a-z-]+: (?:read|write))$/.exec(line)?.[1];
      if (grant === undefined) break;
      grants.push(grant);
    }
    mismatches.push(
      ...setMismatch(
        `${legRel} release permissions ceiling`,
        [
          "contents: write",
          "pull-requests: write",
          "packages: write",
          "id-token: write",
          "attestations: write",
          "issues: read",
          "vulnerability-alerts: read",
        ],
        grants,
      ),
    );
  }
  // The called release.yml's half of the judged-sha pass, pinned as two
  // ADJACENT blocks (the file is jinja-heavy, so no YAML parse): the sha
  // input declared under workflow_call, and the head-gate step whose
  // JUDGED env and comparison ride in one piece - a decoy carrying the
  // JUDGED line in a skipped step while the real gate reads github.sha
  // would satisfy line-anywhere pins, so the load-bearing lines are also
  // counted UNIQUE below (the one comparison in the file is the pinned
  // one).
  const releaseBlocks: [string, string][] = [
    [
      ["on:", "  workflow_call:", "    inputs:", "      sha:"].join("\n"),
      "the workflow_call must declare the sha input the leg passes (an undeclared input fails the call outright, fleet-wide)",
    ],
    [
      [
        "      - name: Check this run judged the current head",
        "        id: head",
        "        env:",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal template lines under pin
        "          GH_TOKEN: {% raw %}${{ github.token }}{% endraw %}",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal template lines under pin
        "          JUDGED: {% raw %}${{ inputs.sha || github.sha }}{% endraw %}",
        "        run: |",
        '          head="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/main" --jq .object.sha)"',
        '          if [ "$head" = "$JUDGED" ]; then',
        '            echo "current=true" >> "$GITHUB_OUTPUT"',
        "          else",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal template lines under pin
        '            echo "::notice::main moved to ${head:0:7} since ${JUDGED:0:7} was judged; the newer run releases"',
        '            echo "current=false" >> "$GITHUB_OUTPUT"',
        "          fi",
      ].join("\n"),
      "the WHOLE head gate in one piece, both branches through fi - a rewired else emitting current=true would release from a stale judged commit",
    ],
  ];
  for (const [block, why] of releaseBlocks) {
    if (releaseWorkflowText.split(block).length !== 2) {
      mismatches.push({
        file: releaseRel,
        expected: `the verbatim block starting ${JSON.stringify(block.split("\n")[0])} exactly once (${why})`,
        got: "missing, reshaped, or duplicated",
      });
    }
  }
  // Uniqueness of the gate's load-bearing lines: with each appearing ONCE
  // (inside the pinned block, per above), no second step or job can carry
  // a rival JUDGED or head comparison that the gate does not use.
  const releaseLines = releaseWorkflowText.split("\n");
  // The release action's consumer binding, anchored on its OWN uses: line
  // (version-agnostic, so dependabot bumps stay free): exactly one
  // release-please-action step, whose next two lines must be the id and
  // the head-gate condition - a decoy step carrying the id/if pair while
  // the real action runs ungated must be unrepresentable.
  const actionUses = "      - uses: googleapis/release-please-action@";
  const actionIndexes = releaseLines.flatMap((line, index) =>
    line.startsWith(actionUses) ? [index] : [],
  );
  if (actionIndexes.length !== 1) {
    mismatches.push({
      file: releaseRel,
      expected: `exactly one step whose uses: starts ${JSON.stringify(actionUses.trim())} (the one release cutter)`,
      got: `${actionIndexes.length} occurrences`,
    });
  } else {
    const [idLine, ifLine] = releaseLines.slice(actionIndexes[0] + 1, actionIndexes[0] + 3);
    if (
      idLine !== "        id: release" ||
      ifLine !== "        if: steps.head.outputs.current == 'true'"
    ) {
      mismatches.push({
        file: releaseRel,
        expected:
          "the release-please-action step must itself consume the head gate: its next two lines are 'id: release' then \"if: steps.head.outputs.current == 'true'\" (an always() or dropped condition releases regardless of the gate)",
        got: [idLine ?? "<end of file>", ifLine ?? "<end of file>"]
          .map((l) => l.trim())
          .join(" / "),
      });
    }
  }
  for (const marker of ["JUDGED: {% raw %}", 'if [ "$head" =']) {
    const count = releaseLines.filter((candidate) => candidate.includes(marker)).length;
    if (count !== 1) {
      mismatches.push({
        file: releaseRel,
        expected: `exactly one line carrying ${JSON.stringify(marker)} (a rival copy outside the pinned head gate could shadow the judged-sha read)`,
        got: `${count} occurrences`,
      });
    }
  }
  // The self-deadlock ban's other half: the caller's lane name must never
  // appear inside the called workflow (concurrency groups are
  // case-insensitive on GitHub, so the scan is too).
  if (releaseWorkflowText.toLowerCase().includes("post-green-release")) {
    mismatches.push({
      file: releaseRel,
      expected:
        "no 'post-green-release' concurrency group inside the called workflow, any casing (the calling leg holds that lane; a job here waiting for it would self-deadlock)",
      got: "a post-green-release mention",
    });
  }
  return mismatches;
}

const rules: Rule[] = [
  {
    // The module roster's independently-authored sites, compared against
    // the manifests (loadManifests walks MODULE_ORDER, so the hand-ordered
    // list and the manifest set share one spine; the loader already fails
    // on a listed module without a folder). copier.yml's choices,
    // KNOWN_MODULES, and the doc rosters are generated FROM the manifests
    // and are generate:check's job, not this rule's.
    name: "module-list",
    run: () => {
      const mismatches: Mismatch[] = [];
      const reference = loadManifests().map((m) => m.module);

      // The filesystem side of MODULE_ORDER: the loader catches a listed
      // module without a templates/ folder, this catches a folder no
      // manifest claims.
      const dirs = readdirSync(join(REPO_ROOT, "templates")).filter(
        (name) => name !== "base" && lstatSync(join(REPO_ROOT, "templates", name)).isDirectory(),
      );
      mismatches.push(...setMismatch("templates/ module directories", reference, dirs));

      const everyModules = smokeRowModules(smokeMatrixRow("everything"));
      mismatches.push(
        ...setMismatch("ci.yml smoke-generate 'everything' row", reference, everyModules),
      );

      const gating = read(".github/scripts/ci/verify_smoke_gating.sh");
      for (const module of reference) {
        if (!gatesOnModule(gating, module)) {
          mismatches.push({
            file: ".github/scripts/ci/verify_smoke_gating.sh",
            expected: `an executable 'has ${module}' condition gating an assertion`,
            got: "none (comments and unrelated substrings do not count)",
          });
        }
      }
      return mismatches;
    },
  },

  {
    // ci.yml's dogfood-oracle smoke row and .repo-platform-answers.yml are
    // two independently-authored statements of this repository's own module
    // selection and visibility. The oracle step byte-compares real copier
    // output rendered from the ROW against copies generated from the
    // ANSWERS, so a drifted row would make it test the wrong render (the
    // oracle script re-checks the recorded answers at run time; this rule
    // catches the drift before CI spends a render on it).
    name: "dogfood-oracle-row",
    run: () => {
      const mismatches: Mismatch[] = [];
      const answers = parseAnswers(read(ANSWERS_FILE), ANSWERS_FILE);
      const row = smokeMatrixRow("dogfood-oracle");
      mismatches.push(
        ...setMismatch(
          "ci.yml smoke-generate 'dogfood-oracle' row modules",
          [...answers.modules],
          smokeRowModules(row),
        ),
      );
      if (String(row.private) !== String(answers.private)) {
        mismatches.push({
          file: "ci.yml smoke-generate 'dogfood-oracle' row",
          expected: `private: "${answers.private}" (${ANSWERS_FILE})`,
          got: `private: "${String(row.private)}"`,
        });
      }
      return mismatches;
    },
  },

  {
    name: "bun-dirs",
    run: () => {
      const mismatches: Mismatch[] = [];
      const lockDirs = [
        ".",
        ...readdirSync(join(REPO_ROOT, "actions"))
          .sort()
          .map((name) => `actions/${name}`)
          .filter((dir) => existsSync(join(REPO_ROOT, dir, "bun.lock"))),
      ];

      const dependabot = asRecord(parseYaml(read(".github/dependabot.yml")), "dependabot.yml");
      const bunDirs = (dependabot.updates as Record<string, unknown>[])
        .filter((entry) => entry["package-ecosystem"] === "bun")
        .map((entry) => String(entry.directory).replace(/^\//, "") || ".");
      for (const dir of lockDirs) {
        if (!bunDirs.includes(dir)) {
          mismatches.push({
            file: ".github/dependabot.yml",
            expected: `a bun ecosystem entry for ${dir} (it commits bun.lock)`,
            got: "no entry",
          });
        }
      }

      const scripts = packageScripts();
      for (const dir of lockDirs.filter((d) => d !== ".")) {
        if (!scripts.typecheck.includes(`cd ${dir}`)) {
          mismatches.push({
            file: "package.json",
            expected: `typecheck to cover ${dir}`,
            got: "not in the typecheck script",
          });
        }
      }

      const typecheckJob = asRecord(ciJobs(repoCi(), "ci.yml").typecheck, "typecheck job");
      const runs = (typecheckJob.steps as Record<string, unknown>[])
        .map((step) => String(step.run ?? ""))
        .join("\n");
      // The job iterates a tsconfig glob, so it cannot drift when actions
      // are added; pin the glob shape, and require every bun dir to carry
      // the tsconfig.json the glob keys on so none skips typechecking.
      if (!runs.includes("for tsconfig in tsconfig.json actions/*/tsconfig.json")) {
        mismatches.push({
          file: "ci.yml typecheck",
          expected: "a glob loop over tsconfig.json actions/*/tsconfig.json",
          got: "no such loop",
        });
      }
      for (const dir of lockDirs) {
        if (!existsSync(join(REPO_ROOT, dir, "tsconfig.json"))) {
          mismatches.push({
            file: `${dir}/tsconfig.json`,
            expected: "present (the ci.yml typecheck glob keys on it)",
            got: "missing",
          });
        }
      }

      const scriptTests = asRecord(ciJobs(repoCi(), "ci.yml")["script-tests"], "script-tests job");
      const testRun = (scriptTests.steps as Record<string, unknown>[])
        .map((step) => String(step.run ?? "").trim())
        .find((run) => run.startsWith("bun test"));
      if (testRun !== scripts.test) {
        mismatches.push({
          file: "ci.yml script-tests",
          expected: `the package.json test command (${scripts.test})`,
          got: String(testRun),
        });
      }
      return mismatches;
    },
  },

  {
    name: "action-pins",
    run: () => {
      const files = [
        ...walkFiles(".github/workflows").map((f) => f.path),
        ...walkFiles("templates")
          .filter((f) => !f.symlink)
          .map((f) => f.path),
        ...readdirSync(join(REPO_ROOT, "actions"))
          .sort()
          .map((name) => `actions/${name}/action.yml`)
          .filter((rel) => existsSync(join(REPO_ROOT, rel))),
      ];
      const pins = files.flatMap((rel) => extractUsesPins(read(rel), rel));
      if (pins.length === 0)
        throw new Error("no `uses: owner/action@ref` pins found anywhere - anchor lost");
      return pinMismatches(pins, ALLOWED_MULTI_REFS);
    },
  },

  {
    // Starter-classed templates and the sync-side rollout, coupled in both
    // directions (starterPinCoverage has the full statement). The starter
    // roster comes from the ownership declarations - the same single
    // source the composed manifest and _skip_if_exists are generated from
    // - and DELIVERY_REF is pinned against publish.ts's BRANCH (AST
    // extraction of the declaration: importing the publisher would run
    // its top-level git wiring).
    name: "starter-pin-rollout",
    run: () => {
      const mismatches: Mismatch[] = [];
      const published = constStringValue(
        read(".github/scripts/build-branches/publish.ts"),
        "BRANCH",
        { where: "publish.ts", what: "the delivery branch" },
      );
      if (published !== DELIVERY_REF) {
        mismatches.push({
          file: "scripts/check_ssot.ts DELIVERY_REF",
          expected: `'${published}' (publish.ts's BRANCH - the branch the fleet's pins execute from)`,
          got: `'${DELIVERY_REF}'`,
        });
      }
      const declarations = [
        ...loadBaseOwnership(join(REPO_ROOT, "templates")),
        ...loadManifests().flatMap((m) => m.ownership ?? []),
      ];
      const starters = new Set(
        declarations.filter((d) => d.class === "starter").map((d) => d.path),
      );
      const templateFiles = walkFiles("templates")
        .filter((f) => !f.symlink)
        .map((f) => f.path);
      const files = starterTemplateFiles(templateFiles, starters);
      // Free-form compose anchors splice module fragments into shared
      // files, so a fragment feeding a starter renders INTO the starter -
      // a pin there needs the same rollout coverage as one in the
      // starter's own source. withToolchainSetup covers the composer's
      // one generator-input fragment the same way.
      const anchors = withToolchainSetup(
        new Set(files.flatMap((rel) => composeAnchorNames(read(rel)))),
      );
      const sources = [...files, ...fragmentFilesFor(anchors, templateFiles)];
      const pins = sources.flatMap((rel) => starterSelfPins(read(rel), rel));
      if (pins.length === 0) {
        throw new Error("no starter template carries a self-delivery pin - anchor lost");
      }
      mismatches.push(...starterPinCoverage(pins, PIN_FLIPS, DELIVERY_REF));
      return mismatches;
    },
  },

  {
    // The INSTALLED @types/bun - each lockfile's resolved entry, for the
    // root plus the actions/ packages that declare the dependency (the
    // same directories the bun-dirs rule keeps under dependabot) -
    // against the manifests' bun runtime pin, ahead-direction only
    // (bunTypesAheadMismatches states why one direction). The lock is the
    // compared side on purpose: package.json's caret range is only a
    // floor, so a lock resolving a newer MINOR while the declared range
    // stays put would typecheck against APIs the pinned runtime lacks and
    // previously passed here. The runtime side reads the manifest itself
    // - the single source the .bun-version dotfiles are generated from.
    name: "bun-types-pin",
    run: () => {
      const bun = loadManifests().find((m) => m.module === "bun");
      if (bun?.toolchain?.pin === undefined) {
        throw new Error("templates/bun/module.yml declares no toolchain.pin - anchor lost");
      }
      const types: { file: string; version: string }[] = [];
      for (const dir of [
        ".",
        ...readdirSync(join(REPO_ROOT, "actions"))
          .sort()
          .map((name) => `actions/${name}`),
      ]) {
        const pkgRel = dir === "." ? "package.json" : `${dir}/package.json`;
        if (!existsSync(join(REPO_ROOT, pkgRel))) continue;
        const pkg = asRecord(JSON.parse(read(pkgRel)), pkgRel);
        const declares = ["dependencies", "devDependencies"].some(
          (key) => (pkg[key] as Record<string, unknown> | undefined)?.["@types/bun"] !== undefined,
        );
        if (!declares) continue;
        const lockRel = dir === "." ? "bun.lock" : `${dir}/bun.lock`;
        if (!existsSync(join(REPO_ROOT, lockRel))) {
          throw new Error(`${pkgRel} declares @types/bun but ${lockRel} is missing - anchor lost`);
        }
        types.push({ file: lockRel, version: lockedTypesBunVersion(read(lockRel), lockRel) });
      }
      if (types.length === 0) {
        throw new Error("no package.json declares @types/bun - anchor lost");
      }
      return bunTypesAheadMismatches(bun.toolchain.pin.version, types);
    },
  },

  {
    // Every pinned-toolchain setup step must read its version dotfile: the
    // manifest pin (and the generated dotfile) only govern anything while
    // the workflows actually pass the version-file input. Real steps are
    // matched structurally (the key must sit inside that step's own with:
    // block); commented starter examples are checked as comment text and
    // can never satisfy the per-action anchors. actions/ is deliberately
    // out of scope: the composite actions install their own floating bun
    // for vendored scripts run in caller checkouts, where the repo's
    // dotfile may not exist. reusable-pages.yml satisfies the rule with
    // its hashFiles() production/staging fallback expression.
    name: "toolchain-version-files",
    run: () => {
      const mismatches: Mismatch[] = [];
      const files = [
        ...walkFiles(".github/workflows").map((f) => f.path),
        ...walkFiles("templates")
          .filter((f) => !f.symlink)
          .map((f) => f.path),
      ];
      const seen = new Set<string>();
      for (const rel of files) {
        const lines = read(rel).split("\n");
        for (const [index, line] of lines.entries()) {
          for (const [action, input] of SETUP_VERSION_FILES) {
            const trimmed = line.trim();
            if (trimmed.startsWith("#")) {
              // Commented starter example: the commented step must carry
              // its commented input nearby (text match suffices there).
              if (
                action.test(trimmed.replace(/^#\s*/, "")) &&
                !lines
                  .slice(index + 1, index + 6)
                  .some((next) => next.trim().startsWith("#") && next.includes(input))
              ) {
                mismatches.push({
                  file: `${rel}:${index + 1}`,
                  expected: `a commented '${input} ...' input beside the commented example step`,
                  got: "an example step floating on the action's default version",
                });
              }
              continue;
            }
            if (!action.test(trimmed)) continue;
            seen.add(input);
            if (!stepCarriesWithKey(lines, index, input)) {
              mismatches.push({
                file: `${rel}:${index + 1}`,
                expected: `a '${input} ...' input in the setup step's own with: block`,
                got: "a setup step floating on the action's default version",
              });
            }
          }
        }
      }
      for (const [, input] of SETUP_VERSION_FILES) {
        if (!seen.has(input)) {
          throw new Error(
            `no uncommented setup step for the ${input} toolchain found anywhere - anchor lost`,
          );
        }
      }
      return mismatches;
    },
  },

  {
    name: "local-gates",
    run: () => {
      const mismatches: Mismatch[] = [];
      const scripts = packageScripts();
      const chain = expandCheckChain(scripts, "check");
      const jobs = ciJobs(repoCi(), "ci.yml");
      // The verdict roster IS the gating-job list now (the all-green-roster
      // rule pins it against ci.yml's actual jobs).
      const needs = ALL_GREEN_ROSTER;
      for (const jobName of needs) {
        const job = asRecord(jobs[jobName], jobName);
        const steps = (job.steps as Record<string, unknown>[] | undefined) ?? [];
        for (const step of steps) {
          for (const line of String(step.run ?? "").split("\n")) {
            const command = line.trim();
            if (!command.startsWith("bun ") || command.startsWith("bun install")) continue;
            // The ci/ scripts are CI-only by design (they need workflow
            // context: matrix rows, PR refs) and never belong in the local
            // chain - their bash predecessors never matched this rule's
            // "bun " prefix either.
            if (command.startsWith("bun .github/scripts/ci/")) continue;
            const words = command.split(/\s+/);
            let reachable: boolean;
            let wanted: string;
            if (words[1] === "run") {
              wanted = `bun run ${words[2]}`;
              reachable = chain.names.has(words[2]);
            } else if (words[1] === "x") {
              wanted = `bun x ${words[2]}`;
              reachable = chain.text.includes(wanted);
            } else if (words[1] === "test") {
              wanted = "bun test";
              reachable = chain.text.includes(wanted);
            } else {
              wanted = `bun ${words[1]}`;
              reachable = chain.text.includes(wanted);
            }
            if (!reachable) {
              mismatches.push({
                file: `ci.yml job '${jobName}'`,
                expected: `'${command}' reachable from package.json's check chain`,
                got: `${wanted} missing from the chain`,
              });
            }
          }
        }
      }
      // The reverse direction, for the gates whose only CI home is a step in
      // a needed job: trimming the step out of ci.yml would silently stop
      // them running anywhere in CI while the chain (and this rule's forward
      // pass) stayed green. Line-anchored equality, so an echoed or
      // commented copy of the command cannot satisfy it.
      const gatingLines = new Set(
        needs.flatMap((jobName) => {
          const job = asRecord(jobs[jobName], jobName);
          return (
            ((job.steps as Record<string, unknown>[] | undefined) ?? [])
              // A `continue-on-error` step fails OPEN: its command runs but a
              // non-zero exit is swallowed, so the gate it was meant to be is
              // no gate. Drop those lines from the gating set - a required
              // command sitting on a suppressed step is the same missing gate
              // as a deleted step. (A plain `if:` is NOT rejected here: ci.yml
              // steps legitimately carry event conditions like
              // `if: github.event_name == 'pull_request'`, the repo
              // convention for keeping the JOB unconditional.)
              .filter((step) => step["continue-on-error"] === undefined)
              .flatMap((step) => [
                // `uses` counts too: a gate that moved into a composite action
                // has no run line left to pin, and deleting its step would fail
                // the gate open exactly as deleting a run line would.
                String(step.uses ?? "").trim(),
                ...String(step.run ?? "")
                  .split("\n")
                  .map((line) => line.trim()),
              ])
          );
        }),
      );
      for (const required of [
        "bun run ssot:check",
        // The guard-binding layer's only CI home is its validate-template
        // step: losing the step would leave the registry unenforced in CI
        // while the local chain stayed green.
        "bun run guards:binding",
        "bun run generate:check",
        "bun run dogfood:check",
        "bun run gitignore:topology",
        "bun .github/scripts/fleet/repos_registry.ts validate",
        "bun actions/validate-template/validate_generated_files.ts --self .",
        // The copier-render oracle for the generated dogfood copies: its
        // only home is a step of the smoke-generate job (dogfood-oracle
        // row), so losing the step would fail the gate open silently.
        "bun .github/scripts/ci/verify_dogfood_oracle.ts",
        // The fleet rehearsal gate lives only as a step of its
        // all-green-needed job: trimming the step would leave a green
        // checkout/setup/install job and fail the gate open.
        "bun .github/scripts/ci/rehearse_fleet_gate.ts",
      ]) {
        if (!gatingLines.has(required)) {
          mismatches.push({
            file: "ci.yml",
            expected: `'${required}' as a run line of an all-green-needed job`,
            got: "missing",
          });
        }
      }
      return mismatches;
    },
  },

  {
    // Most dogfooded copies (.editorconfig,
    // CODE_OF_CONDUCT.md, CODEOWNERS, auto-assign.yml,
    // dependabot-bun-lockfile.yml, validate-skills.yml) are GENERATED from
    // their templates by
    // scripts/render_dogfood.ts, byte-checked by `bun run dogfood:check`,
    // and byte-compared against a REAL copier render by ci.yml's
    // dogfood-oracle smoke row (verify_dogfood_oracle.ts), so they need no
    // comparison here. This rule keeps only the pairs generation cannot
    // own: the prefix files, whose repo-specific tails
    // live below the template's marker.
    name: "dogfood-parity",
    run: () => {
      const vars = jinjaVars();
      const mismatches: Mismatch[] = [];
      const pairs: {
        repo: string;
        tpl: string;
        mode: "prefix" | "semantic";
        context?: Record<string, boolean>;
      }[] = [
        {
          // The template ends with a repo-specific-docs marker; everything a
          // repo appends after it is its own, hence prefix semantics.
          repo: "SECURITY.md",
          tpl: "templates/base/SECURITY.md.jinja",
          mode: "prefix",
        },
        {
          // The template ends with a repo-specific-notices marker
          // (third-party components, differently licensed paths);
          // everything a repo appends after it is its own, hence prefix
          // semantics.
          repo: "LICENSE.md",
          tpl: "templates/base/{% if 'custom-license' not in modules %}LICENSE.md{% endif %}.jinja",
          mode: "prefix",
        },
        {
          // Same marker semantics as SECURITY.md: repo-specific contributing
          // docs live below the marker.
          repo: "CONTRIBUTING.md",
          tpl: "templates/base/{% if not private %}CONTRIBUTING.md{% endif %}.jinja",
          mode: "prefix",
        },
      ];
      for (const pair of pairs) {
        const expected = normalizeJinja(read(pair.tpl), vars, pair.context);
        const got = read(pair.repo);
        if (pair.mode === "prefix" && !got.startsWith(expected)) {
          mismatches.push(
            ...lineDiffMismatch(pair.repo, pair.tpl, expected.split("\n"), got.split("\n")),
          );
        } else if (pair.mode === "semantic") {
          const excused = applyDivergences(pair.repo, semanticLines(expected), semanticLines(got));
          mismatches.push(...excused.mismatches);
          mismatches.push(
            ...lineDiffMismatch(pair.repo, pair.tpl, excused.expected, excused.actual),
          );
        }
      }
      return mismatches;
    },
  },

  {
    name: "gitattributes-subset",
    run: () => {
      const expected = semanticLines(
        normalizeJinja(read("templates/base/.gitattributes.jinja"), jinjaVars()),
      );
      if (expected.length === 0)
        throw new Error(".gitattributes.jinja: no shared lines found - anchor lost");
      const got = new Set(semanticLines(read(".gitattributes")));
      const mismatches = expected
        .filter((line) => !got.has(line))
        .map((line) => ({
          file: ".gitattributes",
          expected: `line ${JSON.stringify(line)} (from templates/base/.gitattributes.jinja)`,
          got: "missing",
        }));
      // semanticLines drops # lines, so the repo-local-section marker needs
      // its own presence check or its loss would go unnoticed.
      if (!read(".gitattributes").split("\n").includes("# repo-platform:local-section")) {
        mismatches.push({
          file: ".gitattributes",
          expected: "the '# repo-platform:local-section' marker line",
          got: "missing",
        });
      }
      return mismatches;
    },
  },

  {
    name: "dependabot-actions-block",
    run: () => {
      // The repo entry covers "/" plus its composite actions/ dirs (which
      // downstream repos do not have), so compare the shared shape with the
      // directory coverage held out, and pin each side's coverage of "/".
      // groups IS compared: one-PR-per-cycle grouping is shared policy.
      const rootActionsEntry = (rel: string, text: string, wantDirs: (d: unknown) => boolean) => {
        const doc = asRecord(parseYaml(text), rel);
        const entries = (doc.updates as Record<string, unknown>[]).filter(
          (entry) => entry["package-ecosystem"] === "github-actions",
        );
        if (entries.length !== 1)
          throw new Error(`${rel}: expected exactly one github-actions dependabot entry`);
        const { directory, directories, ...shape } = entries[0];
        if (!wantDirs(directory ?? directories))
          throw new Error(`${rel}: github-actions entry does not cover "/"`);
        return shape;
      };
      const expected = rootActionsEntry(
        "templates/base/.github/dependabot.yml.jinja",
        normalizeJinja(read("templates/base/.github/dependabot.yml.jinja"), jinjaVars()),
        (d) => d === "/",
      );
      const got = rootActionsEntry(
        ".github/dependabot.yml",
        read(".github/dependabot.yml"),
        (d) => d === "/" || (Array.isArray(d) && d.includes("/")),
      );
      if (canonical(expected) === canonical(got)) return [];
      return [
        { file: ".github/dependabot.yml", expected: canonical(expected), got: canonical(got) },
      ];
    },
  },

  {
    // Every composite-action package must sit in the github-actions
    // block's directories list, or its upstream pins quietly stop
    // receiving dependabot bumps. Nothing else guards the list: the
    // dogfood comparison above deliberately holds directories out
    // (downstream repos have no actions/ dirs).
    name: "dependabot-action-dirs",
    run: () => {
      const mismatches: Mismatch[] = [];
      // Only action.yml-bearing directories carry upstream `uses:` pins to
      // bump; actions/shared/ is the dependency-free library zone with
      // nothing for dependabot to see.
      const dirs = readdirSync(join(REPO_ROOT, "actions")).filter(
        (name) =>
          lstatSync(join(REPO_ROOT, "actions", name)).isDirectory() &&
          existsSync(join(REPO_ROOT, "actions", name, "action.yml")),
      );
      const doc = asRecord(parseYaml(read(".github/dependabot.yml")), "dependabot.yml");
      const updates = (doc.updates as Record<string, unknown>[] | undefined) ?? [];
      const block = updates.find((entry) => entry["package-ecosystem"] === "github-actions");
      if (!block) throw new Error("dependabot.yml: no github-actions block - anchor lost");
      const covered = new Set(((block.directories as unknown[] | undefined) ?? []).map(String));
      for (const dir of dirs) {
        if (!covered.has(`/actions/${dir}`)) {
          mismatches.push({
            file: ".github/dependabot.yml",
            expected: `"/actions/${dir}" in the github-actions directories list`,
            got: "missing - the package's upstream pins receive no dependabot bumps",
          });
        }
      }
      return mismatches;
    },
  },

  {
    name: "ci-skeleton",
    run: () => {
      const mismatches: Mismatch[] = [];
      const repo = repoCi();
      const template = templateCi();
      const on = (ci: Record<string, unknown>) => asRecord(ci.on, "on");

      const pull = (ci: Record<string, unknown>) =>
        asRecord(on(ci).pull_request, "pull_request").types;
      if (canonical(pull(template)) !== canonical(pull(repo))) {
        mismatches.push({
          file: ".github/workflows/ci.yml on.pull_request.types",
          expected: canonical(pull(template)),
          got: canonical(pull(repo)),
        });
      }

      if (canonical(template.concurrency) !== canonical(repo.concurrency)) {
        mismatches.push({
          file: ".github/workflows/ci.yml concurrency",
          expected: canonical(template.concurrency),
          got: canonical(repo.concurrency),
        });
      }

      const cron = (ci: Record<string, unknown>, where: string) => {
        const schedule = on(ci).schedule as Record<string, unknown>[] | undefined;
        if (!schedule?.[0]?.cron) throw new Error(`${where}: no schedule cron - anchor lost`);
        return String(schedule[0].cron);
      };
      const tplCron = cron(template, "ci.yml.jinja");
      const repoCron = cron(repo, "ci.yml");
      if (tplCron !== repoCron) {
        mismatches.push({
          file: ".github/workflows/ci.yml schedule cron",
          expected: tplCron,
          got: repoCron,
        });
      }
      return mismatches;
    },
  },

  {
    name: "typography-allow",
    run: () => {
      const entries = semanticLines(
        read("templates/release-please/fragments/typography-allow.jinja"),
      );
      if (entries.length === 0)
        throw new Error("typography-allow.jinja fragment has no entries - anchor lost");
      const got = new Set(semanticLines(read(".typography-allow")));
      return entries
        .filter((entry) => !got.has(entry))
        .map((entry) => ({
          file: ".typography-allow",
          expected: `entry ${JSON.stringify(entry)} (downstream repos get it from the release-please fragment)`,
          got: "missing",
        }));
    },
  },

  {
    name: "symlink-trio",
    run: () => {
      const mismatches: Mismatch[] = [];
      const aliases = (base: string, target: string): string[] => {
        const found: string[] = [];
        const dirs = ["", ".github"];
        for (const dir of dirs) {
          const abs = join(REPO_ROOT, base, dir);
          if (!existsSync(abs)) continue;
          for (const name of readdirSync(abs).sort()) {
            const rel = dir ? `${dir}/${name}` : name;
            const path = join(abs, name);
            if (!lstatSync(path).isSymbolicLink()) continue;
            if (readlinkSync(path).split("/").pop() === target) found.push(rel);
          }
        }
        return found;
      };
      const rootTrio = aliases("", "AGENTS.md");
      const templateTrio = aliases("templates/agents", "AGENTS.md.jinja");
      if (rootTrio.length === 0 || templateTrio.length === 0) {
        throw new Error("no AGENTS.md symlink aliases found - anchor lost");
      }
      mismatches.push(...setMismatch("templates/agents/ symlink aliases", rootTrio, templateTrio));

      const repoAttrs = new Set(semanticLines(read(".gitattributes")));
      const tplAttrs = new Set(semanticLines(read("templates/base/.gitattributes.jinja")));
      for (const alias of rootTrio) {
        for (const [line, file] of [
          [`${alias} -text`, ".gitattributes"],
          [`templates/agents/${alias} -text`, ".gitattributes"],
        ]) {
          if (!repoAttrs.has(line)) {
            mismatches.push({ file, expected: `line ${JSON.stringify(line)}`, got: "missing" });
          }
        }
        if (!tplAttrs.has(`${alias} -text`)) {
          mismatches.push({
            file: "templates/base/.gitattributes.jinja",
            expected: `line ${JSON.stringify(`${alias} -text`)}`,
            got: "missing",
          });
        }
      }
      return mismatches;
    },
  },

  {
    // The settings-sync starter and repo-platform's own .github/settings.yml
    // are the two independently-authored repo layers this repo controls;
    // the managed baseline document (.github/settings-baseline.yml) is the
    // single home of the fleet-generic content, so no baseline pair exists
    // to compare here. This rule pins what the layers must declare: the
    // starter seeds all four identity keys, repo-platform's own file
    // declares them with valid shapes, and its hand-written non-bypassable
    // override stays byte-equivalent to the baseline entry it replaces
    // wholesale (a drifted override would silently weaken the ruleset the
    // baseline promises).
    name: "settings-starter",
    run: () => {
      const mismatches: Mismatch[] = [];
      const vars = jinjaVars();
      const starter = asRecord(
        parseYaml(
          placeholderJinja(
            normalizeJinja(read("templates/settings-sync/.github/settings.yml.jinja"), vars),
          ),
        ),
        "settings.yml.jinja",
      );
      const starterRepository = asRecord(starter.repository, "settings.yml.jinja repository");
      for (const key of ["description", "homepage", "topics", "private"]) {
        if (!(key in starterRepository)) {
          mismatches.push({
            file: "templates/settings-sync/.github/settings.yml.jinja",
            expected: `repository.${key} seeded from the copier answers`,
            got: "missing - the starter must declare all four identity keys",
          });
        }
      }
      // The starter is a repo layer: a labels or rulesets section in it
      // would seed every new repo with a shadowing copy of baseline
      // entries (frozen at render time, overriding baseline evolution).
      for (const section of ["labels", "rulesets"]) {
        if (starter[section] !== undefined) {
          mismatches.push({
            file: "templates/settings-sync/.github/settings.yml.jinja",
            expected: `no ${section} section (the managed baseline supplies it; the starter only shows commented examples)`,
            got: "declared",
          });
        }
      }

      const own = asRecord(parseYaml(read(".github/settings.yml")), ".github/settings.yml");
      mismatches.push(
        ...settingsIdentityMismatches(asRecord(own.repository, ".github/settings.yml repository")),
      );

      // The fleet protection rulesets live in the override layer, which
      // merges ABOVE every repo layer - so a repo (this one included)
      // redeclaring one would be silently overridden. Assert the override
      // owns them and no repo layer duplicates them.
      const override = loadOverrideLayer();
      const overrideRulesets = (override.rulesets ?? []) as Record<string, unknown>[];
      for (const name of ["main", "non-bypassable"]) {
        if (!overrideRulesets.some((ruleset) => ruleset.name === name)) {
          throw new Error(`.github/settings-override.yml: no ${name} ruleset - anchor lost`);
        }
        if ((own.rulesets as Record<string, unknown>[] | undefined)?.some((r) => r.name === name)) {
          mismatches.push({
            file: ".github/settings.yml",
            expected: `no '${name}' ruleset (the override layer supplies it and wins over this file)`,
            got: "declared, which the merge silently overrides",
          });
        }
      }
      return mismatches;
    },
  },

  {
    name: "labels",
    run: () => {
      const mismatches: Mismatch[] = [];
      // The baseline generator is the label roster's single home; this
      // regression tripwire keeps the hand-maintained tuples from quietly
      // losing a member the fleet's tools recreate (dependabot, the
      // release machinery) - losing one restarts the nightly
      // delete/recreate loop the generator exists to kill.
      const rosterNames = new Set(managedLabelRoster().map((label) => label.name));
      const required = [
        "dependencies",
        "github_actions",
        "javascript",
        "bug",
        "enhancement",
        "fix-lint",
        "settings-as-code-report",
        "autorelease: pending",
        "autorelease: tagged",
        "release-blocker",
        "release-override",
      ];
      for (const name of required) {
        if (!rosterNames.has(name)) {
          mismatches.push({
            file: ".github/settings-baseline.yml (or a module's settings.yml layer)",
            expected: `label '${name}' in the managed roster`,
            got: "missing",
          });
        }
      }

      // Tracking-label streams: each manifest's tracking_label block is the
      // single source; the hand-written copier question is anchored back to
      // it here (the baseline generator renders the stream labels from the
      // same manifest tuples, so it cannot drift), and the create-tuple
      // carriers (the action's defaults for the fuzz stream, the starter's
      // overrides for the nightly stream) below.
      for (const { module, tracking } of trackingManifests()) {
        const question = asRecord(copierConfig()[tracking.answer], `copier.yml ${tracking.answer}`);
        if (String(question.default) !== tracking.default) {
          mismatches.push({
            file: `copier.yml ${tracking.answer} default`,
            expected: `${tracking.default} (templates/${module}/module.yml tracking_label)`,
            got: String(question.default),
          });
        }
      }

      // The fuzz stream's create tuple lives in the action's DEFAULTS, so
      // the fuzz starter must pass no override - asserted, so adding one
      // later fails this rule instead of silently orphaning its premise.
      const fuzzTracking = trackingManifests().find((m) => m.module === "fuzzer")?.tracking;
      if (!fuzzTracking) throw new Error("templates/fuzzer/module.yml lost tracking_label");
      const action = read("actions/fuzz-issue/fuzz-issue.ts");
      const color = constStringValue(action, "DEFAULT_LABEL_COLOR", {
        where: "fuzz-issue.ts",
        what: "label color",
      });
      const description = constStringValue(action, "DEFAULT_LABEL_DESCRIPTION", {
        where: "fuzz-issue.ts",
        what: "label description",
      });
      if (color !== fuzzTracking.color || description !== fuzzTracking.description) {
        mismatches.push({
          file: "actions/fuzz-issue/fuzz-issue.ts label defaults",
          expected: `${fuzzTracking.color} / ${fuzzTracking.description} (templates/fuzzer/module.yml tracking_label)`,
          got: `${color} / ${description}`,
        });
      }
      const fuzzStarter = read("templates/fuzzer/.github/workflows/nightly-fuzz.yml.jinja");
      if (/label-(?:color|description):/.test(fuzzStarter)) {
        mismatches.push({
          file: "templates/fuzzer/.github/workflows/nightly-fuzz.yml.jinja",
          expected:
            "no label-color/label-description override (the fuzz tuple is anchored to the action's defaults)",
          got: "an override - anchor this rule to it instead",
        });
      }
      // The fuzz starter's explicit title must stay the action's title
      // default: already-rendered fleet starters omit the input and depend
      // on the default (the action's own test pins DEFAULT_TITLE to it).
      const titleDefault = mustMatch(
        read("actions/fuzz-issue/action.yml"),
        /^ {2}title:\n(?: {4}.+\n)*? {4}default: (.+)$/m,
        "actions/fuzz-issue/action.yml",
        "title default",
      )[1];
      const starterTitle = mustMatch(
        fuzzStarter,
        /^ {10}title: (.+)$/m,
        "nightly-fuzz.yml.jinja",
        "title input",
      )[1];
      if (starterTitle !== titleDefault) {
        mismatches.push({
          file: "templates/fuzzer/.github/workflows/nightly-fuzz.yml.jinja title",
          expected: `${titleDefault} (actions/fuzz-issue/action.yml title default)`,
          got: starterTitle,
        });
      }

      // The nightly stream's create tuple is passed by its starter.
      const nightlyTracking = trackingManifests().find((m) => m.module === "nightly")?.tracking;
      if (!nightlyTracking) throw new Error("templates/nightly/module.yml lost tracking_label");
      const starter = read("templates/nightly/.github/workflows/nightly.yml.jinja");
      const starterColor = mustMatch(
        starter,
        /label-color: "([^"]+)"/,
        "nightly.yml.jinja",
        "label-color input",
      )[1];
      const starterDescription = mustMatch(
        starter,
        /label-description: (.+)/,
        "nightly.yml.jinja",
        "label-description input",
      )[1];
      if (
        starterColor !== nightlyTracking.color ||
        starterDescription !== nightlyTracking.description
      ) {
        mismatches.push({
          file: "templates/nightly/.github/workflows/nightly.yml.jinja label overrides",
          expected: `${nightlyTracking.color} / ${nightlyTracking.description} (templates/nightly/module.yml tracking_label)`,
          got: `${starterColor} / ${starterDescription}`,
        });
      }
      return mismatches;
    },
  },

  {
    name: "issue-labels",
    run: () => {
      const mismatches: Mismatch[] = [];
      const rosterNames = new Set(managedLabelRoster().map((label) => label.name));
      const forms = walkFiles("templates/issue-templates").map((f) => f.path);
      let sawLabels = false;
      for (const rel of forms) {
        const text = read(rel);
        if (!/^labels:/m.test(text)) continue;
        // Parse the whole form so block-style lists count too; a labels key
        // that stops parsing must fail loudly, not drop out of the check.
        const doc = asRecord(parseYaml(placeholderJinja(normalizeJinja(text, jinjaVars()))), rel);
        if (!Array.isArray(doc.labels)) {
          throw new Error(`${rel}: labels key present but not a parsable list`);
        }
        sawLabels = true;
        for (const name of doc.labels.map(String)) {
          if (!rosterNames.has(name)) {
            mismatches.push({
              file: rel,
              expected: `label '${name}' declared in the managed settings roster (render_managed_settings.ts)`,
              got: "missing - the label sync would delete what the issue form applies",
            });
          }
        }
      }
      if (!sawLabels) throw new Error("no issue form declares labels - anchor lost");
      return mismatches;
    },
  },

  {
    // The stale-pending guard in the release-please workflow queries and
    // names the autorelease labels as string literals. gh pr list exits 0
    // and empty for a label that does not exist, so a literal that drifts
    // from the managed roster degrades the guard to a permanent silent
    // no-op - anchor the literals to the release-please manifest's
    // settings layer here instead. Only the template side exists to check:
    // repo-platform runs no release pipeline of its own.
    name: "release-guard-labels",
    run: () => {
      const mismatches: Mismatch[] = [];
      const releaseLabels = (loadLayer("templates/release-please/settings.yml").labels ?? []) as {
        name: string;
      }[];
      if (releaseLabels.length === 0) {
        throw new Error("templates/release-please/settings.yml declares no labels - anchor lost");
      }
      const roster = new Set(releaseLabels.map((label) => label.name));
      const rel = "templates/release-please/.github/workflows/release.yml.jinja";
      const text = read(rel);
      const queried = mustMatch(
        text,
        /gh pr list --state merged --label '([^']+)'/,
        rel,
        "guard label query",
      )[1];
      const worn = mustMatch(text, /have worn '([^']+)'/, rel, "guard error's pending label")[1];
      const target = mustMatch(
        text,
        /move the label to '([^']+)'/,
        rel,
        "guard error's tagged label",
      )[1];
      for (const name of [queried, worn, target]) {
        if (!roster.has(name)) {
          mismatches.push({
            file: rel,
            expected: `label '${name}' declared in templates/release-please/settings.yml`,
            got: "not in the manifest roster",
          });
        }
      }
      if (worn !== queried) {
        mismatches.push({
          file: rel,
          expected: `guard error names the queried label '${queried}'`,
          got: `'${worn}'`,
        });
      }
      // The prescribed fix must point at the tagged label specifically -
      // roster membership alone would accept any declared label.
      if (target !== "autorelease: tagged") {
        mismatches.push({
          file: rel,
          expected: "guard error prescribes moving to 'autorelease: tagged'",
          got: `'${target}'`,
        });
      }
      return mismatches;
    },
  },

  {
    // Roster enforcement at authoring time: ci.yml's gating jobs against
    // the authored ALL_GREEN_ROSTER, both directions (see
    // verdictRosterMismatches). This is where a deleted gate goes loud.
    name: "all-green-roster",
    run: () => {
      const jobs = ciJobs(repoCi(), "ci.yml");
      const mismatches = verdictRosterMismatches(ALL_GREEN_ROSTER, Object.keys(jobs));
      for (const [name, raw] of Object.entries(jobs)) {
        if (name.startsWith("info-")) continue;
        const job = asRecord(raw ?? {}, name);
        // The verdict treats a skipped job as standing down, so a
        // job-level `if:` on a gating job fails OPEN; event conditions go
        // on steps.
        if (job.if !== undefined) {
          mismatches.push({
            file: `.github/workflows/ci.yml job '${name}'`,
            expected:
              "no job-level if: on a gating job (a skipped job stands down in the all-green verdict - put event conditions on the steps)",
            got: "a job-level condition",
          });
        }
        // The verdict judges DISPLAY names, the roster pins job ids: a
        // custom name could rename a rostered job to info-* (silent
        // opt-out) or to all-green (check collision) without touching the
        // key this rule reads, so gating jobs display as their ids.
        if (job.name !== undefined) {
          mismatches.push({
            file: `.github/workflows/ci.yml job '${name}'`,
            expected:
              "no job-level name: on a gating job (the verdict judges display names; a rename could opt the job out of the roster's reach)",
            got: `name: ${String(job.name)}`,
          });
        }
      }
      return mismatches;
    },
  },

  {
    // The fleet counterpart: fleet-ci.yml's gating jobs against
    // FLEET_CI_ROSTER, both directions - deleting dependency-review or
    // codeql there would silently drop the gate for every managed
    // repository at once. Unlike the operator rule, job-level `if:` is the
    // DESIGN here (module/visibility conditions; the verdict reads skipped
    // as standing down), but the info-* opt-out and display-name renames
    // are banned outright: an opt-out in the fleet's shared gate home is a
    // fleet-wide silent disarm, and opt-outs belong to the repo-owned
    // checks.yml.
    name: "fleet-ci-roster",
    run: () => {
      const rel = ".github/workflows/fleet-ci.yml";
      const jobs = ciJobs(asRecord(parseYaml(read(rel)), rel), rel);
      const mismatches = verdictRosterMismatches(FLEET_CI_ROSTER, Object.keys(jobs), {
        jobsFile: rel,
        rosterName: "FLEET_CI_ROSTER",
      });
      for (const [name, raw] of Object.entries(jobs)) {
        const job = asRecord(raw ?? {}, name);
        if (name.startsWith("info-")) {
          mismatches.push({
            file: `${rel} job '${name}'`,
            expected:
              "no info-* job in the fleet's shared gate home (that opt-out disarms every managed repository at once; repo-local opt-outs belong to checks.yml)",
            got: "an info-* job id",
          });
        }
        if (job.name !== undefined) {
          mismatches.push({
            file: `${rel} job '${name}'`,
            expected:
              "no job-level name: on a fleet gating job (the verdict judges display names; a rename could opt the job out fleet-wide)",
            got: `name: ${String(job.name)}`,
          });
        }
      }
      return mismatches;
    },
  },

  {
    // The verdict check's NAME, pinned once as data: the string the
    // ruleset REQUIRES and the string the verdict REPORTS must be provably
    // the same at authoring time (a renamed check would leave branch
    // protection waiting forever while every job stayed green). Its
    // independently-authored homes: the shared green-gate predicate's
    // CHECK_NAME (all_green.ts) - which must also feed its own check-run
    // lookup - the check reusable-all-green.yml creates, the override
    // layer's required-check contexts (next to Copilot's review check),
    // and docs/all-green.md's prose. The repo's own all-green.yml wrapper
    // must also actually wire the verdict: workflow_run on CI, the
    // dispatch unwedge input, and the local reusable call.
    name: "all-green-name",
    run: () => {
      const mismatches: Mismatch[] = [];
      const predicate = read(".github/scripts/shared/all_green.ts");
      // The IMPORTED constant is the authoritative name; the AST pin
      // (declaredCheckName) then proves the exported declaration NODE
      // carries the same value, so neither a decoy in a comment or
      // template nor a declaration rewritten off the string-literal
      // form can pass silently.
      const gateName = CHECK_NAME;
      const declared = declaredCheckName(predicate);
      if (declared !== gateName) {
        mismatches.push({
          file: ".github/scripts/shared/all_green.ts",
          expected: `the CHECK_NAME declaration line naming '${gateName}' (the imported constant)`,
          got: declared,
        });
      }
      // The publish/sync gates' LOOKUP must consume the same constant, or
      // they could read a differently named check than the one pinned.
      if (!templateCarries(predicate, CHECK_RUN_LOOKUP)) {
        throw new Error(
          "all_green.ts: anchor for a check-run lookup keyed on CHECK_NAME not found " +
            `(no template literal carries ${CHECK_RUN_LOOKUP})`,
        );
      }

      const reusable = read(".github/workflows/reusable-all-green.yml");
      const created = mustMatch(
        reusable,
        ALL_GREEN_WIRING.created,
        "reusable-all-green.yml",
        "created check name",
      )[1];
      if (created !== gateName) {
        mismatches.push({
          file: ".github/workflows/reusable-all-green.yml",
          expected: `the created check named '${gateName}' (all_green.ts CHECK_NAME)`,
          got: created,
        });
      }

      // The verdict's ANCHOR job: the fleet wrapper template pins
      // require-job, the reusable wires it into the judge, and the render
      // validator enforces the same string at sync time. Every fleet gate
      // lives inside the managed ci.yml's one fleet-ci caller, so this
      // anchor is what makes a disarmed caller fail the verdict; its
      // value must be "<caller job id> / <fleet-ci job id>" exactly as
      // the judged run spells it, so both ids are pinned here too -
      // renaming either would redden every fleet verdict.
      const wrapperRel = "templates/base/.github/workflows/all-green.yml.jinja";
      const anchor = mustMatch(
        read(wrapperRel),
        ALL_GREEN_WIRING.anchor,
        wrapperRel,
        "the require-job anchor",
      )[1];
      mustMatch(
        reusable,
        ALL_GREEN_WIRING.anchorWired,
        ".github/workflows/reusable-all-green.yml",
        "the REQUIRE_JOB env wiring",
      );
      // The bot stand-down's author env lines, pinned at the WORKFLOW
      // level: the run block reads whatever these map, and the harness
      // injects PR_AUTHOR_* itself, so only this pin notices the source
      // being rewired away from the pull request's author (probe PB:
      // github.actor here survived every other gate - a bot-submitted
      // review wake would then disarm the copilot expectation on a
      // human PR and could mint green over a failed review check).
      mustMatch(
        reusable,
        ALL_GREEN_WIRING.authorLoginWired,
        ".github/workflows/reusable-all-green.yml",
        "the PR_AUTHOR_LOGIN env wiring (github.event.pull_request.user.login, never an actor)",
      );
      mustMatch(
        reusable,
        ALL_GREEN_WIRING.authorTypeWired,
        ".github/workflows/reusable-all-green.yml",
        "the PR_AUTHOR_TYPE env wiring (github.event.pull_request.user.type, never an actor)",
      );
      const validated = constStringValue(
        read("actions/validate-template/validate_generated_files.ts"),
        "REQUIRED_GATE_JOB",
        {
          where: "actions/validate-template/validate_generated_files.ts",
          what: "the validator's REQUIRED_GATE_JOB",
        },
      );
      if (validated !== anchor) {
        mismatches.push({
          file: "actions/validate-template/validate_generated_files.ts",
          expected: `REQUIRED_GATE_JOB '${anchor}' (the wrapper template's require-job)`,
          got: validated,
        });
      }
      const anchorParts = anchor.split(" / ");
      if (anchorParts.length !== 2) {
        mismatches.push({
          file: wrapperRel,
          expected: "a require-job of the form '<caller job id> / <fleet-ci job id>'",
          got: anchor,
        });
      } else {
        const [callerId, anchorJob] = anchorParts;
        mustMatch(
          read("templates/base/.github/workflows/ci.yml.jinja"),
          new RegExp(`^  ${callerId}:$`, "m"),
          "templates/base/.github/workflows/ci.yml.jinja",
          `the '${callerId}' fleet-ci caller job the anchor names`,
        );
        const fleetJobs = ciJobs(
          asRecord(parseYaml(read(".github/workflows/fleet-ci.yml")), "fleet-ci.yml"),
          "fleet-ci.yml",
        );
        const anchorFleetJob = asRecord(fleetJobs[anchorJob] ?? {}, "fleet-ci anchor job");
        if (!(anchorJob in fleetJobs)) {
          mismatches.push({
            file: ".github/workflows/fleet-ci.yml",
            expected: `a job '${anchorJob}' (the verdict anchor the wrapper requires)`,
            got: "no such job",
          });
        } else if (anchorFleetJob.if !== undefined) {
          mismatches.push({
            file: ".github/workflows/fleet-ci.yml",
            expected: `an unconditional '${anchorJob}' job (a skipped anchor fails every fleet verdict)`,
            got: `if: ${String(anchorFleetJob.if)}`,
          });
        }
      }

      // The operator-facing contract's CANONICAL sentence must quote the
      // same name: anchored with mustMatch (the doc mentions all-green in
      // many places, so a bare .includes could stay green after the
      // contractual sentence changed or vanished).
      const documented = mustMatch(
        read("docs/all-green.md"),
        /required status check named `([^`]+)`/,
        "docs/all-green.md",
        "the required-check sentence",
      )[1];
      if (documented !== gateName) {
        mismatches.push({
          file: "docs/all-green.md",
          expected: `the required check documented as \`${gateName}\``,
          got: `\`${documented}\``,
        });
      }

      const wrapper = asRecord(parseYaml(read(".github/workflows/all-green.yml")), "all-green.yml");
      const on = asRecord(wrapper.on, "all-green.yml on");
      const workflowRun = asRecord(on.workflow_run ?? {}, "all-green.yml on.workflow_run");
      if (canonical(workflowRun.workflows) !== canonical(["CI"])) {
        mismatches.push({
          file: ".github/workflows/all-green.yml",
          expected: "on.workflow_run.workflows: [CI] (the verdict must fire on CI completions)",
          got: canonical(workflowRun.workflows ?? null),
        });
      }
      // types must be exactly [completed]: omitting it fires the verdict
      // on requested/in_progress too, judging a run that has not finished.
      if (canonical(workflowRun.types) !== canonical(["completed"])) {
        mismatches.push({
          file: ".github/workflows/all-green.yml",
          expected: "on.workflow_run.types: [completed] (only finished runs may be judged)",
          got: canonical(workflowRun.types ?? null),
        });
      }
      const dispatch = asRecord(on.workflow_dispatch ?? {}, "all-green.yml on.workflow_dispatch");
      if (!("sha" in asRecord(dispatch.inputs ?? {}, "all-green.yml dispatch inputs"))) {
        mismatches.push({
          file: ".github/workflows/all-green.yml",
          expected:
            "a workflow_dispatch `sha` input (the unwedge path for a lost workflow_run event)",
          got: "missing",
        });
      }
      const verdictJob = Object.values(ciJobs(wrapper, "all-green.yml"))
        .map((job) => asRecord(job ?? {}, "all-green.yml job"))
        .find((job) => job.uses === "./.github/workflows/reusable-all-green.yml");
      if (verdictJob === undefined) {
        mismatches.push({
          file: ".github/workflows/all-green.yml",
          expected: "a job calling ./.github/workflows/reusable-all-green.yml (the shared verdict)",
          got: "no such job",
        });
      } else {
        if (verdictJob.if !== undefined) {
          mismatches.push({
            file: ".github/workflows/all-green.yml",
            expected:
              "an unconditional verdict job (a condition could silently stop every verdict)",
            got: `if: ${String(verdictJob.if)}`,
          });
        }
        const grants = asRecord(verdictJob.permissions ?? {}, "all-green.yml verdict permissions");
        if (grants.checks !== "write" || grants.actions !== "read") {
          mismatches.push({
            file: ".github/workflows/all-green.yml",
            expected: "the verdict job granting checks: write and actions: read",
            got: canonical(verdictJob.permissions ?? null),
          });
        }
        const shaInput = String(asRecord(verdictJob.with ?? {}, "all-green.yml with").sha ?? "");
        if (!/\binputs\.sha\b/.test(shaInput)) {
          mismatches.push({
            file: ".github/workflows/all-green.yml",
            expected:
              "with.sha forwarding inputs.sha (the dispatch unwedge input must reach the judgment)",
            got: shaInput === "" ? "no sha forwarding" : shaInput,
          });
        }
        // The verdict-owned Copilot expectation must stay WIRED: the
        // ruleset requires only the all-green check since the cutover,
        // so this input is the review gate's ONLY home - a silent
        // regression to the reusable's false default would un-gate the
        // review while CI stayed green.
        const copilotWired = asRecord(verdictJob.with ?? {}, "all-green.yml with")[
          "require-copilot-review"
        ];
        if (copilotWired !== true) {
          mismatches.push({
            file: ".github/workflows/all-green.yml",
            expected:
              "with.require-copilot-review: true (the ruleset carries no Copilot context since the cutover - this input is the review gate's only home)",
            got: copilotWired === undefined ? "not wired" : canonical(copilotWired),
          });
        }
      }

      const contexts = (rulesets: Record<string, unknown>[], where: string): string[] => {
        const main = rulesets.find((r) => r.name === "main");
        if (!main) throw new Error(`${where}: no main ruleset - anchor lost`);
        const checksRule = (main.rules as Record<string, unknown>[]).find(
          (rule) => rule.type === "required_status_checks",
        );
        if (!checksRule) throw new Error(`${where}: no required_status_checks rule - anchor lost`);
        const params = asRecord(checksRule.parameters, `${where} parameters`);
        return (params.required_status_checks as Record<string, unknown>[]).map((c) =>
          String(c.context),
        );
      };
      // The override layer's main ruleset is the fleet's only home for
      // the required-check context: exactly the all-green entry, nothing
      // else - the retired Copilot context must not creep back (the
      // verdict owns that expectation now), and loadOverrideLayer
      // separately refuses an override that drops the context or its
      // Actions integration pin.
      const override = loadOverrideLayer();
      mismatches.push(
        ...setMismatch(
          ".github/settings-override.yml main ruleset required checks",
          [gateName],
          contexts(
            (override.rulesets ?? []) as Record<string, unknown>[],
            ".github/settings-override.yml",
          ),
        ),
      );
      return mismatches;
    },
  },

  {
    // The fleet wrapper template's shape (WRAPPER_TEMPLATE_PINS and
    // wrapperTemplateMismatches have the model): every fleet repository
    // renders this file verbatim-ish, so a drift here IS a fleet-wide
    // drift - pinned at authoring time, one loud diff.
    name: "all-green-wrapper-template",
    run: () =>
      wrapperTemplateMismatches(
        read("templates/base/.github/workflows/all-green.yml.jinja"),
        read(".github/workflows/reusable-all-green.yml"),
      ),
  },

  {
    // The fleet release leg's render shape at the source
    // (fleetCiRenderMismatches has the model): the template ci.yml may
    // carry exactly the two caller jobs and no release job, and the
    // all-green wrapper's release leg must stay verdict-gated with the
    // judged sha passed through.
    name: "fleet-ci-render-roster",
    run: () =>
      fleetCiRenderMismatches(
        read("templates/base/.github/workflows/ci.yml.jinja"),
        read("templates/release-please/fragments/all-green-release.jinja"),
        read("templates/release-please/.github/workflows/release.yml.jinja"),
      ),
  },

  {
    name: "dependabot-label-tuples",
    run: () => {
      // A toolchain module's dependabot label now has two homes: the
      // manifest's `dependabot` tuple (which drives the generated
      // dependabot.yml and the docs) and the module's own settings layer
      // (which drives the label roster the apply syncs). If they drift,
      // dependabot recreates a label the settings apply then deletes -
      // the nightly delete/recreate loop this whole roster exists to kill.
      const mismatches: Mismatch[] = [];
      for (const manifest of loadManifests()) {
        const tuple = manifest.dependabot;
        if (tuple === undefined) continue;
        const rel = `templates/${manifest.module}/settings.yml`;
        const declared = (loadLayer(rel).labels ?? []) as {
          name: string;
          color: string;
          description: string;
        }[];
        const entry = declared.find((label) => label.name === tuple.label);
        if (entry === undefined) {
          mismatches.push({
            file: rel,
            expected: `a label '${tuple.label}' (the manifest's dependabot.label)`,
            got: declared.map((label) => label.name).join(", ") || "no labels",
          });
          continue;
        }
        if (entry.color !== tuple.color) {
          mismatches.push({
            file: `${rel} label '${tuple.label}' color`,
            expected: `${tuple.color} (templates/${manifest.module}/module.yml dependabot.color)`,
            got: entry.color,
          });
        }
      }
      return mismatches;
    },
  },

  {
    name: "settings-read-pin",
    run: () => {
      // The unit tests can prove factsFromFetch forwards one ref and that
      // the CLI refuses an unpinned fetch. They cannot see the TRANSPORT
      // or the workflow, so those are pinned here: the ref has to reach
      // the API URL, and the fetch call has to carry the render's output.
      const mismatches: Mismatch[] = [];
      const render = read(".github/scripts/fleet/render_managed_settings.ts");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal template shape under pin
      if (!templateCarries(render, "contents/${path}?ref=${ref}")) {
        mismatches.push({
          file: ".github/scripts/fleet/render_managed_settings.ts",
          expected: "the contents URL carries ?ref=, or every fact reads the moving branch",
          got: "no ?ref= on the fetch URL",
        });
      }
      const merge = read(".github/scripts/fleet/merge_settings_layers.ts");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal template shape under pin
      if (!templateCarries(merge, "contents/.github/settings.yml?ref=${ref}")) {
        mismatches.push({
          file: ".github/scripts/fleet/merge_settings_layers.ts",
          expected: "the repo-layer URL carries ?ref=",
          got: "no ?ref= on the repo-layer fetch",
        });
      }
      const workflow = read(".github/workflows/settings-repos.yml").replace(/\\[ \t]*\n\s*/g, " ");
      if (
        !/--repo-fetch [^\n]*--repo-ref "\$\{\{ steps\.render\.outputs\.ref \}\}"/.test(workflow)
      ) {
        mismatches.push({
          file: ".github/workflows/settings-repos.yml",
          expected: "every --repo-fetch passes the render step's published ref",
          got: "a fetch without the pinned ref",
        });
      }
      // The operator row reads its own checkout; fetching it would race
      // against the facts the render took from that same working tree.
      if (!/--repo-file \.github\/settings\.yml/.test(workflow)) {
        mismatches.push({
          file: ".github/workflows/settings-repos.yml",
          expected: "the operator row merges from its checkout (--repo-file)",
          got: "the operator row fetches",
        });
      }
      return mismatches;
    },
  },

  {
    name: "self-apply-fact-source",
    run: () => {
      // The self-apply's REPO_PLATFORM_TOKEN grant is Administration and
      // Issues only - no Contents - so reading the caller's
      // .repo-platform.yml or .copier-answers.yml over gh api fails on
      // every private repository before anything renders. The caller is
      // already checked out, so the render must take --target-dir and
      // touch no network. The central run is the opposite case: it holds
      // the fleet PAT and has no checkout of the target, so it fetches.
      const mismatches: Mismatch[] = [];
      const selfApply = read(".github/workflows/reusable-apply-settings.yml").replace(
        /\\[ \t]*\n\s*/g,
        " ",
      );
      if (!/render_managed_settings\.ts[^\n]*--target-dir/.test(selfApply)) {
        mismatches.push({
          file: ".github/workflows/reusable-apply-settings.yml",
          expected: "the render reads the caller's checkout (--target-dir), not gh api",
          got: "no --target-dir on the render",
        });
      }
      return mismatches;
    },
  },

  {
    name: "settings-hide-details",
    run: () => {
      // The layer render and the merge run BEFORE the settings action, so
      // the action's own redaction cannot cover their output, and both
      // quote repo-owned content on their diagnostic paths. hide_details
      // must therefore reach them: it has to ride the matrix AND be
      // handed to both steps, which pass it to run_hidden.ts. This was
      // dropped once already, with a comment explaining why it was safe -
      // it was not, so the invariant is pinned rather than commented.
      const mismatches: Mismatch[] = [];
      const matrix = read(".github/scripts/fleet/build_settings_matrix.ts");
      if (
        !intersectionCarriesType(matrix, "RedactionState") ||
        !propertyAssignmentCarries(matrix, "hide_details", "row.hide_details")
      ) {
        mismatches.push({
          file: ".github/scripts/fleet/build_settings_matrix.ts",
          expected:
            "the matrix Target carries the row's RedactionState (redact.ts), hide_details copied from the row",
          got: "the flag is not on the matrix",
        });
      }
      const workflow = read(".github/workflows/settings-repos.yml");
      // Per INVOCATION, not per count: there are two render call sites
      // (operator and target), so counting matches passed even with a
      // wrapper removed - which is the exact regression this rule exists
      // to catch. Fold continuations first, then require every call of
      // either script to sit behind its own run_hidden wrapper. The
      // freshness recheck is covered too: its moved warning quotes commit
      // shas and its resolver errors name the target's default branch.
      const flat = workflow.replace(/\\[ \t]*\n/g, " ").replace(/\s+/g, " ");
      for (const script of [
        "render_managed_settings",
        "merge_settings_layers",
        "check_target_fresh",
      ]) {
        const calls =
          flat.match(new RegExp(`bun \\.github/scripts/fleet/${script}\\.ts`, "g")) ?? [];
        const wrapped =
          flat.match(
            new RegExp(
              `run_hidden\\.ts "settings [a-z]+" -- bun \\.github/scripts/fleet/${script}\\.ts`,
              "g",
            ),
          ) ?? [];
        if (calls.length === 0 || wrapped.length !== calls.length) {
          mismatches.push({
            file: ".github/workflows/settings-repos.yml",
            expected: `every ${script}.ts call wrapped in run_hidden.ts (${calls.length} call(s))`,
            got: `${wrapped.length} wrapped`,
          });
        }
      }
      if (!/^\s+HIDE_DETAILS: \$\{\{ matrix\.hide_details \}\}$/m.test(workflow)) {
        mismatches.push({
          file: ".github/workflows/settings-repos.yml",
          expected: "the apply job takes HIDE_DETAILS from the matrix row",
          got: "no such env binding",
        });
      }
      if (!flat.includes("failure_issue.ts deliver")) {
        mismatches.push({
          file: ".github/workflows/settings-repos.yml",
          expected:
            "a deliver step for hidden diagnostics (run_hidden captures them privately; without delivery the detail dies with the runner)",
          got: "no failure_issue.ts deliver step",
        });
      }
      // Per STEP, not per flattened file: a title binding or a condition
      // sitting on some unrelated step would satisfy a whole-file search.
      // Steps are the "- name:" blocks of the apply job.
      const steps = new Map<string, string>();
      for (const block of workflow.split(/\n {6}- name: /).slice(1)) {
        const name = block.slice(0, block.indexOf("\n"));
        steps.set(name.trim(), block);
      }
      const step = (name: string, needs: [RegExp, string][]) => {
        const block = steps.get(name);
        if (block === undefined) {
          mismatches.push({
            file: ".github/workflows/settings-repos.yml",
            expected: `a step named "${name}"`,
            got: "no such step",
          });
          return;
        }
        for (const [pattern, what] of needs) {
          if (!pattern.test(block)) {
            mismatches.push({
              file: `.github/workflows/settings-repos.yml step "${name}"`,
              expected: what,
              got: "missing",
            });
          }
        }
      };
      const settingsTitle = /REPORT_TITLE: \$\{\{ env\.SETTINGS_REPORT_TITLE \}\}/;
      step("Deliver hidden failure diagnostics", [
        [/failure_issue\.ts deliver/, "the deliver call"],
        [settingsTitle, "the settings-specific report title"],
        [/if: failure\(\)/, "a failure() condition"],
      ]);
      // Deliver without resolve leaves the report open after a recovered
      // run, and a shared title would let the sync workflow's green run
      // close a report the settings apply is still failing on.
      step("Resolve the settings failure report", [
        [/failure_issue\.ts resolve/, "the resolve call"],
        [settingsTitle, "the settings-specific report title"],
        [/success\(\)/, "a success() condition"],
        // A moved target was never checked, so a green job alone must not
        // close its open report.
        [/steps\.apply\.outcome == .success./, "a check that the apply actually ran"],
      ]);
      // OUTSIDE the hidden capture, or a hide-details target is skipped
      // with a green job and no signal at all.
      step("Report a skipped target", [
        [/steps\.merge\.outputs\.skipped == 'true'/, "a condition on the merge step's output"],
        [/::notice::/, "a public notice"],
      ]);
      // The whole point of that step is being OUTSIDE the capture, so the
      // wrapper is checked as a forbidden token, not a negated pattern.
      const skipStep = steps.get("Report a skipped target");
      if (skipStep?.includes("run_hidden")) {
        mismatches.push({
          file: '.github/workflows/settings-repos.yml step "Report a skipped target"',
          expected: "the notice stays outside run_hidden, or the skip has no public signal",
          got: "wrapped in run_hidden",
        });
      }
      return mismatches;
    },
  },

  {
    name: "settings-apply-skip-gate",
    run: () => {
      // The apply DELETES labels the merged document does not declare, so
      // every step condition guarding it is load-bearing: a target that
      // dropped the module writes no baseline, one with no settings.yml of
      // its own writes no merged document, and a target whose branch moved
      // has a stale one. No unit test can see a workflow, so the shape is
      // asserted here - on the parsed steps, not on the file's text, so a
      // matching string in a comment or an unrelated step cannot satisfy it.
      const mismatches: Mismatch[] = [];
      const expected: Record<string, string> = {
        merge: "steps.render.outputs.skipped == 'false'",
        freshness:
          "steps.render.outputs.skipped == 'false' && steps.merge.outputs.skipped == 'false'",
        apply: "steps.freshness.outputs.moved == 'false'",
      };
      for (const rel of [
        ".github/workflows/settings-repos.yml",
        ".github/workflows/reusable-apply-settings.yml",
      ]) {
        const steps = workflowSteps(rel);
        for (const [id, condition] of Object.entries(expected)) {
          // EVERY apply step, not the first: a second, ungated
          // invocation of the settings action would otherwise pass.
          const matched =
            id === "apply"
              ? steps.filter((s) => String(s.uses ?? "").includes("github-settings-as-code"))
              : steps.filter((s) => s.id === id);
          if (matched.length === 0) {
            mismatches.push({ file: rel, expected: `a settings ${id} step`, got: "no such step" });
            continue;
          }
          for (const step of matched) {
            const actual = String(step.if ?? "").trim();
            if (actual !== condition) {
              mismatches.push({
                file: rel,
                expected: `the ${id} step condition ${condition}`,
                got: actual === "" ? "no condition at all" : actual,
              });
            }
          }
        }
        // Defense in depth over the REST of the workflow: a condition that
        // tests a step output negatively passes when the step never ran.
        for (const step of steps) {
          const unsafe = unsafeStepCondition(String(step.if ?? ""));
          if (unsafe !== null) {
            mismatches.push({
              file: rel,
              expected: `step "${step.id ?? step.name ?? step.uses}" tests step outputs positively`,
              got: `${unsafe} (a step that did not run has an EMPTY output, which passes)`,
            });
          }
        }
      }
      return mismatches;
    },
  },

  {
    name: "pins-and-identities",
    run: () => {
      const mismatches: Mismatch[] = [];

      const settingsActionRef = (rel: string) =>
        mustMatch(
          read(rel),
          /\/github-settings-as-code@(\S+)/,
          rel,
          "github-settings-as-code pin",
        )[1];
      const applyRef = settingsActionRef(".github/workflows/settings-repos.yml");
      const reusableRef = settingsActionRef(".github/workflows/reusable-apply-settings.yml");
      if (applyRef !== reusableRef) {
        mismatches.push({
          file: ".github/workflows/reusable-apply-settings.yml",
          expected: `github-settings-as-code@${applyRef} (settings-repos.yml)`,
          got: `github-settings-as-code@${reusableRef}`,
        });
      }

      // No git-identity arm: every committer is TypeScript and imports
      // shared/git_identity.ts, so the import is the guarantee.

      // Every PAT URL in every file must match, not just the first per file.
      const patUrls = (rel: string) => {
        const urls = [
          ...read(rel).matchAll(
            /https:\/\/github\.com\/settings\/personal-access-tokens\/new\?[^\s")\]]+/g,
          ),
        ].map((m) => m[0]);
        if (urls.length === 0) {
          throw new Error(`${rel}: anchor for PAT-creation URL not found`);
        }
        return [...new Set(urls)];
      };
      const patFiles = [
        "README.md",
        ".github/workflows/sync-repos.yml",
        ".github/workflows/settings-repos.yml",
      ];
      const referenceUrl = patUrls(patFiles[0])[0];
      for (const rel of patFiles) {
        const stray = patUrls(rel).filter((url) => url !== referenceUrl);
        if (stray.length > 0) {
          mismatches.push({ file: rel, expected: referenceUrl, got: stray.join(", ") });
        }
      }

      const schemaVersion = mustMatch(
        read("biome.json"),
        /biomejs\.dev\/schemas\/([^/]+)\/schema\.json/,
        "biome.json",
        "$schema version",
      )[1];
      const pkg = asRecord(JSON.parse(read("package.json")), "package.json");
      const devDeps = asRecord(pkg.devDependencies, "devDependencies");
      const biomePin = String(devDeps["@biomejs/biome"]).replace(/^[\^~]/, "");
      if (schemaVersion !== biomePin) {
        mismatches.push({
          file: "biome.json",
          expected: `$schema version ${biomePin} (package.json @biomejs/biome pin)`,
          got: schemaVersion,
        });
      }
      return mismatches;
    },
  },

  {
    // Every tracking-label copier question (one per manifest tracking_label
    // stream) must validate exactly the shape the fuzz-issue action
    // enforces, and every later stream's validator must carry the
    // case-insensitive cross-answer collision clause against each earlier
    // answer - the validator is the ONLY collision boundary for
    // settings-sync repos (the fleet preflight covers central ones), so
    // deleting the clause must fail here.
    name: "tracking-label-regex",
    run: () => {
      const mismatches: Mismatch[] = [];
      const action = read("actions/fuzz-issue/fuzz-issue.ts");
      const labelRe = constRegexSource(action, "LABEL_RE", {
        where: "fuzz-issue.ts",
        what: "LABEL_RE",
        exported: true,
      });
      const streams = trackingManifests();
      for (const [index, { tracking }] of streams.entries()) {
        const question = asRecord(copierConfig()[tracking.answer], `copier.yml ${tracking.answer}`);
        const validator = String(question.validator ?? "");
        const copierRe = zToDollar(
          mustMatch(
            validator,
            /regex_search\('([^']+)'\)/,
            `copier.yml ${tracking.answer} validator`,
            "pattern",
          )[1],
        );
        if (copierRe !== labelRe) {
          mismatches.push({
            file: `copier.yml ${tracking.answer} validator`,
            expected: `${labelRe} (actions/fuzz-issue/fuzz-issue.ts LABEL_RE)`,
            got: copierRe,
          });
        }
        for (const earlier of streams.slice(0, index)) {
          const clause = `${tracking.answer} | lower == ${earlier.tracking.answer} | lower`;
          if (!validator.includes(clause)) {
            mismatches.push({
              file: `copier.yml ${tracking.answer} validator`,
              expected: `the collision clause '${clause}' (streams sharing a label close each other's issues)`,
              got: "missing",
            });
          }
        }
      }
      return mismatches;
    },
  },

  {
    // reusable-pages.yml's hand-written token grammar against the manifests'
    // pages declarations. copier.yml's pages_setup validator carries the
    // same token set but is generated from the manifests (generate:check),
    // so the workflow's case arm is the one independently-authored copy.
    name: "pages-grammar",
    run: () => {
      const reference = loadManifests()
        .filter((m) => m.pages !== undefined)
        .map((m) => m.module)
        .concat("none");
      const pages = read(".github/workflows/reusable-pages.yml");
      // Anchor on the token-validation case block: the workflow has other
      // case statements whose arms fit the same shape.
      const tokenCase = mustMatch(
        pages,
        /case "\$tool" in([\s\S]*?)esac/,
        "reusable-pages.yml",
        "token case block",
      )[1];
      const arm = mustMatch(
        tokenCase,
        /^\s*((?:[a-z]+\|)+[a-z]+)\) ;;$/m,
        "reusable-pages.yml",
        "setup case arm",
      )[1];
      return setMismatch(
        ".github/workflows/reusable-pages.yml setup tokens",
        reference,
        arm.split("|"),
      );
    },
  },

  {
    name: "docs-constants",
    run: () => {
      const mismatches: Mismatch[] = [];
      const action = read("actions/fuzz-issue/fuzz-issue.ts");
      const num = (name: string) =>
        constNumberValue(action, name, { where: "fuzz-issue.ts", what: name });
      const reportLines = num("REPORT_LINES");
      const maxBody = num("MAX_BODY");
      const maxBlockChars = num("MAX_BLOCK_CHARS");
      // The doc quotes DIR_NAME's body between its ^...$ anchors; a
      // reshaped regex (anchors gone) is a lost anchor, not a new quote.
      const dirRe = mustMatch(
        constRegexSource(action, "DIR_NAME", { where: "fuzz-issue.ts", what: "DIR_NAME" }),
        /^\^([\s\S]+)\$$/,
        "fuzz-issue.ts",
        "DIR_NAME",
      )[1];

      const fuzzerDoc = read("docs/fuzzer.md");
      const wanted: [string, string][] = [
        [`first ${reportLines} lines`, "REPORT_LINES"],
        [`${maxBlockChars.toLocaleString("en-US")} characters`, "MAX_BLOCK_CHARS"],
        [`\`${dirRe}\``, "DIR_NAME"],
        [`${maxBody.toLocaleString("en-US")} characters`, "MAX_BODY"],
      ];
      for (const [needle, what] of wanted) {
        if (!fuzzerDoc.includes(needle)) {
          mismatches.push({
            file: "docs/fuzzer.md",
            expected: `${JSON.stringify(needle)} (${what})`,
            got: "missing",
          });
        }
      }
      if (maxBody >= 65536) {
        mismatches.push({
          file: "actions/fuzz-issue/fuzz-issue.ts",
          expected: "MAX_BODY under GitHub's 65,536-character cap",
          got: String(maxBody),
        });
      }

      const floor = String(copierConfig()._min_copier_version);
      if (!handProse("docs/new-repo.md").includes(`>= ${floor}`)) {
        mismatches.push({
          file: "docs/new-repo.md",
          expected: `the copier floor '>= ${floor}'`,
          got: "missing",
        });
      }

      // Anchored on the parameter table's row (like the pages cells): a
      // bare backticked "skills" occurs in the doc for unrelated reasons,
      // so only the row's Default cell can satisfy this.
      const skillsDefault = String(asRecord(copierConfig().skills_dir, "skills_dir").default);
      const skillsCell = mustMatch(
        handProse("docs/skills.md"),
        /^\| `skills_dir` \|.+\| ([^|]+) \|$/m,
        "docs/skills.md",
        "the skills_dir table row",
      )[1].trim();
      if (skillsCell !== `\`${skillsDefault}\``) {
        mismatches.push({
          file: "docs/skills.md",
          expected: `the skills_dir Default cell \`${skillsDefault}\``,
          got: skillsCell,
        });
      }

      const settingsProse = handProse("docs/settings.md");
      // Only the two labels the hand prose quotes: the per-toolchain
      // dependabot labels sit in generated dependabot-labels regions
      // (generate:check owns those). Name and color must appear in the
      // exact quoted shape `name` (`color`) / `name` (color `color`) -
      // a spannable gap would let a wrong hand-written color pass by
      // matching a backticked color later in the doc.
      const roster = new Map(managedLabelRoster().map((label) => [label.name, label]));
      for (const name of ["dependencies", "github_actions"]) {
        const label = roster.get(name);
        if (!label)
          throw new Error(`render_managed_settings.ts: label '${name}' vanished - anchor lost`);
        const joint = new RegExp(`\`${name}\` \\((?:color )?\`${label.color}\`\\)`);
        if (!joint.test(settingsProse)) {
          mismatches.push({
            file: "docs/settings.md",
            expected: `label \`${name}\` quoted as \`${name}\` (\`${label.color}\`) in hand prose`,
            got: "missing, reworded, or a different color",
          });
        }
      }

      // Every tracking stream's copier default is quoted in its module doc
      // and in docs/settings.md, whose hand prose also quotes the label
      // color (the manifest is the fragments' anchor, so the docs follow
      // the same source).
      for (const { module, tracking } of trackingManifests()) {
        for (const doc of [`docs/${module}.md`, "docs/settings.md"]) {
          if (!handProse(doc).includes(`\`${tracking.default}\``)) {
            mismatches.push({
              file: doc,
              expected: `the ${tracking.answer} default \`${tracking.default}\``,
              got: "missing",
            });
          }
        }
        if (!settingsProse.includes(`\`${tracking.color}\``)) {
          mismatches.push({
            file: "docs/settings.md",
            expected: `the ${module} tracking label color \`${tracking.color}\``,
            got: "missing",
          });
        }
      }
      return mismatches;
    },
  },

  {
    name: "agents-recipe",
    run: () => {
      const mismatches: Mismatch[] = [];
      const smoke = read(".github/scripts/ci/smoke_generate.ts");
      // Reassembled into the flag string AGENTS.md's recipe carries.
      const vcsRef = argvStringAfter(smoke, "--vcs-ref", ["--defaults", "--trust"], {
        where: "smoke_generate.ts",
        what: "copier flags",
      });
      const flags = `--vcs-ref ${vcsRef} --defaults --trust`;
      const keys = argvFlagLeads(smoke, "-d").flatMap((lead) => {
        const key = /^([a-z_]+)=/.exec(lead);
        return key === null ? [] : [key[1]];
      });
      if (keys.length === 0)
        throw new Error("smoke_generate.ts: no -d answers found - anchor lost");
      const agents = read("AGENTS.md");
      if (!agents.includes(flags)) {
        mismatches.push({
          file: "AGENTS.md",
          expected: `the copier flags '${flags}'`,
          got: "missing",
        });
      }
      for (const key of new Set(keys)) {
        if (!agents.includes(`${key}=`)) {
          mismatches.push({
            file: "AGENTS.md",
            expected: `a -d ${key}=... answer in the recipe`,
            got: "missing",
          });
        }
      }
      // The recipe's staging leg, pinned to the shared hermetic argv
      // (agentsStagingMismatches states the decision and its reason).
      mismatches.push(...agentsStagingMismatches(agents));
      return mismatches;
    },
  },

  {
    name: "owner-slug",
    run: () => {
      const mismatches: Mismatch[] = [];
      const { username, slug } = jinjaVars();
      // capture() carries the hang bound a bare piped spawn lacks (the
      // spawn-sync-hang-bound rule's semantics - the checker must not be
      // its own counterexample).
      const proc = capture(["git", "-C", REPO_ROOT, "ls-files"]);
      if (proc.exitCode !== 0) {
        throw new Error(
          `git ls-files failed${proc.timedOut ? " (timed out)" : ""}: ${proc.stderr.trim()}`,
        );
      }
      const files = proc.stdout
        .split("\n")
        .filter((rel) => rel !== "" && !rel.endsWith(".test.ts"));
      const slugRe = new RegExp(`([A-Za-z0-9-]+)/${slug}(?![A-Za-z0-9-])`, "g");
      let sawExpected = false;
      for (const rel of files) {
        const text = read(rel);
        for (const match of text.matchAll(slugRe)) {
          // <something>/repo-platform.<ext> is a filename inside a path
          // (say, a scratch repo-platform.yml), not an owner slug.
          if (/^\.[A-Za-z0-9]/.test(text.slice(match.index + match[0].length))) continue;
          // The sync branch name is not an owner slug either.
          if (match[1] === "automation") continue;
          if (match[1].toLowerCase() === username.toLowerCase()) {
            sawExpected = true;
            continue;
          }
          mismatches.push({
            file: rel,
            expected: `${username}/${slug} (copier.yml github_username default)`,
            got: match[0],
          });
        }
      }
      if (!sawExpected)
        throw new Error(`no '${username}/${slug}' literal found anywhere - anchor lost`);
      return mismatches;
    },
  },

  {
    // The release-freshness ancestor check exists twice: the shell-checked
    // .github/scripts/ci/release_freshness.sh copy this repo lints, and the
    // fleet-ci.yml job inlining the same logic (a reusable workflow runs in
    // the CALLER's checkout, where this repo's scripts do not exist). Pin
    // the core lines so a fix to one side cannot silently leave the other
    // behind.
    name: "release-freshness-parity",
    run: () => {
      const mismatches: Mismatch[] = [];
      const script = ".github/scripts/ci/release_freshness.sh";
      const fleetCi = ".github/workflows/fleet-ci.yml";
      const pins: { line: string; files: string[] }[] = [
        {
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell line pinned in both copies
          line: 'tip="$(git rev-parse "origin/${GITHUB_BASE_REF}")"',
          files: [script, fleetCi],
        },
        {
          line: 'if git merge-base --is-ancestor "$tip" HEAD; then',
          files: [script, fleetCi],
        },
      ];
      // The release-PR predicates, compared on the PARSED jobs (the two
      // release gates share the same condition text, so a whole-file grep
      // would stay green with one of them changed or deleted): a renamed
      // release-please branch prefix or a dropped module clause would make
      // the job skip and the gate silently stand down.
      const releaseGateIf =
        "contains(fromJSON(inputs.modules), 'release-please') && github.event_name == 'pull_request' && startsWith(github.head_ref, 'release-please--')";
      const fleetJobs = ciJobs(asRecord(parseYaml(read(fleetCi)), fleetCi), fleetCi);
      for (const job of ["release-freshness", "release-health"]) {
        const actual = String(asRecord(fleetJobs[job] ?? {}, job).if ?? "").trim();
        if (actual !== releaseGateIf) {
          mismatches.push({
            file: `${fleetCi} job '${job}'`,
            expected: `the pinned release-PR condition ${releaseGateIf}`,
            got: actual === "" ? "no condition" : actual,
          });
        }
      }
      for (const pin of pins) {
        for (const rel of pin.files) {
          // Whole-line (trimmed) equality: a decorated copy ("|| true") or
          // a commented-out line must not satisfy the pin.
          const hit = read(rel)
            .split("\n")
            .some((l) => l.trim() === pin.line);
          if (!hit) {
            mismatches.push({
              file: rel,
              expected: `the pinned release-freshness line ${JSON.stringify(pin.line)}`,
              got: "missing - the twin copies drifted",
            });
          }
        }
      }
      return mismatches;
    },
  },

  {
    // open_pr.ts reads run_hidden.ts capture files by name to put hidden
    // validation diagnostics into the PR body; the names derive from the
    // labels at the run_hidden call sites. Rewording a label would
    // silently break that hand-off, so every referenced capture name
    // must match a label-derived one.
    name: "hidden-capture-names",
    run: () => {
      const mismatches: Mismatch[] = [];
      const labels = [
        ...[
          ...read(".github/workflows/reusable-template-sync.yml").matchAll(
            /run_hidden\.ts "([^"]+)" --/g,
          ),
        ].map((match) => match[1]),
        ...wrappedArgvLabels(read(".github/scripts/sync/commit_push.ts"), "run_hidden.ts"),
      ];
      if (labels.length === 0) {
        throw new Error("no run_hidden labels found in the sync call sites - anchor lost");
      }
      const derived = new Set(labels.map(captureName));
      const referenced = literalMatches(
        read(".github/scripts/sync/open_pr.ts"),
        /hidden-[A-Za-z0-9-]+\.log/g,
      );
      if (referenced.length === 0) {
        throw new Error("open_pr.ts references no hidden capture files - anchor lost");
      }
      for (const name of referenced) {
        if (!derived.has(name)) {
          mismatches.push({
            file: ".github/scripts/sync/open_pr.ts",
            expected: `a capture name derived from a run_hidden label (${[...derived].join(", ")})`,
            got: name,
          });
        }
      }
      return mismatches;
    },
  },

  {
    // The CODEOWNERS assignee-resolution function is inlined twice: once
    // in reusable-auto-assign.yml and once in
    // reusable-auto-assign-alerts.yml (split for permissions - see the file
    // headers). It cannot be hoisted: a reusable workflow runs from the
    // CALLER's checkout, where this repo's scripts do not exist. Pin the
    // copies byte-identical so a fix to one cannot silently leave the
    // other behind.
    name: "auto-assign-codeowners-parity",
    run: () => {
      const mismatches: Mismatch[] = [];
      const sites = [
        { file: ".github/workflows/reusable-auto-assign.yml", copies: 1 },
        { file: ".github/workflows/reusable-auto-assign-alerts.yml", copies: 1 },
      ];
      const found: { file: string; body: string }[] = [];
      for (const site of sites) {
        const blocks = inlineFunctionCopies(read(site.file), "resolveAssignees");
        if (blocks.length !== site.copies) {
          throw new Error(
            `${site.file}: expected ${site.copies} resolveAssignees ` +
              `cop${site.copies === 1 ? "y" : "ies"}, found ${blocks.length} - anchor lost`,
          );
        }
        for (const body of blocks) found.push({ file: site.file, body });
      }
      const [canon, ...rest] = found;
      for (const copy of rest) {
        if (copy.body !== canon.body) {
          mismatches.push({
            file: copy.file,
            expected: `a resolveAssignees block byte-identical to ${canon.file}'s first copy`,
            got: "a drifted copy - update every inline copy together",
          });
        }
      }
      return mismatches;
    },
  },

  {
    // Every composite action that runs bun carries the same three-step
    // setup guard: probe for a caller-installed bun, install only when
    // absent, retry the install once (a setup-bun fetch flake on a nightly
    // reporting path turns a green night red). The block cannot be hoisted
    // into a shared action - a relative `uses:` inside a composite action
    // resolves against the CALLER's workspace, not this repo - so the
    // copies are load-bearing; this rule keeps every copy present and
    // identical, and catches a future bun-running action shipped bare.
    name: "actions-bun-guard",
    run: () => {
      const mismatches: Mismatch[] = [];
      const guard = [
        "- name: Check for a caller-installed bun",
        "id: bun",
        "shell: bash",
        'run: echo "present=$(command -v bun >/dev/null && echo true || echo false)" >> "$GITHUB_OUTPUT"',
        "- name: Set up bun",
        "id: setup-bun",
        "if: steps.bun.outputs.present != 'true'",
        "continue-on-error: true",
        "uses: oven-sh/setup-bun@v2",
        "- name: Set up bun (retry)",
        "if: steps.setup-bun.outcome == 'failure'",
        "uses: oven-sh/setup-bun@v2",
      ];
      for (const dir of readdirSync(join(REPO_ROOT, "actions"))) {
        const file = `actions/${dir}/action.yml`;
        if (!existsSync(join(REPO_ROOT, file))) continue;
        const text = read(file);
        // Single-line `run: bun ...` steps and `bun ...` lines inside
        // block-scalar run steps both count; a prose line starting with
        // "bun " would over-demand the guard, which fails closed.
        if (!/^\s*run: bun /m.test(text) && !/^\s*bun /m.test(text)) continue;
        // Trimmed: the guard sits at different depths across actions.
        const lines = semanticLines(text).map((line) => line.trim());
        const carried = lines.some((_, i) => guard.every((line, j) => lines[i + j] === line));
        if (!carried) {
          mismatches.push({
            file,
            expected: "the canonical three-step bun setup guard (probe, guarded install, retry)",
            got: "missing or drifted from the block this rule pins",
          });
        }
      }
      return mismatches;
    },
  },

  {
    // copier.yml's hooks run with {{ _copier_conf.src_path }} = the build
    // branch root, and actions/ is the one tree the branch ships verbatim
    // at its checkout-relative path (branch_tree.ts copies it whole, minus
    // its EXCLUDED_DIRS). A hook command therefore resolves on renders
    // exactly when its path is a clean actions/ file the copy ships; a
    // moved or renamed hook file that copier.yml still names the old way
    // would fail every render's stamping at hook time, on the fleet, not
    // in this repo's CI. The rule also pins the stamping WIRING itself:
    // _tasks (copy/recopy) and _migrations (update) must each run the
    // stamper at its real location - hooks that all name some other valid
    // file would leave every render's manifest unstamped and stay green.
    name: "stamp-hook-path",
    run: () => {
      const mismatches: Mismatch[] = [];
      const stampHook = "actions/shared/stamp_manifest.ts";
      const doc = asRecord(parseYaml(read("copier.yml")), "copier.yml");
      const commandsOf = (list: unknown): string[] =>
        (Array.isArray(list) ? list : []).map((hook) =>
          String(asRecord(hook, "copier.yml hook").command ?? ""),
        );
      const sites: [string, string[]][] = [
        ["_tasks", commandsOf(doc._tasks)],
        ["_migrations", commandsOf(doc._migrations)],
      ];
      const pathOf = (command: string): string =>
        mustMatch(
          command,
          /^bun "\{\{ _copier_conf\.src_path \}\}\/(.+)"$/,
          "copier.yml",
          "a src_path-anchored bun hook command",
        )[1];
      for (const [site, commands] of sites) {
        if (!commands.some((command) => pathOf(command) === stampHook)) {
          mismatches.push({
            file: "copier.yml",
            expected: `a ${site} hook running ${stampHook} (copier runs _tasks only on copy/recopy and _migrations only on update, so each site needs its own)`,
            got: "none - renders on that path would ship an unstamped manifest",
          });
        }
        for (const command of commands) {
          const path = pathOf(command);
          // Judged on the path the BRANCH serves, not what this checkout
          // can lexically reach: traversal ("actions/../scripts/x.ts") and
          // excluded segments (node_modules, dist, .turbo) exist here but
          // never ship, so they must fail like any other unshipped path.
          const segments = path.split("/");
          const clean =
            segments[0] === "actions" &&
            segments.every(
              (segment) =>
                segment !== "" &&
                segment !== "." &&
                segment !== ".." &&
                !EXCLUDED_ACTION_DIRS.has(segment),
            );
          const shipped = (): boolean => {
            try {
              return lstatSync(join(REPO_ROOT, path)).isFile();
            } catch {
              return false;
            }
          };
          if (!clean || !shipped()) {
            mismatches.push({
              file: "copier.yml",
              expected: `${site} hook path '${path}' to be a clean, traversal-free actions/ file (the only tree the build branch ships at its checkout-relative path, minus branch_tree.ts's excluded directories)`,
              got: "a path the branch does not serve, so every render's hook would fail",
            });
          }
        }
      }
      return mismatches;
    },
  },

  {
    // Both apply paths must hand github-settings-as-code the MERGED
    // document. A one-line regression to managed-settings.yml ships a
    // baseline-only apply - the exact document the merge pipeline exists
    // to never produce, because the action's label reconciliation would
    // delete every label the repository declares for itself - and every
    // other gate stays green while it does. Self-contained on purpose:
    // both workflows are parsed right here, leaning on no shared workflow
    // helpers.
    name: "settings-apply-merged-input",
    run: () => {
      const mismatches: Mismatch[] = [];
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal GitHub Actions expression, pinned byte-for-byte
      const wanted = "${{ runner.temp }}/merged-settings.yml";
      const mapping = (value: unknown): Record<string, unknown> =>
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      for (const rel of [
        ".github/workflows/settings-repos.yml",
        ".github/workflows/reusable-apply-settings.yml",
      ]) {
        const jobs = mapping(mapping(parseYaml(read(rel))).jobs);
        const applySteps: Record<string, unknown>[] = [];
        for (const job of Object.values(jobs)) {
          const steps = mapping(job).steps;
          if (!Array.isArray(steps)) continue;
          for (const raw of steps) {
            const step = mapping(raw);
            if (String(step.uses ?? "").includes("github-settings-as-code")) {
              applySteps.push(step);
            }
          }
        }
        if (applySteps.length === 0) {
          throw new Error(`${rel}: no github-settings-as-code step - anchor lost`);
        }
        for (const step of applySteps) {
          const settingsFile = String(mapping(step.with)["settings-file"] ?? "");
          if (settingsFile !== wanted) {
            mismatches.push({
              file: rel,
              expected: `the apply step reads settings-file: ${wanted}`,
              got: settingsFile === "" ? "no settings-file input" : settingsFile,
            });
          }
        }
      }
      return mismatches;
    },
  },

  {
    // settings-repos.yml is the one fleet-wide settings WRITER, and its
    // green gate is a plain step of the select job - trimming it would
    // leave the workflow applying from raw pushed commits again, with
    // every other gate green. Pinned on the parsed steps (a mention in a
    // comment cannot satisfy it), before the target selection so an
    // ungreen commit never even computes a matrix. Self-contained like
    // the rule above.
    name: "settings-green-gate",
    run: () => {
      const mismatches: Mismatch[] = [];
      const rel = ".github/workflows/settings-repos.yml";
      const mapping = (value: unknown): Record<string, unknown> =>
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      const select = mapping(mapping(mapping(parseYaml(read(rel))).jobs).select);
      const steps = Array.isArray(select.steps) ? select.steps.map(mapping) : [];
      if (steps.length === 0) throw new Error(`${rel}: no select job steps - anchor lost`);
      const runs = steps.map((step) => String(step.run ?? ""));
      const gateAt = runs.findIndex((run) =>
        run.includes("bun .github/scripts/fleet/require_green_commit.ts"),
      );
      const selectAt = runs.findIndex((run) =>
        run.includes("bun .github/scripts/fleet/select_settings_repos.ts"),
      );
      if (selectAt === -1) throw new Error(`${rel}: no target-selection step - anchor lost`);
      if (gateAt === -1) {
        mismatches.push({
          file: rel,
          expected: "a select-job step running fleet/require_green_commit.ts",
          got: "missing - the fleet-wide settings writer would run ungated from raw pushes",
        });
      } else if (gateAt > selectAt) {
        mismatches.push({
          file: rel,
          expected: "the green gate BEFORE the target selection",
          got: "the gate runs after targets are computed",
        });
      } else if (String(steps[gateAt].if ?? "") !== "") {
        mismatches.push({
          file: rel,
          expected: "an unconditional green gate (every trigger reads main's tip)",
          got: `if: ${String(steps[gateAt].if)}`,
        });
      }
      return mismatches;
    },
  },

  {
    // The heal's SHA PLUMBING: the green gate resolves the one commit
    // the run may write from (the tip, or the scheduled fallback's green
    // ancestor) and every checkout must consume it. Judged structurally
    // on the parsed workflow by settingsHealShaPlumbingMismatches (whose
    // header records the links and the decoy shapes it exists to catch);
    // probe C proved the gap: deleting the apply checkout's ref was
    // invisible to every local gate while the job silently reverted to
    // the trigger ref. Self-contained like the rule above.
    name: "settings-heal-sha-plumbing",
    run: () => settingsHealShaPlumbingMismatches(read(".github/workflows/settings-repos.yml")),
  },

  {
    // Every run_hidden-wrapped step in settings-repos.yml must be
    // followed by a PUBLIC ::notice:: step that fires on one of the
    // wrapped step's own outputs. The capture swallows a wrapped step's
    // success output - warnings included - for a hide-details target, so
    // without a compensating notice its skip is a green job with no
    // signal at all. DERIVED from the workflow rather than pinned per
    // step: this gap was reintroduced three times one step at a time (the
    // merge notice, then the freshness wrap, then the notice condition
    // missing the freshness clause), so a fourth wrapped script fails
    // here until it gets its notice instead of repeating the cycle.
    // Order is part of the requirement - the notice must sit AFTER the
    // wrapped step, or it reads outputs that do not exist yet.
    // Self-contained like the neighbouring settings rules.
    name: "settings-hidden-step-notices",
    run: () => {
      const mismatches: Mismatch[] = [];
      const rel = ".github/workflows/settings-repos.yml";
      const mapping = (value: unknown): Record<string, unknown> =>
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      const jobs = mapping(mapping(parseYaml(read(rel))).jobs);
      let wrapped = 0;
      for (const [jobName, job] of Object.entries(jobs)) {
        const steps = mapping(job).steps;
        if (!Array.isArray(steps)) continue;
        const parsed = steps.map(mapping);
        parsed.forEach((step, index) => {
          if (!String(step.run ?? "").includes("run_hidden.ts")) return;
          wrapped++;
          const id = String(step.id ?? "");
          if (id === "") {
            mismatches.push({
              file: rel,
              expected: `an id on the run_hidden-wrapped step ${JSON.stringify(String(step.name ?? "?"))} (job '${jobName}')`,
              got: "no id - a compensating notice cannot reference the step's outcome",
            });
            return;
          }
          // Positive equality against 'true', the one output test an
          // unrun step cannot satisfy (unsafeStepCondition's rule). The
          // id is escaped so an exotic step id cannot broaden the match.
          const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const fires = new RegExp(`steps\\.${escaped}\\.outputs\\.[\\w-]+ == 'true'`);
          const compensated = parsed.slice(index + 1).some((later) => {
            const laterRun = String(later.run ?? "");
            return (
              !laterRun.includes("run_hidden") &&
              laterRun.includes("::notice::") &&
              fires.test(String(later.if ?? ""))
            );
          });
          if (!compensated) {
            mismatches.push({
              file: rel,
              expected:
                `a public ::notice:: step AFTER the hidden '${id}' step whose condition ` +
                `carries steps.${id}.outputs.<name> == 'true' - the capture swallows the ` +
                "step's own warnings, so its skip would otherwise be a green job with no signal",
              got: "no such step",
            });
          }
        });
      }
      if (wrapped === 0) throw new Error(`${rel}: no run_hidden-wrapped steps - anchor lost`);
      return mismatches;
    },
  },

  {
    // Referenced-label preflight: the FAIL-CLOSED guard both apply paths
    // run before github-settings-as-code's reconciliation DELETES labels
    // (fleet/label_preflight.ts). Dropping, reordering, softening, or
    // re-aiming the step is silent - the apply stays green while
    // referenced-label deletions go unchecked, or checked against the
    // WRONG repository - so the whole landed shape is pinned: exactly
    // one preflight and exactly one apply step per apply job, the
    // preflight BEFORE the apply, `if:`
    // identical (after trimming) to each apply step's, the invocation
    // MULTISET as exact argument lists, the run block byte-identical
    // (PREFLIGHT_EXPECTED_RUN, the terminal backstop a textual parser
    // cannot be smuggled past), the preflight-to-apply GAP byte-pinned
    // (PREFLIGHT_GAP_STEPS - an intervening step could rewrite the
    // merged document after the guard validated it), the COMPLETE
    // apply-input census (PREFLIGHT_APPLY_WITH: every with: key
    // parity-mirrored from a preflight env var, literal-pinned, or
    // presence-only where another rule owns the value), ALLOWLISTED
    // step, step-env, job-env, and job keys (PREFLIGHT_APPLY_JOB_KEYS,
    // with runs-on value-pinned - a container:, services:, or runner
    // change re-homes the execution context under every step-level
    // pin), and no workflow/job defaults
    // and no persisted-environment writes (shell:, working-directory:,
    // continue-on-error:, BASH_ENV, GITHUB_ENV, GITHUB_PATH each
    // reroute or soften the guard while every pinned fact reads
    // intact). In settings-repos.yml every invocation must
    // be run_hidden-wrapped (label names and referencing paths are
    // target content) on the fixed id 'labels' its stood-down notice
    // keys on - settings-hidden-step-notices pins the notice; this rule
    // pins the step it compensates. The judgment itself is
    // labelPreflightJobMismatches, pure over a parsed job, with the
    // grammar in shellSegments/preflightInvocation/preflightArgs - all
    // unit-tested against the spoof shapes a live-file mutation cannot
    // isolate.
    name: "settings-label-preflight",
    run: () =>
      [
        ".github/workflows/settings-repos.yml",
        ".github/workflows/reusable-apply-settings.yml",
      ].flatMap((rel) => labelPreflightFileMismatches(rel, asRecord(parseYaml(read(rel)), rel))),
  },

  {
    // No PIPED Bun spawnSync without a hard `timeout`. On the pinned bun
    // runtime a piped synchronous spawn returns at pipe EOF rather than
    // child exit and pipes both output streams by default
    // (spawnSyncHazard has the measured semantics), so one bare git call
    // can wedge a checker forever behind any descendant that inherited
    // the pipe. Scope: scripts/**, .github/scripts/**, AND tests/** -
    // bun-test's caps are no substitute for a spawn bound: a synchronous
    // spawn blocks the runner, so the per-test timeout cannot interrupt
    // a hung child, and the 5s hook cap trips spuriously on cold starts
    // in fresh worktrees, so suites carry their own explicit bounds
    // (the fleet selector suites' lesson). A positive numeric literal or
    // a named constant IS the bar - tests legitimately need stdio/env
    // shapes proc.ts does not expose, so the helpers are the recommended
    // remedy, not the required one (constants stay spawnSyncHazard's
    // recorded trusted residual: resolving one is value analysis a
    // textual scan cannot do, and rejecting identifiers would red
    // proc.ts's own `timeout: timeoutMs`). tests/ converts through
    // tests/shared/bounded_spawn.ts, the bounded-by-default harness
    // spawn (its internal call carries the bound this rule proves);
    // every site reports per site - the tests/ debt book that once rode
    // here burned to zero and was retired. ASYNC Bun.spawn is judged beside the sync bar under its
    // own model (ASYNC_SPAWN_FILES has the statement): sync =
    // bounded-or-unpiped, async = deadline-or-enumerated, because the
    // async form neither blocks the caller at pipe EOF nor offers a
    // timeout option to pin - and the async pass also scans actions/,
    // where two enumerated sites live (the sync scan's scope is
    // unchanged there; actions run in caller checkouts with their own
    // conventions, and their sync spawns are the actions-bun-guard
    // review surface, not this rule's).
    name: "spawn-sync-hang-bound",
    run: () => {
      const mismatches: Mismatch[] = [];
      let sites = 0;
      const files = [
        ...walkFiles("scripts"),
        ...walkFiles(".github/scripts"),
        ...walkFiles("tests"),
      ]
        .filter((f) => !f.symlink && /\.[mc]?[jt]s$/.test(f.path))
        .map((f) => f.path);
      for (const rel of files) {
        for (const site of spawnSyncSites(read(rel), rel)) {
          sites++;
          if (site.kind === "reference") {
            mismatches.push({
              file: `${rel}:${site.line}`,
              expected:
                "a direct Bun spawnSync call (an alias or destructure cannot be audited for a hang bound)",
              got: "a non-call reference",
            });
            continue;
          }
          const hazard = spawnSyncHazard(site.options);
          if (hazard !== null) {
            const helper = rel.startsWith("tests/")
              ? "tests/shared/bounded_spawn.ts"
              : ".github/scripts/shared/proc.ts";
            mismatches.push({
              file: `${rel}:${site.line}`,
              expected: `a bounded or unpiped spawnSync: a ${helper} helper, an explicit timeout, or every output stream shaped to inherit/ignore/file fds`,
              got: hazard,
            });
          }
        }
      }
      // The async pass, actions/ included: every Bun.spawn caller must
      // sit in ASYNC_SPAWN_FILES by name (exact set, both directions).
      const asyncFiles = [
        ...files,
        ...walkFiles("actions")
          .filter((f) => !f.symlink && /\.[mc]?[jt]s$/.test(f.path))
          .map((f) => f.path),
      ];
      const asyncPresent = new Set(asyncFiles);
      for (const rel of asyncFiles) {
        mismatches.push(...asyncSpawnMismatches(rel, read(rel), rel in ASYNC_SPAWN_FILES));
      }
      for (const rel of Object.keys(ASYNC_SPAWN_FILES).sort()) {
        if (!asyncPresent.has(rel)) {
          mismatches.push({
            file: rel,
            expected: "a scanned file (ASYNC_SPAWN_FILES keys the scanned trees)",
            got: "no such file - stale enumeration entry; remove it",
          });
        }
      }
      if (sites === 0) {
        throw new Error("no Bun spawnSync call found in the scoped trees - anchor lost");
      }
      return mismatches;
    },
  },

  {
    // No async process stream write in the executable trees: on
    // pipe-backed stdio (the Actions runner shape) bun queues these
    // writes, and a process.exit anywhere later in the run drops
    // everything past the pipe buffer (measured at 64 KiB on bun 1.3.14,
    // 128 KiB on 1.4.0) - 13 sites were converted to writeSync one
    // truncation at a time before this rule pinned the class. Scope:
    // scripts/**, .github/scripts/**, and actions/**; tests are excluded
    // by design (tests/ sits outside these roots and the actions' *.test.ts
    // files are filtered out): bun-test owns a test's process lifecycle,
    // so the exit-under-buffered-write truncation is not a shape a test
    // file can produce. tests/shared/stream_write_discipline.test.ts is
    // the bun-test-side guard on the same contract.
    name: "stream-write-sync",
    run: () => {
      const files = ["scripts", ".github/scripts", "actions"].flatMap((root) => {
        const found = walkFiles(root)
          .filter(
            (f) =>
              !f.symlink && /\.[mc]?[jt]s$/.test(f.path) && !/\.test\.[mc]?[jt]s$/.test(f.path),
          )
          .map((f) => f.path);
        if (found.length === 0) throw new Error(`${root}: no scripts to scan - anchor lost`);
        return found;
      });
      const present = new Set(files);
      const mismatches = files.flatMap((rel) =>
        asyncStreamWriteMismatches(rel, read(rel), NATURAL_EXIT_WRITE_FILES.has(rel)),
      );
      // Existence control on the allowlist keys themselves: an entry
      // naming a file the walk never sees would excuse nothing, silently.
      for (const rel of [...NATURAL_EXIT_WRITE_FILES].sort()) {
        if (!present.has(rel)) {
          mismatches.push({
            file: rel,
            expected: "a scanned file (NATURAL_EXIT_WRITE_FILES keys the scanned trees)",
            got: "no such file - stale allowlist entry; remove it",
          });
        }
      }
      return mismatches;
    },
  },

  {
    // The LOCAL bun runtime must be the pinned MAJOR.MINOR (.bun-version,
    // the dogfooded templates/bun pin): a full local `bun run check` under
    // a different runtime is unreliable evidence - it once passed clean
    // under 1.3.14 while CI's 1.4.0 went red on the same commit. In CI
    // this rule can never fire (setup-bun installs from bun-version-file),
    // so it exists exclusively as a local-gate guard.
    name: "local-bun-runtime",
    run: () => bunRuntimeMismatches(Bun.version, read(".bun-version").trim()),
  },
];

// --- the checker's own rule roster ------------------------------------------

/** Every rule this checker runs, by name - the checker's own authored
 *  roster, mirroring ALL_GREEN_ROSTER one level down: the run loop counts
 *  whatever the rules array happens to hold, so a rule silently dropped
 *  (a bad merge, a refactor that loses an entry) or registered twice
 *  would stay green with nothing to notice it. main() compares this list
 *  against the live rules in both directions (ruleRosterMismatches), so
 *  adding a rule means adding its name here, and deleting one means
 *  removing its entry in the same change, deliberately. */
export const RULE_ROSTER = [
  "module-list",
  "dogfood-oracle-row",
  "bun-dirs",
  "action-pins",
  "starter-pin-rollout",
  "bun-types-pin",
  "toolchain-version-files",
  "local-gates",
  "dogfood-parity",
  "gitattributes-subset",
  "dependabot-actions-block",
  "dependabot-action-dirs",
  "ci-skeleton",
  "typography-allow",
  "symlink-trio",
  "settings-starter",
  "labels",
  "issue-labels",
  "release-guard-labels",
  "all-green-roster",
  "fleet-ci-roster",
  "all-green-name",
  "all-green-wrapper-template",
  "fleet-ci-render-roster",
  "dependabot-label-tuples",
  "settings-read-pin",
  "self-apply-fact-source",
  "settings-hide-details",
  "settings-apply-skip-gate",
  "pins-and-identities",
  "tracking-label-regex",
  "pages-grammar",
  "docs-constants",
  "agents-recipe",
  "owner-slug",
  "release-freshness-parity",
  "hidden-capture-names",
  "auto-assign-codeowners-parity",
  "actions-bun-guard",
  "stamp-hook-path",
  "settings-apply-merged-input",
  "settings-green-gate",
  "settings-heal-sha-plumbing",
  "settings-hidden-step-notices",
  "settings-label-preflight",
  "spawn-sync-hang-bound",
  "stream-write-sync",
  "local-bun-runtime",
] as const;

/** Set-plus-uniqueness comparison between the authored roster and the
 *  live rules' names, mirroring verdictRosterMismatches' two directions:
 *  a live rule missing from the roster is a gate the roster never vouched
 *  for, a roster entry with no live rule is a DROPPED rule - the silent
 *  case the roster exists for, since the run loop only ever counts what
 *  survived - and a duplicate on either side is a double-run rule or a
 *  double-vouched entry. Not a rule itself: it runs unconditionally in
 *  main(), before the loop it audits, so it cannot drop out of the rules
 *  array alongside what it guards. */
export function ruleRosterMismatches(
  roster: readonly string[],
  names: readonly string[],
): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const flagDuplicate = (list: readonly string[], site: string) => {
    const duplicate = list.find((name, index) => list.indexOf(name) !== index);
    if (duplicate !== undefined) {
      mismatches.push({
        file: site,
        expected: "each rule name listed once",
        got: `'${duplicate}' appears more than once`,
      });
    }
  };
  flagDuplicate(roster, "scripts/check_ssot.ts RULE_ROSTER");
  flagDuplicate(names, "scripts/check_ssot.ts rules");
  const expected = new Set(roster);
  for (const name of names) {
    if (!expected.has(name)) {
      mismatches.push({
        file: "scripts/check_ssot.ts rules",
        expected: `rule '${name}' in RULE_ROSTER (adding a rule is a roster edit too)`,
        got: "not in the roster - add its name there, deliberately",
      });
    }
  }
  const present = new Set(names);
  for (const name of roster) {
    if (!present.has(name)) {
      mismatches.push({
        file: "scripts/check_ssot.ts RULE_ROSTER",
        expected: `a rule named '${name}'`,
        got: "no such rule - a dropped rule is a silently retired gate; remove the entry in the same change, deliberately",
      });
    }
  }
  return mismatches;
}

/** Normalize python-style \Z end anchors to $, for regex-pair comparison. */
export function zToDollar(pattern: string): string {
  return pattern.replace(/\\Z$/, "$");
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    console.error(`error: unrecognized argument(s): ${args.join(" ")}`);
    return 2;
  }
  let failures = 0;
  // The roster audit runs before the loop it vouches for: a rules array
  // that lost or doubled an entry must scream regardless of what the
  // surviving rules report.
  for (const mismatch of ruleRosterMismatches(
    RULE_ROSTER,
    rules.map((rule) => rule.name),
  )) {
    console.error(
      `rule-roster: ${mismatch.file} -> expected ${mismatch.expected}, got ${mismatch.got}`,
    );
    failures++;
  }
  for (const rule of rules) {
    let mismatches: Mismatch[];
    try {
      mismatches = rule.run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      mismatches = [{ file: "(rule aborted)", expected: "a readable anchor", got: message }];
    }
    for (const mismatch of mismatches) {
      console.error(
        `${rule.name}: ${mismatch.file} -> expected ${mismatch.expected}, got ${mismatch.got}`,
      );
      failures++;
    }
  }
  for (const [index, entry] of RECORDED_DIVERGENCES.entries()) {
    if (!usedDivergences.has(index)) {
      console.error(
        `recorded-divergences: ${entry.file} -> expected pattern ${entry.skip} to match a line, got nothing (stale entry - remove it)`,
      );
      failures++;
    }
  }
  if (failures > 0) {
    console.error(`ssot: ${failures} mismatch(es) across ${rules.length} rules`);
    return 1;
  }
  console.log(`ssot: all ${rules.length} rules green`);
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
