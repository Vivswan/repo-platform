import { type Context, REGISTRATION_PATH } from "../context.ts";
import { error, type Finding } from "../findings.ts";

/** The registration every managed repository carries (repo-platform
 *  itself included): .repo-platform.yml exists, its `modules` is a list,
 *  and every name is a module files.yml knows. The vocabulary comes from
 *  the data file the caller named; a data file that cannot be read is
 *  reported once and the names stand unjudged. */
export function checkRegistration(ctx: Context): Finding[] {
  const findings: Finding[] = [];
  if (ctx.registration === null) {
    return [
      error(
        `${REGISTRATION_PATH} is missing - every repository the platform manages registers ` +
          "here (docs/new-repo.md); restore it from git history or write it again",
      ),
    ];
  }
  const modules = ctx.registration.modules;
  if (!Array.isArray(modules)) {
    findings.push(
      error(
        `${REGISTRATION_PATH}: top-level \`modules\` is missing or not a list ` +
          "(the file may have failed to parse); set it to a YAML list of " +
          "module names, e.g. modules: [uv, release-please]",
      ),
    );
    return findings;
  }
  if ("problem" in ctx.vocabulary) {
    findings.push(
      error(
        `${ctx.vocabulary.problem} - the registration's module names cannot be judged ` +
          "without it",
      ),
    );
    return findings;
  }
  const known = ctx.vocabulary.modules;
  const unknown = modules
    .filter((m) => typeof m !== "string" || !known.has(m))
    .map((m) => String(m))
    .sort();
  if (unknown.length > 0) {
    findings.push(
      error(
        `${REGISTRATION_PATH}: unknown module(s): ${unknown.join(", ")} - ` +
          `valid modules are: ${[...known].sort().join(", ")}; fix the modules list`,
      ),
    );
  }
  return findings;
}
