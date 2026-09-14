#!/usr/bin/env bun
// The one writer of the upstream pins: a commit pin (an upstream ref's sha in files.yml, fetched at by every sync) moves
// to its repository's HEAD; a release pin (a module's version dotfile under files/, read by the sync, the operator's
// workflows, and the composite actions) moves to its repository's latest release. The workflow around this script runs
// it once per kind and commits each kind on its own PR branch, so a toolchain bump is never held behind a gitignore diff.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isScalar, parseDocument, visit } from "yaml";
import {
  type FilesConfig,
  type ModulePin,
  PIN_VERSION_TOKEN,
  parseFilesConfig,
  type UpstreamRef,
  upstreamRefs,
} from "../../../actions/plan/files_config.ts";
import { BUN_PIN_FILE, bunLockDirs } from "../../../scripts/bootstrap.ts";
import { setOutput } from "../shared/gha.ts";
import { must } from "../shared/proc.ts";
import { unifiedDiff } from "../sync/writer/report.ts";
import { type Fetch, fetchText, fetchUpstream, RAW_HOST } from "../sync/writer/upstream.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const API_HOST = "https://api.github.com";

export const PIN_KINDS = ["commit", "release"] as const;
export type PinKind = (typeof PIN_KINDS)[number];

/** One api.github.com reply under the repository, read with the run token; the failure line is fixed text, never the body. */
async function api(repository: string, path: string, fetch: Fetch): Promise<unknown> {
  const headers: Record<string, string> = { accept: "application/vnd.github+json" };
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const url = `${API_HOST}/repos/${repository}/${path}`;
  const body = await fetch(url, headers);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`GET ${url} returned a body that is not valid JSON`);
  }
}

/** HEAD of the default branch. */
export async function headSha(repository: string, fetch: Fetch): Promise<string> {
  const reply = (await api(repository, "commits/HEAD", fetch)) as { sha?: unknown } | null;
  const sha = reply?.sha;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`${repository}: the commits/HEAD reply carries no full sha`);
  }
  return sha;
}

export interface CommitPin {
  repository: string;
  sha: string;
  /** Every file files.yml fetches at this pin, sorted. */
  paths: string[];
}

export function pins(refs: UpstreamRef[]): CommitPin[] {
  const seen = new Map<string, CommitPin>();
  for (const { repository, sha, path } of refs) {
    const key = `${repository}@${sha}`;
    const pin = seen.get(key) ?? { repository, sha, paths: [] };
    if (!pin.paths.includes(path)) pin.paths.push(path);
    seen.set(key, pin);
  }
  return [...seen.values()].map((pin) => ({ ...pin, paths: [...pin.paths].sort() }));
}

/** Every mapping spelling the pin (a source ref, a registry) moves together, by the sha scalar's own text range so the
 *  document keeps its bytes outside the sha scalar; a quoted pin comes back bare. The repository is part of the match,
 *  so another repository at the same sha stays put. */
export function repin(
  text: string,
  pin: Pick<CommitPin, "repository" | "sha">,
  to: string,
): string {
  const spans: [number, number][] = [];
  visit(parseDocument(text), {
    Map(_, map) {
      const repository = map.get("repository", true);
      const sha = map.get("sha", true);
      if (
        isScalar(repository) &&
        repository.value === pin.repository &&
        isScalar(sha) &&
        sha.value === pin.sha &&
        sha.range
      ) {
        spans.push([sha.range[0], sha.range[1]]);
      }
    },
  });
  if (spans.length === 0) {
    throw new Error(`files.yml names no pin ${pin.repository}@${pin.sha}`);
  }
  return spans
    .sort(([a], [b]) => b - a)
    .reduce((out, [start, end]) => `${out.slice(0, start)}${to}${out.slice(end)}`, text);
}

export type Bump =
  | {
      kind: "commit";
      /** The repository. */
      name: string;
      from: string;
      to: string;
      /** Path to its unified diff between the two commits, normalized as the writer fetches it; unchanged paths are absent. */
      diffs: Map<string, string>;
    }
  | {
      kind: "release";
      /** The module. */
      name: string;
      from: string;
      to: string;
    };

