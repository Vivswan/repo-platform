// A repository still registered the old way (.repo-platform.yml holding
// only `modules`, its render recorded in .github/.copier-answers.yml) gets
// its registration derived here, once, before the writer reads it: the
// project block from the recorded answers, the per-module values only
// where they differ from the module defaults in files.yml, unknown module
// names dropped and reported. The answers file itself leaves through the
// data file's retired entry. A repository whose website the retired
// pages.yml deployed is held until its site-build hook is filled in.
// Every note holds the PR for review.

import { parse as parseYaml, stringify } from "yaml";
import type { ModuleData } from "../../../../actions/plan/files_config.ts";
import {
  parseRegistration,
  REGISTRATION_PATH,
  readModules,
} from "../../../../actions/plan/registration.ts";
import type { WriterFilesConfig } from "./files_config.ts";
import type { RepositorySlug } from "./registration.ts";
import { existingFile, probe, writeFile } from "./target_files.ts";

export const ANSWERS_FILE = ".github/.copier-answers.yml";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** The registration schema still judges the result, so a repository name
 *  with no usable character fails there, naming the field. */
const slugified = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** A recorded answer: absent, or a string; any other type is the answers
 *  file's error, never a silently defaulted value. */
function answer(answers: Record<string, unknown>, key: string): string | undefined {
  const value = answers[key];
  if (value === undefined || typeof value === "string") return value;
  throw new Error(`${ANSWERS_FILE}: ${key} must be a string`);
}

/** The keys the old registration template wrote; anything else means the
 *  repository already registers the new way and nothing is derived. */
export const V1_KEYS: ReadonlySet<string> = new Set(["modules", "mirrors"]);

/** The hook a repository's own site build lives in now; the old template
 *  recorded the build as `pages_*` answers instead. */
export const SITE_BUILD_HOOK = ".github/actions/site-build/action.yml";

/** The retired workflow whose presence marks a repository as one whose
 *  website build has not moved into the hook yet. */
export const PAGES_WORKFLOW = ".github/workflows/pages.yml";

/** The `pages_*` answers, in the order the note lists them. */
const PAGES_ANSWERS = [
  "pages_setup",
  "pages_install_command",
  "pages_build_command",
  "pages_dist_dir",
];

/** A module's tracking label stream: `tracking_label: {key, default}`. */
function trackingLabel(data: ModuleData | undefined): { key: string; default: string } | null {
  const stream = data?.tracking_label;
  if (!isRecord(stream)) return null;
  const key = text(stream.key);
  const fallback = text(stream.default);
  return key !== undefined && fallback !== undefined ? { key, default: fallback } : null;
}

export interface Derived {
  document: Record<string, unknown>;
  notes: string[];
}

/** The v2 registration for a v1 document and its recorded answers. */
export function deriveRegistration(
  v1: Record<string, unknown>,
  answers: Record<string, unknown>,
  config: WriterFilesConfig,
  repository: RepositorySlug,
): Derived {
  const modules = readModules(v1).modules;
  if (modules === null)
    throw new Error(`${REGISTRATION_PATH}: ${readModules(v1).errors.join("; ")}`);
  const known = Object.keys(config.modules);
  const selected = known.filter((name) => modules.includes(name));
  const dropped = modules.filter((name) => !known.includes(name));
  const data = (name: string) => config.modules[name];
  const has = (name: string) => selected.includes(name);
  const differs = (answer: string | undefined, fallback: string) =>
    answer !== undefined && answer !== fallback ? answer : undefined;
  const compact = (entries: Record<string, string | undefined>) => {
    const kept = Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== undefined));
    return Object.keys(kept).length === 0 ? undefined : kept;
  };

  const project = compact({
    name: answer(answers, "project_name") ?? repository.name,
    slug: answer(answers, "project_slug") ?? slugified(repository.name),
    description: answer(answers, "description") ?? "",
    copyright_holder: differs(answer(answers, "copyright_holder"), repository.owner),
  });
  const skills = has("skills")
    ? compact({
        dir: differs(answer(answers, "skills_dir"), config.defaults.skills_dir ?? "skills"),
      })
    : undefined;
  const labels: Record<string, string | undefined> = {};
  for (const name of selected) {
    const stream = trackingLabel(data(name));
    if (stream === null) continue;
    labels[stream.key] = differs(answer(answers, `${stream.key}_label`), stream.default);
  }

  const document: Record<string, unknown> = { modules: selected };
  if (project !== undefined) document.project = project;
  if (skills !== undefined) document.skills = skills;
  const declaredLabels = compact(labels);
  if (declaredLabels !== undefined) document.labels = declaredLabels;
  // Carried as written: a malformed declaration is the schema check's to refuse, loudly.
  if ("mirrors" in v1) document.mirrors = v1.mirrors;

  const notes = [
    `cutover: ${REGISTRATION_PATH} was derived from ${ANSWERS_FILE} (${Object.keys(document).join(", ")}); review it before merging`,
    ...dropped.map(
      (name) =>
        `cutover: dropped unknown module \`${name}\` from ${REGISTRATION_PATH} (files.yml does not know it)`,
    ),
    ...siteNotes(modules, answers, {
      path: text(data("site")?.path) ?? "docs",
      label: trackingLabel(data("site"))?.default ?? "docs-link-rot",
    }),
  ];
  return { document, notes };
}

