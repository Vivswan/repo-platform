#!/usr/bin/env bun
// Renders the template twins this repository dogfoods and writes this
// repo's own copies, so each generated file has exactly one author: the
// template. The copies carry the template's comments verbatim; the pairs
// generation cannot own (the prefix files with repo-specific tails,
// release.yml with its recorded divergence) stay compared by
// check_ssot's dogfood-parity rule instead.
//
// Answers come from .repo-platform-answers.yml, this repository's own
// copier answers; every value is cross-checked against its authoritative
// source (package.json, copier.yml defaults, the central settings file).
// One render context is built from the answers - private, has_toolchain
// and enable_codeql exactly as copier.yml computes them, plus a membership
// key per module - and every pair renders against it; a condition the
// context cannot resolve fails the render (see renderJinjaFile).
//
// Usage:
//   bun scripts/render_dogfood.ts           # rewrite every generated copy
//   bun scripts/render_dogfood.ts --check   # exit 1 listing stale copies

import { lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { type JinjaVars, renderJinjaFile, resolveCondition } from "./jinja_subset.ts";
import { loadManifests, type ModuleManifest } from "./module_manifests.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** This repository's own copier answers file; check_ssot.ts and
 *  verify_dogfood_oracle.ts read the same name. */
export const ANSWERS_FILE = ".repo-platform-answers.yml";

// The generated pairs: repo copy <- template twin. A template under
// templates/<module>/ renders only while the answers select that module
// (moduleOfPair), and a filename gate in the template's own name
// (gateOfPair) decides whether the repo copy may exist at all.
export const PAIRS: { repo: string; tpl: string }[] = [
  { repo: ".editorconfig", tpl: "templates/base/.editorconfig.jinja" },
  {
    repo: "release-please-config.json",
    tpl: "templates/release-please/release-please-config.json.jinja",
  },
  {
    repo: "CODE_OF_CONDUCT.md",
    tpl: "templates/base/{% if not private %}CODE_OF_CONDUCT.md{% endif %}.jinja",
  },
  { repo: ".github/CODEOWNERS", tpl: "templates/base/.github/CODEOWNERS.jinja" },
  {
    repo: ".github/workflows/auto-assign.yml",
    tpl: "templates/auto-assign/.github/workflows/auto-assign.yml.jinja",
  },
  {
    repo: ".github/workflows/dependabot-bun-lockfile.yml",
    tpl: "templates/bun/.github/workflows/dependabot-bun-lockfile.yml.jinja",
  },
  {
    repo: ".github/workflows/validate-skills.yml",
    tpl: "templates/skills/.github/workflows/validate-skills.yml.jinja",
  },
  { repo: ".bun-version", tpl: "templates/bun/.bun-version" },
];

const answersSchema = z.strictObject({
  project_name: z.string().min(1),
  project_slug: z.string().min(1),
  description: z.string().min(1),
  github_username: z.string().min(1),
  copyright_holder: z.string().min(1),
  private: z.boolean(),
  modules: z
    .array(z.string().min(1))
    .min(1)
    .refine((modules) => new Set(modules).size === modules.length, {
      message: "modules must be unique",
    })
    .transform((modules): ReadonlySet<string> => new Set(modules)),
  // Asked by copier only while the skills module is selected;
  // answerMismatches enforces the same presence rule here. The shape
  // mirrors copier.yml's skills_dir validator (plain relative segments,
  // no . or ..), so a value copier would reject cannot render here.
  skills_dir: z
    .string()
    .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/, {
      message:
        "must be relative path segments of letters, digits, dots, underscores, " +
        "or dashes joined by single slashes (copier.yml's skills_dir validator)",
    })
    .refine((value) => !value.split("/").some((part) => part === "." || part === ".."), {
      message: "must not contain . or .. segments (copier.yml's skills_dir validator)",
    })
    .optional(),
});

export type Answers = z.infer<typeof answersSchema>;

/** Parse the answers file's YAML text; `where` names the file in errors. */
export function parseAnswers(text: string, where: string): Answers {
  const result = answersSchema.safeParse(parseYaml(text));
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(top level)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`${where}: ${details}`);
  }
  return result.data;
}

/** copier.yml's computed has_toolchain from the same inputs: at least one
 *  selected module whose manifest declares a toolchain. */
export function hasToolchain(answers: Answers, manifests: ModuleManifest[]): boolean {
  return manifests.some((m) => m.toolchain !== undefined && answers.modules.has(m.module));
}

/** copier.yml's computed enable_codeql: a public repository with a
 *  toolchain. */
export function enableCodeql(answers: Answers, manifests: ModuleManifest[]): boolean {
  return !answers.private && hasToolchain(answers, manifests);
}