async function commitBump(pin: CommitPin, to: string, host: string, fetch: Fetch): Promise<Bump> {
  const refs = (sha: string) =>
    pin.paths.map((path) => ({ repository: pin.repository, sha, path }));
  const before = await fetchUpstream(refs(pin.sha), host, fetch);
  const after = await fetchUpstream(refs(to), host, fetch);
  const diffs = new Map<string, string>();
  for (const [old, next] of refs(pin.sha).map((ref, i) => [ref, refs(to)[i]] as const)) {
    if (before.body(old) !== after.body(next)) {
      diffs.set(old.path, unifiedDiff(old.path, before.body(old), after.body(next)));
    }
  }
  return { kind: "commit", name: pin.repository, from: pin.sha, to, diffs };
}

function versionFrom(value: unknown, pattern: RegExp, what: string): string {
  if (typeof value !== "string") {
    throw new Error(`${what}: expected a string, got ${typeof value}`);
  }
  const match = pattern.exec(value);
  if (!match) throw new Error(`${what}: '${value}' does not match ${pattern}`);
  return match[1];
}

/** The version a release tag spells under the pin's `tag` template, anchored and escaped: a tag of another shape (a
 *  canary, a foreign prefix) is refused, so it can never land in the dotfile. */
export function tagVersion(tag: unknown, template: string, what: string): string {
  const [before, after] = template.split(PIN_VERSION_TOKEN);
  const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return versionFrom(
    tag,
    new RegExp(`^${literal(before)}(\\d+\\.\\d+\\.\\d+)${literal(after)}$`),
    what,
  );
}

/** Exactly the version plus a newline, what the setup actions' version-file inputs read. */
export function pinnedVersion(text: string, where: string): string {
  return versionFrom(text, /^(\d+\.\d+\.\d+)\n$/, where);
}