/** A selected old module becomes the instruction to select `site`; the
 *  recorded build belongs in the repo-owned hook, not in a registration
 *  key, so the answers ride in the note. Copier recorded every answer
 *  whether or not its module was selected: only a selection notes. */
function siteNotes(
  modules: string[],
  answers: Record<string, unknown>,
  defaults: { path: string; label: string },
): string[] {
  const notes: string[] = [];
  if (modules.includes("pages")) {
    const recorded = PAGES_ANSWERS.map((key) => [key, answer(answers, key)] as const).filter(
      ([, value]) => value !== undefined && value !== "",
    );
    const build =
      recorded.length > 0
        ? `the recorded ${recorded.map(([key, value]) => `${key}=\`${value}\``).join(", ")}`
        : "its build";
    notes.push(
      `cutover: the \`pages\` module is the \`site\` module now, and its build is the repo-owned ${SITE_BUILD_HOOK} hook: ` +
        `select \`site\` and move ${build} into the hook before merging`,
    );
  }
  if (modules.includes("docs-site")) {
    // Each recorded docs-site answer that is not the site default, as the
    // registration key it becomes.
    const moved = (
      [
        ["docs_site_path", "site.path", defaults.path],
        ["docs_site_label", "labels.site", defaults.label],
      ] as const
    )
      .map(([key, target, fallback]) => [answer(answers, key), target, key, fallback] as const)
      .filter(([value, , , fallback]) => value !== undefined && value !== "" && value !== fallback)
      .map(([value, target, key]) => `${target} to \`${value}\` (the recorded ${key})`);
    const settings = moved.length > 0 ? ` and set ${moved.join(" and ")}` : "";
    notes.push(
      `cutover: the \`docs-site\` module is the \`site\` module now: select \`site\`${settings} before merging`,
    );
  }
  return notes;
}

const HEADER =
  "# Written once by repo-platform and repo-owned from then on: the sync reads this file and never rewrites it.\n";

/** The hold for a repository whose website the retired pages.yml deployed:
 *  the sync seeds the hook as a no-op, so without this note a clean report
 *  would auto-merge and the next main run would publish the docs alone. A
 *  hook already at its path means the build has moved. */
export function siteHoldNotes(target: string): string[] {
  // Presence is what the starter writer judges too: a symlink at the hook
  // path is the repository's own hook.
  if (probe(target, PAGES_WORKFLOW).kind === "absent") return [];
  if (probe(target, SITE_BUILD_HOOK).kind !== "absent") return [];
  return [
    `site cutover: ${PAGES_WORKFLOW} is retired and ${SITE_BUILD_HOOK} is seeded as a no-op; ` +
      "move the former pages build into the hook before merging, or the next main run serves the docs alone (or nothing)",
  ];
}

/** Every transitional note: the site hold, then the v1 rewrite. */
export function cutover(
  target: string,
  config: WriterFilesConfig,
  repository: RepositorySlug,
): string[] {
  return [...siteHoldNotes(target), ...answersCutover(target, config, repository)];
}

/** Rewrites a v1 registration as v2 when the target still carries its
 *  answers file; returns the notes, empty when there is nothing to do. */
function answersCutover(
  target: string,
  config: WriterFilesConfig,
  repository: RepositorySlug,
): string[] {
  const answersBytes = existingFile(target, ANSWERS_FILE);
  const registrationBytes = existingFile(target, REGISTRATION_PATH);
  if (answersBytes === null || registrationBytes === null) return [];
  const v1: unknown = parseYaml(registrationBytes.toString("utf-8"), { logLevel: "error" });
  if (!isRecord(v1) || !Object.keys(v1).every((key) => V1_KEYS.has(key))) return [];
  const answers: unknown = parseYaml(answersBytes.toString("utf-8"), { logLevel: "error" });
  if (!isRecord(answers)) throw new Error(`${ANSWERS_FILE}: not a mapping of recorded answers`);
  const { document, notes } = deriveRegistration(v1, answers, config, repository);
  const rendered = HEADER + stringify(document, { lineWidth: 0 });
  const check = parseRegistration(rendered);
  if ("errors" in check) {
    throw new Error(
      `the ${REGISTRATION_PATH} derived from ${ANSWERS_FILE} is invalid:\n  - ${check.errors.join("\n  - ")}`,
    );
  }
  writeFile(target, REGISTRATION_PATH, Buffer.from(rendered));
  return notes;
}