/** lstat-based existence: a dangling symlink still counts as present here
 *  (existsSync follows the link and reports false, so a false-gated copy
 *  left behind as a dangling symlink would slip past the absence check). */
export function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
}

/** The one render context every pair renders against: the computed copier
 *  variables plus a positive and a negated membership key per module (both
 *  `'x' in modules` and `'x' not in modules` gate template content), so
 *  any condition a template carries resolves (or the render fails naming
 *  it). */
export function renderContext(
  answers: Answers,
  manifests: ModuleManifest[],
): Record<string, boolean> {
  const context: Record<string, boolean> = {
    private: answers.private,
    has_toolchain: hasToolchain(answers, manifests),
    enable_codeql: enableCodeql(answers, manifests),
  };
  for (const manifest of manifests) {
    const selected = answers.modules.has(manifest.module);
    context[`'${manifest.module}' in modules`] = selected;
    context[`'${manifest.module}' not in modules`] = !selected;
  }
  return context;
}

/** The module a pair's template belongs to, or null for templates/base/
 *  (unconditional). */
export function moduleOfPair(tpl: string): string | null {
  const match = /^templates\/([^/]+)\//.exec(tpl);
  if (!match) throw new Error(`pair template ${tpl} is not under templates/`);
  return match[1] === "base" ? null : match[1];
}

export type FilenameGate = { kind: "always" } | { kind: "when"; condition: string };

/** The filename gate carried in a template's own name: copier renders
 *  `{% if <cond> %}NAME{% endif %}.jinja` only while the condition holds,
 *  so a false condition means this repo's copy must be ABSENT. */
export function gateOfPair(tpl: string): FilenameGate {
  const name = tpl.split("/").pop() ?? "";
  const match = /^\{% if (.+?) %\}[^{}]+\{% endif %\}(\.jinja)?$/.exec(name);
  return match ? { kind: "when", condition: match[1] } : { kind: "always" };
}

/** Whether a pair's repo copy should exist under this context; an
 *  unresolvable gate condition fails loudly. */
export function pairIsRendered(tpl: string, context: Record<string, boolean>): boolean {
  const gate = gateOfPair(tpl);
  if (gate.kind === "always") return true;
  const value = resolveCondition(gate.condition, context);
  if (value === null) {
    throw new Error(
      `${tpl}: the filename gate condition '${gate.condition}' does not resolve ` +
        "in the render context",
    );
  }
  return value;
}

/** The authoritative sources each answer must match. */
export interface AnswerSources {
  packageName: string;
  usernameDefault: string;
  copyrightDefault: string;
  skillsDirDefault: string;
  centralDescription: string;
  centralPrivate: boolean;
  moduleNames: Set<string>;
}

/** Every answer is cross-checked against the source that owns it, so this
 *  file can never silently disagree with what check_ssot's jinjaVars reads
 *  for the remaining dogfood-parity pairs, with the central settings, or
 *  with the module roster. */
