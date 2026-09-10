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
// rows ({repo, private, display, verify, ...}) - the enrolled, adopted
// repos (a readable .repo-platform.yml). --self appends the operator
// repository itself: it is not adopted (no .repo-platform.yml), but its
// settings are managed by the same run (its baseline facts come from
// .repo-platform-answers.yml - see settings_layers.ts). Prints a
// JSON array of {repo, name, private, verify} entries sorted by the
// emitted repo; a private row's `repo`/`name` carry its display hint so
// the matrix, the job name it becomes, and the called steps never see the
// slug (the apply leg re-resolves it from `verify`).

import { readFileSync } from "node:fs";
import { parseFlags } from "../shared/flags.ts";
import { fail } from "../shared/gha.ts";
import { type EnrichedRow, parseEnrichedRows, type RedactionState } from "./redact.ts";

// `private` rides the matrix so the layers step, which runs BEFORE the
// settings action and quotes repo-owned content, can hide it via run_hidden.ts.
// Derived from EnrichedRow's union, so a tagless private row is unrepresentable.
export type Target = { repo: string; name: string } & RedactionState;

/** The operator repository's own matrix row: committed workflows disclose
 *  its name, so it never redacts. */
export function selfTarget(self: string): Target {
  return {
    repo: self,
    name: self.split("/").pop() ?? self,
    private: false,
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
      row.private
        ? { repo: row.display, name: row.display, private: true, verify: row.verify }
        : {
            repo: row.repo,
            name: row.repo.split("/").pop() ?? row.repo,
            private: false,
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
