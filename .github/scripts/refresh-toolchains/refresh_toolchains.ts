#!/usr/bin/env bun
// Weekly refresher for the toolchain version pins: fetch each pinned
// toolchain's latest upstream version (bun's latest GitHub release, Node's
// newest LTS line, Deno's latest stable release), rewrite the manifests'
// pin version lines in place (line-targeted, so manifest comments and
// layout survive), and regenerate the derived outputs (the pinned
// dotfiles, the validator/docs regions, the dogfood copies). The workflow
// around it commits and opens the PR, mirroring refresh-gitignore.
//
// Emits to GITHUB_OUTPUT: `bumps=<prose list>` (empty when everything is
// already current), e.g. "bun to 1.3.15 and deno to 2.9.6", and
// `major=<fragments>` naming any major-version jumps ("node 24 -> 26")
// for the PR body's prominent callout. A source that cannot be fetched or
// parsed is a per-module ::warning (the others still refresh); the run
// aborts only when no source at all could be fetched. A fetched "latest"
// LOWER than the current pin (date-ordered /releases/latest can surface a
// backport on an older line) is warned about and never applied.
//
// Usage: bun .github/scripts/refresh-toolchains/refresh_toolchains.ts

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadManifests } from "../../../scripts/module_manifests.ts";
import { must } from "../shared/proc.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

function versionFrom(value: unknown, pattern: RegExp, what: string): string {
  if (typeof value !== "string") {
    throw new Error(`${what}: expected a string, got ${typeof value}`);
  }
  const match = pattern.exec(value);
  if (!match) throw new Error(`${what}: '${value}' does not match ${pattern}`);
  return match[1];
}

/** GitHub releases/latest payload for oven-sh/bun: tag bun-vX.Y.Z. */
export function latestBunVersion(payload: unknown): string {
  const tag = (payload as { tag_name?: unknown } | null)?.tag_name;
  return versionFrom(tag, /^bun-v(\d+\.\d+\.\d+)$/, "oven-sh/bun latest release tag");
}

/** nodejs.org/dist/index.json: the first (newest) entry whose lts field is
 *  a non-empty codename string is the newest release of the newest LTS
 *  line (non-LTS entries carry lts: false; anything else is malformed and
 *  must not be mistaken for an LTS). */
export function latestNodeLts(payload: unknown): string {
  if (!Array.isArray(payload)) {
    throw new Error("nodejs.org dist index: expected an array of releases");
  }
  const entry = payload.find(
    (release) =>
      typeof release === "object" &&
      release !== null &&
      typeof (release as { lts?: unknown }).lts === "string" &&
      (release as { lts: string }).lts !== "",
  );
  if (entry === undefined) throw new Error("nodejs.org dist index: no LTS release found");
  return versionFrom(
    (entry as { version?: unknown }).version,
    /^v(\d+\.\d+\.\d+)$/,
    "nodejs.org LTS version",
  );
}

/** GitHub releases/latest payload for denoland/deno: tag vX.Y.Z (the
 *  endpoint never returns prereleases, so this is the latest stable). */
export function latestDenoVersion(payload: unknown): string {
  const tag = (payload as { tag_name?: unknown } | null)?.tag_name;
  return versionFrom(tag, /^v(\d+\.\d+\.\d+)$/, "denoland/deno latest release tag");
}

/** Upstream source per pinned module. A pinned manifest without an entry
 *  here (or a stale entry without a pinned manifest) fails the run. */
export const PIN_SOURCES: Record<string, { url: string; parse: (payload: unknown) => string }> = {
  bun: {
    url: "https://api.github.com/repos/oven-sh/bun/releases/latest",
    parse: latestBunVersion,
  },
  node: { url: "https://nodejs.org/dist/index.json", parse: latestNodeLts },
  deno: {
    url: "https://api.github.com/repos/denoland/deno/releases/latest",
    parse: latestDenoVersion,
  },
};

/** Rewrite the manifest's `version:` line inside its `pin:` block, leaving
 *  every other byte (comments, layout, key order) untouched. The line must
 *  be exactly `version: X.Y.Z` - a quoted value or a trailing comment
 *  fails loudly rather than being skipped or half-rewritten. */
export function bumpPinVersion(text: string, version: string, where: string): string {
  const lines = text.split("\n");
  const pinAt = lines.findIndex((line) => /^\s*pin:\s*$/.test(line));
  if (pinAt === -1) throw new Error(`${where}: no pin block found`);
  const pinIndent = lines[pinAt].length - lines[pinAt].trimStart().length;
  for (let i = pinAt + 1; i < lines.length; i++) {
    const line = lines[i];
    const indent = line.length - line.trimStart().length;
    if (line.trim() !== "" && indent <= pinIndent) break;
    if (!line.trim().startsWith("version:")) continue;
    const match = /^(\s*version: )\d+\.\d+\.\d+$/.exec(line);
    if (!match) {
      throw new Error(
        `${where}: the pin version line must be exactly 'version: X.Y.Z' ` +
          `(no quotes, no trailing comment), got '${line.trim()}'`,
      );
    }
    lines[i] = `${match[1]}${version}`;
    return lines.join("\n");
  }
  throw new Error(`${where}: pin block has no version line`);
}

