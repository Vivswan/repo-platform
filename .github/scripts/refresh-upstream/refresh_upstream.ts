#!/usr/bin/env bun
// The one writer of the upstream pins in files.yml: every sync fetches at them, so moving a pin is the fleet-wide refresh
// of every source and block that names it. The workflow around this script commits and opens the PR; the body carries
// each pinned file's diff between the two commits, which is exactly what the next sync renders wherever the file lands.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isScalar, parseDocument, visit } from "yaml";
import {
  parseFilesConfig,
  type UpstreamRef,
  upstreamRefs,
} from "../../../actions/plan/files_config.ts";
import { setOutput } from "../shared/gha.ts";
import { unifiedDiff } from "../sync/writer/report.ts";
import { type Fetch, fetchText, fetchUpstream, RAW_HOST } from "../sync/writer/upstream.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const FILES_CONFIG = join(REPO_ROOT, "files.yml");
const API_HOST = "https://api.github.com";

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

export interface Pin {
  repository: string;
  sha: string;
  /** Every file files.yml fetches at this pin, sorted. */
  paths: string[];
}

/** One bump per pin, however many entries and blocks spell it. */
export function pins(refs: UpstreamRef[]): Pin[] {
  const seen = new Map<string, Pin>();
  for (const { repository, sha, path } of refs) {
    const key = `${repository}@${sha}`;
    const pin = seen.get(key) ?? { repository, sha, paths: [] };
    if (!pin.paths.includes(path)) pin.paths.push(path);
    seen.set(key, pin);
  }
  return [...seen.values()].map((pin) => ({ ...pin, paths: [...pin.paths].sort() }));
}

/** Every mapping spelling the pin (a source ref, a registry) moves together, by the sha scalar's own text range so the
 *  document keeps its bytes; the repository is part of the match, so another repository at the same sha stays put. */
export function repin(text: string, pin: Pick<Pin, "repository" | "sha">, to: string): string {
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

export interface Bump {
  repository: string;
  from: string;
  to: string;
  /** Path to its unified diff between the two commits, normalized as the writer fetches it; unchanged paths are absent. */
  diffs: Map<string, string>;
}

export async function bump(pin: Pin, to: string, host: string, fetch: Fetch): Promise<Bump> {
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
  return { repository: pin.repository, from: pin.sha, to, diffs };
}

const short = (sha: string) => sha.slice(0, 7);

export function proseBumps(bumps: Bump[]): string {
  return bumps.map((b) => `${b.repository} to ${short(b.to)}`).join(" and ");
}

export function prBody(bumps: Bump[]): string {
  const sections = bumps.map((b) => {
    const head = `## ${b.repository}: \`${short(b.from)}\` -> \`${short(b.to)}\``;
    if (b.diffs.size === 0) {
      return `${head}\n\nNo fetched file changed between the two commits; the pin moves so the next refresh diffs from here.`;
    }
    const blocks = [...b.diffs].map(
      ([path, diff]) => `### ${path}\n\n\`\`\`\`diff\n${diff}\n\`\`\`\``,
    );
    return `${head}\n\n${blocks.join("\n\n")}`;
  });
  return `${sections.join("\n\n")}\n\nThe next sync renders these files wherever files.yml names them as a source or a block, one sync PR per repository whose rendered bytes moved (auto-merged when clean). Merging this moves the stable tag once green.`;
}

async function main(): Promise<number> {
  const text = readFileSync(FILES_CONFIG, "utf-8");
  const bumps: Bump[] = [];
  let rewritten = text;
  // Every HEAD first, then the writes: an unreachable upstream aborts before the pin moves, so "nothing moved" (which lets the
  // workflow close a stale refresh PR) is never a view that could not look.
  for (const pin of pins(upstreamRefs(parseFilesConfig(text).files))) {
    const head = await headSha(pin.repository, fetchText);
    if (head === pin.sha) {
      console.log(`${pin.repository}: ${pin.sha} is HEAD`);
      continue;
    }
    console.log(`${pin.repository}: ${pin.sha} -> ${head}`);
    bumps.push(await bump(pin, head, RAW_HOST, fetchText));
    rewritten = repin(rewritten, pin, head);
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
