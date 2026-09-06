#!/usr/bin/env bun
// Umbrella generator for the marker-fenced GENERATED regions derived from
// the module manifests (templates/<module>/module.yml, loaded by
// scripts/lib/module_manifests.ts):
//
// - copier.yml: the modules question's choices block, the has_toolchain
//   default expression, the pages_setup default + validator, the
//   pages_install_command / pages_build_command default chains, and the
//   tracking-label questions' validators (shape, the reserved-label
//   roster the settings baseline generator declares, and cross-stream
//   distinctness).
// - actions/validate-template-report/validator/ownership.ts: the
//   KNOWN_MODULES set literal, the TOOLCHAIN_PINS record literal, and the
//   MODULE_OWNERSHIP and BASE_OWNERSHIP records (each rendered file's
//   declared ownership, from the module.yml `ownership:` lists and
//   templates/base/ownership.yml plus the sources' header/marker
//   decoration; the action imports only the shipped actions/shared/ zone
//   for client-side execution; only the constants' authorship is
//   generated).
// - README.md, docs/new-repo.md, docs/settings.md, docs/pages.md,
//   docs/toolchains.md, the module rosters in skills/: the prose that enumerates manifest data (module
//   roster, dependabot labels, pages toolchain defaults, toolchain pins).
// - templates/module.schema.json: a WHOLE generated file (no markers), the
//   JSON Schema the manifests' yaml-language-server directive points at,
//   derived from the zod schema in scripts/lib/module_manifests.ts.
// - templates/<module>/<pin.file> for every manifest toolchain pin: WHOLE
//   generated dotfiles carrying exactly the pinned version plus a newline.
// - actions/<dir>/.bun-version for every action calling the shared
//   bun-setup action: WHOLE dotfiles carrying the manifests' bun pin, so
//   the actions never ride the CALLER's bun resolution.
// - templates/base/.github/workflows/ci.yml.jinja and
//   templates/release-please/.github/workflows/release.yml.jinja:
//   the tracking-labels input both release-health call sites pass, built
//   from the manifests' tracking_label streams (jinja-comment markers, so
//   a rendered downstream workflow carries no marker text).
//
// The .gitignore outputs are NOT owned here: scripts/generate/build_gitignore.ts
// fetches them from github/gitignore HEAD on every run, so regeneration
// lives outside `bun run regen`. The refresh-gitignore workflow is the only
// caller of that networked path; `bun run check` and CI's validate job also
// call the script with --topology for offline validation.
//
// A region is the content strictly between its BEGIN/END marker comments;
// the markers themselves are hand-placed once and never rewritten. Editing
// a region by hand is drift: --check fails CI until it is regenerated.
// Every target's output is computed before anything is written, so a
// broken marker in one file never leaves another half-updated.
//
// Line-comment files (#, //) carry the markers on lines of their own, and
// jinja templates the same way as `{#- ... #}` comment lines (the leading
// dash folds the marker line into the preceding line's whitespace the way
// the fenced `{%- if %}` blocks already do, so rendering leaves no blank
// lines behind). In
// markdown that is impossible without visible damage - a standalone
// comment line is a CommonMark HTML block that severs the paragraph,
// list, or table it sits in - so markdown markers ride INLINE at the ends
// of content lines and render as invisible inline HTML: the BEGIN marker
// ends the line preceding the region, the END marker ends the region's
// last line, and table-cell regions keep both markers inside the row.
// Markdown regions start and end at sentence or paragraph boundaries, so
// a hand-reword outside a region cannot strand a generated half-sentence.
//
// The pieces live under scripts/generate/: markers.ts (the marker grammar
// and splicing), the region builders by topic (copier_questions.ts,
// pages.ts, toolchain_pins.ts, ownership_regions.ts, doc_rosters.ts), and
// targets.ts (the per-file region roster and the whole generated files).
//
// Usage:
//   bun scripts/generate.ts           # rewrite every generated region
//   bun scripts/generate.ts --check   # exit 1 if any region is stale

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { reservedLabelNames } from "./generate/copier_questions.ts";
import { spliceInlineRegion, spliceRegion } from "./generate/markers.ts";
import { pagesManifests } from "./generate/pages.ts";
import { type RegionInputs, targets, wholeFiles } from "./generate/targets.ts";
import { strayActionPinFiles, strayPinFiles } from "./generate/toolchain_pins.ts";
import { loadManifests } from "./lib/module_manifests.ts";
import { baseOwnershipTables, moduleOwnershipEntries } from "./ownership/enforcement_tables.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

