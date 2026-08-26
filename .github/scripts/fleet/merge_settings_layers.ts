#!/usr/bin/env bun
// Merges a repository's own .github/settings.yml OVER its computed
// managed settings baseline (render_managed_settings.ts), producing the
// one document github-settings-as-code applies. The single home of the
// layering dialect:
//
// - Deep merge: the repo layer wins; objects merge key by key.
// - An explicit `null` in the repo layer opts that key out entirely: the
//   key is stripped from the merged document, so the apply never touches
//   that section (or nested key) on this repository.
// - `labels` and `rulesets` are NAME-KEYED UNIONS: a repo entry replaces
//   the same-name managed entry wholesale (never a field-merge of the
//   two), and both sides' other entries are kept. Plain array-replace
//   would freeze the managed roster (a repo declaring one extra label
//   would nightly-delete every module label the moment the baseline
//   grows); the union keeps repo additions and managed evolution both
//   live. Label names match case-insensitively (GitHub deduplicates
//   label names that way); ruleset names match exactly.
// - Every other array (and every scalar) replaces wholesale.
//
// A repo with no settings.yml gets the plain baseline - identity keys
// (description, homepage, topics, private) are then undeclared and their
// out-of-band drift is never healed, which draws a warning; the starter
// the settings-sync module renders seeds all four.
//
// CLI:
//   bun .github/scripts/fleet/merge_settings_layers.ts --managed <file>
//     --out <file> [--repo-file <path> | --repo-fetch <owner/name>]
//
// --repo-file reads the repo layer from a local path (the self-apply's
// own checkout); --repo-fetch reads it from the target's default branch
// via gh api (env: GH_TOKEN), tolerating a 404 as "no repo layer".
// Neither flag means baseline-only (with the warning above).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parseFlags } from "../shared/flags.ts";
import { fail, warning } from "../shared/gha.ts";
import { captureNetwork } from "./discovery.ts";

/** The list sections merged as name-keyed unions, with each section's
 *  name-matching fold (labels case-insensitive, rulesets exact). */
const NAME_KEYED: Record<string, (name: string) => string> = {
  labels: (name) => name.toLowerCase(),
  rulesets: (name) => name,
};

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function entryName(entry: unknown): string | null {
  if (!isMapping(entry)) return null;
  return typeof entry.name === "string" ? entry.name : null;
}

/** Managed entries in managed order, each replaced WHOLESALE by the
 *  same-name repo entry when one exists; repo-only entries (and nameless
 *  repo entries, which the apply will reject on its own terms) appended
 *  in repo order. A repo entry of `null` under a matched name is not a
 *  thing (entries are objects); the null opt-out applies to the section
 *  key itself. */
export function nameKeyedUnion(
  managed: unknown[],
  repo: unknown[],
  fold: (name: string) => string,
): unknown[] {
  const repoByName = new Map<string, unknown>();
  for (const entry of repo) {
    const name = entryName(entry);
    if (name !== null && !repoByName.has(fold(name))) repoByName.set(fold(name), entry);
  }
  const taken = new Set<string>();
  const merged: unknown[] = [];
  for (const entry of managed) {
    const name = entryName(entry);
    if (name === null) {
      merged.push(entry);
      continue;
    }
    const key = fold(name);
    const override = repoByName.get(key);
    if (override !== undefined) {
      merged.push(override);
      taken.add(key);
    } else {
      merged.push(entry);
    }
  }
  for (const entry of repo) {
    const name = entryName(entry);
    if (name === null) {
      merged.push(entry);
      continue;
    }
    if (!taken.has(fold(name))) merged.push(entry);
  }
  return merged;
}

/** Repo-layer entries sharing a folded name: the union takes the FIRST
 *  and the rest ride through as repo-only extras, so the apply would
 *  fight itself over the label. Returned as warning texts - the repo
 *  layer is repo-owned content the merge must not hard-fail on. */
export function duplicateNameWarnings(repo: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  for (const [section, fold] of Object.entries(NAME_KEYED)) {
    const entries = repo[section];
    if (!Array.isArray(entries)) continue;
    const seen = new Map<string, string>();
    for (const entry of entries) {
      const name = entryName(entry);
      if (name === null) continue;
      const prior = seen.get(fold(name));
      if (prior !== undefined) {
        warnings.push(
          `the repository's settings.yml declares ${section} ${JSON.stringify(prior)} and ` +
            `${JSON.stringify(name)}, which the apply treats as one name - only the first ` +
            "entry takes effect in the merge; remove the duplicate",
        );
      } else {
        seen.set(fold(name), name);
      }
    }
  }
  return warnings;
}

/** Two plain objects merged key by key, repo winning; a repo `null`
 *  strips the key. */
function mergeMappings(
  managed: Record<string, unknown>,
  repo: Record<string, unknown>,
  nameKeyed: Record<string, (name: string) => string>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const key of [...Object.keys(managed), ...Object.keys(repo)]) {
    if (key in merged) continue;
    if (!(key in repo)) {
      merged[key] = managed[key];
      continue;
    }
    const repoValue = repo[key];
    if (repoValue === null) continue; // explicit opt-out: the key is stripped
    if (!(key in managed)) {
      merged[key] = repoValue;
      continue;
    }
    const managedValue = managed[key];
    const fold = nameKeyed[key];
    if (fold !== undefined && Array.isArray(managedValue) && Array.isArray(repoValue)) {
      merged[key] = nameKeyedUnion(managedValue, repoValue, fold);
    } else if (isMapping(managedValue) && isMapping(repoValue)) {
      // Name-keying applies only at the section level; nested objects
      // merge plainly.
      merged[key] = mergeMappings(managedValue, repoValue, {});
    } else {
      merged[key] = repoValue;
    }
  }
  return merged;
}