export interface Bump {
  module: string;
  from: string;
  version: string;
}

/** Numeric X.Y.Z comparison: negative when a < b, zero when equal. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** What a fetched version means for the pin. GitHub's /releases/latest is
 *  most-recent-by-DATE, so a backport patch on an older line can surface
 *  as "latest" - never auto-downgrade (a genuine rollback is a deliberate
 *  hand edit, not an automated bump). */
export function decideBump(pinned: string, fetched: string): "bump" | "current" | "downgrade" {
  const order = compareVersions(fetched, pinned);
  return order === 0 ? "current" : order < 0 ? "downgrade" : "bump";
}

/** "bun to 1.3.15" / "bun to 1.3.15 and deno to 2.9.6" / an ", and" list. */
export function proseBumps(bumps: Bump[]): string {
  const parts = bumps.map((b) => `${b.module} to ${b.version}`);
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/** The bumps crossing a major version (an LTS transition, a bun 2.0), as
 *  "node 24 -> 26" fragments for the PR body's prominent callout. */
export function majorJumps(bumps: Bump[]): string {
  return bumps
    .filter((b) => b.from.split(".")[0] !== b.version.split(".")[0])
    .map((b) => `${b.module} ${b.from.split(".")[0]} -> ${b.version.split(".")[0]}`)
    .join(", ");
}

async function fetchJson(url: string): Promise<unknown> {
  const headers: Record<string, string> = { "user-agent": "repo-platform-refresh-toolchains" };
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (token && url.startsWith("https://api.github.com/")) {
    headers.authorization = `Bearer ${token}`;
  }
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status}`);
  return response.json();
}

async function main(): Promise<number> {
  const pinned = loadManifests().flatMap((m) =>
    m.toolchain?.pin ? [{ module: m.module, pin: m.toolchain.pin }] : [],
  );
  for (const { module } of pinned) {
    if (!(module in PIN_SOURCES)) {
      throw new Error(
        `templates/${module}/module.yml declares a toolchain pin but ` +
          "refresh_toolchains.ts has no upstream source for it - add a " +
          "PIN_SOURCES entry",
      );
    }
  }
  for (const module of Object.keys(PIN_SOURCES)) {
    if (!pinned.some((p) => p.module === module)) {
      throw new Error(
        `PIN_SOURCES names '${module}', which declares no toolchain pin - ` +
          "remove the stale entry",
      );
    }
  }

  // Fetch and parse EVERY source before touching any manifest, so a bad
  // upstream cannot abort the run mid-write. A single failing source is a
  // warning (the others still refresh); only a total blackout aborts.
  const latests: { module: string; pin: { file: string; version: string }; latest: string }[] = [];
  for (const { module, pin } of pinned) {
    const source = PIN_SOURCES[module];
    try {
      latests.push({ module, pin, latest: source.parse(await fetchJson(source.url)) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`::warning::${module}: skipping this refresh (${message})`);
    }
  }
  if (latests.length === 0) {
    throw new Error("no toolchain source could be fetched - refusing to refresh nothing");
  }

  // Compute every rewrite before writing anything, for the same reason.
  const writes: { path: string; next: string }[] = [];
  const bumps: Bump[] = [];
  for (const { module, pin, latest } of latests) {
    const decision = decideBump(pin.version, latest);
    if (decision === "current") {
      console.log(`${module}: ${pin.version} is current`);
      continue;
    }
    if (decision === "downgrade") {
      console.log(
        `::warning::${module}: upstream latest ${latest} is OLDER than the pinned ` +
          `${pin.version} (a backport release surfacing as latest?) - not downgrading`,
      );
      continue;
    }
    const manifestPath = join(REPO_ROOT, "templates", module, "module.yml");
    const where = `templates/${module}/module.yml`;
    writes.push({
      path: manifestPath,
      next: bumpPinVersion(readFileSync(manifestPath, "utf-8"), latest, where),
    });
    console.log(`${module}: ${pin.version} -> ${latest}`);
    bumps.push({ module, from: pin.version, version: latest });
  }
  for (const { path, next } of writes) writeFileSync(path, next);

  if (bumps.length > 0) {
    must(["bun", "run", "generate"], { cwd: REPO_ROOT });
    must(["bun", "run", "dogfood"], { cwd: REPO_ROOT });
  } else {
    console.log("all toolchain pins are current; nothing to regenerate");
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `bumps=${proseBumps(bumps)}\nmajor=${majorJumps(bumps)}\n`,
    );
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
