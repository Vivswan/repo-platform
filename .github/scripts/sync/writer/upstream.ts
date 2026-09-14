// Every pinned upstream file files.yml names is fetched from the raw-content host once per run and before any file is
// written: a sync that cannot see its upstream writes nothing, and two syncs render the same bytes until the refresh
// workflow moves the pin.

import { refKey, type UpstreamRef } from "../../../../actions/plan/files_config.ts";
import { PLATFORM_NAME } from "../../../../actions/shared/platform.ts";

export const RAW_HOST = "https://raw.githubusercontent.com";

export type Fetch = (url: string, headers?: Record<string, string>) => Promise<string>;

/** CRLF and trailing whitespace would fail the fleet's text gates on the rendered file; only the blank lines around the
 *  body go, so an indented first line (a YAML list item) keeps its indentation, and the renderer owns every newline. */
export function normalizeUpstream(text: string): string {
  return text
    .replaceAll("\r\n", "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
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
  // 200 alone: a 204 or 206 is "ok" to fetch and would render an empty or partial block.
  if (response.status !== 200) throw new Error(`GET ${url} failed: HTTP ${response.status}`);
  try {
    return await response.text();
  } catch {
    throw new Error(`GET ${url} failed while its body was read`);
  }
}

/** Normalized bodies by refKey; every ref files.yml names is present, so a lookup cannot miss for a ref the grammar admitted. */
export class UpstreamBodies {
  constructor(private readonly bodies: ReadonlyMap<string, string>) {}

  body(ref: UpstreamRef): string {
    const body = this.bodies.get(refKey(ref));
    if (body === undefined) throw new Error(`${refKey(ref)} was not fetched`);
    return body;
  }
}

export async function fetchUpstream(
  refs: UpstreamRef[],
  host: string,
  fetchImpl: Fetch = fetchText,
): Promise<UpstreamBodies> {
  const bodies = new Map<string, string>();
  for (const ref of refs) {
    const key = refKey(ref);
    if (!bodies.has(key)) bodies.set(key, normalizeUpstream(await fetchImpl(`${host}/${key}`)));
  }
  return new UpstreamBodies(bodies);
}
