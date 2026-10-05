// git's push-service advertisement answers 200 only with push permission; fine-grained PATs read every public repo and user/repos
// reports the USER's permissions, so this is the only honest enrollment signal.

import { requireEnv } from "../shared/gha.ts";
import { NETWORK_TIMEOUT_MS } from "./discovery.ts";

/** The advertisement's status, as git's basic auth would see it; 0 for a transport failure or the deadline, a body cut
 *  short included. */
export async function pushProbeStatus(slug: string, pat: string): Promise<number> {
  const url = `${requireEnv("GITHUB_SERVER_URL")}/${slug}.git/info/refs?service=git-receive-pack`;
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Basic ${btoa(`x-access-token:${pat}`)}` },
      redirect: "manual",
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });
    await response.arrayBuffer();
    return response.status;
  } catch {
    return 0;
  }
}