export function answerMismatches(answers: Answers, sources: AnswerSources): string[] {
  const problems: string[] = [];
  const expect = (key: string, expected: string | boolean, got: string | boolean, src: string) => {
    if (expected !== got) {
      problems.push(
        `${key}: expected ${JSON.stringify(expected)} (${src}), got ${JSON.stringify(got)}`,
      );
    }
  };
  expect("project_slug", sources.packageName, answers.project_slug, "package.json name");
  expect(
    "project_slug",
    answers.project_name.toLowerCase().replaceAll(" ", "-"),
    answers.project_slug,
    "copier.yml's derivation from project_name",
  );
  expect(
    "github_username",
    sources.usernameDefault,
    answers.github_username,
    "copier.yml github_username default",
  );
  expect(
    "copyright_holder",
    sources.copyrightDefault,
    answers.copyright_holder,
    "copier.yml copyright_holder default",
  );
  expect(
    "description",
    sources.centralDescription,
    answers.description,
    "settings/repos/repo-platform.yml repository.description",
  );
  expect(
    "private",
    sources.centralPrivate,
    answers.private,
    "settings/repos/repo-platform.yml repository.private",
  );
  for (const module of answers.modules) {
    if (!sources.moduleNames.has(module)) {
      problems.push(`modules: '${module}' has no templates/ module manifest`);
    }
  }
  // Mirror copier.yml's `when` on the skills_dir question: the answer
  // exists exactly while the skills module is selected, and - like the
  // identity answers above - it must match the copier.yml default this
  // repository renders with.
  if (answers.modules.has("skills") && answers.skills_dir === undefined) {
    problems.push(
      "skills_dir: missing - the skills module is selected, so the skills " +
        "pairs need the directory copier.yml asks for",
    );
  }
  if (!answers.modules.has("skills") && answers.skills_dir !== undefined) {
    problems.push(
      "skills_dir: set but the skills module is not selected - copier " +
        "never asks the question then; remove the stale answer",
    );
  }
  if (answers.skills_dir !== undefined) {
    expect(
      "skills_dir",
      sources.skillsDirDefault,
      answers.skills_dir,
      "copier.yml skills_dir default",
    );
  }
  for (const pair of PAIRS) {
    const module = moduleOfPair(pair.tpl);
    if (module !== null && !answers.modules.has(module)) {
      problems.push(
        `modules: the generated pair ${pair.repo} belongs to module '${module}', ` +
          "which the answers do not select",
      );
    }
  }
  return problems;
}

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf-8");
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where}: expected a mapping`);
  }
  return value as Record<string, unknown>;
}

function stringDefault(copier: Record<string, unknown>, question: string): string {
  const value = asRecord(copier[question], `copier.yml ${question}`).default;
  if (typeof value !== "string" || value === "") {
    throw new Error(`copier.yml: ${question} has no string default`);
  }
  return value;
}

function loadSources(manifests: ModuleManifest[]): AnswerSources {
  const copier = asRecord(parseYaml(read("copier.yml")), "copier.yml");
  const pkg = asRecord(JSON.parse(read("package.json")), "package.json");
  const central = asRecord(
    asRecord(parseYaml(read("settings/repos/repo-platform.yml")), "repo-platform.yml").repository,
    "settings/repos/repo-platform.yml repository",
  );
  if (typeof central.description !== "string" || typeof central.private !== "boolean") {
    throw new Error(
      "settings/repos/repo-platform.yml: repository.description/private missing or mistyped",
    );
  }
  return {
    packageName: String(pkg.name),
    usernameDefault: stringDefault(copier, "github_username"),
    copyrightDefault: stringDefault(copier, "copyright_holder"),
    skillsDirDefault: stringDefault(copier, "skills_dir"),
    centralDescription: central.description,
    centralPrivate: central.private,
    moduleNames: new Set(manifests.map((m) => m.module)),
  };
}

function main(): number {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const unknown = args.filter((a) => a !== "--check");
  if (unknown.length > 0) {
    console.error(`error: unrecognized argument(s): ${unknown.join(" ")}`);
    return 2;
  }

  // Compute every rendering before writing anything, so a bad answer or an
  // unhandled template construct never leaves the copies half-updated.
  // next === null means the pair's filename gate is false and the repo copy
  // must not exist.
  let stale: { path: string; repo: string; next: string | null }[];
  try {
    const manifests = loadManifests();
    const answers = parseAnswers(read(ANSWERS_FILE), ANSWERS_FILE);
    const drift = answerMismatches(answers, loadSources(manifests));
    if (drift.length > 0) {
      for (const problem of drift) console.error(`${ANSWERS_FILE}: ${problem}`);
      return 1;
    }
    const vars: JinjaVars = {
      username: answers.github_username,
      slug: answers.project_slug,
      copyrightHolder: answers.copyright_holder,
      skillsDir: answers.skills_dir,
    };
    const context = renderContext(answers, manifests);
    stale = PAIRS.flatMap((pair): { path: string; repo: string; next: string | null }[] => {
      const path = join(REPO_ROOT, pair.repo);
      if (!pairIsRendered(pair.tpl, context)) {
        return pathExists(path) ? [{ path, repo: pair.repo, next: null }] : [];
      }
      const next = renderJinjaFile(read(pair.tpl), vars, context);
      // A missing copy (a pair adopted for the first time) is stale too.
      if (!pathExists(path)) return [{ path, repo: pair.repo, next }];
      return next === read(pair.repo) ? [] : [{ path, repo: pair.repo, next }];
    });
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (check) {
    for (const { path, repo, next } of stale) {
      console.log(
        next === null
          ? `${repo} should be absent (its template's filename gate is false); ` +
              "run bun run dogfood to remove it"
          : pathExists(path)
            ? `${repo} is stale: it does not match its rendered template twin; ` +
              "run bun run dogfood to rewrite it"
            : `${repo} is missing: its template twin renders it; ` +
              "run bun run dogfood to write it",
      );
    }
    if (stale.length > 0) return 1;
    console.log(`generated dogfood copies are up to date (${PAIRS.length} pairs)`);
    return 0;
  }
  for (const { path, repo, next } of stale) {
    if (next === null) {
      unlinkSync(path);
      console.log(`removed ${repo} (its template's filename gate is false)`);
    } else {
      writeFileSync(path, next);
      console.log(`rewrote ${repo} from its template twin`);
    }
  }
  if (stale.length === 0) {
    console.log("generated dogfood copies already match their template twins; nothing to write");
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
