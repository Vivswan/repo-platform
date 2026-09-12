// The fleet's plan: resolves one managed repository's CI configuration at
// run time from the repository's registration (.repo-platform.yml) and
// files.yml, the module data shipped at the build branch root beside this
// action. Every managed ci.yml is byte-identical; what differs per
// repository is computed here and handed to the jobs as step outputs.
//
// `default` mode resolves what fleet-ci.yml's jobs key on: the selection in
// canonical order, the visibility, the skills directory, the CodeQL
// languages, the tracking labels, and whether a scheduled run is the week's
// CodeQL rescan; it also rejects a mirror declaration files.yml proves
// unwritable (mirrors.ts). `site` mode resolves the site configuration the
// pages-site action consumes (one JSON document: the site title, the docs
// mount path or null for no docs half, the include roots, the link-rot
// label) from the registration. Fail closed: an
// unknown module or key, a malformed value, or a missing registration fails
// the step; nothing here defaults an invalid registration into a green run.
//
// Env: MODE (default|site), PRIVATE ("true"/"false"; empty asks the API
// for GITHUB_REPOSITORY with GH_TOKEN), FILES_CONFIG (the build branch's
// files.yml: `modules` keys are the vocabulary in canonical order, values
// the defaults the registration may leave unset), RESERVED_LABELS_FILE
// (labels the platform manages, which no tracking stream may reuse),
// GITHUB_OUTPUT. Runs in the caller's checkout.

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { DocsConfig, SiteConfigJson } from "../pages-site/.vitepress/conventions.ts";
import {
  capture,
  env,
  error,
  failureDetail,
  requireEnv,
  succeeded,
} from "../shared/action_runtime.ts";
import {
  type FileEntry,
  type FilesConfig,
  FilesConfigError,
  type ModuleData,
  parseFilesConfig,
  type RetiredEntry,
} from "./files_config.ts";
import { describeMirrorProblem, mirrorDeclarationProblems, ownedPaths } from "./mirrors.ts";
import {
  LABEL_RE,
  parseRegistration,
  REGISTRATION_PATH,
  type Registration,
} from "./registration.ts";

export const MODES = ["default", "site"] as const;
export type Mode = (typeof MODES)[number];

export class PlanError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("\n"));
  }
}

/** One module of files.yml, named. */
export type Module = ModuleData & { name: string };

/** The values a registration may leave unset, each declared once in
 *  files.yml by the module that owns the setting. */
export interface PlanDefaults {
  /** modules.skills.skills_dir.default */
  skillsDir: string;
  /** modules.site.path: the URL segment the docs mount under beside a website. */
  docsPath: string;
}

export interface FilesData {
  /** Every module in files.yml order, which is the canonical module order. */
  modules: Module[];
  defaults: PlanDefaults;
  /** The file entries and retirements, for the paths a mirror may name. */
  files: FileEntry[];
  retired: RetiredEntry[];
}

/** Where files.yml declares one default the plan reads. */
export interface DefaultSource {
  module: string;
  /** The key path under `modules.<module>`, dotted. */
  key: string;
  pick: (data: ModuleData) => string | undefined;
}

/** The defaults the plan cannot do without, by PlanDefaults key: the module
 *  and key must be there, or the build tree is broken and no repository
 *  plans. */
export const REQUIRED_DEFAULTS: Readonly<Record<keyof PlanDefaults, DefaultSource>> = {
  skillsDir: { module: "skills", key: "skills_dir.default", pick: (d) => d.skills_dir?.default },
  docsPath: { module: "site", key: "path", pick: (d) => d.path },
};

/** files.yml's module data as the plan reads it: an unreadable or invalid
 *  file, or one missing a default the plan resolves from, is an error
 *  naming the file and every missing default. */
export function loadModuleData(text: string, label = "files.yml"): FilesData {
  let config: FilesConfig;
  try {
    config = parseFilesConfig(text, label);
  } catch (error) {
    if (!(error instanceof FilesConfigError)) throw error;
    throw new PlanError(error.problems.map((problem) => `${label}: ${problem}`));
  }
  const { modules } = config;
  const missing: string[] = [];
  const required = ({ module, key, pick }: DefaultSource): string => {
    const data = modules[module];
    const value = data === undefined ? undefined : pick(data);
    if (value === undefined) {
      missing.push(
        `${label}: modules.${module}.${key}: missing - the plan reads it as the default`,
      );
    }
    return value ?? "";
  };
  const defaults: PlanDefaults = {
    skillsDir: required(REQUIRED_DEFAULTS.skillsDir),
    docsPath: required(REQUIRED_DEFAULTS.docsPath),
  };
  if (missing.length > 0) throw new PlanError(missing);
  return {
    modules: Object.entries(modules).map(([name, data]) => ({ ...data, name })),
    defaults,
    files: config.files,
    retired: config.retired,
  };
}

export interface PlanInput {
  registration: Registration;
  modules: Module[];
  defaults: PlanDefaults;
  files: FileEntry[];
  retired: RetiredEntry[];
  /** Lowercased names of the labels the platform manages (the settings
   *  layers' labels): a tracking stream reusing one would let a green night
   *  close unrelated issues and every settings apply fight over it. */
  reservedLabels: ReadonlySet<string>;
  private: boolean;
}

