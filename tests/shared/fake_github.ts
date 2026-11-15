// A stand-in for api.github.com at the client's transport seam (actions/github-client/github.ts), answering each path from
// a table of replies handed out in order, the last one repeating; a path the table lacks answers 404, as GitHub does.
//
// In process: `fakeGithub(routes).fetch` is the client's `fetch` option. For a script run as a subprocess the same table
// serves from its own process (tests/shared/loopback_server.ts): the script's GITHUB_API_URL is `<host>/<run>`, so no
// run sees another's place in a reply list, and a run may bring its own table. `bun tests/shared/fake_github.ts <routes json> <request log>`.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { GitHubClient, type GitHubClientOptions } from "../../actions/github-client/github.ts";
import { type LoopbackServer, spawnLoopback } from "./loopback_server";

export interface FakeReply {
  /** The HTTP status. */
  status: number;

  /** A string is a file's raw bytes; anything else is sent as JSON. Absent: GitHub's `{"message": ...}` error body. */
  body?: unknown;

  /** Extra response headers (the rate-limit pair, a deprecation notice). */
  headers?: Record<string, string>;

  /** The reply links to a next page: the same path, answered by the next reply in the list. */
  next?: boolean;

  /** Never answer: a stalled network. In process the request ends when its signal aborts. */
  hang?: boolean;

  /** The connection drops after the headers and half the body. */
  cut?: boolean;
}

/** Replies by API path, no leading slash and no query: `repos/o/r/contents/.repo-platform.yml`. A `*` stands for one
 *  segment. A write's key leads with its method: `POST repos/o/r/issues`. */
export type FakeRoutes = Record<string, FakeReply[]>;

export interface FakeCall {
  /** The API path, no leading slash, with its query string; a write's leads with its method, as its route key does. */
  path: string;

  /** The request's authorization header, or null. */
  authorization: string | null;
}

export interface FakeWrite {
  /** The write's method and path, as its route key spells them. */
  path: string;

  /** The request's JSON body, null when it sent none. */
  body: unknown;
}

export interface FakeGithub {
  /** The client's `fetch` option. */
  fetch: typeof fetch;

  /** Every request so far, in order. */
  calls(): FakeCall[];

  /** Every write so far, in order, with what it sent. */
  writes(): FakeWrite[];
}

/** GitHub's answer for a path the table lacks. */
const NOT_FOUND: FakeReply = { status: 404 };

/** The statuses the Fetch standard gives no body. */
const BODILESS = [204, 205, 304];

/** A request as the table and the log name it: a read by its path alone, so every read-only table stays as it was. */
function routeKey(method: string, path: string): string {
  return method === "GET" ? path : `${method} ${path}`;
}

/** The body a write sent, parsed; null for none. */
async function sentBody(request: Request): Promise<unknown> {
  const text = await request.text();
  return text === "" ? null : JSON.parse(text);
}

/** An exact path wins; otherwise the first pattern whose `*` segments each stand for one path segment. */
function repliesFor(routes: FakeRoutes, path: string): FakeReply[] {
  if (routes[path] !== undefined) return routes[path];
  const segments = path.split("/");
  for (const [pattern, replies] of Object.entries(routes)) {
    const wanted = pattern.split("/");
    const matches =
      wanted.length === segments.length &&
      wanted.every((segment, index) => segment === "*" || segment === segments[index]);
    if (matches) return replies;
  }
  return [NOT_FOUND];
}

function nextReply(routes: FakeRoutes, served: Map<string, number>, state: string, path: string) {
  const replies = repliesFor(routes, path);
  const key = `${state} ${path}`;
  const index = served.get(key) ?? 0;
  served.set(key, index + 1);
  return replies[Math.min(index, replies.length - 1)];
}

function response(reply: FakeReply, url: URL): Response {
  const headers = new Headers(reply.headers);
  if (reply.next === true) {
    const next = new URL(url);
    next.searchParams.set("page", String(Number(url.searchParams.get("page") ?? "1") + 1));
    headers.set("link", `<${next.href}>; rel="next"`);
  }
  const raw = typeof reply.body === "string";
  headers.set(
    "content-type",
    raw ? "application/vnd.github.raw; charset=utf-8" : "application/json; charset=utf-8",
  );
  const body = "body" in reply ? reply.body : { message: `fake reply ${reply.status}` };
  const text = raw ? (reply.body as string) : JSON.stringify(body);
  if (BODILESS.includes(reply.status)) return new Response(null, { status: reply.status, headers });

  return new Response(reply.cut === true ? cutShort(text) : text, {
    status: reply.status,
    headers,
  });
}

