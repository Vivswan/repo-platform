// Dependency-free like action_runtime.ts: a composite action runs from its own directory with only its own pinned
// dependencies, and bun's fetch is built in. The job token arrives as GH_TOKEN, which the step sets, and the API root
// as GITHUB_API_URL, which every runner sets (GHES included).

import { requireEnv } from "./action_runtime.ts";

/** A request that hangs on a billed runner fails the job on the clock, not on a verdict. */
const REQUEST_TIMEOUT_MS = 60_000;

/** GitHub's answer: the status with the body on one line, or status null when no response came (a connection
 *  failure, the deadline) with the failure's message as the body. */
export interface Answer {
  status: number | null;
  body: string;
}

/** GitHub pretty-prints JSON, and the body lands in one annotation line. */
const oneLine = (text: string): string => text.replaceAll(/\s+/g, " ").trim();

/** Reads `path` (under the API root: `repos/{owner}/{repo}/...`). */
export async function github(path: string): Promise<Answer> {
  try {
    const response = await fetch(`${requireEnv("GITHUB_API_URL")}/${path}`, {
      headers: {
        authorization: `Bearer ${requireEnv("GH_TOKEN")}`,
        accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { status: response.status, body: oneLine(await response.text()) };
  } catch (failure) {
    return { status: null, body: failure instanceof Error ? failure.message : String(failure) };
  }
}

/** What came back, for an error line: `HTTP 500: {...}`, `HTTP 204`, or `nothing: <the failure>`. */
export function answerText({ status, body }: Answer): string {
  const came = status === null ? "nothing" : `HTTP ${status}`;
  return body === "" ? came : `${came}: ${body}`;
}