/** The reserved label roster the build branch ships, a YAML list of names. */
export function readReservedLabels(path: string): Set<string> {
  const data: unknown = parseYaml(readFileSync(path, "utf-8"), { logLevel: "error" });
  if (!Array.isArray(data) || !data.every((name) => typeof name === "string")) {
    throw new PlanError([`${path}: must be a YAML list of label names`]);
  }
  return new Set(data.map((name) => name.toLowerCase()));
}

/** The selected modules' data in canonical order; an unknown name fails. */
export function selectModules(input: PlanInput): Module[] {
  const known = new Map(input.modules.map((module) => [module.name, module]));
  const unknown = input.registration.modules.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new PlanError(
      unknown.map(
        (name) =>
          `${REGISTRATION_PATH}: module "${name}" is not a module files.yml offers ` +
          `(known: ${[...known.keys()].join(", ")})`,
      ),
    );
  }
  const selected = new Set(input.registration.modules);
  return input.modules.filter((module) => selected.has(module.name));
}

/** Each selected tracking stream's label, in canonical order: the
 *  registration's `labels.<key>`, else the module's default. A `labels`
 *  key naming no selected stream fails: it would silently label nothing. */
export function trackingLabels(
  input: Pick<PlanInput, "registration" | "reservedLabels">,
  selected: Module[],
): string[] {
  const streams = selected.flatMap((module) =>
    module.tracking_label
      ? [{ key: module.tracking_label.key, default: module.tracking_label.default }]
      : [],
  );
  const declared = input.registration.labels ?? {};
  const keys = new Set(streams.map((stream) => stream.key));
  const stray = Object.keys(declared).filter((key) => !keys.has(key));
  if (stray.length > 0) {
    throw new PlanError(
      stray.map(
        (key) =>
          `${REGISTRATION_PATH}: labels.${key} names no selected tracking stream ` +
          `(selected: ${[...keys].join(", ") || "none"})`,
      ),
    );
  }
  const labels = streams.map((stream) => declared[stream.key] ?? stream.default);
  for (const [index, value] of labels.entries()) {
    if (!LABEL_RE.test(value)) {
      throw new PlanError([
        `files.yml: the ${streams[index].key} tracking label default is not a plain label: ${value}`,
      ]);
    }
    if (input.reservedLabels.has(value.toLowerCase())) {
      throw new PlanError([
        `tracking label "${value}" (${streams[index].key}) is a label the platform already manages; ` +
          "a green night would close whatever issues carry it and every settings apply would fight over it",
      ]);
    }
  }
  const lowered = labels.map((value) => value.toLowerCase());
  const duplicate = lowered.find((value, index) => lowered.indexOf(value) !== index);
  if (duplicate !== undefined) {
    throw new PlanError([
      `tracking label "${duplicate}" is shared by two streams (GitHub label names are case-insensitive); each stream needs its own`,
    ]);
  }
  return labels;
}

export interface CiPlan {
  modules: string[];
  private: boolean;
  skillsDir: string;
  codeqlLanguages: string[];
  trackingLabels: string[];
  weekly: boolean;
}

/** Whether a scheduled run is the week's CodeQL rescan: the skeleton's
 *  schedule fires nightly, and CodeQL reruns on Mondays (UTC) only. */
export function weekly(now: Date): boolean {
  return now.getUTCDay() === 1;
}

/** The fleet-wide nightly security stream's label (docs/security-scans.md):
 *  fleet-nightly.yml's trivy-nightly job files every repository's Trivy
 *  findings under it, so it joins the tracking labels release-health
 *  blocks on without a module or an answer; the settings baseline
 *  declares it on every repository. */
export const SECURITY_LABEL = "security-nightly";

/** CodeQL is off for a private repository (personal-account code scanning
 *  is public-only) and where no selected module analyzes as a language;
 *  otherwise the distinct languages in canonical order. */
export function codeqlLanguages(selected: Module[], isPrivate: boolean): string[] {
  if (isPrivate) return [];
  return [...new Set(selected.flatMap((m) => (m.codeql_language ? [m.codeql_language] : [])))];
}

export function planCi(input: PlanInput, now: Date = new Date()): CiPlan {
  const selected = selectModules(input);
  if (input.registration.mirrors !== undefined) {
    const owned = ownedPaths(input, {
      modules: selected.map((module) => module.name),
      private: input.private,
    });
    const problems = mirrorDeclarationProblems(input.registration.mirrors, owned);
    if (problems.length > 0) throw new PlanError(problems.map(describeMirrorProblem));
  }
  return {
    modules: selected.map((module) => module.name),
    private: input.private,
    skillsDir: input.registration.skills?.dir ?? input.defaults.skillsDir,
    codeqlLanguages: codeqlLanguages(selected, input.private),
    trackingLabels: [...trackingLabels(input, selected), SECURITY_LABEL],
    weekly: weekly(now),
  };
}

