// The scripts' one GitHub REST client: every read shares one retry and rate-limit policy, one deadline, and one failure vocabulary.
// A failure's reason is fixed text. The library's error spells the request URL, which names a private repository, and the selectors' logs are public (docs/platform/sync/private-repositories.md).

import { Octokit } from "@octokit/core";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { RequestError } from "@octokit/request-error";
import { z } from "zod";
import { env } from "./gha.ts";
import { JsonShapeError, parseWithThrow } from "./json.ts";

/** A stalled-network backstop, not a latency budget: two minutes covers the paginated user/repos listing of several hundred repos, and the plan jobs' timeout-minutes are sized from it. */
export const READ_DEADLINE_MS = 120_000;

/** The statuses a second attempt cannot change. 429 is here because the throttling plugin alone answers a rate limit. */
const NEVER_RETRIED = [400, 401, 403, 404, 410, 422, 429, 451];

/** The longest rate-limit wait a billed runner sits out; a longer one fails the read. */
const RATE_LIMIT_WAIT_SECONDS = 60;

/** The largest page GitHub serves. */
const PAGE_SIZE = 100;

const PlatformOctokit = Octokit.plugin(retry, throttling, paginateRest);

const SILENT = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** One read's outcome. `not-found` is GitHub's 404 and nothing else; `failed` is every other non-answer, its reason safe for a public log. */
export type Read<T> =
  | { kind: "ok"; value: T }
  | { kind: "not-found" }
  | { kind: "failed"; reason: string };

/** Query parameters of one read. */
export type Query = Record<string, string | number>;

export interface GitHubClientOptions {
  /** Defaults to GH_TOKEN, then GITHUB_TOKEN, an empty one skipped (gh's own lookup); none reads anonymously. */
  token?: string;

  /** Defaults to the runner's GITHUB_API_URL, then api.github.com. */
  baseUrl?: string;

  /** The transport; tests answer from a table here. */
  fetch?: typeof fetch;

  /** The wire time one read may take, its retries and pages included. */
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

/** The statuses the Fetch standard gives no body. */
const BODILESS = [204, 205, 304];

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

export class GitHubClient {
  readonly #octokit: InstanceType<typeof PlatformOctokit>;
  readonly #deadlineMs: number;

  constructor(options: GitHubClientOptions = {}) {
    const retryBaseMs = options.retryBaseMs ?? Number(env("GITHUB_RETRY_BASE_MS", "1000"));
    const token = options.token ?? (env("GH_TOKEN") || env("GITHUB_TOKEN"));
    this.#deadlineMs = options.deadlineMs ?? READ_DEADLINE_MS;
    this.#octokit = new PlatformOctokit({
      auth: token === "" ? undefined : token,
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
    return this.#read(schema, async (signal) => {
      const reply = await this.#octokit.request(`GET /${path}`, { ...query, request: { signal } });
      return reply.data;
    });
  }

  /** A file's raw bytes as text, from a `contents/` path. The text is repository-owned: read for a fact, never printed. */
  text(path: string): Promise<Read<string>> {
    return this.#read(z.string(), async (signal) => {
      const reply = await this.#octokit.request(`GET /${path}`, {
        headers: { accept: "application/vnd.github.raw" },
        request: { signal, parseSuccessResponseBody: false },
      });
      return new Response(reply.data as ReadableStream).text();
    });
  }

  /** Every page of a listing as one array, each item validated. */
  paginate<T>(path: string, itemSchema: z.ZodType<T>, query: Query = {}): Promise<Read<T[]>> {
    const search = new URLSearchParams({ per_page: String(PAGE_SIZE) });
    for (const [name, value] of Object.entries(query)) search.set(name, String(value));

    return this.#read(z.array(itemSchema), (signal) => {
      // The plugin asks for each next page with the method, URL, and headers alone, so the signal rides the request's defaults.
      const page = this.#octokit.request.defaults({
        method: "GET",
        url: `/${path}?${search}`,
        request: { signal },
      });
      return this.#octokit.paginate(page);
    });
  }

  /** A reply of the wrong shape is a failure like an outage: no caller may act on a listing it cannot trust. */
  async #read<T>(
    schema: z.ZodType<T>,
    send: (signal: AbortSignal) => Promise<unknown>,
  ): Promise<Read<T>> {
    const deadline = new AbortController();
    // An abort() is not retried by the retry plugin; AbortSignal.timeout's TimeoutError would be.
    const timer = setTimeout(() => deadline.abort(), this.#deadlineMs);
    let data: unknown;
    try {
      data = await send(deadline.signal);
    } catch (error) {
      return thrownOutcome(error, deadline.signal.aborted, this.#deadlineMs);
    } finally {
      clearTimeout(timer);
    }

    try {
      return { kind: "ok", value: parseWithThrow(schema, data, "the reply") };
    } catch (error) {
      if (!(error instanceof JsonShapeError)) throw error;
      return failed(error.message);
    }
  }
}
