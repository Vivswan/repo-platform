#!/usr/bin/env bun
// FAIL-CLOSED label preflight for the settings apply: the action's label
// reconciliation DELETES every live label the merged document does not
// declare and RENAMES entries that declare `new_name` - either way a
// label the target's issue forms or workflows still reference vanishes
// under its referenced name, a silent break the run stays green through
// (the chromium-bridge and litellm incidents). Before the action runs,
// this script lists the live labels, extracts the referenced ones from
// the target's own files (label_references.ts owns the extraction rule
// and its stated limits), and FAILS the apply for this repository when a
// referenced label is scheduled for removal - naming the label and its
// referencing files, so the fix (declare the label in a settings layer,
// or drop the reference) is one message away. A false positive from the
// heuristic blocks one repo's apply loudly; the silent break it prevents
// surfaced only when a user hit the broken form.
//
// Scope is exactly the destructive act: a referenced label that is
// neither live nor declared is already broken and removing nothing, so
// it warns on the sync path (referenced_labels.ts), never here. A merged
// document that declares NO labels key leaves the action's reconciliation
// off entirely, so the preflight stands down without probing.
//
// Usage:
//   bun label_preflight.ts --merged <merged-settings.yml> --repo owner/name
//     (--target-dir <checkout> | --ref <40-hex sha>) [--sections <allowlist>]
//     [--required-sections <list>] [--mode apply|check]
//     [--on-missing-permission fail|warn]
//
// --target-dir reads the reference files from a local checkout (the
// self-apply, whose token has no Contents scope); --ref fetches them from
// the target via gh api (env: GH_TOKEN) at the SAME pinned commit the
// merged document's facts were read at. The optional flags mirror the
// ACTION's inputs so the preflight is never stricter OR looser than the
// apply it guards: --sections stands the preflight down when a non-empty
// allowlist does not select `labels` (that apply reconciles none); --mode
// check reports findings as warnings and exits 0 (a check run deletes
// nothing, and hard-failing would cost the drift report the run exists
// for); --on-missing-permission warn turns a permission refusal on the
// live-label listing into a warned stand-down (the action's own labels
// section warns and skips under the same input) - UNLESS
// --required-sections names labels, where the action fails that section
// even under warn. Everything else fails closed: a non-permission listing
// failure or a failed file fetch fails the step rather than reading as
// "nothing referenced".

import { readFileSync } from "node:fs";
import { parseFlags } from "../shared/flags.ts";
import { fail, setOutput, warning } from "../shared/gha.ts";
import { captureNetwork } from "./discovery.ts";
import {
  collectReferences,
  finalLabelNames,
  foldLabel,
  type LabelReference,
  type RepoDirLister,
  type RepoFileReader,
  referenceFilesFromDir,
  referenceFilesFromFetch,
} from "./label_references.ts";
import { fetchRepoFile } from "./render_managed_settings.ts";
import { isMapping, parseSettingsDoc } from "./settings_document.ts";

/** The references whose label is LIVE on the repository but absent from
 *  the post-apply names (finalLabelNames): exactly the set the apply
 *  would delete - or rename away - out from under a referencing file. */
export function blockedRemovals(
  references: LabelReference[],
  liveNames: string[],
  finalNames: string[],
): LabelReference[] {
  const live = new Set(liveNames.map(foldLabel));
  const kept = new Set(finalNames.map(foldLabel));
  return references.filter(
    (reference) => live.has(foldLabel(reference.label)) && !kept.has(foldLabel(reference.label)),
  );
}

/** Every live label name on the repository (gh api, paginated), or the
 *  permission refusal the caller may be configured to tolerate. The
 *  permission shape mirrors the action's own classification: a 404 is a
 *  permission denial too (the render already resolved this repo, so the
 *  slug exists - the token just cannot see it), while a rate-limit 403 is
 *  NOT (the quota recovers; standing down would publish a false
 *  permission claim). Any other failure throws: an unreadable roster must
 *  never read as an empty one. */
