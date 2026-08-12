#!/usr/bin/env bun
// Single-source-of-truth drift checker: facts this repo intentionally states
// in more than one INDEPENDENTLY-authored place (channel enums, the
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
import { centralIdentityIssues } from "../.github/scripts/fleet/validate_central_settings.ts";
import { captureName } from "../.github/scripts/sync/run_hidden.ts";
import { dependabotLabels } from "./compose_template.ts";
import { MARKER_TOKENS, trackingGate, trackingStreams } from "./generate.ts";
import { type JinjaVars, normalizeJinja, placeholderJinja } from "./jinja_subset.ts";
import { loadManifests, type ModuleManifest } from "./module_manifests.ts";
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
}[] = [
  {
    file: ".github/workflows/release-please.yml",
    reason:
      "the release-health pre-flight is dogfooded from this repository's own tree " +
      "(./actions/release-health), which needs the repository checked out; downstream " +
      "repos use the remote pin and carry no checkout",
    skip: /^- uses: actions\/checkout@v7$/,
    before: /^- uses: \.\/actions\/release-health$/,
  },
];

// Actions allowed to be pinned at more than one ref, with the full expected
// ref set. Empty today; record any intentional split here with a comment.
export const ALLOWED_MULTI_REFS: Record<string, string[]> = {};

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf-8");
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

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where}: expected a mapping`);
  }
  return value as Record<string, unknown>;
}

function copierConfig(): Record<string, unknown> {
  return asRecord(parseYaml(read("copier.yml")), "copier.yml");
}

function copierChoices(question: string): string[] {
  const q = asRecord(copierConfig()[question], `copier.yml ${question}`);
  const choices = asRecord(q.choices, `copier.yml ${question}.choices`);
  return Object.values(choices).map(String);
}

/** The manifests' tracking_label streams (fuzzer, nightly, ...): the single
 *  source the hand-written copier questions, settings-labels fragments, and
 *  doc constants are anchored to. The list comes from generate.ts's
 *  trackingStreams (which throws when no manifest declares one), so every
 *  rule keyed on it fails loudly rather than passing vacuously and can
 *  never disagree with the generated tracking-labels regions. */
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
  // { private: false }: the ssot rules compare this against repo-platform's
  // own (public) ci.yml, and keep-both would model an impossible hybrid
  // carrying the private base-checks job next to the public fan-out.
  const text = normalizeJinja(read("templates/base/.github/workflows/ci.yml.jinja"), jinjaVars(), {
    private: false,
  });
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

export function parseLabels(yamlText: string, where: string): Label[] {
  const doc = asRecord(parseYaml(yamlText), where);
  const labels = doc.labels;
  if (!Array.isArray(labels)) throw new Error(`${where}: no labels list`);
  return labels.map((entry) => {
    const rec = asRecord(entry, `${where} label`);
    for (const key of ["name", "color", "description"] as const) {
      if (typeof rec[key] !== "string") {
        throw new Error(`${where}: label ${JSON.stringify(rec.name ?? "?")} has no ${key}`);
      }
    }
    return {
      name: String(rec.name),
      color: String(rec.color),
      description: String(rec.description),
    };
  });
}

function templateLabelRoster(): Label[] {
  const vars = jinjaVars();
  const settings = placeholderJinja(
    normalizeJinja(read("templates/settings-sync/.github/settings.yml.jinja"), vars),
  );
  const fragment = placeholderJinja(
    normalizeJinja(read("templates/release-please/fragments/settings-labels.jinja"), vars),
  );
  // The dependabot toolchain labels are spliced in at compose time from the
  // module manifests; read them from the composer's own derivation.
  const manifestLabels = dependabotLabels(loadManifests()).map(
    ({ name, color, description }): Label => ({ name, color, description }),
  );
  return parseLabels(settings, "settings.yml.jinja").concat(
    manifestLabels,
    parseLabels(`labels:\n${fragment}`, "settings-labels.jinja"),
  );
}

function centralLabelRoster(): Label[] {
  return parseLabels(read("settings/repos/repo-platform.yml"), "settings/repos/repo-platform.yml");
}

/** The identity keys the settings-sync template renders unconditionally
 *  for module repos; the key list lives in the fleet preflight
 *  (centralIdentityIssues), which checks every central file - this wrapper
 *  applies the same contract to repo-platform's own file so the two
 *  checkers cannot drift apart. */
export function centralIdentityMismatches(repository: Record<string, unknown>): Mismatch[] {
  return centralIdentityIssues(repository).map((issue) => ({
    file: `settings/repos/repo-platform.yml repository.${issue.key}`,
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
    name: "channels",
    run: () => {
      const mismatches: Mismatch[] = [];
      const reference = copierChoices("channel");

      const registry = read(".github/scripts/fleet/repos_registry.ts");
      const channelsLiteral = mustMatch(
        registry,
        /const CHANNELS = \[([^\]]+)\]/,
        "repos_registry.ts",
        "CHANNELS",
      )[1];
      const registryChannels = [...channelsLiteral.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      mismatches.push(
        ...setMismatch(
          ".github/scripts/fleet/repos_registry.ts CHANNELS",
          reference,
          registryChannels,
        ),
      );

      const branchTree = read(".github/scripts/build-branches/branch_tree.ts");
      const union = mustMatch(
        branchTree,
        /\{ channel: "([a-z]+)" \} \| \{ channel: "([a-z]+)";/,
        "branch_tree.ts",
        "channel type",
      );
      mismatches.push(
        ...setMismatch(".github/scripts/build-branches/branch_tree.ts channel type", reference, [
          union[1],
          union[2],
        ]),
      );
      const guard = mustMatch(
        branchTree,
        /channel !== "([a-z]+)" && channel !== "([a-z]+)"/,
        "branch_tree.ts",
        "channel validation",
      );
      mismatches.push(
        ...setMismatch(
          ".github/scripts/build-branches/branch_tree.ts channel validation",
          reference,
          [guard[1], guard[2]],
        ),
      );

      const plan = read(".github/scripts/build-branches/plan.ts");
      for (const channel of reference) {
        // The camelCase twin of the old build_<channel>=true anchor: the
        // rule must fail when a channel loses its build leg, not merely
        // when its output line disappears.
        const leg = `build${channel[0].toUpperCase()}${channel.slice(1)} = true`;
        if (!plan.includes(leg)) {
          mismatches.push({
            file: ".github/scripts/build-branches/plan.ts",
            expected: `a '${leg}' leg`,
            got: "no such leg",
          });
        }
        if (!plan.includes(`setOutput("${channel}"`)) {
          mismatches.push({
            file: ".github/scripts/build-branches/plan.ts",
            expected: `a setOutput("${channel}", ...) leg`,
            got: "no such leg",
          });
        }
      }

      const answersFile = read(".github/scripts/sync/answers_file.ts");
      // The sync consumers all take Channel from this one const.
      const syncChannels = mustMatch(
        answersFile,
        /const CHANNELS = \[([^\]]+)\]/,
        "answers_file.ts",
        "CHANNELS",
      )[1];
      mismatches.push(
        ...setMismatch(
          ".github/scripts/sync/answers_file.ts CHANNELS",
          reference,
          [...syncChannels.matchAll(/"([^"]+)"/g)].map((m) => m[1]),
        ),
      );

      const protect = read(".github/workflows/protect-build-branches.yml");
      const fromJson = mustMatch(
        protect,
        /fromJSON\('(\[[^']*\])'\)/,
        "protect-build-branches.yml",
        "channel list",
      );
      mismatches.push(
        ...setMismatch(
          ".github/workflows/protect-build-branches.yml fromJSON",
          reference,
          (JSON.parse(fromJson[1]) as unknown[]).map(String),
        ),
      );

      const buildBranches = asRecord(
        parseYaml(read(".github/workflows/build-branches.yml")),
        "build-branches.yml",
      );
      const dispatch = asRecord(
        asRecord(buildBranches.on, "on").workflow_dispatch,
        "workflow_dispatch",
      );
      const channelInput = asRecord(asRecord(dispatch.inputs, "inputs").channel, "channel input");
      const options = (channelInput.options as unknown[])
        .map(String)
        .filter((option) => option !== "both");
      mismatches.push(
        ...setMismatch(".github/workflows/build-branches.yml dispatch options", reference, options),
      );

      const central = asRecord(
        parseYaml(read("settings/repos/repo-platform.yml")),
        "repo-platform.yml",
      );
      const ruleset = (central.rulesets as Record<string, unknown>[]).find(
        (r) => r.name === "build-branches",
      );
      if (!ruleset) throw new Error("settings/repos/repo-platform.yml: no build-branches ruleset");
      const conditions = asRecord(asRecord(ruleset.conditions, "conditions").ref_name, "ref_name");
      mismatches.push(
        ...setMismatch(
          "settings/repos/repo-platform.yml build-branches ruleset",
          reference,
          (conditions.include as unknown[]).map(String),
        ),
      );
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
      const dirList = mustMatch(runs, /for dir in ([^;\n]+);/, "ci.yml typecheck", "dir list");
      mismatches.push(
        ...setMismatch("ci.yml typecheck job dir list", lockDirs, dirList[1].trim().split(/\s+/)),
      );

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
      const gate = asRecord(jobs["all-green"], "all-green");
      const needs = (gate.needs as unknown[]).map(String);
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
          return ((job.steps as Record<string, unknown>[] | undefined) ?? []).flatMap((step) =>
            String(step.run ?? "")
              .split("\n")
              .map((line) => line.trim()),
          );
        }),
      );
      for (const required of [
        "bun run ssot:check",
        "bun run generate:check",
        "bun run dogfood:check",
        "bun .github/scripts/fleet/repos_registry.ts validate",
        "bun actions/validate-template/validate_generated_files.ts --self .",
        // The copier-render oracle for the generated dogfood copies: its
        // only home is a step of the smoke-generate job (dogfood-oracle
        // row), so losing the step would fail the gate open silently.
        "bun .github/scripts/ci/verify_dogfood_oracle.ts",
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
    // Most dogfooded copies (.editorconfig, release-please-config.json,
    // CODE_OF_CONDUCT.md, CODEOWNERS, auto-assign.yml,
    // dependabot-bun-lockfile.yml, validate-skills.yml) are GENERATED from
    // their templates by
    // scripts/render_dogfood.ts, byte-checked by `bun run dogfood:check`,
    // and byte-compared against a REAL copier render by ci.yml's
    // dogfood-oracle smoke row (verify_dogfood_oracle.ts), so they need no
    // comparison here. This rule keeps only the pairs generation cannot
    // own: the prefix files, whose repo-specific tails
    // live below the template's marker, and release-please.yml, whose one
    // recorded divergence (the dogfooded ./actions/release-health checkout)
    // needs semantic comparison with an excuse.
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
          repo: ".github/workflows/release-please.yml",
          tpl: "templates/release-please/.github/workflows/release-please.yml.jinja",
          mode: "semantic",
          // This repository selects no tracking-stream module (fuzzer,
          // nightly), so the generated tracking-labels block must evaluate
          // to what this repo really renders: absent. The key is the exact
          // or-chain the generator emits, so a new stream module updates
          // both sides together.
          context: { [trackingGate(loadManifests())]: false },
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

      const gateRun = (ci: Record<string, unknown>, where: string) => {
        const gate = asRecord(ciJobs(ci, where)["all-green"], `${where} all-green`);
        const run = (gate.steps as Record<string, unknown>[])?.[0]?.run;
        if (typeof run !== "string")
          throw new Error(`${where}: all-green has no run step - anchor lost`);
        return run;
      };
      const tplGate = gateRun(template, "ci.yml.jinja");
      const repoGate = gateRun(repo, "ci.yml");
      if (tplGate !== repoGate) {
        mismatches.push(
          ...lineDiffMismatch(
            ".github/workflows/ci.yml all-green run body",
            "templates/base/.github/workflows/ci.yml.jinja",
            tplGate.split("\n"),
            repoGate.split("\n"),
          ),
        );
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
    name: "uses-ref-preamble",
    run: () => {
      const files = walkFiles("templates")
        .filter((f) => !f.symlink)
        .map((f) => f.path)
        // Discover by CONSUMERS of uses_ref, not by preamble presence: a file
        // that still references uses_ref but lost the preamble must fail its
        // mustMatch below rather than silently drop out of the comparison.
        // Fragments are spliced into a skeleton that carries the preamble;
        // a fragment referencing uses_ref without one renders as undefined
        // jinja, which smoke-generate catches.
        .filter((rel) => !rel.includes("/fragments/") && read(rel).includes("uses_ref"));
      if (files.length < 2)
        throw new Error("fewer than two templates carry the uses_ref preamble - anchor lost");
      const block = (rel: string) => {
        const text = read(rel);
        return ["tpl_ref", "release_pin", "uses_ref"]
          .map((name) =>
            mustMatch(text, new RegExp(`\\{%-?\\s*set ${name} =[^\\n]*%\\}`), rel, `set ${name}`)[0]
              // Whitespace-control dashes vary with surrounding layout and
              // do not change the assignment; normalize them away.
              .replace(/\{%-/g, "{%")
              .replace(/-%\}/g, "%}"),
          )
          .join("\n");
      };
      const reference = block(files[0]);
      return files
        .slice(1)
        .filter((rel) => block(rel) !== reference)
        .map((rel) => ({
          file: rel,
          expected: `the preamble in ${files[0]}`,
          got: "a diverged preamble",
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
    name: "settings-blocks",
    run: () => {
      const mismatches: Mismatch[] = [];
      const vars = jinjaVars();
      const defaults = asRecord(parseYaml(read("settings/defaults.yml")), "defaults.yml");
      const jinja = asRecord(
        parseYaml(
          placeholderJinja(
            normalizeJinja(read("templates/settings-sync/.github/settings.yml.jinja"), vars),
          ),
        ),
        "settings.yml.jinja",
      );
      const central = asRecord(
        parseYaml(read("settings/repos/repo-platform.yml")),
        "repo-platform.yml",
      );

      const sharedFields = asRecord(defaults.repository, "defaults repository");
      if (Object.keys(sharedFields).length === 0) {
        throw new Error("settings/defaults.yml: repository block is empty - anchor lost");
      }
      // List-valued sections live per repo, never in defaults (arrays
      // REPLACE on merge), and the central preflight treats an absent
      // labels section as unmanaged - a labels or rulesets block here
      // would silently break both.
      for (const section of ["labels", "rulesets"]) {
        if (section in defaults) {
          mismatches.push({
            file: "settings/defaults.yml",
            expected: `no ${section} section (list sections live in each repo's own settings file)`,
            got: "declared",
          });
        }
      }
      const jinjaRepository = asRecord(jinja.repository, "settings.yml.jinja repository");
      for (const [key, value] of Object.entries(sharedFields)) {
        if (canonical(jinjaRepository[key]) !== canonical(value)) {
          mismatches.push({
            file: `templates/settings-sync/.github/settings.yml.jinja repository.${key}`,
            expected: canonical(value),
            got: canonical(jinjaRepository[key]),
          });
        }
      }

      // Template-only repository keys (private, description) have no
      // defaults.yml counterpart, so the loop above never sees them; assert
      // the central file declares them the way the template guarantees
      // them for module repos.
      const centralRepository = asRecord(central.repository, "repo-platform.yml repository");
      mismatches.push(...centralIdentityMismatches(centralRepository));

      // security_and_analysis is template-only too (public-only: defaults
      // reach private repos, which reject the block), so it needs the same
      // template<->central lock as the identity keys.
      if (jinjaRepository.security_and_analysis === undefined) {
        throw new Error("settings.yml.jinja: security_and_analysis block missing - anchor lost");
      }
      if (
        canonical(jinjaRepository.security_and_analysis) !==
        canonical(centralRepository.security_and_analysis)
      ) {
        mismatches.push({
          file: "settings/repos/repo-platform.yml repository.security_and_analysis",
          expected: canonical(jinjaRepository.security_and_analysis),
          got: canonical(centralRepository.security_and_analysis),
        });
      }

      const namedRuleset = (doc: Record<string, unknown>, name: string, where: string) => {
        const matches = (doc.rulesets as Record<string, unknown>[]).filter((r) => r.name === name);
        if (matches.length === 0) throw new Error(`${where}: no ${name} ruleset - anchor lost`);
        if (matches.length > 1) throw new Error(`${where}: duplicate ${name} rulesets`);
        return matches[0] as Record<string, unknown>;
      };
      for (const name of ["main", "non-bypassable"]) {
        const tplRuleset = namedRuleset(jinja, name, "settings.yml.jinja");
        const centralRuleset = namedRuleset(central, name, "settings/repos/repo-platform.yml");
        if (canonical(tplRuleset) !== canonical(centralRuleset)) {
          mismatches.push({
            file: `settings/repos/repo-platform.yml ${name} ruleset`,
            expected: canonical(tplRuleset),
            got: canonical(centralRuleset),
          });
        }
        // The non-bypassable ruleset's whole point is that no actor is
        // exempt, and only an EXPLICIT empty list keeps that healable: an
        // omitted key is invisible to the applier's drift detection and
        // preserved by its update.
        if (name === "non-bypassable") {
          for (const [where, ruleset] of [
            ["templates/settings-sync/.github/settings.yml.jinja", tplRuleset],
            ["settings/repos/repo-platform.yml", centralRuleset],
          ] as const) {
            if (canonical(ruleset.bypass_actors) !== canonical([])) {
              mismatches.push({
                file: `${where} non-bypassable ruleset`,
                expected: "bypass_actors: [] (explicit empty list)",
                got: canonical(ruleset.bypass_actors),
              });
            }
          }
        }
      }
      return mismatches;
    },
  },

  {
    name: "labels",
    run: () => {
      const mismatches: Mismatch[] = [];
      const template = templateLabelRoster();
      const central = centralLabelRoster();
      const templateByName = new Map(template.map((label) => [label.name, label]));
      const required = [
        "dependencies",
        "github_actions",
        "javascript",
        "bug",
        "enhancement",
        "fix-lint",
        "autorelease: pending",
        "autorelease: tagged",
        "release-blocker",
        "release-override",
      ];
      for (const name of required) {
        if (!templateByName.has(name) || !central.some((label) => label.name === name)) {
          mismatches.push({
            file: "label rosters",
            expected: `label '${name}' in both the settings-sync template and settings/repos/repo-platform.yml`,
            got: "missing from at least one roster",
          });
        }
      }
      for (const label of central) {
        const counterpart = templateByName.get(label.name);
        if (counterpart && canonical(counterpart) !== canonical(label)) {
          mismatches.push({
            file: `settings/repos/repo-platform.yml label '${label.name}'`,
            expected: canonical(counterpart),
            got: canonical(label),
          });
        }
      }

      // Tracking-label streams: each manifest's tracking_label block is the
      // single source; the hand-written copier question and settings-labels
      // fragment are anchored back to it here, and the create-tuple
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
        const fragment = parseLabels(
          `labels:\n${placeholderJinja(normalizeJinja(read(`templates/${module}/fragments/settings-labels.jinja`), jinjaVars()))}`,
          `${module} settings-labels.jinja`,
        )[0];
        if (fragment.color !== tracking.color || fragment.description !== tracking.description) {
          mismatches.push({
            file: `templates/${module}/fragments/settings-labels.jinja`,
            expected: `${tracking.color} / ${tracking.description} (templates/${module}/module.yml tracking_label)`,
            got: `${fragment.color} / ${fragment.description}`,
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
      const templateNames = new Set(templateLabelRoster().map((label) => label.name));
      const centralNames = new Set(centralLabelRoster().map((label) => label.name));
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
          if (!templateNames.has(name) || !centralNames.has(name)) {
            mismatches.push({
              file: rel,
              expected: `label '${name}' declared in both settings label rosters`,
              got: "missing from at least one roster",
            });
          }
        }
      }
      if (!sawLabels) throw new Error("no issue form declares labels - anchor lost");
      return mismatches;
    },
  },

  {
    name: "all-green-name",
    run: () => {
      const mismatches: Mismatch[] = [];
      const vgf = read("actions/validate-template/validate_generated_files.ts");
      const gateName = mustMatch(
        vgf,
        /!\("([^"]+)" in jobs\)/,
        "validate_generated_files.ts",
        "gate job name",
      )[1];

      for (const [jobs, where] of [
        [ciJobs(repoCi(), "ci.yml"), ".github/workflows/ci.yml"],
        [ciJobs(templateCi(), "ci.yml.jinja"), "templates/base/.github/workflows/ci.yml.jinja"],
      ] as const) {
        if (!(gateName in jobs)) {
          mismatches.push({
            file: where,
            expected: `a '${gateName}' gate job`,
            got: "no such job",
          });
        }
      }

      const contexts = (text: string, where: string): string[] => {
        const doc = asRecord(parseYaml(text), where);
        const main = (doc.rulesets as Record<string, unknown>[]).find((r) => r.name === "main");
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
      for (const [text, where] of [
        [
          placeholderJinja(
            normalizeJinja(read("templates/settings-sync/.github/settings.yml.jinja"), jinjaVars()),
          ),
          "templates/settings-sync/.github/settings.yml.jinja",
        ],
        [read("settings/repos/repo-platform.yml"), "settings/repos/repo-platform.yml"],
      ] as const) {
        mismatches.push(
          ...setMismatch(`${where} required checks`, [gateName], contexts(text, where)),
        );
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

      const identity = (rel: string) => {
        const text = read(rel);
        // Covers the shell shape (user.name "x"), the single-arg config
        // shape ("user.name=x"), and the argv-array shape ("user.name",
        // "x").
        const name = mustMatch(text, /user\.name["', =]+([^\s"',]+)/, rel, "git user.name")[1];
        const email = mustMatch(text, /user\.email["', =]+([^\s"',]+)/, rel, "git user.email")[1];
        return `${name} <${email}>`;
      };
      const identityFiles = [
        ".github/workflows/refresh-gitignore.yml",
        ".github/scripts/sync/normalize_src.ts",
        ".github/scripts/sync/commit_push.ts",
      ];
      const referenceIdentity = identity(identityFiles[0]);
      for (const rel of identityFiles.slice(1)) {
        if (identity(rel) !== referenceIdentity) {
          mismatches.push({ file: rel, expected: referenceIdentity, got: identity(rel) });
        }
      }

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
        ".github/workflows/reusable-template-sync.yml",
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
      const roster = new Map(templateLabelRoster().map((label) => [label.name, label]));
      for (const name of ["dependencies", "github_actions"]) {
        const label = roster.get(name);
        if (!label) throw new Error(`settings.yml.jinja: label '${name}' vanished - anchor lost`);
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
          // <something>/repo-platform.<ext> is a filename inside a repo path
          // (settings/repos/repo-platform.yml), not an owner slug.
          if (/^\.[A-Za-z0-9]/.test(text.slice(match.index + match[0].length))) continue;
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
    // The release-freshness ancestor check exists twice: this repo's
    // ci.yml runs .github/scripts/ci/release_freshness.sh, while the
    // release-please fragment inlines the same logic (downstream repos do
    // not carry this repo's scripts). Pin the core lines so a fix to one
    // side cannot silently leave the other behind.
    name: "release-freshness-parity",
    run: () => {
      const mismatches: Mismatch[] = [];
      const script = ".github/scripts/ci/release_freshness.sh";
      const fragment = "templates/release-please/fragments/ci-gate-jobs.jinja";
      const workflow = ".github/workflows/ci.yml";
      const pins: { line: string; files: string[] }[] = [
        {
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell line pinned in both copies
          line: 'tip="$(git rev-parse "origin/${GITHUB_BASE_REF}")"',
          files: [script, fragment],
        },
        {
          line: 'if git merge-base --is-ancestor "$tip" HEAD; then',
          files: [script, fragment],
        },
        {
          // The release-PR predicate: a renamed release-please branch
          // prefix would make every step skip and the gate silently fail
          // open, so the exact condition is pinned in both workflows.
          line: "if: github.event_name == 'pull_request' && startsWith(github.head_ref, 'release-please--')",
          files: [workflow, fragment],
        },
      ];
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
    // The CODEOWNERS assignee-resolution function is inlined three times:
    // twice in reusable-auto-assign.yml and once in
    // reusable-auto-assign-alerts.yml (split for permissions - see the file
    // headers). It cannot be hoisted: a reusable workflow runs from the
    // CALLER's checkout, where this repo's scripts do not exist. Pin the
    // copies byte-identical so a fix to one cannot silently leave the
    // others behind.
    name: "auto-assign-codeowners-parity",
    run: () => {
      const mismatches: Mismatch[] = [];
      const sites = [
        { file: ".github/workflows/reusable-auto-assign.yml", copies: 2 },
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
