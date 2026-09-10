// The facts that select a repository's settings layers (settings_layers.ts
// turns them into the ordered list github-settings-as-code merges): the
// module selection, the effective visibility, the tracking-label answers,
// and whether the pr-title module's workflow is on the default branch. Every
// fact source pins to one commit and publishes it, so the repo layer and the
// reference files are read at the same revision the facts were.
//
// Three sources: a target fetched through gh api at its default-branch head
// (env: GH_TOKEN), a local checkout (--target-dir: the smoke gate, the sync's
// referenced-label check), and the operator repository's recorded answers
// (repo-platform is the one fleet member with no .repo-platform.yml).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseAnswers } from "../../../scripts/generate/render_dogfood.ts";
import { loadManifests, type ModuleManifest } from "../../../scripts/lib/module_manifests.ts";
import { notice } from "../shared/gha.ts";
import { capture } from "../shared/proc.ts";
import { ANSWERS_PATH, readAnswersBytes } from "../sync/answers_file.ts";
import { readModules } from "../sync/modules.ts";
import { captureNetwork } from "./discovery.ts";

export interface RepoFacts {
  /** The target's module selection (its .repo-platform.yml list). */
  modules: string[];
  /** Effective visibility (declared repository.private, else live):
   *  private repos reject the public-only layers with a 422. */
  private: boolean;
  /** Resolved tracking-label answers, one per SELECTED stream module. */
  trackingLabels: { module: string; label: string }[];
  /** Whether the pinned revision carries the pr-title module's managed
   *  workflow: selecting the module activates a required check, and a
   *  check nothing creates wedges every PR, so activation also waits for
   *  the workflow to be on the default branch (the sync delivering it can
   *  land in any order relative to the apply). */
  prTitleWorkflowPresent: boolean;
}

export function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseYamlText(text: string, where: string): unknown {
  try {
    return parseYaml(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(`${where}: YAML parse error: ${detail}`);
  }
}

/** A YAML mapping with location-carrying diagnostics; the values stay
 *  `unknown` because each caller reads one key and validates it itself. */
export function parseYamlMapping(text: string, where: string): Record<string, unknown> {
  const data = parseYamlText(text, where);
  if (!isMapping(data)) throw new Error(`${where}: not a YAML mapping`);
  return data;
}

/** A settings LAYER document, read the way the action reads it: an empty
 *  document is an empty layer (a repository whose settings.yml declares
 *  nothing is still onboarded); any other non-mapping is refused. */
export function parseLayerText(text: string, where: string): Record<string, unknown> {
  const data = parseYamlText(text, where);
  if (data == null) return {};
  if (!isMapping(data)) throw new Error(`${where}: not a YAML mapping`);
  return data;
}

/** The module selection of a .repo-platform.yml text, read with the
 *  sync's registration grammar and validated against the manifest roster:
 *  a name that selects no layers would yield a valid-looking stack missing
 *  that module's labels, which the apply then deletes. */
export function modulesFrom(
  registrationText: string,
  where: string,
  manifests: ModuleManifest[] = loadManifests(),
): string[] {
  const { modules } = readModules(parseYamlMapping(registrationText, where), where);
  if (modules === null) throw new Error(`${where}: no readable top-level modules list`);
  return assertKnownModules(modules, where, manifests);
}

export function assertKnownModules(
  modules: string[],
  where: string,
  manifests: ModuleManifest[],
): string[] {
  const known = new Set(manifests.map((m) => m.module));
  const unknown = modules.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `${where}: unknown module(s) ${unknown.map((n) => JSON.stringify(n)).join(", ")} - not a ` +
        "template module. Applying the settings without them would select a layer stack missing " +
        "their labels, and the apply deletes undeclared labels. A name the template retired " +
        "leaves the file with the repository's pending sync PR (its migration rung rewrites " +
        "the list); merge that PR first.",
    );
  }
  return modules;
}

/** What an ABSENT tracking-label answer means: a client repository's answer
 *  arrives with its pending sync PR, so absence falls back to the manifest
 *  default with a notice; the operator maintains its answers by hand, so
 *  absence there is a defect. */
export type AbsentAnswerPolicy =
  | { readonly fallback: "default"; readonly report: (message: string) => void }
  | { readonly fallback: "fail" };

/** The selected stream modules' tracking-label answers from a
 *  .github/.copier-answers.yml text. A PRESENT but unreadable answer throws:
 *  the label is the stream's identity, and a guess would loop it. */
