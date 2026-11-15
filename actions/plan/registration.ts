// Lives inside the plan action because it needs yaml and zod, which the dependency-free actions/shared zone cannot carry.
// The sync imports it by relative path.
import { parse } from "yaml";
import { z } from "zod";
import {
  includeRootsSchema,
  includeWithoutDocsProblem,
  relPathProblem,
  urlSegmentProblem,
} from "../pages-site/.vitepress/conventions.ts";
import { LABEL_RE } from "../shared/label.ts";
import { REGISTRATION_PATH } from "../shared/platform.ts";
import { pathProblem } from "../shared/repo_path.ts";

/** The one refusal of a module files.yml does not offer.
 *  The plan on every PR and the sync writer speak it alike, so no reader drops a name quietly. */
export function unknownModuleProblems(
  requested: readonly string[],
  known: readonly string[],
): string[] {
  return requested
    .filter((name) => !known.includes(name))
    .map(
      (name) =>
        `${REGISTRATION_PATH}: module "${name}" is not a module files.yml offers (known: ${known.join(", ")})`,
    );
}

// A nested list or mapping is named by shape: JSON.stringify throws on the
// cycle a YAML alias can build, which would turn a bad entry into a crash.
function describeEntry(entry: unknown): string {
  if (Array.isArray(entry)) return "(a list)";

  if (typeof entry === "object" && entry !== null) return "(a mapping)";

  return JSON.stringify(entry) ?? String(entry);
}

/** Module names, each once. `when` keeps the duplicate check running beside an entry that is no name, which zod would otherwise skip, hence its string test. */
const moduleNames = z
  .array(
    z
      .string({ error: (issue) => `${describeEntry(issue.input)} is not a module name` })
      .min(1, { error: '"" is not a module name' }),
    {
      error: (issue) =>
        issue.input === undefined
          ? "no module selection found - add a top-level `modules: [...]` list (the sync never assumes an empty selection, which would strip every module from the repo)"
          : "must be a list of module names",
    },
  )
  .superRefine(
    (names, ctx) => {
      names.forEach((name, index) => {
        if (typeof name !== "string" || names.indexOf(name) === index) return;

        ctx.addIssue({ code: "custom", message: `duplicate entry "${name}"`, path: [index] });
      });
    },
    { when: (payload) => Array.isArray(payload.value) },
  );

/** A document's top level, for both schemas that read one: any other shape is named in the document's own word. */
const MAPPING: { error: z.core.$ZodErrorMap } = {
  error: (issue) => (issue.code === "invalid_type" ? "must be a mapping" : undefined),
};

/** The selection alone, whatever else the document carries: the fleet plans read it from registrations they do not otherwise judge. */
const selectionSchema = z.looseObject({ modules: moduleNames }, MAPPING);

/** Every issue as one line, the place before the problem. */
function problemLines(error: z.ZodError, label: string): string[] {
  return error.issues.map(
    (issue) => `${label}: ${issue.path.join(".") || "(top level)"}: ${issue.message}`,
  );
}

export function readModules(
  data: unknown,
  label = REGISTRATION_PATH,
): { modules: string[] | null; errors: string[] } {
  const read = selectionSchema.safeParse(data);
  if (!read.success) return { modules: null, errors: problemLines(read.error, label) };

  return { modules: read.data.modules, errors: [] };
}

/** logLevel error: the parser's default level prints warned-on source lines (target content) to stderr.
 *  The fleet plans' public logs must never carry them. */
export function declaredModules(registrationText: string): string[] | null {
  let data: unknown;
  try {
    data = parse(registrationText, { logLevel: "error" });
  } catch {
    return null;
  }

  return readModules(data).modules;
}

const slug = z
  .string()
  .regex(
    /^[a-z0-9]+(-[a-z0-9]+)*$/,
    "must be kebab-case (lowercase letters and digits, dash-separated)",
  );

function judged(problem: (value: string) => string | null) {
  return z.string().superRefine((value, ctx) => {
    const message = problem(value);
    if (message !== null) ctx.addIssue({ code: "custom", message });
  });
}

const urlSegment = judged(urlSegmentProblem);
const relativePath = judged(relPathProblem);

/** The sync substitutes these into quoted YAML scalars verbatim, so a quote, a backslash, or a control character
 *  would change the document it lands in. */
