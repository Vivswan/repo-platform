#!/usr/bin/env bun
// Compose the flat template/ tree Copier renders from templates/ sources.
//
// templates/ is the source of truth, one folder per module plus base/:
//
// - templates/base/: passed through verbatim, filenames included (explicit
//   conditional filenames like SECURITY.md's `not private` gate live here).
// - templates/<module>/: whole files owned by that module. The composer adds
//   the module's filename gate automatically ({% if '<module>' in modules %}),
//   wrapping the leaf name (keeping any .jinja suffix outside), or a whole
//   directory listed in the folder's optional module.yml `gate_dirs`.
// - templates/<module>/fragments/<anchor>.jinja: additive contributions to
//   shared files. A skeleton file contains a full-line marker
//   `{# compose:<anchor> #}`; the composer replaces it with every module's
//   fragment wrapped in that module's gate, in MODULE_ORDER. Fragments own all
//   whitespace between the tags; the composer adds none.
//
// Collisions are errors, never silent merges: the same logical path provided
// by two folders (or a module file colliding with base) must be resolved by
// hoisting the file to base/ with an explicit gate or by adding an anchor.
//
// All I/O is bytes (template/.gitignore.jinja carries an intentional CR) and
// symlinks are copied as symlinks. Output is deterministic: sorted walks plus
// the fixed MODULE_ORDER (CI builds twice and diffs to prove it).
//
// Usage:
//   bun scripts/compose_template.ts   # regenerate the local template/ artifact

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = resolve(import.meta.dir, "..");
const SRC = join(REPO_ROOT, "templates");
const OUT = join(REPO_ROOT, "template");

// Fixed, deterministic fragment/collision order (bun before uv preserves the
// dependabot ecosystem order). A templates/ folder not listed here is an error.
export const MODULE_ORDER = [
  "agents",
  "bun",
  "uv",
  "pages",
  "release-please",
  "issue-templates",
  "pr-title",
  "auto-assign",
  "settings-sync",
];

const ANCHOR_RE = /^\{# compose:([a-z0-9][a-z0-9-]*) #\}$/;
const JINJA_SUFFIX = ".jinja";
const MANIFEST_NAME = "module.yml";
const FRAGMENTS_DIR = "fragments";

// One collected source file: regular bytes or a symlink target (emitted as a
// link with the target rewritten).
export type Entry = { kind: "symlink"; target: string } | { kind: "file"; data: Buffer };

interface Manifest {
  gate?: string;
  gate_dirs?: string[];
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

function relToRepo(path: string): string {
  return path.startsWith(`${REPO_ROOT}/`) ? path.slice(REPO_ROOT.length + 1) : path;
}

function readEntry(path: string): Entry {
  if (lstatSync(path).isSymbolicLink()) return { kind: "symlink", target: readlinkSync(path) };
  return { kind: "file", data: readFileSync(path) };
}

/** All non-directory entries below `dir` as relative paths, sorted. */
function walkFiles(dir: string): string[] {
  const found: string[] = [];
  const visit = (rel: string) => {
    for (const name of readdirSync(join(dir, rel))) {
      const childRel = rel ? `${rel}/${name}` : name;
      const stat = lstatSync(join(dir, childRel));
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(childRel);
      else if (stat.isSymbolicLink() || stat.isFile()) found.push(childRel);
    }
  };
  visit("");
  return found.sort();
}

function loadManifest(folder: string): Manifest {
  const manifest = join(folder, MANIFEST_NAME);
  if (!existsSync(manifest) || !lstatSync(manifest).isFile()) return {};
  const data: unknown = parseYaml(readFileSync(manifest, "utf-8")) ?? {};
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    die(
      `error: ${relToRepo(manifest)} must be a YAML mapping ` +
        "(it parsed as something else); rewrite it as 'key: value' lines " +
        "using only the gate / gate_dirs keys",
    );
  }
  const record = data as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => key !== "gate" && key !== "gate_dirs");
  if (unknown.length > 0) {
    die(
      `error: ${relToRepo(manifest)}: unknown key(s): ` +
        `${unknown.sort().join(", ")} - only gate and gate_dirs are ` +
        "recognized; remove or rename the extra keys",
    );
  }
  const gate = record.gate;
  if (gate !== undefined && gate !== null && typeof gate !== "string") {
    die(
      `error: ${relToRepo(manifest)}: gate must be a string ` +
        "(quote it - unquoted YAML may parse as bool/int)",
    );
  }
  const gateDirs = record.gate_dirs;
  if (
    gateDirs !== undefined &&
    gateDirs !== null &&
    (!Array.isArray(gateDirs) || !gateDirs.every((d) => typeof d === "string"))
  ) {
    die(
      `error: ${relToRepo(manifest)}: gate_dirs must be a list of ` +
        "strings naming directories in this module; write it as e.g. " +
        'gate_dirs: [".github/ISSUE_TEMPLATE"]',
    );
  }
  const result: Manifest = {};
  if (typeof gate === "string") result.gate = gate;
  if (Array.isArray(gateDirs)) result.gate_dirs = gateDirs as string[];
  return result;
}

