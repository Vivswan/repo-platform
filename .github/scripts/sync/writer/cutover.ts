// A repository still registered the old way (.repo-platform.yml holding
// only `modules`, its render recorded in .github/.copier-answers.yml) gets
// its registration derived here, once, before the writer reads it: the
// project block from the recorded answers, the per-module values only
// where they differ from the module defaults in files.yml, unknown module
// names dropped and reported. The answers file itself leaves through the
// data file's retired entry. Every note holds the PR for review.

import { parse as parseYaml, stringify } from "yaml";
import type { ModuleData } from "../../../../actions/plan/files_config.ts";
import {
  parseRegistration,
  REGISTRATION_PATH,
  readModules,
} from "../../../../actions/plan/registration.ts";
import type { WriterFilesConfig } from "./files_config.ts";
import type { RepositorySlug } from "./registration.ts";
import { existingFile, writeFile } from "./target_files.ts";

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

/** A module's `pages` data (install, build) marks it as a toolchain the
 *  pages build installs; the copier defaults derived from these. */
function pagesData(data: ModuleData | undefined): { install: string; build: string } | null {
  const pages = data?.pages;
  if (!isRecord(pages)) return null;
  return { install: text(pages.install) ?? "", build: text(pages.build) ?? "" };
}

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
  // The plan's rule for the pages defaults: the setup is the selected
  // toolchains (modules carrying pages data), and the commands come from
  // the first module, in files.yml order, that the RESOLVED setup names.
  const defaultSetup =
    selected.filter((name) => pagesData(data(name)) !== null).join(",") || "none";
  const setup = answer(answers, "pages_setup") ?? defaultSetup;
  const named = new Set(setup.split(","));
  const commands = pagesData(
    data(known.find((name) => named.has(name) && pagesData(data(name)) !== null) ?? ""),
  );
  const pages = has("pages")
    ? compact({
        setup: differs(answer(answers, "pages_setup"), defaultSetup),
        install: differs(answer(answers, "pages_install_command"), commands?.install ?? ""),
        build: differs(answer(answers, "pages_build_command"), commands?.build ?? ""),
        dist: differs(answer(answers, "pages_dist_dir"), text(data("pages")?.dist) ?? "dist"),
      })
    : undefined;
  const docsSite = has("docs-site")
    ? compact({
        path: differs(answer(answers, "docs_site_path"), text(data("docs-site")?.path) ?? "docs"),
      })
    : undefined;
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
  if (pages !== undefined) document.pages = pages;
  if (docsSite !== undefined) document.docs_site = docsSite;
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
  ];
  return { document, notes };
}

const HEADER =
  "# Generated once by repo-platform and repo-owned from then on: the sync reads this file and never rewrites it.\n";

/** Rewrites a v1 registration as v2 when the target still carries its
 *  answers file; returns the notes, empty when there is nothing to do. */
export function cutover(
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
      `the derived ${REGISTRATION_PATH} is invalid:\n  - ${check.errors.join("\n  - ")}`,
    );
  }
  writeFile(target, REGISTRATION_PATH, Buffer.from(rendered));
  return notes;
}
