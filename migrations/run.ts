#!/usr/bin/env bun
// From-version migration runner (pattern from copilot-env src/migrations).
//
// Copier's native `_migrations` gates each entry on the version being updated
// TO, which forces authors to predict the next release number - awkward with
// release-please, where the number is only known when the release PR merges.
// Instead copier.yml registers this single unconditional runner, and selection
// happens here: each migration script is named for the release it migrates
// AWAY from and runs when an update leaves that version behind, i.e. its
// version falls in the half-open range [from, to).
//
// Contract for migrations/<X.Y.Z>.ts scripts:
// - named for the released version they migrate away from (bare X.Y.Z)
// - executed with bun, cwd = the downstream repository being updated
// - IDEMPOTENT: an update can be retried, so a script may run more than once
// - best-effort: a failing script warns and the rest still run (the sync PR's
//   validation step catches structural damage); migrations must never abort
//   an otherwise-successful update
//
// Invoked by copier with VERSION_FROM / VERSION_TO / STAGE in the environment
// (positional args override: run.ts <from> <to>). Versions arrive as git refs
// of the build branches: `templates/vX.Y.Z` build tags on the latest channel
// (the prefix is stripped here), or describe/sha strings on the staging
// channel, which do not parse as semver - staging updates run no migrations.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

type Version = [number, number, number];

function parse(version: string): Version | null {
  let v = version.trim();
  if (v.startsWith("templates/")) v = v.slice("templates/".length);
  if (v.startsWith("v")) v = v.slice(1);
  const match = SEMVER.exec(v);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** Scripts whose from-version falls in [vfrom, vto), ascending. */
function dueMigrations(vfrom: Version, vto: Version): [Version, string][] {
  const due: [Version, string][] = [];
  for (const name of readdirSync(HERE)) {
    if (!name.endsWith(".ts") || name === "run.ts") continue;
    const version = parse(name.slice(0, -".ts".length));
    if (version && compare(vfrom, version) <= 0 && compare(version, vto) < 0) {
      due.push([version, name]);
    }
  }
  return due.sort(([a], [b]) => compare(a, b));
}

function main(): number {
  const args = process.argv.slice(2);
  const versionFrom = args[0] ?? process.env.VERSION_FROM ?? "";
  const versionTo = args[1] ?? process.env.VERSION_TO ?? "";
  const vfrom = parse(versionFrom);
  const vto = parse(versionTo);

  if (vfrom === null || vto === null || compare(vto, vfrom) <= 0) {
    console.log(`migrations: nothing to do (from=${versionFrom || "?"} to=${versionTo || "?"})`);
    return 0;
  }

  const due = dueMigrations(vfrom, vto);
  if (due.length === 0) {
    console.log(`migrations: none due for ${versionFrom} -> ${versionTo}`);
    return 0;
  }

  for (const [version, name] of due) {
    const label = version.join(".");
    console.log(`migrating from ${label}: ${name}`);
    const result = spawnSync("bun", [join(HERE, name)], { stdio: "inherit" });
    if (result.status !== 0) {
      console.error(`warning: migration ${label} exited ${result.status} (non-fatal)`);
    }
  }
  return 0;
}

process.exit(main());