function plainText(what: string) {
  return z.string().refine((value) => !/["\\\p{Cc}]/u.test(value), {
    message: `${what} must not contain double quotes, backslashes, or control characters`,
  });
}

/** A label as GitHub accepts it and gh takes it as a flag value (LABEL_RE). */
const label = z
  .string()
  .regex(
    LABEL_RE,
    "must be a plain label: letters, digits, ._:- and spaces, not starting with a dash, at most 50 characters",
  );

/** A name the hook can receive: GitHub's shape for a variable name, less PATH (exported empty when unset, it breaks command lookup) and NODE_OPTIONS (refused in GITHUB_ENV). */
const variableName = z
  .string()
  .regex(
    /^(?!GITHUB_|(?:PATH|NODE_OPTIONS)$)[A-Z_][A-Z0-9_]*$/,
    "must be a repository variable's name: uppercase letters, digits, and underscores, not starting with a digit or GITHUB_, and not PATH or NODE_OPTIONS",
  );

/** Why `value` cannot be an entry of an autofix list, or null: a glob over repository paths, or a directory spelled with a closing slash. */
function fixGlobProblem(value: string): string | null {
  if (value.startsWith("!")) return "is a negation, which a list of allowed paths does not take";

  return pathProblem(value.endsWith("/") ? value.slice(0, -1) : value);
}

/** A list of the autofix module, matched against repository paths by the autofix action. */
const fixGlobs = z.array(judged(fixGlobProblem));

/** One event's allow-lists of the autofix module: what a fix may add or change, and what it may delete. */
const fixLists = z.strictObject({ paths: fixGlobs.min(1), delete: fixGlobs.default([]) });

/** One grammar for both documents that declare mirrors: files.yml's fleet list and the registration's own. `kind` is how a target carries the source: its bytes, or a relative symbolic link to it (docs/platform/sync/mirrors.md). */
export const mirrorsSchema = z.array(
  z.strictObject({
    source: z.string().min(1),
    targets: z.array(z.string().min(1)).min(1),
    kind: z.enum(["copy", "symlink"]).default("copy"),
  }),
);

/** Module names and `labels` keys are checked against files.yml by the reader that has it; the schema pins shapes alone. */
export const registrationSchema = z.strictObject(
  {
    modules: moduleNames,
    project: z.strictObject({
      name: plainText("project.name").pipe(z.string().min(1)),
      slug,
      description: plainText("project.description"),
      copyright_holder: plainText("project.copyright_holder").pipe(z.string().min(1)).optional(),
    }),
    // `path: null` turns the docs half off (docs/modules/site.md, "Turning the docs
    // half off"): the site is the hook's website alone.
    site: z
      .strictObject({
        path: urlSegment.nullable().optional(),
        include: includeRootsSchema(z).optional(),
        // The repository variables the site-build hook reads as environment values (docs/modules/site.md, "Repository variables").
        vars: z.array(variableName).optional(),
      })
      .superRefine((site, ctx) => {
        const message = includeWithoutDocsProblem(site.path, site.include ?? []);
        if (message !== null) ctx.addIssue({ code: "custom", message, path: ["include"] });
      })
      .optional(),
    // The directory of the package the npm legs publish; absent is the repository root (docs/modules/npm.md).
    npm: z.strictObject({ path: relativePath.optional() }).optional(),
    // What a fix may carry, per trigger: the fix-lint label, and a push to a pull request touching `on` (docs/modules/autofix.md).
    autofix: z
      .strictObject({ label: fixLists, push: fixLists.extend({ on: fixGlobs.min(1) }).optional() })
      .optional(),
    labels: z.record(z.string(), label).optional(),
    // Paths the repository keeps as its own: no files.yml entry there is
    // written for it (docs/platform/sync/files.md, Selection).
    except: z.array(judged(pathProblem)).optional(),
    mirrors: mirrorsSchema.optional(),
  },
  MAPPING,
);

export type Registration = z.infer<typeof registrationSchema>;

export type RegistrationRead = { registration: Registration } | { errors: string[] };

export function parseRegistration(text: string, label = REGISTRATION_PATH): RegistrationRead {
  let data: unknown;
  try {
    data = parse(text, { logLevel: "error" });
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return { errors: [`${label}: YAML parse error: ${detail}`] };
  }

  const result = registrationSchema.safeParse(data);
  if (!result.success) return { errors: problemLines(result.error, label) };

  return { registration: result.data };
}