/** The site configuration the pages-site action consumes (docs/site.md):
 *  the website itself is the repo-owned hook's, so nothing about it is
 *  planned here. */
export interface SitePlan {
  /** Empty stays empty: pages-site then titles the site by repository name. */
  siteTitle: string;
  /** The docs half (its include roots the registration's, verbatim), or
   *  null when the registration turns it off (site.path: null). */
  docs: DocsConfig | null;
  linkRotLabel: string;
}

export function planSite(input: PlanInput): SitePlan {
  const selected = selectModules(input);
  if (!selected.some((module) => module.name === "site")) {
    throw new PlanError([
      `${REGISTRATION_PATH}: the site module is not selected - there is no site to deploy`,
    ]);
  }
  const labels = trackingLabels(input, selected);
  const streams = selected.flatMap((m) => (m.tracking_label ? [m.name] : []));
  const site = input.registration.site;
  return {
    siteTitle: input.registration.project?.name ?? "",
    docs:
      site?.path === null
        ? null
        : { path: site?.path ?? input.defaults.docsPath, include: site?.include ?? [] },
    linkRotLabel: labels[streams.indexOf("site")],
  };
}

/** The step outputs of a plan, by output name; a site plan is one row,
 *  the config document pages-site reads. */
export function outputsOf(plan: CiPlan | SitePlan): Record<string, string> {
  if ("docs" in plan) {
    const config: SiteConfigJson = {
      site_title: plan.siteTitle,
      docs_path: plan.docs === null ? null : plan.docs.path,
      include: plan.docs === null ? [] : plan.docs.include,
      link_rot_label: plan.linkRotLabel,
    };
    return { config: JSON.stringify(config) };
  }
  return {
    "modules": JSON.stringify(plan.modules),
    "private": String(plan.private),
    "skills-dir": plan.skillsDir,
    "codeql-languages": JSON.stringify(plan.codeqlLanguages),
    "tracking-labels": plan.trackingLabels.join(","),
    "weekly": String(plan.weekly),
  };
}

/** files.yml's text, or an error naming the path. */
export function readFilesConfig(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PlanError([`${path}: cannot read the file (${detail})`]);
  }
}

export function readRegistration(root: string): Registration {
  const path = join(root, REGISTRATION_PATH);
  if (!existsSync(path)) {
    throw new PlanError([
      `${REGISTRATION_PATH}: missing - every managed repository registers here`,
    ]);
  }
  const read = parseRegistration(readFileSync(path, "utf-8"));
  if ("errors" in read) throw new PlanError(read.errors);
  return read.registration;
}

/** The visibility: the caller's input when it says so, else the API's word
 *  (a schedule or dispatch event still carries the repository object, but
 *  the fallback keeps an empty input from reading as public). */
export function resolvePrivate(input: string, repository: string): boolean {
  if (input === "true") return true;
  if (input === "false") return false;
  if (input !== "")
    throw new PlanError([`private input must be true, false, or empty; got '${input}'`]);
  const result = capture(["gh", "api", `repos/${repository}`, "--jq", ".private"], {
    timeoutMs: 60_000,
  });
  const value = result.stdout.trim();
  if (!succeeded(result.exit) || (value !== "true" && value !== "false")) {
    throw new PlanError([
      `cannot read the visibility of ${repository}: ${succeeded(result.exit) ? `unexpected answer '${value}'` : failureDetail(result)}`,
    ]);
  }
  return value === "true";
}

function main(): number {
  const mode = env("MODE", "default");
  if (!MODES.includes(mode as Mode)) {
    throw new PlanError([`MODE must be one of ${MODES.join(", ")}; got '${mode}'`]);
  }
  const filesConfig = requireEnv("FILES_CONFIG");
  const moduleData = loadModuleData(readFilesConfig(filesConfig), filesConfig);
  const root = process.cwd();
  const input: PlanInput = {
    registration: readRegistration(root),
    ...moduleData,
    reservedLabels: readReservedLabels(requireEnv("RESERVED_LABELS_FILE")),
    private:
      mode === "site" ? false : resolvePrivate(env("PRIVATE"), requireEnv("GITHUB_REPOSITORY")),
  };
  const plan = mode === "site" ? planSite(input) : planCi(input);
  const text = outputLines(outputsOf(plan));
  appendFileSync(requireEnv("GITHUB_OUTPUT"), text);
  writeSync(1, text);
  return 0;
}

/** GITHUB_OUTPUT rows: `name=value` for a one-line value, the delimited
 *  form for a value spanning lines, under a random delimiter the value
 *  cannot contain. */
export function outputLines(outputs: Record<string, string>): string {
  return Object.entries(outputs)
    .map(([name, value]) => {
      if (!/[\r\n]/.test(value)) return `${name}=${value}\n`;
      const delimiter = `ghadelimiter_${randomBytes(16).toString("hex")}`;
      return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
    })
    .join("");
}

if (import.meta.main) {
  try {
    process.exit(main());
  } catch (err) {
    if (!(err instanceof PlanError)) throw err;
    for (const problem of err.problems) error(problem);
    process.exit(1);
  }
}