export function trackingLabelsFrom(
  answersText: string,
  modules: string[],
  manifests: ModuleManifest[],
  where: string,
  absent: AbsentAnswerPolicy = { fallback: "default", report: notice },
): { module: string; label: string }[] {
  const streams = manifests.filter(
    (m) => m.tracking_label !== undefined && modules.includes(m.module),
  );
  if (streams.length === 0) return [];
  const answers = parseYamlMapping(answersText, where);
  return streams.map((m) => {
    const tracking = m.tracking_label;
    if (tracking === undefined) throw new Error("unreachable: filtered on tracking_label");
    if (!Object.hasOwn(answers, tracking.answer)) {
      if (absent.fallback === "fail") {
        throw new Error(
          `${where}: the ${m.module} module is selected but the file records no ` +
            `${tracking.answer} answer - no sync PR records this file, so the tracking label ` +
            "cannot be resolved; record the answer",
        );
      }
      absent.report(
        `${where}: the ${m.module} module is selected but the file records no ` +
          `${tracking.answer} answer yet, so this apply assumes the module's default label ` +
          `'${tracking.default}'. The repository's pending sync PR writes the answer; the ` +
          "first apply after it merges reads the recorded value, so a label customized in " +
          "that PR takes effect then.",
      );
      return { module: m.module, label: tracking.default };
    }
    const value = answers[tracking.answer];
    if (typeof value !== "string" || value === "") {
      throw new Error(
        `${where}: the ${m.module} module is selected but its ${tracking.answer} answer is ` +
          "not readable (recorded, but not a non-empty string) - the tracking label cannot " +
          "be resolved; fix the answers file",
      );
    }
    return { module: m.module, label: value };
  });
}

/** One file from a target AT A PINNED REF, or null on a 404. Reading the
 *  moving branch instead would let a push between two reads pair an old
 *  module selection with a new repo layer. */
export type RepoFileFetcher = (repo: string, path: string, ref: string) => string | null;

export const fetchRepoFile: RepoFileFetcher = (repo, path, ref) => {
  const proc = captureNetwork([
    "gh",
    "api",
    `repos/${repo}/contents/${path}?ref=${ref}`,
    "-H",
    "Accept: application/vnd.github.raw",
  ]);
  if (proc.exitCode === 0) return proc.stdout;
  if (proc.stderr.includes("HTTP 404")) return null;
  throw new Error(`${repo}/${path}@${ref}: fetch failed (${proc.stderr.trim().split("\n")[0]})`);
};

/** The default branch's head, resolved ONCE per target: the commit every
 *  read pins to. */
export function resolveTargetRef(repo: string): string {
  const branchProc = captureNetwork(["gh", "api", `repos/${repo}`, "--jq", ".default_branch"]);
  if (branchProc.exitCode !== 0) {
    throw new Error(
      `${repo}: cannot read the default branch (${branchProc.stderr.trim().split("\n")[0]})`,
    );
  }
  const branch = branchProc.stdout.trim();
  const head = captureNetwork(["gh", "api", `repos/${repo}/commits/${branch}`, "--jq", ".sha"]);
  if (head.exitCode !== 0) {
    throw new Error(`${repo}: cannot resolve ${branch} (${head.stderr.trim().split("\n")[0]})`);
  }
  const sha = head.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`${repo}: ${branch} resolved to no commit sha`);
  }
  return sha;
}

/** A local checkout's HEAD, pinned and rechecked like a fetched one; empty
 *  when the directory is not a git checkout (check_target_fresh.ts refuses
 *  an empty pin). */
export function localHeadSha(dir: string): string {
  const proc = capture(["git", "-C", dir, "rev-parse", "HEAD"]);
  const sha = proc.stdout.trim();
  return proc.exitCode === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : "";
}

/** Live visibility, failing closed: only an explicit "false" proves the
 *  repo public. Live and unpinned, unlike every content fact: a flip
 *  landing mid-run applies the wrong overlay until the next heal
 *  (docs/settings.md records the window). */
function fetchRepoIsPrivate(repo: string): boolean {
  const proc = captureNetwork(["gh", "api", `repos/${repo}`, "--jq", ".private"]);
  if (proc.exitCode !== 0) {
    throw new Error(`${repo}: visibility probe failed (${proc.stderr.trim().split("\n")[0]})`);
  }
  return proc.stdout.trim() !== "false";
}

/** The DECLARED `repository.private` boolean of a settings.yml text, or
 *  null when the file, the key, or the boolean shape is absent. A peek at
 *  a fact, not a validation: a malformed file falls back to the live probe
 *  and is reported by the merge, which names it properly. */
