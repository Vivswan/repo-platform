// The registration file's grammar (.repo-platform.yml), shared by every
// reader: the module list the fleet plans and the sync select on, the
// template's module vocabulary it is checked against (copier.yml's
// choices), and the strict full document the plan action resolves a
// repository's CI from. It lives inside the plan action because it needs
// yaml and zod, which the dependency-free actions/shared zone cannot carry;
// the sync imports it by relative path.

import { parse } from "yaml";
import { z } from "zod";

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

/** The module vocabulary of a template ref: copier.yml's `modules` choice
 *  values, in the order the generated block lists them (the canonical
 *  module order). */
export function readModuleOrder(
  data: unknown,
  label = "copier.yml",
): { choices: string[] | null; errors: string[] } {
  if (!isPlainObject(data) || !isPlainObject(data.modules)) {
    return { choices: null, errors: [`${label}: no \`modules\` question found`] };
  }
  const raw = data.modules.choices;
  const values = Array.isArray(raw) ? raw : isPlainObject(raw) ? Object.values(raw) : null;
  if (values === null || !values.every((value) => typeof value === "string" && value !== "")) {
    return {
      choices: null,
      errors: [`${label}: modules.choices must map choice labels to module-name strings`],
    };
  }
  return { choices: values, errors: [] };
}

// The shape constraints copier.yml's validators state for the same
// answers, so a registration value is refused exactly where a recorded
// answer would have been.
const slug = z
  .string()
  .regex(
    /^[a-z0-9]+(-[a-z0-9]+)*$/,
    "must be kebab-case (lowercase letters and digits, dash-separated)",
  );
const urlSegment = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_-]*$/,
    "must be one plain lowercase URL segment (letters, digits, dashes, underscores)",
  );
const relativePath = (what: string) =>
  z.string().refine(
    (value) => {
      const parts = value.split("/");
      return (
        /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(value) &&
        !parts.includes(".") &&
        !parts.includes("..")
      );
    },
    {
      message: `${what} must be relative path segments of letters, digits, dots, underscores, or dashes joined by single slashes (no leading ./ or /, no '..')`,
    },
  );
// The sync substitutes these into quoted YAML scalars verbatim, so a quote,
// a backslash, or a control character would change the document it lands in.
const plainText = (what: string) =>
  z.string().refine((value) => !/["\\\p{Cc}]/u.test(value), {
    message: `${what} must not contain double quotes, backslashes, or control characters`,
  });
/** The label shape the fuzz-issue action and the copier validators enforce. */
export const LABEL_RE = /^[A-Za-z0-9._][A-Za-z0-9._: -]{0,49}$/;
const label = z
  .string()
  .regex(
    LABEL_RE,
    "must be a plain label: letters, digits, ._:- and spaces, not starting with a dash, at most 50 characters",
  );

/** The full registration document. Module names, `pages.setup` tokens, and
 *  `labels` keys are checked against the template's module data by the
 *  reader that has it (the plan action); the schema pins the shapes. */
export const registrationSchema = z.strictObject({
  modules: z.array(z.unknown()),
  project: z
    .strictObject({
      name: plainText("project.name").pipe(z.string().min(1)),
      slug,
      description: plainText("project.description"),
      copyright_holder: z.string().min(1).optional(),
    })
    .optional(),
  pages: z
    .strictObject({
      setup: z.string().min(1).optional(),
      install: z.string().optional(),
      build: z.string().min(1).optional(),
      dist: relativePath("pages.dist").optional(),
    })
    .optional(),
  docs_site: z
    .strictObject({
      path: urlSegment.optional(),
      // Extra source roots rendered into the docs mount: each tree at
      // `path`, served under `mount`, its pages being `page` files when named.
      include: z
        .array(
          z.strictObject({
            path: relativePath("docs_site.include[].path"),
            mount: urlSegment,
            page: z.string().min(1).optional(),
          }),
        )
        .min(1)
        .optional(),
    })
    .optional(),
  skills: z.strictObject({ dir: relativePath("skills.dir").optional() }).optional(),
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
