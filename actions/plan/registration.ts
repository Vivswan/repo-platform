// The registration file's grammar (.repo-platform.yml), shared by every
// reader: the module list the fleet plans and the sync select on (checked
// against files.yml's modules by the reader that has it), and the strict
// full document the plan action resolves a repository's CI from. It lives
// inside the plan action because it needs yaml and zod, which the
// dependency-free actions/shared zone cannot carry; the sync imports it by
// relative path.

import { parse } from "yaml";
import { z } from "zod";
import {
  includeListProblem,
  includeMountProblem,
  includePageProblem,
  relPathProblem,
  urlSegmentProblem,
} from "../pages-site/.vitepress/conventions.ts";

export const REGISTRATION_PATH = ".repo-platform.yml";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A nested list or mapping is named by shape: JSON.stringify throws on the
// cycle a YAML alias can build, which would turn a bad entry into a crash.
function describeEntry(entry: unknown): string {
  if (Array.isArray(entry)) return "(a list)";
  if (typeof entry === "object" && entry !== null) return "(a mapping)";
  return JSON.stringify(entry) ?? String(entry);
}

/** The top-level `modules` list of parsed registration data: every entry a
 *  distinct non-empty name, or the errors. An absent key is an error (an
 *  empty selection would strip every module from the repo). */
export function readModules(
  data: unknown,
  label = REGISTRATION_PATH,
): { modules: string[] | null; errors: string[] } {
  if (!isPlainObject(data)) {
    return { modules: null, errors: [`${label}: top level must be a mapping`] };
  }
  const raw: unknown = data.modules;
  const key = "modules";
  if (raw === undefined) {
    return {
      modules: null,
      errors: [
        `${label}: no module selection found - add a top-level ` +
          `\`modules: [...]\` list (the sync never assumes an empty selection, ` +
          `which would strip every module from the repo)`,
      ],
    };
  }
  if (!Array.isArray(raw)) {
    return { modules: null, errors: [`${label}: ${key} must be a list of module names`] };
  }
  const errors: string[] = [];
  const seen = new Set<string>();
  const modules: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry === "") {
      errors.push(`${label}: ${key} entry ${describeEntry(entry)} is not a module name`);
      continue;
    }
    if (seen.has(entry)) {
      errors.push(`${label}: duplicate ${key} entry "${entry}"`);
      continue;
    }
    seen.add(entry);
    modules.push(entry);
  }
  if (errors.length > 0) {
    return { modules: null, errors };
  }
  return { modules, errors: [] };
}

/** The module names a registration TEXT declares; null when the document
 *  or its top-level modules list is unreadable. logLevel error: the
 *  parser's default level prints warned-on source lines (target content)
 *  to stderr, which the fleet plans' public logs must never carry. */
export function declaredModules(registrationText: string): string[] | null {
  let data: unknown;
  try {
    data = parse(registrationText, { logLevel: "error" });
  } catch {
    return null;
  }
  return readModules(data).modules;
}

// The shape constraints every value the writer substitutes must meet.
const slug = z
  .string()
  .regex(
    /^[a-z0-9]+(-[a-z0-9]+)*$/,
    "must be kebab-case (lowercase letters and digits, dash-separated)",
  );
/** A string the site's rules judge (conventions.ts): the problem they
 *  name is the issue's message. */
const judged = (problem: (value: string) => string | null) =>
  z.string().superRefine((value, ctx) => {
    const message = problem(value);
    if (message !== null) ctx.addIssue({ code: "custom", message });
  });
const urlSegment = judged(urlSegmentProblem);
const relativePath = judged(relPathProblem);
// The sync substitutes these into quoted YAML scalars verbatim, so a quote,
// a backslash, or a control character would change the document it lands in.
const plainText = (what: string) =>
  z.string().refine((value) => !/["\\\p{Cc}]/u.test(value), {
    message: `${what} must not contain double quotes, backslashes, or control characters`,
  });
/** The label shape the fuzz-issue action enforces. */
export const LABEL_RE = /^[A-Za-z0-9._][A-Za-z0-9._: -]{0,49}$/;
const label = z
  .string()
  .regex(
    LABEL_RE,
    "must be a plain label: letters, digits, ._:- and spaces, not starting with a dash, at most 50 characters",
  );

/** The full registration document. Module names and `labels` keys are
 *  checked against files.yml's module data by the reader that has it (the
 *  plan action); the schema pins the shapes. */
export const registrationSchema = z.strictObject({
  modules: z.array(z.unknown()),
  project: z
    .strictObject({
      name: plainText("project.name").pipe(z.string().min(1)),
      slug,
      description: plainText("project.description"),
      copyright_holder: plainText("project.copyright_holder").pipe(z.string().min(1)).optional(),
    })
    .optional(),
  site: z
    .strictObject({
      path: urlSegment.optional(),
      include: z
        .array(
          z.strictObject({
            path: relativePath,
            mount: judged(includeMountProblem),
            page: judged(includePageProblem),
          }),
        )
        .superRefine((roots, ctx) => {
          const message = includeListProblem(roots);
          if (message !== null) ctx.addIssue({ code: "custom", message });
        })
        .optional(),
    })
    .optional(),
  skills: z.strictObject({ dir: relativePath.optional() }).optional(),
  labels: z.record(z.string(), label).optional(),
  mirrors: z
    .array(
      z.strictObject({
        source: z.string().min(1),
        targets: z.array(z.string().min(1)).min(1),
      }),
    )
    .optional(),
});

export type Registration = Omit<z.infer<typeof registrationSchema>, "modules"> & {
  modules: string[];
};

export type RegistrationRead = { registration: Registration } | { errors: string[] };

/** The registration keys the `site` module replaced, each with where its
 *  content went: a strict schema would report them as unrecognized, which
 *  says nothing about the move. */
const RETIRED_KEYS: Record<string, string> = {
  pages:
    "the website build lives in the repo-owned hook .github/actions/site-build/action.yml " +
    "and the module is `site` (docs/site.md)",
  docs_site:
    "it is `site` now (`site.path`, `site.include`; the label key is `labels.site`), and a " +
    "website build belongs in the repo-owned hook .github/actions/site-build/action.yml",
};

function retiredKeyErrors(data: Record<string, unknown>, label: string): string[] {
  return Object.entries(RETIRED_KEYS)
    .filter(([key]) => key in data)
    .map(([key, where]) => `${label}: ${key}: is no longer a registration key - ${where}`);
}

/** The registration a TEXT declares, fail-closed: a YAML error, a non-mapping
 *  document, an unknown key, a wrong type, or a malformed module list are all
 *  errors naming the file. */
export function parseRegistration(text: string, label = REGISTRATION_PATH): RegistrationRead {
  let data: unknown;
  try {
    data = parse(text, { logLevel: "error" });
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return { errors: [`${label}: YAML parse error: ${detail}`] };
  }
  const modules = readModules(data, label);
  if (modules.modules === null) return { errors: modules.errors };
  const moved = retiredKeyErrors(data as Record<string, unknown>, label);
  if (moved.length > 0) return { errors: moved };
  const result = registrationSchema.safeParse(data);
  if (!result.success) {
    return {
      errors: result.error.issues.map(
        (issue) => `${label}: ${issue.path.join(".") || "(top level)"}: ${issue.message}`,
      ),
    };
  }
  return { registration: { ...result.data, modules: modules.modules } };
}
