// The fleet's plan: resolves one managed repository's CI configuration at
// run time from the repository's registration (.repo-platform.yml, with
// the recorded copier answers as the fallback for values it does not
// carry) and the template's module data shipped beside this action on the
// build branch. Every managed ci.yml is byte-identical; what differs per
// repository is computed here and handed to the jobs as step outputs.
//
// Two modes. `default` resolves what fleet-ci.yml's jobs key on: the
// selection in canonical order, the visibility, the skills directory, the
// CodeQL languages, the tracking labels, and whether a scheduled run is
// the week's CodeQL rescan. `pages` resolves the deploy
// configuration reusable-pages.yml consumes (mounts, toolchain, commands,
// output directory, site title, link-rot label), from the registration or,
// for a caller passing `mounts`, from its own inputs (below). Fail closed:
// an unknown module, an unknown key, a malformed value, or a missing
// registration fails the step - nothing here ever defaults an invalid
// registration into a green run.
//
// Env: MODE (default|pages), PRIVATE ("true"/"false"; empty asks the API
// for GITHUB_REPOSITORY with GH_TOKEN), MODULES_DIR and COPIER_FILE (the
// build branch's modules/<name>.yml copies and its copier.yml, whose module
// choices are the vocabulary and its order), RESERVED_LABELS_FILE (the
// labels the template manages, which no tracking stream may reuse), and
// GITHUB_OUTPUT. A non-empty CALLER_MOUNTS (pages mode) is the caller-
// configured deploy: the CALLER_* values are published unchanged after the
// setup grammar check, the registration unread. Runs in the caller's checkout.

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  capture,
  env,
  error,
  failureDetail,
  requireEnv,
  succeeded,
} from "../shared/action_runtime.ts";
import {
  LABEL_RE,
  parseRegistration,
  REGISTRATION_PATH,
  type Registration,
  readModuleOrder,
} from "./registration.ts";

export const ANSWERS_PATH = ".github/.copier-answers.yml";
export const MODES = ["default", "pages"] as const;
export type Mode = (typeof MODES)[number];

/** The docs tree a vitepress mount renders: the shared deploy's fixed
 *  default, which no caller overrides (docs_site_path names the URL mount,
 *  not the tree). */
export const DOCS_DIR = "docs";
export const SETUP_NONE = "none";

export class PlanError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("\n"));
  }
}

// The manifest slice the plan reads; the rest of a manifest is the
// composer's business, so unknown keys pass here.
const moduleDataSchema = z.looseObject({
  toolchain: z.looseObject({ codeql_language: z.string().min(1) }).optional(),
  tracking_label: z
    .looseObject({ answer: z.string().regex(/^[a-z][a-z0-9_]*$/), default: z.string().min(1) })
    .optional(),
  pages: z.looseObject({ install: z.string(), build: z.string().min(1) }).optional(),
});

export interface TrackingStream {
  /** The copier answer recording the label. */
  answer: string;
  /** The registration's `labels` key: the answer without its `_label` suffix. */
  key: string;
  default: string;
}

export interface ModuleData {
  name: string;
  codeqlLanguage?: string;
  trackingLabel?: TrackingStream;
  pages?: { install: string; build: string };
}

/** Every module's data in canonical order: the vocabulary and order come
 *  from copier.yml's module choices, the data from modules/<name>.yml. A
 *  choice without a data file or a data file without a choice is an error:
 *  the two ship together and disagreeing means a broken build tree. */
export function loadModuleData(modulesDir: string, copierText: string): ModuleData[] {
  const order = readModuleOrder(parseYaml(copierText, { logLevel: "error" }));
  if (order.choices === null) throw new PlanError(order.errors);
  const files = new Set(readdirSync(modulesDir).filter((name) => name.endsWith(".yml")));
  const modules: ModuleData[] = [];
  for (const name of order.choices) {
    const file = `${name}.yml`;
    if (!files.delete(file)) {
      throw new PlanError([`${modulesDir}/${file}: missing - copier.yml offers the module`]);
    }
    const parsed = moduleDataSchema.safeParse(
      parseYaml(readFileSync(join(modulesDir, file), "utf-8"), { logLevel: "error" }) ?? {},
    );
    if (!parsed.success) {
      throw new PlanError(
        parsed.error.issues.map(
          (issue) => `${modulesDir}/${file}: ${issue.path.join(".")}: ${issue.message}`,
        ),
      );
    }
    const data = parsed.data;
    modules.push({
      name,
      ...(data.toolchain ? { codeqlLanguage: data.toolchain.codeql_language } : {}),
      ...(data.tracking_label
        ? {
            trackingLabel: {
              answer: data.tracking_label.answer,
              key: data.tracking_label.answer.replace(/_label$/, ""),
              default: data.tracking_label.default,
            },
          }
        : {}),
      ...(data.pages ? { pages: data.pages } : {}),
    });
  }
  if (files.size > 0) {
    throw new PlanError(
      [...files].sort().map((file) => `${modulesDir}/${file}: not a module copier.yml offers`),
    );
  }
  return modules;
}

