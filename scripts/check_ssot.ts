#!/usr/bin/env bun
// Single-source-of-truth drift checker: facts this repo intentionally states
// in more than one place (module/channel enums, dogfooded template
// counterparts, settings/label rosters, doc-quoted constants) are compared
// here so drift fails CI instead of rotting silently.
//
// Structure: a flat list of named rules, each returning mismatches. Every
// grep-shaped extraction goes through mustMatch(), so a rule whose anchor
// text disappears fails loudly instead of passing vacuously. Template
// (.jinja) inputs are compared modulo jinja via normalizeJinja(); recorded,
// intentional divergences live in RECORDED_DIVERGENCES with a reason.
//
// Usage:
//   bun scripts/check_ssot.ts   # prints "rule: file -> expected X, got Y"
//                               # lines and exits 1 on any mismatch

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { centralIdentityIssues } from "../.github/scripts/fleet/validate_central_settings.ts";
import { MODULE_ORDER } from "./compose_template.ts";

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
// counterpart: lines matching `skip` are dropped from both sides before
// comparing. Honored only by line-based comparisons (semantic-mode parity
// pairs and the .gitattributes rules); byte-compared pairs cannot skip
// lines, and subset rules already tolerate repo-side additions without an
// entry. Every entry must say why the divergence is deliberate; an entry
// whose pattern no longer matches anything is reported as stale.
export const RECORDED_DIVERGENCES: { file: string; reason: string; skip: RegExp }[] = [];

// Actions allowed to be pinned at more than one ref, with the full expected
// ref set. Empty today; record any intentional split here with a comment.
export const ALLOWED_MULTI_REFS: Record<string, string[]> = {};

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf-8");
}

/** Anchor extraction that fails loudly: a missing match means the fact this
 *  rule keys on moved or was deleted, which must never pass silently. */
export function mustMatch(text: string, re: RegExp, where: string, what: string): RegExpExecArray {
  const match = re.exec(text);
  if (!match) throw new Error(`${where}: anchor for ${what} not found (pattern ${re})`);
  return match;
}

// --- jinja normalization -------------------------------------------------

export interface JinjaVars {
  username: string;
  slug: string;
}

/**
 * Reduce a template file to the text this repo's own copy should carry:
 * strip raw markers, jinja comments and set/if/endif tags (bodies are kept -
 * repo-platform is public with a toolchain, so every gate is true for it),
 * substitute the identity expressions, and map remote
 * `<owner>/repo-platform/<path>@{{ uses_ref }}` references to their local
 * `./<path>` form.
 */
export function normalizeJinja(text: string, vars: JinjaVars): string {
  let out = text;
  out = out.replace(/\{%-?\s*(?:raw|endraw)\s*-?%\}/g, "");
  out = out.replace(/\{#-?[\s\S]*?-?#\}/g, "");
  out = out.replace(/\{%-?\s*set\b[\s\S]*?%\}/g, "");
  // Keeping both branches of an if/else would concatenate mutually exclusive
  // content; no processed template uses statement-level else today, so its
  // appearance means this normalizer needs real branch handling.
  const branchTag = /\{%-?\s*(?:else|elif)\b[^%]*?-?%\}/.exec(out);
  if (branchTag) throw new Error(`normalizeJinja cannot handle ${branchTag[0]}`);
  out = out.replace(/\{%-?\s*(?:if|endif)\b[^%]*?-?%\}/g, "");
  out = out.replace(/\{\{ '([^']*)' if [^}]*? else '[^']*' \}\}/g, "$1");
  out = out.replace(
    new RegExp(`\\{\\{ github_username \\}\\}/${vars.slug}/([^\\s@]+)@\\{\\{ uses_ref \\}\\}`, "g"),
    "./$1",
  );
  out = out.replace(/\{\{ github_username \| lower \}\}/g, vars.username.toLowerCase());
  out = out.replace(/\{\{ github_username \}\}/g, vars.username);
  out = out.replace(/\{\{ project_slug \}\}/g, vars.slug);
  // A surviving statement tag ({% for %}, an if whose expression contains %,
  // ...) would silently corrupt the comparison text; fail loudly instead.
  const leftover = /\{%[^}]*%\}/.exec(out);
  if (leftover) throw new Error(`normalizeJinja left ${leftover[0]} unhandled`);
  return out;
}