function main(): number {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const unknown = args.filter((a) => a !== "--check");
  if (unknown.length > 0) {
    console.error(`error: unrecognized argument(s): ${unknown.join(" ")}`);
    return 2;
  }

  // Compute every output before writing anything: a bad manifest or a
  // broken marker aborts cleanly instead of leaving a target half-updated.
  let changed: { path: string; file: string; next: string; stale: string }[];
  try {
    const manifests = loadManifests();
    const strays = strayPinFiles(manifests, join(REPO_ROOT, "templates"));
    if (strays.length > 0) {
      throw new Error(
        `stray toolchain version dotfile(s) not declared by any manifest pin: ` +
          `${strays.join(", ")} - a renamed or removed pin leaves the old file ` +
          "shipping to every render; delete it (or fix the manifest's pin.file)",
      );
    }
    const actionStrays = strayActionPinFiles(join(REPO_ROOT, "actions"));
    if (actionStrays.length > 0) {
      throw new Error(
        `stray action .bun-version dotfile(s) whose action.yml calls no bun-setup step: ` +
          `${actionStrays.join(", ")} - the generator would stop refreshing them ` +
          "while the stale pin keeps shipping on the build branch; delete the " +
          "file (or restore the action's bun-setup step)",
      );
    }
    const inputs: RegionInputs = {
      manifests,
      pages: pagesManifests(manifests),
      reserved: reservedLabelNames(manifests),
      moduleOwnership: moduleOwnershipEntries(manifests, join(REPO_ROOT, "templates")),
      baseOwnership: baseOwnershipTables(join(REPO_ROOT, "templates")),
    };
    const regionStale =
      "its generated region(s) do not match their sources (the module " +
      "manifests; the ownership declarations and template decoration for " +
      "the ownership regions; the settings baseline generator's label " +
      "roster for copier.yml's tracking-label validators)";
    changed = targets(manifests).flatMap((target) => {
      const path = join(REPO_ROOT, target.file);
      const current = readFileSync(path, "utf-8");
      let next = current;
      if (target.syntax === "line") {
        for (const [name, body, sources] of target.regions) {
          next = spliceRegion(next, target.file, name, target.prefix, body(inputs), "", sources);
        }
      } else if (target.syntax === "jinja") {
        for (const [name, body, sources] of target.regions) {
          next = spliceRegion(next, target.file, name, "{#-", body(inputs), "#}", sources);
        }
      } else {
        for (const [name, body] of target.regions ?? []) {
          next = spliceInlineRegion(next, target.file, name, body(inputs));
        }
        for (const [name, body] of target.inlineRegions ?? []) {
          next = spliceInlineRegion(next, target.file, name, body(inputs));
        }
      }
      return next === current ? [] : [{ path, file: target.file, next, stale: regionStale }];
    });
    changed.push(
      ...wholeFiles(manifests).flatMap(([file, content, stale]) => {
        const path = join(REPO_ROOT, file);
        const current = existsSync(path) ? readFileSync(path, "utf-8") : undefined;
        const next = content(inputs);
        return next === current ? [] : [{ path, file, next, stale }];
      }),
    );
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (check) {
    for (const { file, stale } of changed) {
      console.log(`${file} is stale: ${stale}; run bun run generate to rewrite it`);
    }
    if (changed.length > 0) return 1;
    console.log("generated regions are up to date");
    return 0;
  }
  for (const { path, file, next } of changed) {
    writeFileSync(path, next);
    console.log(`rewrote ${file}'s generated content`);
  }
  if (changed.length === 0) {
    console.log("generated content already matches its sources; nothing to write");
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
