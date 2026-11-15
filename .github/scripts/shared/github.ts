// The scripts' one GitHub REST client: every read shares one retry and rate-limit policy, one deadline, and one failure vocabulary.
// A failure's reason is fixed text. The library's error spells the request URL, which names a private repository, and the selectors' logs are public (docs/platform/sync/private-repositories.md).

import { Octokit } from "@octokit/core";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { RequestError } from "@octokit/request-error";
import LinkHeader from "http-link-header";
import { z } from "zod";
import { env } from "./gha.ts";
import { JsonShapeError, parseWithThrow } from "./json.ts";

/** A stalled-network backstop, not a latency budget: two minutes covers the paginated user/repos listing of several hundred repos, and the plan jobs' timeout-minutes are sized from it. */
export const READ_DEADLINE_MS = 120_000;

/** Every 4xx: a second attempt cannot change one, and a rate limit (403, 429) is the throttling plugin's alone to wait out. */
const NEVER_RETRIED = Array.from({ length: 100 }, (_, offset) => 400 + offset);

/** The longest rate-limit wait a billed runner sits out; a longer one fails the read. */
const RATE_LIMIT_WAIT_SECONDS = 60;

/** The largest page GitHub serves. */
const PAGE_SIZE = 100;

/** The statuses the Fetch standard gives no body. */
const BODILESS = [204, 205, 304];

/** What a shape diagnosis calls the thing it judged. */
const REPLY = "the reply";

/** Any spelling of a next relation in a Link header. */
const NAMES_NEXT = /rel="?next\b/i;

/** The failure of a listing whose Link header announces a next page the client cannot follow. */
const UNREADABLE_NEXT = `${REPLY}: a Link header whose next page cannot be read`;

/** The client class: the core with the retry and rate-limit policies plugged in. */
const PlatformOctokit = Octokit.plugin(retry, throttling);

/** A logger that prints nothing: the library's messages spell the request URL. */
const SILENT = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** One read's outcome. `not-found` is GitHub's 404 and nothing else; `failed` is every other non-answer, its reason safe for a public log. */
export type Read<T> =
  | { kind: "ok"; value: T }
  | { kind: "not-found" }
  | { kind: "failed"; reason: string };

/** Query parameters of one read. */
export type Query = Record<string, string | number>;

export interface GitHubClientOptions {
  /** Defaults to GH_TOKEN, then GITHUB_TOKEN, an empty one skipped (gh's own lookup). */
  token?: string;

  /** Defaults to the runner's GITHUB_API_URL, then api.github.com. */
  baseUrl?: string;

  /** The transport; tests answer from a table here. */
  fetch?: typeof fetch;

  /** The time one read may take, its retries, waits, and pages included. */
  deadlineMs?: number;

  /** The unit of the retry backoff (1, 4, 9 units) and of a rate-limit wait's seconds; tests pass 0 so no retry sleeps. */
  retryBaseMs?: number;
}

/** One rate-limit wait per request, and only a short one: the reset can be an hour away. */
function sitsOutRateLimit(
  retryAfterSeconds: number,
  _options: unknown,
  _octokit: unknown,
  retryCount: number,
): boolean {
  return retryCount === 0 && retryAfterSeconds <= RATE_LIMIT_WAIT_SECONDS;
}

/** A transport that hands back a reply only once its whole body arrived, so a connection cut mid-body throws where the retry plugin sees it; the request layer reads a broken body as empty text. */
function wholeReplies(transport: typeof fetch): typeof fetch {
  const whole = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const reply = await transport(input, init);
    const body = await reply.arrayBuffer();
    return new Response(BODILESS.includes(reply.status) ? null : body, {
      status: reply.status,
      statusText: reply.statusText,
      headers: reply.headers,
    });
  };
  return whole as typeof fetch;
}

/** The next page's URL from a listing's Link header, null on the last page.
 *
 * @throws {JsonShapeError} the header is malformed: ending the listing there would shorten it
 */
function nextPage(link: string | undefined): string | null {
  if (link === undefined) return null;

  let next: string | undefined;
  try {
    next = LinkHeader.parse(link).rel("next")[0]?.uri;
  } catch {
    throw new JsonShapeError(UNREADABLE_NEXT);
  }

  // The parser accepts some headers it then files under no relation (a valueless parameter before `rel`).
  if (next === undefined && NAMES_NEXT.test(link)) throw new JsonShapeError(UNREADABLE_NEXT);

  return next ?? null;
}

function failed(reason: string): Read<never> {
  return { kind: "failed", reason };
}