export function fetchLiveLabelNames(
  repo: string,
): { kind: "ok"; names: string[] } | { kind: "forbidden"; detail: string } {
  const proc = captureNetwork([
    "gh",
    "api",
    "--paginate",
    `repos/${repo}/labels`,
    "--jq",
    ".[].name",
  ]);
  if (proc.exitCode !== 0) {
    const detail = proc.stderr.trim().split("\n")[0];
    // Every 404 is permission-shaped; the rate-limit exclusion applies to
    // 403 alone (rate-limit responses are 403s).
    const forbidden =
      proc.stderr.includes("HTTP 404") ||
      (proc.stderr.includes("HTTP 403") && !/rate limit/i.test(proc.stderr));
    if (forbidden) return { kind: "forbidden", detail };
    throw new Error(
      `${repo}: cannot list the live labels (${detail}) - ` +
        "without them the preflight cannot tell what the apply would remove",
    );
  }
  return { kind: "ok", names: proc.stdout.split("\n").filter((name) => name !== "") };
}

const listRepoDir: RepoDirLister = (repo, dir, ref) => {
  const proc = captureNetwork(["gh", "api", `repos/${repo}/contents/${dir}?ref=${ref}`]);
  if (proc.exitCode !== 0) {
    if (proc.stderr.includes("HTTP 404")) return null;
    throw new Error(`${repo}/${dir}@${ref}: listing failed (${proc.stderr.trim().split("\n")[0]})`);
  }
  const entries: unknown = JSON.parse(proc.stdout);
  if (!Array.isArray(entries)) return null; // the path is a file, not a directory
  return entries.flatMap((entry) =>
    isMapping(entry) && entry.type === "file" && typeof entry.name === "string" ? [entry.name] : [],
  );
};

const readRepoFile: RepoFileReader = (repo, path, ref) => {
  const text = fetchRepoFile(repo, path, ref);
  if (text === null) {
    // Listed a moment ago at the SAME pinned ref, so a 404 here is not a
    // race - it is damage, and reading it as "no references" fails open.
    throw new Error(`${repo}/${path}@${ref}: listed but unreadable`);
  }
  return text;
};

/** Where the reference files come from - the same union shape as the
 *  merge's RepoSource, for the same reason: exactly one source, checked
 *  where the flags are parsed, so no downstream cast can degrade it. */
export type ReferenceSource = { kind: "dir"; path: string } | { kind: "fetch"; ref: string };

export function referenceSourceFrom(
  targetDir: string | undefined,
  ref: string | undefined,
): ReferenceSource {
  if (targetDir !== undefined && ref !== undefined) {
    throw new Error("--target-dir and --ref are mutually exclusive - pass one reference source");
  }
  if (targetDir !== undefined) return { kind: "dir", path: targetDir };
  if (ref === undefined || !/^[0-9a-f]{40}$/.test(ref)) {
    throw new Error(
      `pass a reference source: --target-dir <checkout>, or --ref <40-hex commit sha> ` +
        `(got ${JSON.stringify(ref ?? "")}) - fetched reference files must be read at the ` +
        "same commit the merged document's facts were",
    );
  }
  return { kind: "fetch", ref };
}

/** A comma-separated section list (the action's own format), entries
 *  trimmed, [] when unset or blank. */
function listedSections(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [];
  return value
    .split(",")
    .map((section) => section.trim())
    .filter((section) => section !== "");
}

/** Whether the action's `sections` allowlist lets it reconcile labels:
 *  empty means every section (the action's default), otherwise the list
 *  must name `labels`. Mirrored here so the preflight never fails a
 *  caller whose apply was never going to touch labels. */
export function sectionsSelectLabels(sections: string | undefined): boolean {
  const listed = listedSections(sections);
  return listed.length === 0 || listed.includes("labels");
}

/** Whether the action's `required_sections` names labels - the OPPOSITE
 *  default from the allowlist: empty requires nothing. A required labels
 *  section fails the action even under on-missing-permission: warn, so
 *  the preflight must not stand down where the apply would go red. */
export function labelsRequired(requiredSections: string | undefined): boolean {
  return listedSections(requiredSections).includes("labels");
}

/** An optional enum flag, validated where it is parsed. */
function enumFlag<T extends string>(name: string, value: string | undefined, allowed: T[]): T {
  if (value === undefined || value === "") return allowed[0];
  if ((allowed as string[]).includes(value)) return value as T;
  fail(`${name} must be one of ${allowed.join(", ")} (got ${JSON.stringify(value)})`);
}

