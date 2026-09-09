// The labels a repository's own files REFERENCE (docs/settings.md, "Label
// preflight", states the extraction rule and its limits): the `labels:` key
// of its issue forms, and a heuristic extraction from its own workflows.
// The settings apply's reconciliation DELETES every live label the merged
// document does not declare, and deleting one these files still reference
// breaks them silently - an issue form whose label vanished, a stale-close
// workflow keyed on a label the roster never carried. Consumers:
// label_preflight.ts fails an apply that would delete a referenced label;
// the sync's referenced_labels.ts warns in the PR body.
//
// A stated heuristic, not completeness. Workflow keys are matched by SHAPE
// (`label`/`labels` as the final segment, or a `labels-to` opening); a key
// whose label segment modifies a later noun configures an attribute
// (`label-color`) and is skipped, as is everything under `runs-on` (runner
// labels) and `matrix`: a genuine label routed through a matrix variable is
// consumed as `${{ matrix.* }}`, already invisible, so its static definition
// is skipped with the shard selectors rather than kept as a lone echo of a
// reference this extraction cannot see. Any value containing `${{` is
// dropped, and names built in `run:`/`script:` code are never extracted.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { isMapping } from "./settings_document.ts";

export type ReferenceKind = "issue-form" | "workflow";

export interface ReferenceFile {
  /** Repo-relative path, for diagnostics. */
  path: string;
  kind: ReferenceKind;
  text: string;
}

/** One referenced label with every file that references it. */
export interface LabelReference {
  label: string;
  files: string[];
}

/** GitHub deduplicates label names case-insensitively; every comparison
 *  in this module folds the same way. */
export function foldLabel(name: string): string {
  return name.toLowerCase();
}

/** A scalar `labels` value split per the rule above; list elements are the
 *  caller's job. Dynamic and empty values yield nothing. */
function labelsFromScalar(value: string): string[] {
  if (value.includes("${{")) return [];
  return value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
}

/** The label names in one `labels:`-shaped value: a scalar (comma-split),
 *  or a list of scalars (taken whole). Mappings and non-string elements
 *  carry no extractable name. */
function labelsFromValue(value: unknown): string[] {
  if (typeof value === "string") return labelsFromScalar(value);
  if (!Array.isArray(value)) return [];
  return value.flatMap((element) =>
    typeof element === "string" && !element.includes("${{") && element.trim() !== ""
      ? [element.trim()]
      : [],
  );
}

/** The top-level `labels:` of one issue form. A form GitHub cannot parse
 *  applies no labels either, so unparseable YAML reads as no references. */
export function issueFormLabels(text: string): string[] {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch {
    return [];
  }
  return isMapping(data) ? labelsFromValue(data.labels) : [];
}

/** A key SHAPED like a label name: `label`/`labels` as the FINAL
 *  dash/underscore segment (`labels`, `stale-issue-label`,
 *  `any-of-issue-labels`), or a `labels-to` opening
 *  (`labels-to-remove-when-unstale`). Keys whose label segment modifies a
 *  later noun configure label ATTRIBUTES, not names (`label-color`,
 *  `label-description` - the litellm fuzz-issue false positives), and
 *  carry no label reference. */
const LABEL_NAME_KEY = /(^|[-_])labels?$|^labels[-_]to[-_]/;

const EXPRESSION_PATTERNS = [
  /github\.event\.label\.name\s*[!=]=\s*'([^']+)'/g,
  /'([^']+)'\s*[!=]=\s*github\.event\.label\.name/g,
  /contains\(\s*github\.event\.(?:issue|pull_request)\.labels\.\*\.name\s*,\s*'([^']+)'\s*\)/g,
];

function walkWorkflowValue(value: unknown, found: string[]): void {
  if (Array.isArray(value)) {
    for (const element of value) walkWorkflowValue(element, found);
    return;
  }
  if (!isMapping(value)) return;
  for (const [key, child] of Object.entries(value)) {
    // Runner labels, not issue labels; nothing below runs-on can be one.
    if (key === "runs-on") continue;
    // Matrix contexts define job variables, never label rosters - a
    // `labels` shard selector there is data (the litellm docker shape).
    if (key === "matrix") continue;
    if (LABEL_NAME_KEY.test(key.toLowerCase())) found.push(...labelsFromValue(child));
    walkWorkflowValue(child, found);
  }
}

/** The label names one workflow references, per the extraction rule in
 *  the header. The regex pass runs even when the YAML walk cannot (the
 *  grep-level floor for a file YAML rejects). */
export function workflowLabelRefs(text: string): string[] {
  const found: string[] = [];
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch {
    data = null;
  }
  walkWorkflowValue(data, found);
  for (const pattern of EXPRESSION_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (!match[1].includes("${{")) found.push(match[1]);
    }
  }
  return found;
}