/** The outcome of a read that threw, in the fixed vocabulary. */
function thrownOutcome(error: unknown, expired: boolean, deadlineMs: number): Read<never> {
  if (expired) return failed(`no answer within ${deadlineMs}ms`);

  // A reply cut short, or anything else the library threw: its message is not ours to print.
  if (!(error instanceof RequestError)) return failed("the request failed");

  if (error.response === undefined) return failed("no response");

  if (error.status === 404) return { kind: "not-found" };

  return failed(`HTTP ${error.status}`);
}

/** Why a read that is not `ok` gave no value, for a caller to which a 404 is one more failure. */
export function unansweredReason(read: Exclude<Read<unknown>, { kind: "ok" }>): string {
  return read.kind === "not-found" ? "HTTP 404" : read.reason;
}

/** A read that ends at its deadline leaves the request's own timers running, so a caller that continues after a failed read may end up to a minute late. */
export class GitHubClient {
  readonly #octokit: InstanceType<typeof PlatformOctokit>;

  readonly #deadlineMs: number;

  constructor(options: GitHubClientOptions = {}) {
    const retryBaseMs = options.retryBaseMs ?? Number(env("GITHUB_RETRY_BASE_MS", "1000"));
    const token = options.token ?? (env("GH_TOKEN") || env("GITHUB_TOKEN"));
    // GitHub answers an anonymous read of a private repository with 404, which reads as "not there".
    if (token === "") {
      throw new Error(
        "GH_TOKEN or GITHUB_TOKEN must be set: the GitHub API is never read anonymously",
      );
    }

    this.#deadlineMs = options.deadlineMs ?? READ_DEADLINE_MS;
    this.#octokit = new PlatformOctokit({
      auth: token,
      baseUrl: options.baseUrl ?? env("GITHUB_API_URL", "https://api.github.com"),
      // The request layer logs through its own option, not the client's: both spell the URL in a deprecation warning.
      log: SILENT,
      request: { fetch: wholeReplies(options.fetch ?? fetch), log: SILENT },
      retry: { doNotRetry: NEVER_RETRIED, retryAfterBaseValue: retryBaseMs },
      throttle: {
        onRateLimit: sitsOutRateLimit,
        onSecondaryRateLimit: sitsOutRateLimit,
        retryAfterBaseValue: retryBaseMs,
      },
    });
  }

  /** One JSON reply, validated.
   *
   * @param path - the API path, as `gh api` takes it: `repos/o/r/commits/HEAD`
   */
  get<T>(path: string, schema: z.ZodType<T>, query: Query = {}): Promise<Read<T>> {
    return this.#read(async (signal) => {
      const reply = await this.#octokit.request(`GET /${path}`, { ...query, request: { signal } });
      return parseWithThrow(schema, reply.data, REPLY);
    });
  }

  /** A file's raw bytes as text, from a `contents/` path. The text is repository-owned: read for a fact, never printed. */
  text(path: string): Promise<Read<string>> {
    return this.#read(async (signal) => {
      const reply = await this.#octokit.request(`GET /${path}`, {
        headers: { accept: "application/vnd.github.raw" },
        request: { signal, parseSuccessResponseBody: false },
      });
      return new Response(reply.data as ReadableStream).text();
    });
  }

  /** Every page of a listing as one array. Each page is validated as an array before it is added, so a page that is
   *  not one fails the listing instead of shortening it. */
  paginate<T>(path: string, itemSchema: z.ZodType<T>, query: Query = {}): Promise<Read<T[]>> {
    const page = z.array(itemSchema);

    return this.#read(async (signal) => {
      const items: T[] = [];
      let reply = await this.#octokit.request(`GET /${path}`, {
        per_page: PAGE_SIZE,
        ...query,
        request: { signal },
      });
      for (;;) {
        items.push(...parseWithThrow(page, reply.data, REPLY));
        const next = nextPage(reply.headers.link);
        if (next === null) return items;

        reply = await this.#octokit.request({ method: "GET", url: next, request: { signal } });
      }
    });
  }

  /** A reply of the wrong shape is a failure like an outage: no caller may act on a listing it cannot trust. */
  async #read<T>(send: (signal: AbortSignal) => Promise<T>): Promise<Read<T>> {
    const deadline = new AbortController();
    // An abort() is not retried by the retry plugin; AbortSignal.timeout's TimeoutError would be.
    const timer = setTimeout(() => deadline.abort(), this.#deadlineMs);
    // The abort ends the wire, not a backoff or a rate-limit wait the plugins sleep through, so the read races it.
    const expiry = new Promise<never>((_, reject) => {
      deadline.signal.addEventListener("abort", () => reject(deadline.signal.reason));
    });
    try {
      return { kind: "ok", value: await Promise.race([send(deadline.signal), expiry]) };
    } catch (error) {
      if (error instanceof JsonShapeError) return failed(error.message);
      return thrownOutcome(error, deadline.signal.aborted, this.#deadlineMs);
    } finally {
      clearTimeout(timer);
    }
  }
}
