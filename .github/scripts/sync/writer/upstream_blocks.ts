// The blocks an entry's `upstream` registry names are fetched from the raw-content host at the pinned sha, once per run
// and before any file is written: a sync that cannot see its upstream writes nothing, and two syncs render the same bytes
// until the refresh workflow moves the pin.

import type { FileEntry, UpstreamBlocks } from "../../../../actions/plan/files_config.ts";
import { PLATFORM_NAME } from "../../../../actions/shared/platform.ts";

export const RAW_HOST = "https://raw.githubusercontent.com";

/** The block's location under any raw-content host: repository, pinned sha, path. */
export function upstreamRef(
  upstream: Pick<UpstreamBlocks, "repository" | "sha">,
  path: string,
): string {
  return `${upstream.repository}/${upstream.sha}/${path}`;
}

/** Upstream quirks, each normalized so the rendered region stays lint-clean downstream.
 *    Windows.gitignore  CRLF line endings          -> LF
 *    macOS.gitignore    `Icon[\r]`, a raw CR byte   -> the CR-free `?` glob
 *    comment lines      trailing spaces             -> stripped (downstream whitespace linters) */
export function normalizeUpstream(text: string): string {
  return text
    .replaceAll("\r\n", "\n")
    .replaceAll("[\r]", "?")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

/** The heading names the value and where the body came from; the trailing blank line separates the block from the next. */
export function upstreamBlock(
  entry: Pick<Extract<FileEntry, { source: string }>, "upstream">,
  value: string,
  path: string,
  body: string,
): string {
  return `## ${value} (${entry.upstream?.repository} ${path})\n${body}\n\n`;
}

/** Both messages are fixed text: fetch()'s own rejection text is runtime-generated, and this is the run's one ::error:: line. */
export async function fetchText(
  url: string,
  headers: Record<string, string> = {},
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "user-agent": `${PLATFORM_NAME}-sync`, ...headers },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error(`GET ${url} failed before a response (network, TLS, or timeout)`);
  }
  if (!response.ok) throw new Error(`GET ${url} failed: HTTP ${response.status}`);
  try {
    return await response.text();
  } catch {
    throw new Error(`GET ${url} failed while its body was read`);
  }
}

/** Normalized bodies by upstreamRef; every registered path is present, so a lookup cannot miss for a value the grammar admitted. */
export class UpstreamBodies {
  constructor(private readonly bodies: ReadonlyMap<string, string>) {}

  body(entry: Pick<Extract<FileEntry, { source: string }>, "upstream">, path: string): string {
    if (entry.upstream === undefined) throw new Error(`${path}: the entry has no upstream`);
    const ref = upstreamRef(entry.upstream, path);
    const body = this.bodies.get(ref);
    if (body === undefined) throw new Error(`${ref} was not fetched`);
    return body;
  }
}

export async function fetchUpstreamBodies(
  entries: FileEntry[],
  host: string,
  fetchImpl: (url: string) => Promise<string> = fetchText,
): Promise<UpstreamBodies> {
  const bodies = new Map<string, string>();
  for (const entry of entries) {
    if ("render" in entry || entry.upstream === undefined) continue;
    for (const path of Object.values(entry.upstream.paths)) {
      const ref = upstreamRef(entry.upstream, path);
      if (!bodies.has(ref)) bodies.set(ref, normalizeUpstream(await fetchImpl(`${host}/${ref}`)));
    }
  }
  return new UpstreamBodies(bodies);
}
