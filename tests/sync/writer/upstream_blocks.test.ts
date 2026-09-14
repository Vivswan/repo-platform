import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  fetchText,
  fetchUpstreamBodies,
  normalizeUpstream,
  UpstreamBodies,
  upstreamBlock,
  upstreamRef,
} from "../../../.github/scripts/sync/writer/upstream_blocks.ts";
import { type FileEntry, parseFilesConfig } from "../../../actions/plan/files_config.ts";
import { serveUpstream } from "../../shared/upstream_server.ts";

const FIXTURES = join(import.meta.dir, "../../ci/sync_end_to_end/fixtures");
const config = parseFilesConfig(readFileSync(join(FIXTURES, "files.yml"), "utf-8"));
const gitignore = config.files.find((entry) => entry.path === ".gitignore") as Extract<
  FileEntry,
  { source: string }
>;
const SHA = "0123456789abcdef0123456789abcdef01234567";
const served = serveUpstream(join(FIXTURES, "upstream"));
afterAll(() => served.stop());

describe("normalizeUpstream", () => {
  test.each([
    ["CRLF line endings", "a\r\nb\r\n", "a\nb"],
    ["the macOS Icon[\\r] class", "Icon[\r]\n", "Icon?"],
    ["trailing spaces and tabs on any line", "# c  \nx\t\n", "# c\nx"],
    ["surrounding blank lines", "\n\nx\n\n", "x"],
  ])("%s", (_case, input, expected) => {
    expect(normalizeUpstream(input)).toBe(expected);
  });
});

test("upstreamBlock heads the body with the value and its origin, and ends with the blank line that separates blocks", () => {
  expect(upstreamBlock(gitignore, "Node", "Node.gitignore", "*.log")).toBe(
    "## Node (github/gitignore Node.gitignore)\n*.log\n\n",
  );
  expect(
    upstreamRef(gitignore.upstream as { repository: string; sha: string }, "Node.gitignore"),
  ).toBe(`github/gitignore/${SHA}/Node.gitignore`);
});

describe("fetchUpstreamBodies", () => {
  test("fetches every registered path once from the host, normalized, and no path twice", async () => {
    const urls: string[] = [];
    const bodies = await fetchUpstreamBodies([gitignore, gitignore], served.host, (url) => {
      urls.push(url);
      return fetchText(url);
    });
    expect(urls).toEqual(
      [
        "Global/Windows.gitignore",
        "Global/macOS.gitignore",
        "Global/Linux.gitignore",
        "Node.gitignore",
        "Bun.gitignore",
      ].map((path) => `${served.host}/github/gitignore/${SHA}/${path}`),
    );
    expect(
      [
        "Global/Windows.gitignore",
        "Global/macOS.gitignore",
        "Global/Linux.gitignore",
        "Node.gitignore",
      ].map((path) => bodies.body(gitignore, path)),
    ).toEqual(["Thumbs.db", ".DS_Store\nIcon?", "*~", "*.log"]);
    expect(() => bodies.body(gitignore, "Rust.gitignore")).toThrow(
      `github/gitignore/${SHA}/Rust.gitignore was not fetched`,
    );
    expect(() => new UpstreamBodies(new Map()).body({ upstream: undefined }, "x")).toThrow(
      "x: the entry has no upstream",
    );
  });

  test("a path the host does not serve rejects with the fixed HTTP line, before any body is kept", async () => {
    const missing = {
      ...gitignore,
      upstream: {
        ...gitignore.upstream,
        paths: { Node: "Node.gitignore", Gone: "Gone.gitignore" },
      },
    } as FileEntry;
    await expect(fetchUpstreamBodies([missing], served.host)).rejects.toThrow(
      `GET ${served.host}/github/gitignore/${SHA}/Gone.gitignore failed: HTTP 404`,
    );
  });

  test("a 2xx that is not 200 rejects too: an empty 204 body would render a heading over nothing", async () => {
    const noContent = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(null, { status: 204 }),
    });
    try {
      await expect(
        fetchUpstreamBodies([gitignore], `http://127.0.0.1:${noContent.port}`),
      ).rejects.toThrow(
        `GET http://127.0.0.1:${noContent.port}/github/gitignore/${SHA}/Global/Windows.gitignore failed: HTTP 204`,
      );
    } finally {
      noContent.stop(true);
    }
  });

  test("a body that breaks off after the headers rejects with the fixed body line", async () => {
    // A raw socket, since an HTTP server cannot promise more bytes than it sends: 100 announced, 6 delivered, then closed.
    const truncating = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket) {
          socket.write("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nThumbs");
          socket.end();
        },
      },
    });
    try {
      await expect(
        fetchUpstreamBodies([gitignore], `http://127.0.0.1:${truncating.port}`),
      ).rejects.toThrow(
        `GET http://127.0.0.1:${truncating.port}/github/gitignore/${SHA}/Global/Windows.gitignore failed while its body was read`,
      );
    } finally {
      truncating.stop(true);
    }
  });

  test("a host that does not answer rejects with the fixed network line, never the runtime's text", async () => {
    const dead = serveUpstream(join(FIXTURES, "upstream"));
    dead.stop();
    await expect(fetchUpstreamBodies([gitignore], dead.host)).rejects.toThrow(
      `GET ${dead.host}/github/gitignore/${SHA}/Global/Windows.gitignore failed before a response (network, TLS, or timeout)`,
    );
  });
});