export interface PlanInput {
  registration: Registration;
  /** The recorded copier answers; empty when the file is absent. */
  answers: Record<string, unknown>;
  modules: ModuleData[];
  /** Lowercased names of the labels the template manages (the settings
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
export function selectModules(input: PlanInput): ModuleData[] {
  const known = new Map(input.modules.map((module) => [module.name, module]));
  const unknown = input.registration.modules.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new PlanError(
      unknown.map(
        (name) =>
          `${REGISTRATION_PATH}: module "${name}" is not a module this template offers ` +
          `(known: ${[...known.keys()].join(", ")})`,
      ),
    );
  }
  const selected = new Set(input.registration.modules);
  return input.modules.filter((module) => selected.has(module.name));
}

/** A recorded answer as a string; a present non-string answer fails (a
 *  blank `key:` is null, not absent, and must not read as the default). */
function answer(answers: Record<string, unknown>, key: string): string | undefined {
  const value = answers[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new PlanError([`${ANSWERS_PATH}: ${key} must be a string`]);
  }
  return value;
}

/** One value with two possible sources: the registration's `where` and the
 *  recorded answer. Both present and different fails: the settings roster
 *  and today's rendered workflows still read the answer, so a registration
 *  value that disagrees would split the repository's identity between
 *  them. Otherwise whichever exists, else the fallback. */
function resolved(
  input: PlanInput,
  where: string,
  declared: string | undefined,
  answerKey: string,
  fallback: string | undefined,
): string | undefined {
  const recorded = answer(input.answers, answerKey);
  if (declared !== undefined && recorded !== undefined && declared !== recorded) {
    throw new PlanError([
      `${REGISTRATION_PATH}: ${where} is ${JSON.stringify(declared)} but ${ANSWERS_PATH} records ` +
        `${answerKey}: ${JSON.stringify(recorded)}; the two must agree while both exist`,
    ]);
  }
  return declared ?? recorded ?? fallback;
}

/** Each selected tracking stream's label, in canonical order: the
 *  registration's `labels.<key>`, else the recorded answer, else the
 *  module's default. A `labels` key naming no selected stream fails: it
 *  would silently label nothing. */
export function trackingLabels(input: PlanInput, selected: ModuleData[]): string[] {
  const streams = selected.flatMap((module) =>
    module.trackingLabel ? [module.trackingLabel] : [],
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
  const labels = streams.map(
    (stream) =>
      resolved(
        input,
        `labels.${stream.key}`,
        declared[stream.key],
        stream.answer,
        stream.default,
      ) ?? stream.default,
  );
  for (const [index, value] of labels.entries()) {
    if (!LABEL_RE.test(value)) {
      throw new PlanError([
        `${ANSWERS_PATH}: ${streams[index].answer} is not a plain label: ${value}`,
      ]);
    }
    if (input.reservedLabels.has(value.toLowerCase())) {
      throw new PlanError([
        `tracking label "${value}" (${streams[index].key}) is a label the template already manages; ` +
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

/** CodeQL is off for a private repository (personal-account code scanning
 *  is public-only) and where no selected module analyzes as a language;
 *  otherwise the distinct languages in canonical order. */
export function codeqlLanguages(selected: ModuleData[], isPrivate: boolean): string[] {
  if (isPrivate) return [];
  return [...new Set(selected.flatMap((m) => (m.codeqlLanguage ? [m.codeqlLanguage] : [])))];
}

export function planCi(input: PlanInput, now: Date = new Date()): CiPlan {
  const selected = selectModules(input);
  return {
    modules: selected.map((module) => module.name),
    private: input.private,
    skillsDir:
      resolved(input, "skills.dir", input.registration.skills?.dir, "skills_dir", "skills") ??
      "skills",
    codeqlLanguages: codeqlLanguages(selected, input.private),
    trackingLabels: trackingLabels(input, selected),
    weekly: weekly(now),
  };
}

export interface Mount {
  path: string;
  source: "command" | "vitepress";
  versioned: boolean;
  /** Extra source roots a vitepress mount renders (the registration's
   *  docs_site.include, verbatim); absent when none are declared. */
  include?: { path: string; mount: string; page?: string }[];
}

export interface PagesPlan {
  mounts: Mount[];
  setup: string;
  installCommand: string;
  buildCommand: string;
  distDir: string;
  siteTitle: string;
  docsDir: string;
  linkRotLabel: string;
}

/** Why `setup` is not a comma-separated list of distinct toolchain tokens
 *  (or exactly `none`), or null. */
export function setupProblem(setup: string, tokens: readonly string[]): string | null {
  if (!/^[a-z]+(,[a-z]+)*$/.test(setup)) {
    return `invalid setup value '${setup}': it must be a comma-separated list of ${tokens.join("/")}, or ${SETUP_NONE} (no spaces or empty tokens)`;
  }
  const parts = setup.split(",");
  for (const part of parts) {
    if (part !== SETUP_NONE && !tokens.includes(part)) {
      return `invalid setup token '${part}': each token must be ${tokens.join(", ")}, or ${SETUP_NONE}`;
    }
  }
  const duplicate = parts.find((part, index) => parts.indexOf(part) !== index);
  if (duplicate !== undefined) return `duplicate setup token '${duplicate}'`;
  if (parts.includes(SETUP_NONE) && parts.length > 1) {
    return `setup '${SETUP_NONE}' cannot be combined with toolchain tokens`;
  }
  return null;
}

/** The pages defaults copier.yml derives: every selected toolchain module
 *  (one carrying pages data) joined by commas or `none`, and the commands
 *  of the first module in canonical order whose token `setup` names - among
 *  ALL modules, since setup may name a toolchain the selection does not. */
export function defaultSetup(selected: ModuleData[]): string {
  return (
    selected
      .filter((m) => m.pages !== undefined)
      .map((m) => m.name)
      .join(",") || SETUP_NONE
  );
}

export function defaultCommands(
  modules: ModuleData[],
  setup: string,
): { install: string; build: string } {
  const tokens = new Set(setup.split(","));
  const first = modules.find((module) => module.pages !== undefined && tokens.has(module.name));
  return { install: first?.pages?.install ?? "", build: first?.pages?.build ?? "" };
}

export function planPages(input: PlanInput): PagesPlan {
  const selected = selectModules(input);
  const names = new Set(selected.map((module) => module.name));
  const pages = names.has("pages");
  const docsSite = names.has("docs-site");
  if (!pages && !docsSite) {
    throw new PlanError([
      `${REGISTRATION_PATH}: neither pages nor docs-site is selected - there is no site to deploy`,
    ]);
  }
  const tokens = input.modules.filter((m) => m.pages !== undefined).map((m) => m.name);
  const docsPath =
    resolved(
      input,
      "docs_site.path",
      input.registration.docs_site?.path,
      "docs_site_path",
      "docs",
    ) ?? "docs";
  const include = input.registration.docs_site?.include;
  const docsMount = (path: string): Mount => ({
    path,
    source: "vitepress",
    versioned: true,
    ...(include ? { include } : {}),
  });
  const mounts: Mount[] = pages
    ? docsSite
      ? [{ path: "/", source: "command", versioned: false }, docsMount(`/${docsPath}/`)]
      : [{ path: "/", source: "command", versioned: true }]
    : [docsMount("/")];
  let setup = SETUP_NONE;
  let installCommand = "";
  let buildCommand = "";
  let distDir = "dist";
  if (pages) {
    const declared = input.registration.pages ?? {};
    setup =
      resolved(input, "pages.setup", declared.setup, "pages_setup", defaultSetup(selected)) ??
      defaultSetup(selected);
    const problem = setupProblem(setup, tokens);
    if (problem !== null) throw new PlanError([`${REGISTRATION_PATH}: ${problem}`]);
    const defaults = defaultCommands(input.modules, setup);
    installCommand =
      resolved(
        input,
        "pages.install",
        declared.install,
        "pages_install_command",
        defaults.install,
      ) ?? defaults.install;
    buildCommand =
      resolved(input, "pages.build", declared.build, "pages_build_command", defaults.build) ??
      defaults.build;
    if (buildCommand === "") {
      throw new PlanError([
        `${REGISTRATION_PATH}: the pages module needs a build command (pages.build, or the recorded pages_build_command)`,
      ]);
    }
    distDir = resolved(input, "pages.dist", declared.dist, "pages_dist_dir", "dist") ?? "dist";
  }
  let siteTitle = "";
  let linkRotLabel = "";
  if (docsSite) {
    // Empty stays empty: pages-site then titles the site by repository name.
    siteTitle =
      resolved(input, "project.name", input.registration.project?.name, "project_name", "") ?? "";
    const labels = trackingLabels(input, selected);
    const streams = selected.flatMap((m) => (m.trackingLabel ? [m.name] : []));
    linkRotLabel = labels[streams.indexOf("docs-site")];
  }
  return {
    mounts,
    setup,
    installCommand,
    buildCommand,
    distDir,
    siteTitle,
    docsDir: DOCS_DIR,
    linkRotLabel,
  };
}

/** A deploy the caller configured through the workflow inputs: published
 *  unchanged, the setup grammar checked the way a planned one is. */
export interface CallerPages {
  mounts: string;
  setup: string;
  installCommand: string;
  buildCommand: string;
  distDir: string;
  siteTitle: string;
  docsDir: string;
  linkRotLabel: string;
}

export function callerConfiguredPages(caller: CallerPages, modules: ModuleData[]): CallerPages {
  const tokens = modules.filter((m) => m.pages !== undefined).map((m) => m.name);
  const problem = setupProblem(caller.setup, tokens);
  if (problem !== null) throw new PlanError([`setup input: ${problem}`]);
  return caller;
}

/** The step outputs of a plan, by output name (mounts as compact JSON). */
export function outputsOf(plan: CiPlan | PagesPlan | CallerPages): Record<string, string> {
  if ("mounts" in plan) {
    return {
      mounts: typeof plan.mounts === "string" ? plan.mounts : JSON.stringify(plan.mounts),
      setup: plan.setup,
      install_command: plan.installCommand,
      build_command: plan.buildCommand,
      dist_dir: plan.distDir,
      site_title: plan.siteTitle,
      docs_dir: plan.docsDir,
      link_rot_label: plan.linkRotLabel,
    };
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

/** The recorded answers at root, a mapping or absent; anything else fails. */
export function readAnswers(root: string): Record<string, unknown> {
  const path = join(root, ANSWERS_PATH);
  if (!existsSync(path)) return {};
  const data: unknown = parseYaml(readFileSync(path, "utf-8"), { logLevel: "error" });
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new PlanError([`${ANSWERS_PATH}: must be a YAML mapping`]);
  }
  return data as Record<string, unknown>;
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
  const modules = loadModuleData(
    requireEnv("MODULES_DIR"),
    readFileSync(requireEnv("COPIER_FILE"), "utf-8"),
  );
  const callerMounts = env("CALLER_MOUNTS");
  if (mode === "pages" && callerMounts !== "") {
    const text = outputLines(
      outputsOf(
        callerConfiguredPages(
          {
            mounts: callerMounts,
            setup: env("CALLER_SETUP"),
            installCommand: env("CALLER_INSTALL_COMMAND"),
            buildCommand: env("CALLER_BUILD_COMMAND"),
            distDir: env("CALLER_DIST_DIR"),
            siteTitle: env("CALLER_SITE_TITLE"),
            docsDir: env("CALLER_DOCS_DIR"),
            linkRotLabel: env("CALLER_LINK_ROT_LABEL"),
          },
          modules,
        ),
      ),
    );
    appendFileSync(requireEnv("GITHUB_OUTPUT"), text);
    writeSync(1, text);
    return 0;
  }
  const root = process.cwd();
  const input: PlanInput = {
    registration: readRegistration(root),
    answers: readAnswers(root),
    modules,
    reservedLabels: readReservedLabels(requireEnv("RESERVED_LABELS_FILE")),
    private:
      mode === "pages" ? false : resolvePrivate(env("PRIVATE"), requireEnv("GITHUB_REPOSITORY")),
  };
  const plan = mode === "pages" ? planPages(input) : planCi(input);
  const text = outputLines(outputsOf(plan));
  appendFileSync(requireEnv("GITHUB_OUTPUT"), text);
  writeSync(1, text);
  return 0;
}

/** GITHUB_OUTPUT rows: `name=value` for a one-line value, the delimited
 *  form for a value spanning lines (a multi-line build command is valid),
 *  under a random delimiter the value cannot contain. */
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