/** The merged settings document: `repo` layered over `managed` under the
 *  dialect in the header. */
export function mergeSettingsLayers(
  managed: Record<string, unknown>,
  repo: Record<string, unknown>,
): Record<string, unknown> {
  return mergeMappings(managed, repo, NAME_KEYED);
}

/** The identity keys the merged document should declare (they can only
 *  come from the repo layer - the baseline omits them on purpose). The
 *  apply never touches an undeclared key, so a missing one's out-of-band
 *  drift is never healed; returned for the caller to warn on, never an
 *  error - identity is repo-owned under this model, and a repo choosing
 *  not to declare a key must not lose its baseline heal over it. */
export function missingIdentityKeys(merged: Record<string, unknown>): string[] {
  const repository = merged.repository;
  const declared = isMapping(repository) ? repository : {};
  return ["description", "homepage", "topics", "private"].filter((key) => !(key in declared));
}

export interface IdentityIssue {
  key: string;
  expected: string;
  got: string;
}

/** Shape hygiene for the identity keys a repo layer declares (the
 *  settings-sync starter seeds all four; the apply never touches an
 *  undeclared key, so drift in a missing one is never healed).
 *  check_ssot.ts applies this to repo-platform's own .github/settings.yml;
 *  missingIdentityKeys above is the merge path's presence warning. */
export function identityKeyIssues(repository: Record<string, unknown>): IdentityIssue[] {
  const issues: IdentityIssue[] = [];
  const got = (value: unknown) => (value === undefined ? "missing" : JSON.stringify(value));
  if (typeof repository.description !== "string" || repository.description === "") {
    issues.push({
      key: "description",
      expected: "a non-empty description string",
      got: got(repository.description),
    });
  }
  if (typeof repository.homepage !== "string") {
    issues.push({
      key: "homepage",
      expected: 'a homepage string ("" declares-and-clears)',
      got: got(repository.homepage),
    });
  }
  const topics = repository.topics;
  if (
    typeof topics !== "string" &&
    !(Array.isArray(topics) && topics.every((t) => typeof t === "string"))
  ) {
    issues.push({
      key: "topics",
      expected: "a declared topics value (string or string list)",
      got: got(topics),
    });
  }
  if (typeof repository.private !== "boolean") {
    issues.push({
      key: "private",
      expected: "an explicit boolean, so the apply manages visibility",
      got: got(repository.private),
    });
  }
  return issues;
}

export function parseSettingsDoc(text: string, where: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(`${where}: YAML parse error: ${detail}`);
  }
  if (data === null || data === undefined) return {};
  if (!isMapping(data)) throw new Error(`${where}: not a YAML mapping`);
  return data;
}

function fetchRepoLayer(repo: string): { text: string; where: string } | null {
  const proc = captureNetwork([
    "gh",
    "api",
    `repos/${repo}/contents/.github/settings.yml`,
    "-H",
    "Accept: application/vnd.github.raw",
  ]);
  if (proc.exitCode === 0) return { text: proc.stdout, where: `${repo}/.github/settings.yml` };
  if (proc.stderr.includes("HTTP 404")) return null;
  throw new Error(
    `${repo}/.github/settings.yml: fetch failed (${proc.stderr.trim().split("\n")[0]})`,
  );
}

function main(args: string[]): void {
  const flags = parseFlags(
    args,
    ["--managed", "--out"] as const,
    ["--repo-file", "--repo-fetch"] as const,
  );
  if (flags["--repo-file"] !== undefined && flags["--repo-fetch"] !== undefined) {
    fail("--repo-file and --repo-fetch are mutually exclusive - pass one repo-layer source");
  }
  try {
    const managed = parseSettingsDoc(readFileSync(flags["--managed"], "utf-8"), flags["--managed"]);
    let repoLayer: { text: string; where: string } | null = null;
    if (flags["--repo-file"] !== undefined) {
      // A missing local file is a real answer (no repo layer yet), same
      // as the fetch path's 404.
      if (existsSync(flags["--repo-file"])) {
        repoLayer = {
          text: readFileSync(flags["--repo-file"], "utf-8"),
          where: flags["--repo-file"],
        };
      }
    } else if (flags["--repo-fetch"] !== undefined) {
      repoLayer = fetchRepoLayer(flags["--repo-fetch"]);
    }
    const repo = repoLayer === null ? {} : parseSettingsDoc(repoLayer.text, repoLayer.where);
    for (const message of duplicateNameWarnings(repo)) warning(message);
    const merged = mergeSettingsLayers(managed, repo);
    const missing = missingIdentityKeys(merged);
    if (missing.length > 0) {
      warning(
        `the merged settings document declares no ${missing.join(", ")} - the apply never ` +
          "touches an undeclared key, so out-of-band drift in " +
          `${missing.length === 1 ? "it" : "them"} is never healed; ` +
          (repoLayer === null
            ? "the repository has no .github/settings.yml yet (the settings-sync starter seeds all four identity keys)"
            : "declare the identity keys in the repository's .github/settings.yml"),
      );
    }
    writeFileSync(
      flags["--out"],
      `# Merged settings document (managed baseline + the repository's own settings.yml),\n# built by repo-platform's .github/scripts/fleet/merge_settings_layers.ts - scratch output.\n${stringifyYaml(merged)}`,
    );
    console.log(
      `merged the ${repoLayer === null ? "baseline alone (no repo layer)" : `repo layer (${repoLayer.where}) over the baseline`} into ${flags["--out"]}`,
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