/** Every referenced label across `files`, folded case-insensitively (first
 *  spelling wins), each carrying its referencing files; sorted by label
 *  for stable output. */
export function collectReferences(files: ReferenceFile[]): LabelReference[] {
  const byFold = new Map<string, LabelReference>();
  for (const file of files) {
    const names =
      file.kind === "issue-form" ? issueFormLabels(file.text) : workflowLabelRefs(file.text);
    for (const name of names) {
      const entry = byFold.get(foldLabel(name)) ?? { label: name, files: [] };
      if (!entry.files.includes(file.path)) entry.files.push(file.path);
      byFold.set(foldLabel(name), entry);
    }
  }
  return [...byFold.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** The references whose label is absent from `finalNames` (the merged
 *  document's post-apply label names), case-folded like GitHub. */
export function missingFromRoster(
  references: LabelReference[],
  finalNames: string[],
): LabelReference[] {
  const roster = new Set(finalNames.map(foldLabel));
  return references.filter((reference) => !roster.has(foldLabel(reference.label)));
}

/** A merged settings document's POST-APPLY label names, or null when it
 *  declares no `labels` key (the apply never touches an undeclared key, so
 *  no reconciliation happens). Post-apply means a STRING `new_name` when
 *  declared, else `name`; the rename's source is deliberately absent, since
 *  after the apply a reference to it breaks exactly like a deletion. A
 *  DEGENERATE rename target (empty, a collision) fails the action before its
 *  deletion pass, so treating the source as removed anyway is the
 *  conservative read: it blocks an apply that could not have succeeded. */
export function finalLabelNames(merged: Record<string, unknown>): string[] | null {
  const labels = merged.labels;
  if (labels === undefined) return null;
  if (!Array.isArray(labels)) return [];
  return labels.flatMap((entry) => {
    if (!isMapping(entry)) return [];
    const final = typeof entry.new_name === "string" ? entry.new_name : entry.name;
    return typeof final === "string" ? [final] : [];
  });
}

const ISSUE_TEMPLATE_DIR = ".github/ISSUE_TEMPLATE";
const WORKFLOWS_DIR = ".github/workflows";

function isYamlName(name: string): boolean {
  return name.endsWith(".yml") || name.endsWith(".yaml");
}

/** The reference-bearing filenames of one directory listing: YAML files,
 *  minus config.yml for the issue-template directory. */
export function referenceNames(names: string[], kind: ReferenceKind): string[] {
  return names
    .filter(isYamlName)
    .filter((name) => kind !== "issue-form" || name !== "config.yml")
    .sort();
}

/** The reference files of a local checkout. The ROOT must exist - a
 *  mistyped or missing checkout reading as "no references" would pass the
 *  fail-closed preflight open. A missing reference SUBdirectory is simply
 *  no files of that kind; any other read error throws. */
export function referenceFilesFromDir(root: string): ReferenceFile[] {
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${root}: not a directory - no checkout to read reference files from`);
  }
  const listDir = (dir: string): string[] => {
    try {
      return readdirSync(join(root, dir));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return [];
      throw error;
    }
  };
  const files: ReferenceFile[] = [];
  for (const [dir, kind] of [
    [ISSUE_TEMPLATE_DIR, "issue-form"],
    [WORKFLOWS_DIR, "workflow"],
  ] as const) {
    for (const name of referenceNames(listDir(dir), kind)) {
      const path = `${dir}/${name}`;
      if (!statSync(join(root, path)).isFile()) continue;
      files.push({ path, kind, text: readFileSync(join(root, path), "utf-8") });
    }
  }
  return files;
}

/** A directory listing from a target repository at a pinned ref: the
 *  entry names, or null when the directory does not exist there. */
export type RepoDirLister = (repo: string, dir: string, ref: string) => string[] | null;

/** One file's text from a target repository at a pinned ref. */
export type RepoFileReader = (repo: string, path: string, ref: string) => string;

/** The reference files of a remote repository AT A PINNED REF (the same
 *  commit the merged document's facts were read at - a moving-branch read
 *  could pair a new reference with an old roster). The injected readers
 *  throw on anything but a genuine 404, so a fetch failure fails the
 *  preflight closed instead of reading as "no references". */
export function referenceFilesFromFetch(
  repo: string,
  ref: string,
  listDir: RepoDirLister,
  readFile: RepoFileReader,
): ReferenceFile[] {
  const files: ReferenceFile[] = [];
  for (const [dir, kind] of [
    [ISSUE_TEMPLATE_DIR, "issue-form"],
    [WORKFLOWS_DIR, "workflow"],
  ] as const) {
    const names = listDir(repo, dir, ref);
    if (names === null) continue;
    for (const name of referenceNames(names, kind)) {
      const path = `${dir}/${name}`;
      files.push({ path, kind, text: readFile(repo, path, ref) });
    }
  }
  return files;
}
