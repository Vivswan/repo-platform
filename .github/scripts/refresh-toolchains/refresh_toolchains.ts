#!/usr/bin/env bun
// files.yml's pin lines are rewritten in place, line-targeted, so its comments and layout survive; the workflow around it commits
// and opens the PR.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { toolchainPins } from "../../../scripts/generate/toolchain_pins.ts";
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

/** The dist index is newest-first, and `lts` is false or the line's codename, so the first entry whose `lts` is a non-empty string
 *  is the newest LTS release. */
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
  node: { url: "https://nodejs.org/dist/index.json", parse: latestNodeLts },
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

/** GitHub's /releases/latest is most-recent-by-DATE, so a backport patch on an older line can surface as "latest"; a genuine
 *  rollback is a deliberate hand edit, never an automated downgrade. */
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

/** Both failure messages are fixed strings: fetch()'s rejections and response.json()'s carry runtime-generated text, and main()
 *  publishes this message as a public ::warning. */
export async function fetchJson(url: string): Promise<unknown> {
  const headers: Record<string, string> = { "user-agent": "repo-platform-refresh-toolchains" };
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (token && url.startsWith("https://api.github.com/")) {
    headers.authorization = `Bearer ${token}`;
  }
  let response: Response;
  try {
    // A hung upstream should fail this one source fast (each source
    // already degrades to a warning) instead of leaning on the job
    // timeout.
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

  // Fetch and parse EVERY source before touching files.yml, so a bad
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
