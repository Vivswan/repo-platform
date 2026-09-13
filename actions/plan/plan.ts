// Every managed ci.yml is byte-identical; what differs per repository is computed here and handed to the jobs as step outputs. Fail closed: nothing here defaults an invalid registration into a green run.

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { DocsConfig, SiteConfigJson } from "../pages-site/.vitepress/conventions.ts";
import {
  capture,
  env,
  error,
  failureDetail,
  requireEnv,
  succeeded,
} from "../shared/action_runtime.ts";
import { REGISTRATION_PATH } from "../shared/platform.ts";
import {
  type FileEntry,
  type FilesConfig,
  FilesConfigError,
  type ModuleData,
  parseFilesConfig,
  type RetiredEntry,
} from "./files_config.ts";
import { describeMirrorProblem, mirrorDeclarationProblems, ownedPaths } from "./mirrors.ts";
import { LABEL_RE, parseRegistration, type Registration } from "./registration.ts";
import { type LayerSources, reservedLabelNames } from "./reserved_labels.ts";

export const MODES = ["default", "site"] as const;
export type Mode = (typeof MODES)[number];

export class PlanError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("\n"));
  }
}

export type Module = ModuleData & { name: string };

export interface PlanDefaults {
  /** The URL segment the docs mount under beside a website. */
  docsPath: string;
}

export interface FilesData {
  /** Every module in files.yml order, which is the canonical module order. */
  modules: Module[];
  defaults: PlanDefaults;
  /** The file entries and retirements, for the paths a mirror may name. */
  files: FileEntry[];
  retired: RetiredEntry[];
  layers: LayerSources;
}

export interface DefaultSource {
  module: string;
  key: string;
  pick: (data: ModuleData) => string | undefined;
}

/** The module and key must be there, or the delivery commit is broken and no repository plans. */
export const REQUIRED_DEFAULTS: Readonly<Record<keyof PlanDefaults, DefaultSource>> = {
  docsPath: { module: "site", key: "path", pick: (d) => d.path },
};

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
    docsPath: required(REQUIRED_DEFAULTS.docsPath),
  };
  if (missing.length > 0) throw new PlanError(missing);
  return {
    modules: Object.entries(modules).map(([name, data]) => ({ ...data, name })),
    defaults,
    files: config.files,
    retired: config.retired,
    layers: { modules: config.modules, settings: config.settings },
  };
}

export interface PlanInput {
  registration: Registration;
  modules: Module[];
  defaults: PlanDefaults;
  files: FileEntry[];
  retired: RetiredEntry[];
  /** Lowercased: the settings layers' label names. */
  reservedLabels: ReadonlySet<string>;
  private: boolean;
}

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

/** A `labels` key naming no selected stream fails: it would silently label nothing. */
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
  codeqlLanguages: string[];
  trackingLabels: string[];
  weekly: boolean;
}

/** Whether a scheduled run is the week's CodeQL rescan: the skeleton's
 *  schedule fires nightly, and CodeQL reruns on Mondays (UTC) only. */
export function weekly(now: Date): boolean {
  return now.getUTCDay() === 1;
}

/** The fleet-wide nightly security stream (docs/security-scans.md): fleet-nightly.yml files every repository's Trivy findings under it, so it joins the tracking labels without a module, and the settings baseline declares it on every repository. */
export const SECURITY_LABEL = "security-nightly";

/** Personal-account code scanning is public-only, so a private repository gets no CodeQL. */
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
    codeqlLanguages: codeqlLanguages(selected, input.private),
    trackingLabels: [...trackingLabels(input, selected), SECURITY_LABEL],
    weekly: weekly(now),
  };
}

/** The site configuration the pages-site action consumes (docs/site.md):
 *  the website itself is the repo-owned hook's, so nothing about it is
 *  planned here. */
export interface SitePlan {
  siteTitle: string;
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
    siteTitle: input.registration.project.name,
    docs:
      site?.path === null
        ? null
        : { path: site?.path ?? input.defaults.docsPath, include: site?.include ?? [] },
    linkRotLabel: labels[streams.indexOf("site")],
  };
}

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
    "codeql-languages": JSON.stringify(plan.codeqlLanguages),
    "tracking-labels": plan.trackingLabels.join(","),
    "weekly": String(plan.weekly),
  };
}

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

/** The API fallback keeps an empty input from reading as public. */
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
    reservedLabels: reservedLabelNames(moduleData.layers, requireEnv("FILES_TREE")),
    private:
      mode === "site" ? false : resolvePrivate(env("PRIVATE"), requireEnv("GITHUB_REPOSITORY")),
  };
  const plan = mode === "site" ? planSite(input) : planCi(input);
  const text = outputLines(outputsOf(plan));
  appendFileSync(requireEnv("GITHUB_OUTPUT"), text);
  writeSync(1, text);
  return 0;
}

/** The delimiter is random, so no value can be authored to end the output early. */
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