export function declaredPrivate(settingsText: string | null): boolean | null {
  if (settingsText === null) return null;
  let data: unknown;
  try {
    data = parseYaml(settingsText);
  } catch {
    return null;
  }
  const repository = isMapping(data) ? data.repository : null;
  const value = isMapping(repository) ? repository.private : null;
  return typeof value === "boolean" ? value : null;
}

/** The pr-title module's managed workflow, whose presence at the pinned
 *  revision gates the required-check activation. */
export const PR_TITLE_WORKFLOW = ".github/workflows/pr-title.yml";

/** Facts for the operator repository: its selection and visibility come
 *  from the recorded operator answers, the same file the dogfood render
 *  uses. No sync PR writes it, so an absent stream answer is a defect. */
export function factsFromOperatorAnswers(
  answersPath: string,
  manifests: ModuleManifest[] = loadManifests(),
): RepoFacts {
  const answersText = readFileSync(answersPath, "utf-8");
  const answers = parseAnswers(answersText, answersPath);
  const modules = assertKnownModules([...answers.modules], answersPath, manifests);
  return {
    modules,
    private: answers.private,
    trackingLabels: trackingLabelsFrom(answersText, modules, manifests, answersPath, {
      fallback: "fail",
    }),
    prTitleWorkflowPresent: existsSync(join(dirname(resolve(answersPath)), PR_TITLE_WORKFLOW)),
  };
}

/** Facts fetched at `ref`, or null when the target carries no
 *  .repo-platform.yml there (it left management; the caller skips).
 *  Visibility is the DECLARED repository.private when boolean, else the
 *  live probe: the apply flips visibility to the declared value first, so
 *  the visibility-gated layers must match the post-apply state. */
export function factsFromFetch(
  repo: string,
  manifests: ModuleManifest[],
  ref: string,
  fetch: RepoFileFetcher = fetchRepoFile,
  report: (message: string) => void = notice,
): RepoFacts | null {
  const registration = fetch(repo, ".repo-platform.yml", ref);
  if (registration === null) return null;
  const modules = modulesFrom(registration, `${repo}/.repo-platform.yml`, manifests);
  const isPrivate =
    declaredPrivate(fetch(repo, ".github/settings.yml", ref)) ?? fetchRepoIsPrivate(repo);
  const streams = manifests.filter(
    (m) => m.tracking_label !== undefined && modules.includes(m.module),
  );
  let trackingLabels: { module: string; label: string }[] = [];
  if (streams.length > 0) {
    const answers = fetch(repo, ANSWERS_PATH, ref);
    if (answers === null) {
      throw new Error(
        `${repo}: selects tracking-stream module(s) but has no .github/.copier-answers.yml - ` +
          "the tracking labels cannot be resolved",
      );
    }
    trackingLabels = trackingLabelsFrom(answers, modules, manifests, `${repo}/${ANSWERS_PATH}`, {
      fallback: "default",
      report,
    });
  }
  const prTitleWorkflowPresent =
    modules.includes("pr-title") && fetch(repo, PR_TITLE_WORKFLOW, ref) !== null;
  return { modules, private: isPrivate, trackingLabels, prTitleWorkflowPresent };
}

/** Facts read from a local checkout; null when it carries no
 *  .repo-platform.yml. The private fact prefers the checkout's declared
 *  repository.private, falling back to the recorded answer. */
export function factsFromTargetDir(dir: string, manifests: ModuleManifest[]): RepoFacts | null {
  const where = (name: string) => join(dir, name);
  if (!existsSync(join(dir, ".repo-platform.yml"))) return null;
  const modules = modulesFrom(
    readFileSync(join(dir, ".repo-platform.yml"), "utf-8"),
    where(".repo-platform.yml"),
    manifests,
  );
  const answersText = readAnswersBytes(dir).toString("utf-8");
  const settingsPath = join(dir, ".github/settings.yml");
  const declared = declaredPrivate(
    existsSync(settingsPath) ? readFileSync(settingsPath, "utf-8") : null,
  );
  const recorded = parseYamlMapping(answersText, where(ANSWERS_PATH)).private;
  if (declared === null && typeof recorded !== "boolean") {
    throw new Error(
      `${where(ANSWERS_PATH)}: records no boolean private answer - ` +
        "the visibility-gated layers cannot be selected",
    );
  }
  return {
    modules,
    private: declared ?? recorded === true,
    trackingLabels: trackingLabelsFrom(answersText, modules, manifests, where(ANSWERS_PATH)),
    prTitleWorkflowPresent: existsSync(join(dir, PR_TITLE_WORKFLOW)),
  };
}