function compareVersions(a: string, b: string): number {
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

/** Every package declaring @types/bun: the types are published per bun release and ride the runtime pin exactly, so this
 *  script is their one writer (dependabot.yml ignores the package). A run before the matching types publish fails at the
 *  add and the next scheduled run retries. Types are a dev dependency; a declaration under `dependencies` would be
 *  re-added under devDependencies here, so it is refused instead. */
export function typesBunDirs(root: string): string[] {
  return bunLockDirs(root).filter((dir) => {
    const pkg = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf-8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    if (pkg.dependencies?.["@types/bun"] !== undefined) {
      throw new Error(`${dir}/package.json: @types/bun belongs under devDependencies`);
    }
    return pkg.devDependencies?.["@types/bun"] !== undefined;
  });
}

interface ReleasePin extends ModulePin {
  module: string;
  version: string;
}

function releasePins(config: FilesConfig, root: string): ReleasePin[] {
  return Object.entries(config.modules).flatMap(([module, data]) =>
    data.pin === undefined
      ? []
      : [
          {
            module,
            ...data.pin,
            version: pinnedVersion(readFileSync(join(root, data.pin.file), "utf-8"), data.pin.file),
          },
        ],
  );
}

/** releases/latest never returns a prerelease, so this is the latest stable. */
async function latestRelease(pin: ModulePin, fetch: Fetch): Promise<string> {
  const reply = (await api(pin.repository, "releases/latest", fetch)) as {
    tag_name?: unknown;
  } | null;
  return tagVersion(reply?.tag_name, pin.tag, `${pin.repository} latest release tag`);
}

const shown = (bump: Bump, sha: string) => (bump.kind === "commit" ? sha.slice(0, 7) : sha);

/** "bun to 1.3.15" / "bun to 1.3.15 and deno to 2.9.6" / an ", and" list. */
export function proseBumps(bumps: Bump[]): string {
  const parts = bumps.map((b) => `${b.name} to ${shown(b, b.to)}`);
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/** The release bumps crossing a major line (a bun 2.0, a deno 3.0), as "deno 2 -> 3" fragments for the body's callout. */
function majorJumps(bumps: Bump[]): string {
  return bumps
    .filter((b) => b.kind === "release" && b.from.split(".")[0] !== b.to.split(".")[0])
    .map((b) => `${b.name} ${b.from.split(".")[0]} -> ${b.to.split(".")[0]}`)
    .join(", ");
}

function section(bump: Bump): string {
  const head = `## ${bump.name}: \`${shown(bump, bump.from)}\` -> \`${shown(bump, bump.to)}\``;
  if (bump.kind === "release") return head;
  if (bump.diffs.size === 0) {
    return `${head}\n\nNo fetched file changed between the two commits; the pin moves so the next refresh diffs from here.`;
  }
  const blocks = [...bump.diffs].map(
    ([path, diff]) => `### ${path}\n\n\`\`\`\`diff\n${diff}\n\`\`\`\``,
  );
  return `${head}\n\n${blocks.join("\n\n")}`;
}

const FOOTER: Record<PinKind, string> = {
  commit:
    "The next sync renders these files wherever files.yml names them as a source or a block, one sync PR per repository whose rendered bytes moved (auto-merged when clean). Merging this moves the stable tag once green.",
  release:
    "The next sync writes each dotfile to every repository selecting its module (docs/toolchains.md). Merging this moves the stable tag once green.",
};

export function prBody(kind: PinKind, bumps: Bump[]): string {
  const major = majorJumps(bumps);
  const banner = major === "" ? [] : [`**MAJOR VERSION JUMP: ${major} - review before merging.**`];
  return [...banner, ...bumps.map(section), FOOTER[kind]].join("\n\n");
}

export interface Refresh {
  kind: PinKind;
  /** The checkout holding files.yml and the files/ tree. */
  root: string;
  /** The raw-content host commit pins are diffed through. */
  host: string;
  fetch: Fetch;
}

/** Moves every pin of the kind that upstream moved and returns the bumps. Every fetch and every verdict come before any
 *  write: an unreachable upstream or a downgrade aborts before a pin moves, so "nothing moved" (which lets the workflow
 *  close a stale refresh PR) is never a view that could not look. */
export async function refresh({ kind, root, host, fetch }: Refresh): Promise<Bump[]> {
  const configPath = join(root, "files.yml");
  const text = readFileSync(configPath, "utf-8");
  const config = parseFilesConfig(text);
  if (kind === "commit") {
    const bumps: Bump[] = [];
    let rewritten = text;
    for (const pin of pins(upstreamRefs(config.files))) {
      const head = await headSha(pin.repository, fetch);
      if (head === pin.sha) {
        console.log(`${pin.repository}: ${pin.sha} is HEAD`);
        continue;
      }
      console.log(`${pin.repository}: ${pin.sha} -> ${head}`);
      bumps.push(await commitBump(pin, head, host, fetch));
      rewritten = repin(rewritten, pin, head);
    }
    if (bumps.length > 0) writeFileSync(configPath, rewritten);
    return bumps;
  }
  const moved: (ReleasePin & { latest: string })[] = [];
  for (const pin of releasePins(config, root)) {
    const latest = await latestRelease(pin, fetch);
    if (decideBump(pin.version, latest, pin.module) === "current") {
      console.log(`${pin.module}: ${pin.version} is current`);
      continue;
    }
    console.log(`${pin.module}: ${pin.version} -> ${latest}`);
    moved.push({ ...pin, latest });
  }
  for (const pin of moved) {
    writeFileSync(join(root, pin.file), `${pin.latest}\n`);
    if (pin.file !== BUN_PIN_FILE) continue;
    for (const dir of typesBunDirs(root)) {
      must(["bun", "add", "--dev", "--exact", `@types/bun@${pin.latest}`], {
        cwd: join(root, dir),
      });
    }
  }
  return moved.map(({ module, version, latest }) => ({
    kind: "release",
    name: module,
    from: version,
    to: latest,
  }));
}

function isPinKind(value: string | undefined): value is PinKind {
  return (PIN_KINDS as readonly string[]).includes(value ?? "");
}

async function main(argv: string[]): Promise<number> {
  const kind = argv[2];
  if (!isPinKind(kind)) {
    console.error(`usage: refresh_upstream.ts <${PIN_KINDS.join("|")}>`);
    return 2;
  }
  const bumps = await refresh({ kind, root: REPO_ROOT, host: RAW_HOST, fetch: fetchText });
  if (bumps.length === 0) console.log(`every ${kind} pin is current`);
  if (process.env.GITHUB_OUTPUT) {
    setOutput("bumps", proseBumps(bumps));
    setOutput("body", prBody(kind, bumps));
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv));
}