/** Replace leftover jinja expressions with a parseable placeholder so the
 *  result can be YAML-parsed. `${{ ... }}` GitHub expressions are kept. */
export function placeholderJinja(text: string): string {
  return text.replace(/(?<!\$)\{\{[^}]*\}\}/g, '"JINJA"');
}

/** Non-blank, non-comment lines (right-trimmed) - the shape compared for
 *  workflow/dotfile parity, where comments are where copies legitimately
 *  tell their own story. */
export function semanticLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
}

const usedDivergences = new Set<number>();

function applyDivergences(file: string, lines: string[]): string[] {
  const entries = RECORDED_DIVERGENCES.map((d, index) => ({ ...d, index })).filter(
    (d) => d.file === file,
  );
  if (entries.length === 0) return lines;
  return lines.filter(
    (line) =>
      !entries.some((d) => {
        if (!d.skip.test(line.trim())) return false;
        usedDivergences.add(d.index);
        return true;
      }),
  );
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

function jinjaVars(): JinjaVars {
  const username = asRecord(copierConfig().github_username, "copier.yml github_username").default;
  if (typeof username !== "string" || username === "") {
    throw new Error("copier.yml: github_username has no string default");
  }
  const pkg = asRecord(JSON.parse(read("package.json")), "package.json");
  return { username, slug: String(pkg.name) };
}

function packageScripts(): Record<string, string> {
  const pkg = asRecord(JSON.parse(read("package.json")), "package.json");
  return asRecord(pkg.scripts, "package.json scripts") as Record<string, string>;
}

function repoCi(): Record<string, unknown> {
  return asRecord(parseYaml(read(".github/workflows/ci.yml")), "ci.yml");
}

function templateCi(): Record<string, unknown> {
  const text = normalizeJinja(read("templates/base/.github/workflows/ci.yml.jinja"), jinjaVars());
  return asRecord(parseYaml(text), "ci.yml.jinja");
}

function ciJobs(ci: Record<string, unknown>, where: string): Record<string, unknown> {
  return asRecord(ci.jobs, `${where} jobs`);
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
  return parseLabels(settings, "settings.yml.jinja").concat(
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

const rules: Rule[] = [
  {
    name: "module-list",
    run: () => {
      const mismatches: Mismatch[] = [];
      const reference = copierChoices("modules");

      mismatches.push(
        ...setMismatch("scripts/compose_template.ts MODULE_ORDER", reference, MODULE_ORDER),
      );

      const vgf = read("actions/validate-template/validate_generated_files.ts");
      const known = mustMatch(
        vgf,
        /const KNOWN_MODULES = new Set\(\[([\s\S]*?)\]\)/,
        "validate_generated_files.ts",
        "KNOWN_MODULES",
      )[1];
      const knownNames = [...known.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      mismatches.push(
        ...setMismatch(
          "actions/validate-template/validate_generated_files.ts KNOWN_MODULES",
          reference,
          knownNames,
        ),
      );

      const dirs = readdirSync(join(REPO_ROOT, "templates")).filter(
        (name) => name !== "base" && lstatSync(join(REPO_ROOT, "templates", name)).isDirectory(),
      );
      mismatches.push(...setMismatch("templates/ module directories", reference, dirs));

      const smoke = asRecord(ciJobs(repoCi(), "ci.yml")["smoke-generate"], "smoke-generate");
      const include = asRecord(smoke.strategy, "strategy").matrix as Record<string, unknown>;
      const rows = (asRecord(include, "matrix").include as Record<string, unknown>[]) ?? [];
      const everything = rows.find((row) => row.name === "everything");
      if (!everything) throw new Error("ci.yml: smoke-generate has no 'everything' matrix row");
      const everyModules = (parseYaml(String(everything.modules)) as unknown[]).map(String);
      mismatches.push(
        ...setMismatch("ci.yml smoke-generate 'everything' row", reference, everyModules),
      );

      // The two docs enumerate the roster in one anchored sentence; compare
      // the backticked names in that region as a set. A bare text.includes()
      // would pass on module names that appear anywhere else in the doc.
      const docRosters: [string, RegExp][] = [
        ["README.md", /Modules \(pick any combination\):([\s\S]*?)\. /],
        ["docs/new-repo.md", /any combination of([\s\S]*?)\)/],
      ];
      for (const [doc, anchor] of docRosters) {
        const region = mustMatch(read(doc), anchor, doc, "the module roster")[1];
        const listed = [...region.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]);
        mismatches.push(...setMismatch(`${doc} module roster`, reference, listed));
      }
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

      const plan = read(".github/scripts/build-branches/plan.sh");
      for (const channel of reference) {
        if (!plan.includes(`build_${channel}=true`)) {
          mismatches.push({
            file: ".github/scripts/build-branches/plan.sh",
            expected: `a build_${channel}=true leg`,
            got: "no such leg",
          });
        }
      }

      const resolveRefs = read(".github/scripts/sync/resolve_refs.sh");
      // Anchor on the channel case block: resolve_refs.sh has other case
      // statements whose arms fit the same shape.
      const channelCase = mustMatch(
        resolveRefs,
        /case "\$channel" in([\s\S]*?)esac/,
        "resolve_refs.sh",
        "channel case block",
      )[1];
      const arm = mustMatch(
        channelCase,
        /^\s*([a-z]+(?: \| [a-z]+)+)\) ;;$/m,
        "resolve_refs.sh",
        "channel case arm",
      );
      mismatches.push(
        ...setMismatch(
          ".github/scripts/sync/resolve_refs.sh case arm",
          reference,
          arm[1].split(" | "),
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
        "bun .github/scripts/fleet/repos_registry.ts validate",
        "bun actions/validate-template/validate_generated_files.ts --self .",
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
    name: "dogfood-parity",
    run: () => {
      const vars = jinjaVars();
      const mismatches: Mismatch[] = [];
      const pairs: { repo: string; tpl: string; mode: "exact" | "prefix" | "semantic" }[] = [
        { repo: ".editorconfig", tpl: "templates/base/.editorconfig.jinja", mode: "exact" },
        {
          repo: "release-please-config.json",
          tpl: "templates/release-please/release-please-config.json",
          mode: "exact",
        },
        {
          // The template ends with a repo-specific-docs marker; everything a
          // repo appends after it is its own, hence prefix semantics.
          repo: "SECURITY.md",
          tpl: "templates/base/{% if not private %}SECURITY.md{% endif %}.jinja",
          mode: "prefix",
        },
        {
          repo: ".github/CODEOWNERS",
          tpl: "templates/base/.github/CODEOWNERS.jinja",
          mode: "semantic",
        },
        {
          repo: ".github/workflows/release-please.yml",
          tpl: "templates/release-please/.github/workflows/release-please.yml.jinja",
          mode: "semantic",
        },
        {
          repo: ".github/workflows/auto-assign.yml",
          tpl: "templates/auto-assign/.github/workflows/auto-assign.yml.jinja",
          mode: "semantic",
        },
        {
          repo: ".github/workflows/dependabot-bun-lockfile.yml",
          tpl: "templates/bun/.github/workflows/dependabot-bun-lockfile.yml.jinja",
          mode: "semantic",
        },
      ];
      for (const pair of pairs) {
        const expected = normalizeJinja(read(pair.tpl), vars);
        const got = read(pair.repo);
        if (pair.mode === "exact" && expected !== got) {
          mismatches.push(
            ...lineDiffMismatch(pair.repo, pair.tpl, expected.split("\n"), got.split("\n")),
          );
        } else if (pair.mode === "prefix" && !got.startsWith(expected)) {
          mismatches.push(
            ...lineDiffMismatch(pair.repo, pair.tpl, expected.split("\n"), got.split("\n")),
          );
        } else if (pair.mode === "semantic") {
          mismatches.push(
            ...lineDiffMismatch(
              pair.repo,
              pair.tpl,
              applyDivergences(pair.repo, semanticLines(expected)),
              applyDivergences(pair.repo, semanticLines(got)),
            ),
          );
        }
      }
      return mismatches;
    },
  },

  {
    name: "gitattributes-subset",
    run: () => {
      const expected = applyDivergences(
        ".gitattributes",
        semanticLines(normalizeJinja(read("templates/base/.gitattributes.jinja"), jinjaVars())),
      );
      if (expected.length === 0)
        throw new Error(".gitattributes.jinja: no shared lines found - anchor lost");
      const got = new Set(semanticLines(read(".gitattributes")));
      return expected
        .filter((line) => !got.has(line))
        .map((line) => ({
          file: ".gitattributes",
          expected: `line ${JSON.stringify(line)} (from templates/base/.gitattributes.jinja)`,
          got: "missing",
        }));
    },
  },

  {
    name: "dependabot-actions-block",
    run: () => {
      // The repo entry covers "/" plus its composite actions/ dirs (which
      // downstream repos do not have), so compare the shared shape with the
      // directory coverage held out, and pin each side's coverage of "/".
      // groups is held out too: cross-directory grouping is only meaningful
      // for this repo's multi-directory entry.
      const rootActionsEntry = (rel: string, text: string, wantDirs: (d: unknown) => boolean) => {
        const doc = asRecord(parseYaml(text), rel);
        const entries = (doc.updates as Record<string, unknown>[]).filter(
          (entry) => entry["package-ecosystem"] === "github-actions",
        );
        if (entries.length !== 1)
          throw new Error(`${rel}: expected exactly one github-actions dependabot entry`);
        const { directory, directories, groups, ...shape } = entries[0];
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
      mismatches.push(
        ...centralIdentityMismatches(asRecord(central.repository, "repo-platform.yml repository")),
      );

      const mainRuleset = (doc: Record<string, unknown>, where: string) => {
        const ruleset = (doc.rulesets as Record<string, unknown>[]).find((r) => r.name === "main");
        if (!ruleset) throw new Error(`${where}: no main ruleset - anchor lost`);
        return ruleset;
      };
      const tplMain = mainRuleset(jinja, "settings.yml.jinja");
      const centralMain = mainRuleset(central, "settings/repos/repo-platform.yml");
      if (canonical(tplMain) !== canonical(centralMain)) {
        mismatches.push({
          file: "settings/repos/repo-platform.yml main ruleset",
          expected: canonical(tplMain),
          got: canonical(centralMain),
        });
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

      // The fuzzer fragment's tuple must match what the action creates.
      const fragment = parseLabels(
        `labels:\n${placeholderJinja(normalizeJinja(read("templates/fuzzer/fragments/settings-labels.jinja"), jinjaVars()))}`,
        "fuzzer settings-labels.jinja",
      )[0];
      const action = read("actions/fuzz-issue/fuzz-issue.ts");
      const color = mustMatch(action, /"--color",\s*"([^"]+)"/, "fuzz-issue.ts", "label color")[1];
      const description = mustMatch(
        action,
        /"--description",\s*"([^"]+)"/,
        "fuzz-issue.ts",
        "label description",
      )[1];
      if (fragment.color !== color || fragment.description !== description) {
        mismatches.push({
          file: "templates/fuzzer/fragments/settings-labels.jinja",
          expected: `${color} / ${description} (actions/fuzz-issue/fuzz-issue.ts)`,
          got: `${fragment.color} / ${fragment.description}`,
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
        mustMatch(read(rel), /\/repo-settings-as-code@(\S+)/, rel, "repo-settings-as-code pin")[1];
      const applyRef = settingsActionRef(".github/workflows/settings-repos.yml");
      const reusableRef = settingsActionRef(".github/workflows/reusable-apply-settings.yml");
      if (applyRef !== reusableRef) {
        mismatches.push({
          file: ".github/workflows/reusable-apply-settings.yml",
          expected: `repo-settings-as-code@${applyRef} (settings-repos.yml)`,
          got: `repo-settings-as-code@${reusableRef}`,
        });
      }

      const identity = (rel: string) => {
        const text = read(rel);
        const name = mustMatch(text, /user\.name[ =]+"([^"]+)"/, rel, "git user.name")[1];
        const email = mustMatch(text, /user\.email[ =]+"([^"]+)"/, rel, "git user.email")[1];
        return `${name} <${email}>`;
      };
      const identityFiles = [
        ".github/workflows/refresh-gitignore.yml",
        ".github/scripts/sync/normalize_src.sh",
        ".github/scripts/sync/commit_push.sh",
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
    name: "fuzzer-label-regex",
    run: () => {
      const question = asRecord(copierConfig().fuzzer_label, "copier.yml fuzzer_label");
      const validator = String(question.validator ?? "");
      const copierRe = zToDollar(
        mustMatch(
          validator,
          /regex_search\('([^']+)'\)/,
          "copier.yml fuzzer_label validator",
          "pattern",
        )[1],
      );
      const action = read("actions/fuzz-issue/fuzz-issue.ts");
      const labelRe = mustMatch(
        action,
        /export const LABEL_RE = \/(.+)\/;/,
        "fuzz-issue.ts",
        "LABEL_RE",
      )[1];
      if (copierRe === labelRe) return [];
      return [
        { file: "actions/fuzz-issue/fuzz-issue.ts LABEL_RE", expected: copierRe, got: labelRe },
      ];
    },
  },

  {
    name: "pages-grammar",
    run: () => {
      const question = asRecord(copierConfig().pages_setup, "copier.yml pages_setup");
      const validator = String(question.validator ?? "");
      const listLiteral = mustMatch(
        validator,
        /reject\('in', \[([^\]]+)\]\)/,
        "copier.yml pages_setup validator",
        "token whitelist",
      )[1];
      const copierTokens = [...listLiteral.matchAll(/'([^']+)'/g)].map((m) => m[1]);
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
        copierTokens,
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
      if (!read("docs/new-repo.md").includes(`>= ${floor}`)) {
        mismatches.push({
          file: "docs/new-repo.md",
          expected: `the copier floor '>= ${floor}'`,
          got: "missing",
        });
      }

      const fuzzDefault = String(asRecord(copierConfig().fuzzer_label, "fuzzer_label").default);
      for (const doc of ["docs/fuzzer.md", "docs/settings.md"]) {
        if (!read(doc).includes(`\`${fuzzDefault}\``)) {
          mismatches.push({
            file: doc,
            expected: `the fuzzer_label default \`${fuzzDefault}\``,
            got: "missing",
          });
        }
      }

      const settingsDoc = read("docs/settings.md");
      const roster = new Map(templateLabelRoster().map((label) => [label.name, label]));
      for (const name of ["dependencies", "github_actions", "javascript", "python:uv", "rust"]) {
        const label = roster.get(name);
        if (!label) throw new Error(`settings.yml.jinja: label '${name}' vanished - anchor lost`);
        if (!settingsDoc.includes(`\`${name}\``) || !settingsDoc.includes(`\`${label.color}\``)) {
          mismatches.push({
            file: "docs/settings.md",
            expected: `label \`${name}\` with color \`${label.color}\``,
            got: "name or color missing",
          });
        }
      }
      const fuzzColor = parseLabels(
        `labels:\n${placeholderJinja(normalizeJinja(read("templates/fuzzer/fragments/settings-labels.jinja"), jinjaVars()))}`,
        "fuzzer settings-labels.jinja",
      )[0].color;
      if (!settingsDoc.includes(`\`${fuzzColor}\``)) {
        mismatches.push({
          file: "docs/settings.md",
          expected: `the fuzz label color \`${fuzzColor}\``,
          got: "missing",
        });
      }
      return mismatches;
    },
  },

  {
    name: "agents-recipe",
    run: () => {
      const mismatches: Mismatch[] = [];
      const smoke = read(".github/scripts/ci/smoke_generate.sh");
      const flags = mustMatch(
        smoke,
        /--vcs-ref \S+ --defaults --trust/,
        "smoke_generate.sh",
        "copier flags",
      )[0];
      const keys = [...smoke.matchAll(/-d "?([a-z_]+)=/g)].map((m) => m[1]);
      if (keys.length === 0)
        throw new Error("smoke_generate.sh: no -d answers found - anchor lost");
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
    // The redaction verifier is computed twice: redact.ts (plan-side, TS)
    // and resolve_private_repo.sh (leg-side, bash+openssl). The lockstep
    // test in redact.test.ts proves the bytes agree; this rule pins the
    // two spellable constants - truncation length and key-derivation
    // label - so an edit to one side fails CI before the tags stop
    // matching at runtime.
    name: "redact-hmac-lockstep",
    run: () => {
      const ts = read(".github/scripts/fleet/redact.ts");
      const sh = read(".github/scripts/fleet/resolve_private_repo.sh");
      const mismatches: Mismatch[] = [];
      const tsLen = mustMatch(
        ts,
        /export const VERIFY_HEX_LENGTH = (\d+);/,
        "redact.ts",
        "verify truncation length",
      )[1];
      // Anchor to the tag pipeline itself (hexkey ... cut), not any
      // stray cut elsewhere in the script.
      const shLen = mustMatch(
        sh,
        /hexkey:\$\{key_hex\}[\s\S]{0,120}?cut -c1-(\d+)/,
        "resolve_private_repo.sh",
        "verify truncation length",
      )[1];
      if (tsLen !== shLen) {
        mismatches.push({
          file: ".github/scripts/fleet/resolve_private_repo.sh",
          expected: `HMAC truncation to ${tsLen} hex chars (redact.ts VERIFY_HEX_LENGTH)`,
          got: `cut -c1-${shLen}`,
        });
      }
      const label = mustMatch(
        ts,
        /export const KEY_DERIVATION_LABEL = "([^"]+)";/,
        "redact.ts",
        "key-derivation label",
      )[1];
      // The label must sit in the actual key derivation (printf into the
      // PAT-keyed HMAC), not merely appear somewhere in the file.
      const derivation = /printf '%s' "([^"]+)" \|\s*\n\s*openssl dgst -sha256 -hmac "\$PAT"/;
      const shLabel = mustMatch(
        sh,
        derivation,
        "resolve_private_repo.sh",
        "key-derivation label",
      )[1];
      if (shLabel !== label) {
        mismatches.push({
          file: ".github/scripts/fleet/resolve_private_repo.sh",
          expected: `the key-derivation label ${JSON.stringify(label)} (redact.ts)`,
          got: JSON.stringify(shLabel),
        });
      }
      return mismatches;
    },
  },

  {
    // open_pr.sh reads run_hidden.sh capture files by name to put hidden
    // validation diagnostics into the PR body; the names derive from the
    // labels at the run_hidden call sites. Rewording a label would
    // silently break that hand-off, so every referenced capture name
    // must match a label-derived one.
    name: "hidden-capture-names",
    run: () => {
      const mismatches: Mismatch[] = [];
      // Mirrors run_hidden.sh's slug transform (tr -c 'A-Za-z0-9' '-'
      // squeezed and trimmed).
      const slugify = (label: string) =>
        label.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      const labels = [
        ...read(".github/workflows/reusable-template-sync.yml").matchAll(
          /run_hidden\.sh "([^"]+)" --/g,
        ),
        ...read(".github/scripts/sync/commit_push.sh").matchAll(/run_hidden\.sh" "([^"]+)" --/g),
      ].map((m) => m[1]);
      if (labels.length === 0) {
        throw new Error("no run_hidden labels found in the sync call sites - anchor lost");
      }
      const derived = new Set(labels.map((l) => `hidden-${slugify(l)}.log`));
      const referenced = [
        ...read(".github/scripts/sync/open_pr.sh").matchAll(/hidden-[A-Za-z0-9-]+\.log/g),
      ].map((m) => m[0]);
      if (referenced.length === 0) {
        throw new Error("open_pr.sh references no hidden capture files - anchor lost");
      }
      for (const name of referenced) {
        if (!derived.has(name)) {
          mismatches.push({
            file: ".github/scripts/sync/open_pr.sh",
            expected: `a capture name derived from a run_hidden label (${[...derived].join(", ")})`,
            got: name,
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
