#!/usr/bin/env bun
// Builds the per-repo apply matrix for settings-repos.yml: one entry per
// managed settings target, so the workflow can run one fail-fast-free
// matrix job per repository and one target's failure never blocks the
// heal for the others.
//
// Usage:
//   bun .github/scripts/fleet/build_settings_matrix.ts
//     --targets targets.json [--self owner/name] [--only owner/name[,owner/name...]]
//
// Targets come from --targets, a JSON array of the selector's enriched
// rows ({repo, redact_name, hide_details, display, verify, ...}) - the
// enrolled, adopted repos (a readable .repo-platform.yml). --self appends
// the operator repository itself: it
// is not adopted (no .repo-platform.yml), but its settings are managed by
// the same run (its baseline facts come from .repo-platform-answers.yml -
// see render_managed_settings.ts). Prints a JSON array of
// {repo, name, redact_name, verify} entries sorted by the emitted repo; a
// redacted row's `repo`/`name` carry its display hint so the matrix, the
// job name it becomes, and the called steps never see the slug (the apply
// leg re-resolves it from `verify`).

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { parseFlags } from "../shared/flags.ts";
import { fail } from "../shared/gha.ts";
import { readModules } from "../sync/modules.ts";
import { type EnrichedRow, parseEnrichedRows, type RedactionState } from "./redact.ts";

/** The module names a .repo-platform.yml text declares - the readable
 *  registration that makes a repository a settings target; null when the
 *  file or its top-level modules list is unreadable. One grammar with the
 *  sync's module selection (readModules), and logLevel error so a warned-on
 *  source line (target content) never reaches a public log. Lives here (not
 *  in the selector script, which runs at import time) so the parse stays
 *  unit-testable. */
export function declaredModules(registrationText: string): string[] | null {
  let data: unknown;
  try {
    data = parseYaml(registrationText, { logLevel: "error" });
  } catch {
    return null;
  }
  return readModules(data).modules;
}

// hide_details rides the matrix because the apply leg DOES have
// consumers for it now: the layer render and the merge run as workflow
// steps BEFORE the action, and their diagnostics quote repo-owned
// content (duplicate label and ruleset names, tracking-label values,
// parser errors). The action's own private-repos redaction cannot cover
// output produced before it runs, and a self-disclosed private repo
// (redact_name false, hide_details true) would otherwise have that
// content printed to a public log. settings-repos.yml passes this to
// run_hidden.ts, which is the boundary that keeps it out.
//
// The redaction triple keeps EnrichedRow's discriminated-union shape
// (RedactionState is derived from the row schema in redact.ts) instead
// of flattening to three independent fields: a redacted row always hides
// its details and always carries a resolution tag, so `redact_name:
// true, hide_details: false` - the combination the selector's schema
// exists to prevent - stays unrepresentable here too.
export type Target = { repo: string; name: string } & RedactionState;

/** The operator repository's own matrix row: committed workflows disclose
 *  its name, so it never redacts. */
export function selfTarget(self: string): Target {
  return {
    repo: self,
    name: self.split("/").pop() ?? self,
    redact_name: false,
    hide_details: false,
    verify: "",
  };
}

/** Merge the rows (plus an optional self target) into the matrix,
 *  deduplicating by slug case-insensitively, like GitHub. */
export function buildMatrix(rows: EnrichedRow[], self: Target | null): Target[] {
  const targets: Target[] = self === null ? [] : [self];
  const seen = new Set(targets.map((t) => t.repo.toLowerCase()));
  for (const row of rows) {
    const key = row.repo.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Branch on the discriminant rather than copying field by field, so
    // the row's union arm carries through to the Target unchanged.
    targets.push(
      row.redact_name
        ? {
            repo: row.display,
            name: row.display,
            redact_name: true,
            hide_details: true,
            verify: row.verify,
          }
        : {
            repo: row.repo,
            name: row.repo.split("/").pop() ?? row.repo,
            redact_name: false,
            hide_details: row.hide_details,
            verify: "",
          },
    );
  }
  return targets.sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));
}

/** Scope to the listed repositories (real owner/name slugs, comma
 *  separated, case-insensitive) for a dispatched or called run. Redaction
 *  has not happened yet - rows still carry the real slug - so a private
 *  target is matchable here and redacted as usual afterwards; the self
 *  target matches on its slug. */
export function applyOnly(
  rows: EnrichedRow[],
  self: Target | null,
  only: string,
): { rows: EnrichedRow[]; self: Target | null } {
  const wanted = new Set(only.split(",").map((entry) => entry.trim().toLowerCase()));
  return {
    rows: rows.filter((r) => wanted.has(r.repo.toLowerCase())),
    self: self !== null && wanted.has(self.repo.toLowerCase()) ? self : null,
  };
}

function loadRows(path: string): EnrichedRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    fail([`${path}: cannot read the settings target list`]);
  }
  return parseEnrichedRows(parsed, `${path}: settings target list`);
}

function main(args: string[]): void {
  const flags = parseFlags(args, ["--targets"], ["--self", "--only"]);
  let rows = loadRows(flags["--targets"]);
  let self = flags["--self"] === undefined ? null : selfTarget(flags["--self"]);
  const only = flags["--only"] ?? "";
  if (only !== "") ({ rows, self } = applyOnly(rows, self, only));
  console.log(JSON.stringify(buildMatrix(rows, self)));
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
