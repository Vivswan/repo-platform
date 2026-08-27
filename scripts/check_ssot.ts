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
// text disappears fails loudly instead of passing vacuously. Template
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
import { parse as parseYaml } from "yaml";
import {
  COPILOT_REVIEW_CONTEXT,
  identityKeyIssues,
  loadOverrideLayer,
} from "../.github/scripts/fleet/merge_settings_layers.ts";
import { allLayerLabels, loadLayer } from "../.github/scripts/fleet/render_managed_settings.ts";
import { captureName } from "../.github/scripts/sync/run_hidden.ts";
import { MARKER_TOKENS, trackingStreams } from "./generate.ts";
import { type JinjaVars, normalizeJinja, placeholderJinja } from "./jinja_subset.ts";
import { loadManifests as loadManifestsFresh, type ModuleManifest } from "./module_manifests.ts";
import { ANSWERS_FILE, parseAnswers } from "./render_dogfood.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

export interface Mismatch {
  file: string;
  expected: string;
  got: string;
}

interface Rule {
  name: string;
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

/** The all-green-name rule's text anchors into executable wiring, exported
 *  so the suite can prove BOTH directions on the exact patterns the rule
 *  runs. Line-anchored (^\s*...): a commented-out copy of the wiring (`#`
 *  in the run block, `//` in the predicate) starts its line with the
 *  comment marker, which the anchor rejects - dead wiring must never
 *  satisfy the rule. */
export const ALL_GREEN_WIRING = {
  /** The verdict's check-run POST names the check. */
  created: /^\s*-f "name=([^"]+)"/m,
  /** The green gates' lookup keys on the shared CHECK_NAME constant. */
  lookup:
    /^\s*`repos\/\$\{repository\}\/commits\/\$\{sha\}\/check-runs\?check_name=\$\{CHECK_NAME\}/m,
  /** The fleet wrapper template pins the verdict's anchor job. */
  anchor: /^\s*require-job: (\S[^\n#]*?)\s*$/m,
  /** The reusable wires the anchor input into the judging step. */
  anchorWired: /^\s*REQUIRE_JOB: \$\{\{ inputs\.require-job \}\}$/m,
  /** The render validator enforces the same anchor at sync time. */
  anchorValidated: /^\s*const REQUIRED_GATE_JOB = "([^"]+)";$/m,
};

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
      const dirs = readdirSync(join(REPO_ROOT, "actions")).filter((name) =>
        lstatSync(join(REPO_ROOT, "actions", name)).isDirectory(),
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
      const color = mustMatch(
        action,
        /DEFAULT_LABEL_COLOR = "([^"]+)"/,
        "fuzz-issue.ts",
        "label color",
      )[1];
      const description = mustMatch(
        action,
        /DEFAULT_LABEL_DESCRIPTION = "([^"]+)"/,
        "fuzz-issue.ts",
        "label description",
      )[1];
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
      const gateName = mustMatch(
        predicate,
        /export const CHECK_NAME = "([^"]+)"/,
        "all_green.ts",
        "verdict check name",
      )[1];
      // The publish/sync gates' LOOKUP must consume the same constant, or
      // they could read a differently named check than the one pinned.
      mustMatch(
        predicate,
        ALL_GREEN_WIRING.lookup,
        "all_green.ts",
        "a check-run lookup keyed on CHECK_NAME",
      );

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
      const validated = mustMatch(
        read("actions/validate-template/validate_generated_files.ts"),
        ALL_GREEN_WIRING.anchorValidated,
        "actions/validate-template/validate_generated_files.ts",
        "the validator's REQUIRED_GATE_JOB",
      )[1];
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
      // The override layer's main ruleset is the fleet's only home for the
      // required-check contexts: the predicate's name literal must match
      // the all-green entry, and the second entry is Copilot's own per-sha
      // review check run (loadOverrideLayer separately refuses an override
      // that drops either context or its Actions integration pin).
      const override = loadOverrideLayer();
      mismatches.push(
        ...setMismatch(
          ".github/settings-override.yml main ruleset required checks",
          [gateName, COPILOT_REVIEW_CONTEXT],
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
      if (!/contents\/\$\{path\}\?ref=\$\{ref\}/.test(render)) {
        mismatches.push({
          file: ".github/scripts/fleet/render_managed_settings.ts",
          expected: "the contents URL carries ?ref=, or every fact reads the moving branch",
          got: "no ?ref= on the fetch URL",
        });
      }
      const merge = read(".github/scripts/fleet/merge_settings_layers.ts");
      if (!/contents\/\.github\/settings\.yml\?ref=\$\{ref\}/.test(merge)) {
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
        !matrix.includes("& RedactionState") ||
        !matrix.includes("hide_details: row.hide_details")
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
      const labelRe = mustMatch(
        action,
        /export const LABEL_RE = \/(.+)\/;/,
        "fuzz-issue.ts",
        "LABEL_RE",
      )[1];
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
        Number(
          mustMatch(
            action,
            new RegExp(`const ${name} = ([\\d_]+)`),
            "fuzz-issue.ts",
            name,
          )[1].replace(/_/g, ""),
        );
      const reportLines = num("REPORT_LINES");
      const maxBody = num("MAX_BODY");
      const maxBlockChars = num("MAX_BLOCK_CHARS");
      const dirRe = mustMatch(
        action,
        /const DIR_NAME = \/\^(.+)\$\/;/,
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
      // The copier invocation is an argv array; reassemble the flag string
      // AGENTS.md's recipe carries.
      const vcsRef = mustMatch(
        smoke,
        /"--vcs-ref",\s*"([^"]+)",\s*"--defaults",\s*"--trust",/,
        "smoke_generate.ts",
        "copier flags",
      )[1];
      const flags = `--vcs-ref ${vcsRef} --defaults --trust`;
      const keys = [...smoke.matchAll(/"-d",\s*[`"]([a-z_]+)=/g)].map((m) => m[1]);
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
      return mismatches;
    },
  },

  {
    name: "owner-slug",
    run: () => {
      const mismatches: Mismatch[] = [];
      const { username, slug } = jinjaVars();
      const proc = Bun.spawnSync(["git", "-C", REPO_ROOT, "ls-files"]);
      if (proc.exitCode !== 0) throw new Error("git ls-files failed");
      const files = proc.stdout
        .toString()
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
        ...read(".github/workflows/reusable-template-sync.yml").matchAll(
          /run_hidden\.ts "([^"]+)" --/g,
        ),
        // commit_push.ts passes the label as the argv element after the
        // script path, with "--" next.
        ...read(".github/scripts/sync/commit_push.ts").matchAll(
          /run_hidden\.ts"\),\s*"([^"]+)",\s*"--",/g,
        ),
      ].map((m) => m[1]);
      if (labels.length === 0) {
        throw new Error("no run_hidden labels found in the sync call sites - anchor lost");
      }
      const derived = new Set(labels.map(captureName));
      const referenced = [
        ...read(".github/scripts/sync/open_pr.ts").matchAll(/hidden-[A-Za-z0-9-]+\.log/g),
      ].map((m) => m[0]);
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
];

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
