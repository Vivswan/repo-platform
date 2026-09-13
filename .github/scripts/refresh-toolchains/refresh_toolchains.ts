#!/usr/bin/env bun
// The one writer of the toolchain pins: each version dotfile under files/ is the pin's only spelling, read by the
// sync, the operator's workflows, and the composite actions. The workflow around this script commits and opens the PR.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PLATFORM_NAME } from "../../../actions/shared/platform.ts";
import { BUN_PIN_FILE, bunLockDirs } from "../../../scripts/bootstrap.ts";
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

export interface PinSource {
  /** The version dotfile the sync delivers to every repository selecting the module: the pin's one spelling. */
  file: string;
  url: string;
  parse: (payload: unknown) => string;
}

export const PIN_SOURCES: Record<string, PinSource> = {
  bun: {
    file: BUN_PIN_FILE,
    url: "https://api.github.com/repos/oven-sh/bun/releases/latest",
    parse: latestBunVersion,
  },
  deno: {
    file: "files/deno/.dvmrc",
    url: "https://api.github.com/repos/denoland/deno/releases/latest",
    parse: latestDenoVersion,
  },
};

/** Exactly the version plus a newline, what the setup actions' version-file inputs read. */
export function pinnedVersion(text: string, where: string): string {
  return versionFrom(text, /^(\d+\.\d+\.\d+)\n?$/, where);
}

/** Every package declaring @types/bun: the types are published per bun release and ride the runtime pin exactly, so this
 *  script is their one writer (dependabot.yml ignores the package). A run before the matching types publish fails at the
 *  add and the next scheduled run retries. */
export function typesBunDirs(root: string): string[] {
  return bunLockDirs(root).filter((dir) => {
    const pkg = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf-8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    return ["dependencies", "devDependencies"].some(
      (key) => pkg[key]?.["@types/bun"] !== undefined,
    );
  });
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
  const pinned = Object.entries(PIN_SOURCES).map(([module, source]) => ({
    module,
    file: source.file,
    version: pinnedVersion(readFileSync(join(REPO_ROOT, source.file), "utf-8"), source.file),
  }));
  // Every fetch and every verdict, then the writes: a bad upstream or a downgrade aborts before any dotfile is touched.
  const latests = await latestVersions(pinned);
  const moved = latests.filter(({ module, version, latest }) => {
    const verdict = decideBump(version, latest, module);
    console.log(
      verdict === "bump"
        ? `${module}: ${version} -> ${latest}`
        : `${module}: ${version} is current`,
    );
    return verdict === "bump";
  });
  for (const { file, latest } of moved) writeFileSync(join(REPO_ROOT, file), `${latest}\n`);
  const bumps: Bump[] = moved.map(({ module, version, latest }) => ({
    module,
    from: version,
    version: latest,
  }));
  const bun = bumps.find((bump) => bump.module === "bun");
  if (bun !== undefined) {
    for (const dir of typesBunDirs(REPO_ROOT)) {
      must(["bun", "add", "--dev", "--exact", `@types/bun@${bun.version}`], {
        cwd: join(REPO_ROOT, dir),
      });
    }
  }
  if (bumps.length === 0) console.log("all toolchain pins are current");
  if (process.env.GITHUB_OUTPUT) {
    setOutput("bumps", proseBumps(bumps));
    setOutput("body", prBody(bumps));
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