/** Logical path -> Entry for a source folder (skips manifest + fragments). */
function collectFiles(folder: string): Map<string, Entry> {
  const files = new Map<string, Entry>();
  for (const rel of walkFiles(folder)) {
    if (rel.split("/")[0] === FRAGMENTS_DIR || rel === MANIFEST_NAME) continue;
    files.set(rel, readEntry(join(folder, rel)));
  }
  return files;
}

/** Anchor name -> fragment bytes for a module folder. */
function collectFragments(folder: string): Map<string, Buffer> {
  const fragments = new Map<string, Buffer>();
  const fragDir = join(folder, FRAGMENTS_DIR);
  if (!existsSync(fragDir) || !lstatSync(fragDir).isDirectory()) return fragments;
  for (const name of readdirSync(fragDir).sort()) {
    const path = join(fragDir, name);
    if (!lstatSync(path).isFile()) continue;
    if (!name.endsWith(JINJA_SUFFIX)) {
      die(
        `error: ${relToRepo(path)}: fragment files must end in ` +
          `${JINJA_SUFFIX} (the composer strips it to get the anchor name); ` +
          `rename the file to <anchor>${JINJA_SUFFIX} or move it out of ${FRAGMENTS_DIR}/`,
      );
    }
    fragments.set(name.slice(0, -JINJA_SUFFIX.length), readFileSync(path));
  }
  return fragments;
}

function gateExpression(module: string, manifest: Manifest): string {
  return manifest.gate || `'${module}' in modules`;
}

function rpartition(value: string, sep: string): [string, string, string] {
  const index = value.lastIndexOf(sep);
  if (index === -1) return ["", "", value];
  return [value.slice(0, index), sep, value.slice(index + sep.length)];
}

/** Wrap the leaf filename (or a declared directory) in the module gate. */
function gatedPath(logical: string, gate: string, gateDirs: string[]): string {
  for (const gatedDir of gateDirs) {
    const prefix = gatedDir.replace(/\/+$/, "");
    if (logical === prefix || logical.startsWith(`${prefix}/`)) {
      const [parent, , dirname_] = rpartition(prefix, "/");
      const wrapped = `{% if ${gate} %}${dirname_}{% endif %}`;
      const newPrefix = parent ? `${parent}/${wrapped}` : wrapped;
      return newPrefix + logical.slice(prefix.length);
    }
  }
  const [parent, , leaf] = rpartition(logical, "/");
  let wrapped: string;
  if (leaf.endsWith(JINJA_SUFFIX)) {
    const stem = leaf.slice(0, -JINJA_SUFFIX.length);
    wrapped = `{% if ${gate} %}${stem}{% endif %}${JINJA_SUFFIX}`;
  } else {
    wrapped = `{% if ${gate} %}${leaf}{% endif %}`;
  }
  return parent ? `${parent}/${wrapped}` : wrapped;
}

const NEWLINE = Buffer.from("\n");
const ANCHOR_HINT = Buffer.from("{# compose:");

function splitLines(data: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x0a) {
      lines.push(data.subarray(start, i));
      start = i + 1;
    }
  }
  lines.push(data.subarray(start));
  return lines;
}

function joinLines(lines: Buffer[]): Buffer {
  const parts: Buffer[] = [];
  lines.forEach((line, index) => {
    if (index > 0) parts.push(NEWLINE);
    parts.push(line);
  });
  return Buffer.concat(parts);
}

function matchAnchor(line: Buffer): string | null {
  // Bytes, matched as latin1: non-ASCII bytes can never satisfy the pattern.
  const match = ANCHOR_RE.exec(line.toString("latin1"));
  return match ? match[1] : null;
}