/** The fixed stand-down categories. A CLOSED union rather than string:
 *  the reason rides a step output into the workflow's PUBLIC notice, so
 *  "value-free" must hold by type - a future caller cannot smuggle target
 *  content into the public log without changing this union. */
export type StandDownReason =
  | "the sections allowlist does not select labels, so this apply reconciles no labels"
  | "the merged settings document declares no labels key, so the apply reconciles (deletes or renames) no labels"
  | "the token cannot read the live labels, and on-missing-permission is warn";

/** The guard stood down without checking: published as step outputs (a
 *  hidden target's capture swallows the log line, and a stood-down guard
 *  must not look like one that checked and passed) and logged. */
function standDown(repo: string, reason: StandDownReason): void {
  setOutput("not_applicable", "true");
  setOutput("reason", reason);
  console.log(`${repo}: preflight not applicable - ${reason}`);
}

function main(args: string[]): void {
  const flags = parseFlags(
    args,
    ["--merged", "--repo"] as const,
    [
      "--target-dir",
      "--ref",
      "--sections",
      "--required-sections",
      "--mode",
      "--on-missing-permission",
    ] as const,
  );
  const repo = flags["--repo"];
  let source: ReferenceSource;
  const mode = enumFlag("--mode", flags["--mode"], ["apply", "check"]);
  // A required labels section outranks the warn tolerance, exactly like
  // the action's own required_sections input does.
  const tolerateMissingPermission =
    enumFlag("--on-missing-permission", flags["--on-missing-permission"], ["fail", "warn"]) ===
      "warn" && !labelsRequired(flags["--required-sections"]);
  try {
    source = referenceSourceFrom(flags["--target-dir"], flags["--ref"]);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  try {
    const merged = parseSettingsDoc(readFileSync(flags["--merged"], "utf-8"), flags["--merged"]);
    const finalNames = finalLabelNames(merged);
    if (!sectionsSelectLabels(flags["--sections"])) {
      standDown(
        repo,
        "the sections allowlist does not select labels, so this apply reconciles no labels",
      );
      return;
    }
    if (finalNames === null) {
      standDown(
        repo,
        "the merged settings document declares no labels key, so the apply reconciles (deletes or renames) no labels",
      );
      return;
    }
    const live = fetchLiveLabelNames(repo);
    if (live.kind === "forbidden") {
      if (!tolerateMissingPermission) {
        throw new Error(
          `${repo}: cannot list the live labels (${live.detail}) - grant the token Issues ` +
            "read, or run with on-missing-permission: warn (and labels outside " +
            "required_sections), under which the labels section skips",
        );
      }
      warning(
        `${repo}: the token cannot list the live labels (missing permission), so the label ` +
          "preflight cannot run - standing down because on-missing-permission is warn, under " +
          "which the apply's own labels section warns and skips the same way",
      );
      standDown(repo, "the token cannot read the live labels, and on-missing-permission is warn");
      return;
    }
    setOutput("not_applicable", "false");
    setOutput("reason", "");
    const files =
      source.kind === "dir"
        ? referenceFilesFromDir(source.path)
        : referenceFilesFromFetch(repo, source.ref, listRepoDir, readRepoFile);
    const references = collectReferences(files);
    const blocked = blockedRemovals(references, live.names, finalNames);
    if (blocked.length > 0) {
      const messages = blocked.map(
        (reference) =>
          `${repo}: the apply would REMOVE label ${JSON.stringify(reference.label)} (deleted, ` +
          `or renamed away via new_name), which is still referenced by ` +
          `${reference.files.join(", ")}. Declare the label in the repository's ` +
          ".github/settings.yml (or a fleet/module layer), or remove the reference, before " +
          "this repository's settings can apply.",
      );
      if (mode === "apply") fail(messages);
      // Check mode deletes nothing: report the would-be blocks as
      // warnings and let the run keep its drift report.
      for (const message of messages) warning(message);
      console.log(
        `${repo}: check mode - the apply would be BLOCKED for ${blocked.length} referenced label(s)`,
      );
      return;
    }
    console.log(
      `${repo}: no referenced label is scheduled for removal ` +
        `(${references.length} referenced, ${finalNames.length} in the post-apply roster)`,
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
