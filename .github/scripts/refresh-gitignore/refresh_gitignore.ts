#!/usr/bin/env bun
// The one writer of the upstream pin in files.yml: every sync fetches the registered blocks at it, so moving it is the
// fleet-wide gitignore refresh. The workflow around this script commits and opens the PR; the body carries each block's
// diff between the two commits, which is exactly what the next sync renders into every repository's region.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type FileEntry,
  parseFilesConfig,
  type UpstreamBlocks,
} from "../../../actions/plan/files_config.ts";
import { setOutput } from "../shared/gha.ts";
import { unifiedDiff } from "../sync/writer/report.ts";
import {
  fetchText,
  normalizeUpstream,
  RAW_HOST,
  upstreamRef,
} from "../sync/writer/upstream_blocks.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const FILES_CONFIG = join(REPO_ROOT, "files.yml");
const API_HOST = "https://api.github.com";

export type Fetch = (url: string, headers?: Record<string, string>) => Promise<string>;

/** HEAD of the default branch. */
export async function headSha(repository: string, fetch: Fetch): Promise<string> {
  const headers: Record<string, string> = { accept: "application/vnd.github+json" };
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const body = await fetch(`${API_HOST}/repos/${repository}/commits/HEAD`, headers);
  const sha = (JSON.parse(body) as { sha?: unknown }).sha;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`${repository}: the commits/HEAD reply carries no full sha`);
  }
  return sha;
}

/** The registries files.yml carries, one per repository and pin. */
export function upstreams(files: FileEntry[]): UpstreamBlocks[] {
  const seen = new Map<string, UpstreamBlocks>();
  for (const entry of files) {
    if (entry.class === "link" || "render" in entry || entry.upstream === undefined) continue;
    seen.set(`${entry.upstream.repository}@${entry.upstream.sha}`, entry.upstream);
  }
  return [...seen.values()];
}

/** The pin is spelled once per registry; a second spelling would be a copy this rewrite cannot keep honest. */
export function repin(text: string, from: string, to: string): string {
  const line = `sha: ${from}`;
  const count = text.split(line).length - 1;
  if (count !== 1) throw new Error(`files.yml spells 'sha: ${from}' ${count} times, expected once`);
  return text.replace(line, `sha: ${to}`);
}

export interface Bump {
  repository: string;
  from: string;
  to: string;
  /** Path to its unified diff between the two commits, normalized as the writer renders it; unchanged paths are absent. */
  diffs: Map<string, string>;
}

export async function bump(
  upstream: UpstreamBlocks,
  to: string,
  host: string,
  fetch: Fetch,
): Promise<Bump> {
  const diffs = new Map<string, string>();
  for (const path of [...new Set(Object.values(upstream.paths))].sort()) {
    const before = normalizeUpstream(await fetch(`${host}/${upstreamRef(upstream, path)}`));
    const after = normalizeUpstream(
      await fetch(`${host}/${upstreamRef({ ...upstream, sha: to }, path)}`),
    );
    if (before !== after) diffs.set(path, unifiedDiff(path, before, after));
  }
  return { repository: upstream.repository, from: upstream.sha, to, diffs };
}

const short = (sha: string) => sha.slice(0, 7);

/** "github/gitignore to 1a2b3c4", the commit subject's object. */
export function proseBumps(bumps: Bump[]): string {
  return bumps.map((b) => `${b.repository} to ${short(b.to)}`).join(" and ");
}

export function prBody(bumps: Bump[]): string {
  const sections = bumps.map((b) => {
    const head = `## ${b.repository}: \`${short(b.from)}\` -> \`${short(b.to)}\``;
    if (b.diffs.size === 0) {
      return `${head}\n\nNo registered block changed between the two commits; the pin moves so the next refresh diffs from here.`;
    }
    const blocks = [...b.diffs].map(
      ([path, diff]) => `### ${path}\n\n\`\`\`\`diff\n${diff}\n\`\`\`\``,
    );
    return `${head}\n\n${blocks.join("\n\n")}`;
  });
  return `${sections.join("\n\n")}\n\nThe next sync renders these blocks into every repository's \`.gitignore\` region, one sync PR per repository (auto-merged when clean). Merging this moves the stable tag once green.`;
}

async function main(): Promise<number> {
  const text = readFileSync(FILES_CONFIG, "utf-8");
  const bumps: Bump[] = [];
  let rewritten = text;
  // Every HEAD first, then the writes: an unreachable upstream aborts before the pin moves, so "nothing moved" (which lets the
  // workflow close a stale refresh PR) is never a view that could not look.
  for (const upstream of upstreams(parseFilesConfig(text).files)) {
    const head = await headSha(upstream.repository, fetchText);
    if (head === upstream.sha) {
      console.log(`${upstream.repository}: ${upstream.sha} is HEAD`);
      continue;
    }
    console.log(`${upstream.repository}: ${upstream.sha} -> ${head}`);
    bumps.push(await bump(upstream, head, RAW_HOST, fetchText));
    rewritten = repin(rewritten, upstream.sha, head);
  }
  if (bumps.length > 0) writeFileSync(FILES_CONFIG, rewritten);
  if (process.env.GITHUB_OUTPUT) {
    setOutput("bumps", proseBumps(bumps));
    setOutput("body", prBody(bumps));
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