function sortedByKey<V>(map: Map<string, V>): [string, V][] {
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

type SourcedEntry = { source: string; entry: Entry };

/** Replace anchor lines in-place; returns error strings. */
function spliceFragments(
  files: Map<string, SourcedEntry>,
  fragments: Map<string, [string, Buffer][]>,
  gates: Map<string, string>,
): string[] {
  const errors: string[] = [];
  const anchorOwner = new Map<string, [string, string]>(); // anchor -> [source, logical]
  for (const [logical, { source, entry }] of sortedByKey(files)) {
    if (entry.kind === "symlink") continue;
    for (const line of splitLines(entry.data)) {
      if (line.includes(ANCHOR_HINT) && matchAnchor(line) === null) {
        errors.push(
          `templates/${source}/${logical}: malformed anchor line ` +
            `'${line.toString("utf-8").trim()}' - anchors must be a ` +
            "full line exactly matching '{# compose:<name> #}' (no " +
            "indentation, trailing whitespace, or CRLF)",
        );
        continue;
      }
      const anchor = matchAnchor(line);
      if (anchor === null) continue;
      const other = anchorOwner.get(anchor);
      if (other) {
        errors.push(
          `duplicate anchor '${anchor}' in templates/${source}/${logical} ` +
            `and templates/${other[0]}/${other[1]} - each anchor may appear ` +
            "in exactly one skeleton file; rename one anchor (and any " +
            `fragments/${anchor}.jinja files that feed it) or remove the duplicate marker`,
        );
      }
      anchorOwner.set(anchor, [source, logical]);
    }
  }

  for (const [anchor, contributions] of sortedByKey(fragments)) {
    if (!anchorOwner.has(anchor)) {
      for (const [module] of contributions) {
        errors.push(
          `templates/${module}/${FRAGMENTS_DIR}/${anchor}${JINJA_SUFFIX}: no ` +
            `anchor {# compose:${anchor} #} found in any source file - the ` +
            "fragment has nowhere to splice; add the marker line to a " +
            "skeleton file or delete the fragment",
        );
      }
    }
  }
  for (const [anchor, [source, logical]] of sortedByKey(anchorOwner)) {
    if (!fragments.has(anchor)) {
      errors.push(
        `templates/${source}/${logical}: anchor '${anchor}' has no contributing ` +
          `fragments - remove the marker or add ${FRAGMENTS_DIR}/${anchor}${JINJA_SUFFIX} ` +
          "to a module",
      );
    }
  }
  if (errors.length > 0) return errors;

  for (const sourced of files.values()) {
    const { entry } = sourced;
    if (entry.kind === "symlink" || !entry.data.includes(ANCHOR_HINT)) continue;
    const rebuilt: Buffer[] = [];
    for (const line of splitLines(entry.data)) {
      const anchor = matchAnchor(line);
      if (anchor === null) {
        rebuilt.push(line);
        continue;
      }
      const spliced = Buffer.concat(
        (fragments.get(anchor) as [string, Buffer][]).flatMap(([module, body]) => [
          Buffer.from(`{% if ${gates.get(module)} %}`),
          body,
          Buffer.from("{% endif %}"),
        ]),
      );
      rebuilt.push(spliced);
    }
    entry.data = joinLines(rebuilt);
  }
  return errors;
}

/** Compose the output map: emitted path -> Entry. Exits 1 on errors. */
export function build(): Map<string, Entry> {
  const base = join(SRC, "base");
  if (!existsSync(base) || !lstatSync(base).isDirectory() || readdirSync(base).length === 0) {
    die(
      "error: templates/base is missing or empty; refusing to compose " +
        "(a broken checkout must not wipe template/). Restore templates/base/ " +
        "with git checkout before rerunning.",
    );
  }
  const folders = readdirSync(SRC)
    .filter((name) => name !== "base" && lstatSync(join(SRC, name)).isDirectory())
    .sort();
  const unknown = folders.filter((f) => !MODULE_ORDER.includes(f));
  if (unknown.length > 0) {
    die(
      `error: templates/${unknown[0]}/ is not a known module; add it to ` +
        "MODULE_ORDER in scripts/compose_template.ts",
    );
  }

  const errors: string[] = [];
  const files = new Map<string, SourcedEntry>();
  const fragments = new Map<string, [string, Buffer][]>();
  const gates = new Map<string, string>();
  const gateDirs = new Map<string, string[]>();

  for (const [logical, entry] of collectFiles(base)) {
    files.set(logical, { source: "base", entry });
  }
  try {
    lstatSync(join(base, FRAGMENTS_DIR));
    errors.push(
      `templates/base/${FRAGMENTS_DIR}: base cannot contribute fragments ` +
        "(it owns the skeletons); fragments belong to module folders",
    );
  } catch {
    // No fragments/ entry under base - the expected state.
  }

  for (const module of MODULE_ORDER.filter((m) => folders.includes(m))) {
    const folder = join(SRC, module);
    const manifest = loadManifest(folder);
    gates.set(module, gateExpression(module, manifest));
    const dirs = [...(manifest.gate_dirs ?? [])];
    gateDirs.set(module, dirs);
    const moduleFiles = collectFiles(folder);
    // Every gate_dirs entry must name a DIRECTORY holding at least one of
    // this module's files - a typo would otherwise silently fall back to
    // per-leaf gating, and a file entry would break .jinja suffix handling.
    for (const gatedDir of dirs) {
      const prefix = gatedDir.replace(/\/+$/, "");
      if (moduleFiles.has(prefix)) {
        errors.push(
          `templates/${module}/${MANIFEST_NAME}: gate_dirs entry ` +
            `'${gatedDir}' is a file, not a directory - leaf files are ` +
            "gated automatically; remove the entry",
        );
      } else if (![...moduleFiles.keys()].some((p) => p.startsWith(`${prefix}/`))) {
        errors.push(
          `templates/${module}/${MANIFEST_NAME}: gate_dirs entry ` +
            `'${gatedDir}' matches none of the module's files - likely a ` +
            "typo; fix the path or remove the entry",
        );
      }
    }
    for (const [logical, entry] of moduleFiles) {
      if (logical.includes("{%")) {
        errors.push(
          `templates/${module}/${logical}: module files must not hand-write ` +
            `filename gates; the composer adds the '${module}' gate ` +
            "automatically (custom gates go in module.yml)",
        );
        continue;
      }
      const existing = files.get(logical);
      if (existing) {
        errors.push(
          `collision: templates/${existing.source}/${logical} and ` +
            `templates/${module}/${logical} both provide ${logical}. Additive ` +
            "content must go through an anchor ({# compose:<name> #} plus " +
            `${FRAGMENTS_DIR}/<name>${JINJA_SUFFIX}); otherwise hoist the file ` +
            "to templates/base/ with an explicit {% if %} filename.",
        );
        continue;
      }
      files.set(logical, { source: module, entry });
    }
    for (const [anchor, body] of collectFragments(folder)) {
      const contributions = fragments.get(anchor) ?? [];
      contributions.push([module, body]);
      fragments.set(anchor, contributions);
    }
  }

  errors.push(...spliceFragments(files, fragments, gates));
  if (errors.length > 0) {
    for (const error of errors) console.error(`error: ${error}`);
    process.exit(1);
  }

  const output = new Map<string, Entry>();
  const emittedErrors: string[] = [];
  for (const [logical, { source, entry }] of files) {
    const emitted =
      source === "base"
        ? logical
        : gatedPath(logical, gates.get(source) as string, gateDirs.get(source) as string[]);
    if (output.has(emitted)) {
      // Distinct logical paths can still emit the same name (e.g. a
      // hand-gated base filename plus the module's plain copy).
      emittedErrors.push(
        `collision: two sources emit template/${emitted} (one of them via ` +
          "an explicit filename gate in base/) - delete the module copy or " +
          "the hand-gated base file",
      );
      continue;
    }
    output.set(emitted, entry);
  }
  if (emittedErrors.length > 0) {
    for (const error of emittedErrors) console.error(`error: ${error}`);
    process.exit(1);
  }
  return output;
}

/** Write the composed map into `out`, replacing it entirely. */
export function writeOutput(composed: Map<string, Entry>, out: string): void {
  if (existsSync(out)) rmSync(out, { recursive: true });
  for (const [path, entry] of sortedByKey(composed)) {
    const dest = join(out, path);
    mkdirSync(dirname(dest), { recursive: true });
    if (entry.kind === "symlink") {
      // Source symlinks target the .jinja file so they are never
      // dangling in git (GitHub's action downloader refuses tarballs
      // with broken links); emitted links target the RENDERED name.
      let target = entry.target;
      if (target.endsWith(JINJA_SUFFIX)) target = target.slice(0, -JINJA_SUFFIX.length);
      symlinkSync(target, dest);
    } else {
      writeFileSync(dest, entry.data);
    }
  }
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    console.error(`error: unrecognized argument(s): ${args.join(" ")}`);
    return 2;
  }
  const composed = build();
  writeOutput(composed, OUT);
  console.log(`composed ${composed.size} file(s) into template/`);
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
