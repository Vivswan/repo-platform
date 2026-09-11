import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST_NAME } from "../../../shared/manifest.ts";
import { ANSWERS_PATH, type BuildRecord, type Context, REGISTRATION_PATH } from "../context.ts";
import { advisory, error, type Finding } from "../findings.ts";
import { KNOWN_MODULES, TOOLCHAIN_PINS } from "../ownership.ts";
import { isRegularFile } from "../readers.ts";
import { RESYNC } from "./manifest_shape.ts";

const FULL_SHA_RE = /^[0-9a-f]{40}$/;

/** The recorded build commit is the full sha of the build the tree was
 *  written from: the fleet's checks judge a tree at exactly that commit,
 *  and a short or tag-shaped value cannot name one without a checkout. */
function buildCommitError(record: BuildRecord): Finding | null {
  const { file, commit } = record;
  if (commit !== null && FULL_SHA_RE.test(commit)) return null;
  if (file === ANSWERS_PATH) {
    return error(
      `${ANSWERS_PATH}: _commit ${commit === null ? "is missing" : `'${commit}' is not a full 40-hex commit sha`} - ` +
        "every render's stamp hook records the build commit's full sha; run a template " +
        "sync to rewrite it, since the render cannot be judged at its own template commit " +
        "until then",
    );
  }
  return error(
    `${MANIFEST_NAME}: its own entry records ${commit === null ? "no build commit" : `'${commit}', which is not a full 40-hex commit sha`} - ` +
      "the sync writer stamps the build commit it wrote the tree from there, and the tree " +
      `cannot be judged at its own build commit until it does; ${RESYNC}`,
  );
}

/** The registration files a managed render carries: .repo-platform.yml
 *  selects known modules whose toolchain pins are on disk verbatim, the
 *  tree records the full sha of the build it was written from, and the
 *  answers file, while it is the registration record, pins the owner. Not
 *  applicable to the template repository itself. */
export function checkRegistration(ctx: Context): Finding[] {
  if (ctx.mode !== "render") return [];
  const findings: Finding[] = [];
  // The template renders this fleet's composite actions as
  // <github_username>/repo-platform/actions/<name>@<ref>, so a missing or
  // malformed owner is a hard error, never a permissive fallback. (A
  // missing answers file gets its own error below; no second diagnostic.)
  if (ctx.answers !== null && ctx.owner === null) {
    findings.push(
      error(
        `${ANSWERS_PATH}: \`github_username\` is missing or not a ` +
          "GitHub username - it pins which owner's composite actions " +
          "ci.yml must use; restore the field or re-run a template sync",
      ),
    );
  }
  // An unreadable manifest is the manifest checks' report, not a second
  // error here for the record it would have carried.
  if (ctx.buildRecord !== null) {
    const problem = buildCommitError(ctx.buildRecord);
    if (problem !== null) findings.push(problem);
  }
  if (ctx.answers === null && ctx.registeredByAnswers) {
    findings.push(
      error(
        `${ANSWERS_PATH} is missing while ${REGISTRATION_PATH} still has the shape the template ` +
          "rendered - the file records the render's owner, visibility, and build commit " +
          `until the sync converts the registration and retires it; restore it from git history or ${RESYNC}`,
      ),
    );
  }
  if (ctx.registration === null) {
    findings.push(
      error(
        `${REGISTRATION_PATH} is missing - every managed repository registers there (or the ` +
          `file was deleted); restore it from git history or ${RESYNC}`,
      ),
    );
    return findings;
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
  const unknown = modules
    .filter((m) => typeof m !== "string" || !KNOWN_MODULES.has(m))
    .map((m) => String(m))
    .sort();
  if (unknown.length > 0) {
    findings.push(
      error(
        `${REGISTRATION_PATH}: unknown module(s): ${unknown.join(", ")} - ` +
          `valid modules are: ${[...KNOWN_MODULES].sort().join(", ")}; ` +
          "fix the modules list",
      ),
    );
  }
  // Setup steps read the pin dotfiles, so drifted content silently unpins
  // the whole toolchain.
  for (const module of modules) {
    const pin = typeof module === "string" ? TOOLCHAIN_PINS[module] : undefined;
    if (!pin) continue;
    const pinPath = join(ctx.root, pin.file);
    if (!isRegularFile(pinPath)) {
      findings.push(
        error(
          `${pin.file} is missing - the ${module} module pins its toolchain ` +
            "version there and the template always generates it; restore the " +
            "file from git history or run a template sync",
        ),
      );
    } else if (readFileSync(pinPath, "utf-8") !== `${pin.version}\n`) {
      findings.push(
        error(
          `${pin.file}: content must be exactly '${pin.version}' plus a newline ` +
            `(the ${module} module's pinned toolchain version) - the file is ` +
            "managed, so a template sync heals it; version overrides belong in " +
            "the repo-owned workflows' explicit version inputs",
        ),
      );
    }
  }
  // packageManager is setup-bun's LAST fallback, dead once .bun-version
  // pins the toolchain - and a stale field is a second, disagreeing pin.
  // Advisory only: the field also drives corepack shims some repos rely on.
  if (modules.includes("bun")) {
    const pkgPath = join(ctx.root, "package.json");
    if (isRegularFile(pkgPath)) {
      let pkg: unknown = null;
      try {
        pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      } catch {
        pkg = null;
      }
      if (typeof pkg === "object" && pkg !== null && "packageManager" in pkg) {
        findings.push(
          advisory(
            "package.json: packageManager is redundant (and can disagree) once " +
              ".bun-version pins the toolchain - consider removing it " +
              "(repo-platform docs/toolchains.md)",
          ),
        );
      }
    }
  }
  return findings;
}
