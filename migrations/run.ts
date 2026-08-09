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
// channel, which do not parse as semver. An unparseable TO means the update
// lands on staging: no migrations run. An unparseable FROM under a parseable
// TO is a channel switch (staging -> latest): the base version is unknowable,
// so ALL migrations up to TO run - the idempotence contract makes
// over-running safe, while skipping would silently forfeit every migration
// due since the repo joined staging.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export type Version = [number, number, number];

export function parse(version: string): Version | null {
  let v = version.trim();
  if (v.startsWith("templates/")) v = v.slice("templates/".length);
  if (v.startsWith("v")) v = v.slice(1);
  const match = SEMVER.exec(v);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** Scripts among `names` whose from-version falls in [vfrom, vto), ascending. */
export function dueMigrations(
  vfrom: Version,
  vto: Version,
  names: readonly string[],
): [Version, string][] {
  const due: [Version, string][] = [];
  for (const name of names) {
    if (!name.endsWith(".ts") || name === "run.ts") continue;
    const version = parse(name.slice(0, -".ts".length));
    if (version && compare(vfrom, version) <= 0 && compare(version, vto) < 0) {
      due.push([version, name]);
    }
  }
  return due.sort(([a], [b]) => compare(a, b));
}

/**
 * The version range an update crosses, or null when no migrations apply.
 * Unparseable TO: the update lands on the staging channel - null. Parseable
 * both: the usual [from, to) range, null when it is empty. Unparseable FROM
 * under a parseable TO: the staging -> latest channel switch - the range
 * starts at 0.0.0 so every migration up to TO is due (`channelSwitch` tells
 * the caller to say so out loud).
 */
export function migrationRange(
  versionFrom: string,
  versionTo: string,
): { vfrom: Version; vto: Version; channelSwitch: boolean } | null {
  const vto = parse(versionTo);
  if (vto === null) return null;
  const vfrom = parse(versionFrom);
  if (vfrom === null) return { vfrom: [0, 0, 0], vto, channelSwitch: true };
  if (compare(vto, vfrom) <= 0) return null;
  return { vfrom, vto, channelSwitch: false };
}

function main(): number {
  const args = process.argv.slice(2);
  const versionFrom = args[0] ?? process.env.VERSION_FROM ?? "";
  const versionTo = args[1] ?? process.env.VERSION_TO ?? "";
  const range = migrationRange(versionFrom, versionTo);

  if (range === null) {
    console.log(`migrations: nothing to do (from=${versionFrom || "?"} to=${versionTo || "?"})`);
    return 0;
  }

  const due = dueMigrations(range.vfrom, range.vto, readdirSync(HERE));
  if (due.length === 0) {
    console.log(`migrations: none due for ${versionFrom || "?"} -> ${versionTo}`);
    return 0;
  }
  if (range.channelSwitch) {
    console.log(
      `migrations: base '${versionFrom || "?"}' does not parse as a released ` +
        `templates/vX.Y.Z version - that usually means the repo is leaving the staging ` +
        `channel, so ALL migrations up to ${versionTo} run (migrations are idempotent, ` +
        `so over-running is safe)`,
    );
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

if (import.meta.main) process.exit(main());
