#!/usr/bin/env bun
// Umbrella generator for the marker-fenced GENERATED regions derived from
// the module manifests (templates/<module>/module.yml): copier.yml's
// questions and validators, validate-template's ownership tables, the doc
// and skill rosters, module.schema.json, the toolchain pin dotfiles (the
// template's and the sync writer's copy under files/), the actions'
// .bun-version files (so an action never rides the CALLER's bun
// resolution); the per-file roster is generate/targets.ts beside this file. The .gitignore outputs are
// NOT owned here: build_gitignore.ts fetches upstream on every run, so it
// lives outside `bun run regen` (docs/compose.md).
//
// A region is the content strictly between hand-placed BEGIN/END markers; a
// hand edit inside one is drift that --check fails, and every target's output
// is computed before anything is written so a broken marker in one file never
// leaves another half-updated. Markers sit on lines of their own EXCEPT in
// markdown, where a standalone comment line is a CommonMark HTML block that
// severs its paragraph, list, or table: there markers ride inline (BEGIN ends
// the line before the region, END ends its last line, a table cell keeps both
// in its row) and regions start and end at sentence boundaries so a hand
// reword outside one cannot strand a half-sentence. Usage: bun scripts/generate.ts [--check]

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
    const strays = [
      ...strayPinFiles(manifests, join(REPO_ROOT, "templates")),
      ...strayPinFiles(manifests, join(REPO_ROOT, "files"), "files"),
    ];
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
