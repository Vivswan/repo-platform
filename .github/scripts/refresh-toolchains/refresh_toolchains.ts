#!/usr/bin/env bun
// files.yml's pin lines are rewritten in place, line-targeted, so its comments and layout survive; the workflow around it commits
// and opens the PR.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PLATFORM_NAME } from "../../../actions/shared/platform.ts";
import { toolchainPins } from "../../../scripts/generate/toolchain_pins.ts";
import { setOutput } from "../shared/gha.ts";
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

export function latestBunVersion(payload: unknown): string {
  const tag = (payload as { tag_name?: unknown } | null)?.tag_name;
  return versionFrom(tag, /^bun-v(\d+\.\d+\.\d+)$/, "oven-sh/bun latest release tag");
}

/** releases/latest never returns a prerelease, so this is the latest stable. */
export function latestDenoVersion(payload: unknown): string {
  const tag = (payload as { tag_name?: unknown } | null)?.tag_name;
  return versionFrom(tag, /^v(\d+\.\d+\.\d+)$/, "denoland/deno latest release tag");
}

export const PIN_SOURCES: Record<string, { url: string; parse: (payload: unknown) => string }> = {
  bun: {
    url: "https://api.github.com/repos/oven-sh/bun/releases/latest",
    parse: latestBunVersion,
  },
  deno: {
    url: "https://api.github.com/repos/denoland/deno/releases/latest",
    parse: latestDenoVersion,
  },
};

export function bumpFilesPin(text: string, module: string, version: string, where: string): string {
  const lines = text.split("\n");
  const modulesAt = lines.indexOf("modules:");
  if (modulesAt === -1) throw new Error(`${where}: no modules section found`);
  const moduleAt = lines.indexOf(`  ${module}:`, modulesAt + 1);
  if (moduleAt === -1) throw new Error(`${where}: no modules.${module} entry found`);
  for (let i = moduleAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() !== "" && !line.startsWith("    ")) break;
    if (!line.trim().startsWith("pin:")) continue;
    const match = /^( {4}pin: \{file: [^,}]+, version: )\d+\.\d+\.\d+\}$/.exec(line);
    if (!match) {
      throw new Error(
        `${where}: modules.${module}.pin must be exactly 'pin: {file: X, version: X.Y.Z}' ` +
          `(no quotes, no trailing comment), got '${line.trim()}'`,
      );
    }
    lines[i] = `${match[1]}${version}}`;
    return lines.join("\n");
  }
  throw new Error(`${where}: modules.${module} has no pin line`);
}

export interface Bump {
  module: string;
  from: string;
  version: string;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** GitHub's /releases/latest is most-recent-by-DATE, so a backport patch on an older line can surface as "latest". A genuine
 *  rollback is a deliberate hand edit, never an automated downgrade, and a run that saw one cannot tell whether main is
 *  behind upstream, so it aborts instead of reporting "nothing moved" (the workflow's PR step would close a valid PR on that). */
export function decideBump(pinned: string, fetched: string, what: string): "bump" | "current" {
  const order = compareVersions(fetched, pinned);
  if (order < 0) {
    throw new Error(
      `${what}: upstream latest ${fetched} is OLDER than the pinned ${pinned} ` +
        "(a backport release surfacing as latest?) - refusing to refresh on a view that cannot see upstream's newest",
    );
  }
  return order === 0 ? "current" : "bump";
}

/** "bun to 1.3.15" / "bun to 1.3.15 and deno to 2.9.6" / an ", and" list. */
export function proseBumps(bumps: Bump[]): string {
  const parts = bumps.map((b) => `${b.module} to ${b.version}`);
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/** The bumps crossing a major version (a bun 2.0, a deno 3.0), as
 *  "deno 2 -> 3" fragments for the PR body's prominent callout. */
function majorJumps(bumps: Bump[]): string {
  return bumps
    .filter((b) => b.from.split(".")[0] !== b.version.split(".")[0])
    .map((b) => `${b.module} ${b.from.split(".")[0]} -> ${b.version.split(".")[0]}`)
    .join(", ");
}

export function prBody(bumps: Bump[]): string {
  const summary =
    `Automated toolchain pin refresh: bump ${proseBumps(bumps)} (fleet-wide via the managed version dotfiles - ` +
    "see docs/toolchains.md). Merging this moves the stable tag once green; the next sync pushes it to the fleet.";
  const major = majorJumps(bumps);
  if (major === "") return summary;
  return `**MAJOR VERSION JUMP: ${major} - review before merging.**\n\n${summary}`;
}

/** Both failure messages are fixed strings: fetch()'s rejections and response.json()'s carry runtime-generated text, and this
 *  message is the run's public failure line. */
export async function fetchJson(url: string): Promise<unknown> {
  const headers: Record<string, string> = { "user-agent": `${PLATFORM_NAME}-refresh-toolchains` };
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (token && url.startsWith("https://api.github.com/")) {
    headers.authorization = `Bearer ${token}`;
  }
  let response: Response;
  try {
    // A hung upstream should fail the run fast instead of leaning on the
    // job timeout.
    response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new Error(`GET ${url} failed before a response (network, TLS, or timeout)`);
  }
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`GET ${url} returned a body that is not valid JSON`);
  }
}

/** Every source or none: a run that cannot see one upstream cannot tell "nothing moved" from "could not look", and an
 *  empty bumps output lets the workflow's PR step close a still-valid refresh PR as caught up. */
export async function latestVersions<T extends { module: string }>(
  pinned: T[],
  fetch: (url: string) => Promise<unknown> = fetchJson,
): Promise<(T & { latest: string })[]> {
  const latests: (T & { latest: string })[] = [];
  for (const entry of pinned) {
    const source = PIN_SOURCES[entry.module];
    latests.push({ ...entry, latest: source.parse(await fetch(source.url)) });
  }
  return latests;
}

async function main(): Promise<number> {
  const filesPath = join(REPO_ROOT, "files.yml");
  let filesText = readFileSync(filesPath, "utf-8");
  const pinned = toolchainPins(filesText).map(({ module, file, version }) => ({
    module,
    pin: { file, version },
  }));
  for (const { module } of pinned) {
    if (!(module in PIN_SOURCES)) {
      throw new Error(
        `files.yml modules.${module} declares a pin but refresh_toolchains.ts has no ` +
          "upstream source for it - add a PIN_SOURCES entry",
      );
    }
  }
  for (const module of Object.keys(PIN_SOURCES)) {
    if (!pinned.some((p) => p.module === module)) {
      throw new Error(
        `PIN_SOURCES names '${module}', which declares no pin in files.yml - remove the stale entry`,
      );
    }
  }

  // Every fetch, then every rewrite, then the one write: a bad upstream or
  // a malformed pin line aborts before files.yml is touched.
  const latests = await latestVersions(pinned);
  const bumps: Bump[] = [];
  for (const { module, pin, latest } of latests) {
    if (decideBump(pin.version, latest, module) === "current") {
      console.log(`${module}: ${pin.version} is current`);
      continue;
    }
    filesText = bumpFilesPin(filesText, module, latest, "files.yml");
    console.log(`${module}: ${pin.version} -> ${latest}`);
    bumps.push({ module, from: pin.version, version: latest });
  }
  if (bumps.length > 0) {
    writeFileSync(filesPath, filesText);
    must(["bun", "run", "pins"], { cwd: REPO_ROOT });
  } else {
    console.log("all toolchain pins are current; nothing to regenerate");
  }
  if (process.env.GITHUB_OUTPUT) {
    setOutput("bumps", proseBumps(bumps));
    setOutput("body", prBody(bumps));
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