function cutShort(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text.slice(0, text.length / 2)));
      controller.error(new Error("connection reset"));
    },
  });
}

/** Resolves never; rejects with the signal's reason when the request is aborted, as a real fetch does. */
function stalled(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    if (signal?.aborted === true) reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason));
  });
}

export function fakeGithub(routes: FakeRoutes): FakeGithub {
  const served = new Map<string, number>();
  const calls: FakeCall[] = [];
  const writes: FakeWrite[] = [];
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const key = routeKey(request.method, url.pathname.slice(1));
    calls.push({ path: key + url.search, authorization: request.headers.get("authorization") });
    if (request.method !== "GET") writes.push({ path: key, body: await sentBody(request) });
    const reply = nextReply(routes, served, "", key);
    if (reply.hang === true) return stalled(init?.signal);
    return response(reply, url);
  };
  return { fetch: fake as typeof fetch, calls: () => calls, writes: () => writes };
}

/** A client over an in-process fake, its retries without their sleeps. */
export function clientOver(
  routes: FakeRoutes,
  options: GitHubClientOptions = {},
): { client: GitHubClient; github: FakeGithub } {
  const github = fakeGithub(routes);
  const client = new GitHubClient({
    token: "stub-token",
    baseUrl: "https://api.github.test",
    fetch: github.fetch,
    retryBaseMs: 0,
    ...options,
  });
  return { client, github };
}

/** Where one run's own table sits beside the server's log. */
function runRoutesFile(log: string, run: string): string {
  return `${log}.${run}.routes.json`;
}

function serve(routes: FakeRoutes, log: string): ReturnType<typeof Bun.serve> {
  const served = new Map<string, number>();
  const tables = new Map<string, FakeRoutes>();
  const tableOf = (run: string): FakeRoutes => {
    const known = tables.get(run);
    if (known !== undefined) return known;

    const own = runRoutesFile(log, run);
    const table = existsSync(own) ? (JSON.parse(readFileSync(own, "utf-8")) as FakeRoutes) : routes;
    tables.set(run, table);
    return table;
  };

  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const [, run, ...rest] = url.pathname.split("/");
      const key = routeKey(request.method, rest.join("/"));
      const body = request.method === "GET" ? "" : `\t${JSON.stringify(await sentBody(request))}`;
      appendFileSync(log, `${run}\t${key}${url.search}${body}\n`);
      const reply = nextReply(tableOf(run), served, run, key);
      if (reply.hang === true) return stalled(request.signal);
      return response(reply, url);
    },
  });
}

export interface FakeGithubServer extends LoopbackServer {
  /** The request log, a `<run>\t<path>` line per request; a stub of another program may append its own `<run>\t<line>`, so one file holds a run's calls in order. */
  log: string;

  /** Gives one run its own table instead of the server's; called before the run's first request. */
  routes(run: string, routes: FakeRoutes): void;

  /** Every line one run logged so far, in order: a read's path with its query string, a write's led by its method. */
  calls(run: string): string[];

  /** Every write of one run so far, in order, with what it sent. */
  writes(run: string): FakeWrite[];
}

/** The `host` is the server's root: a run reads `${host}/<its own name>` as its GITHUB_API_URL.
 *
 * @param log - a file in the caller's temp dir; the server appends each request to it before answering
 */
export async function spawnFakeGithub(routes: FakeRoutes, log: string): Promise<FakeGithubServer> {
  writeFileSync(log, "");
  const server = await spawnLoopback(
    [import.meta.path, JSON.stringify(routes), log],
    "fake GitHub API",
  );
  const lines = (run: string): string[][] =>
    readFileSync(log, "utf-8")
      .split("\n")
      .map((line) => line.split("\t"))
      .filter(([name]) => name === run);
  return {
    ...server,
    log,
    routes: (run, table) => writeFileSync(runRoutesFile(log, run), JSON.stringify(table)),
    calls: (run) => lines(run).map(([, path]) => path),
    writes: (run) =>
      lines(run)
        .filter((line) => line.length === 3)
        .map(([, path, body]) => ({ path, body: JSON.parse(body) })),
  };
}

if (import.meta.main) {
  const server = serve(JSON.parse(process.argv[2]) as FakeRoutes, process.argv[3]);
  console.log(server.port);
}
