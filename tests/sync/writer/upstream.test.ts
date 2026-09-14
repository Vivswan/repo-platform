import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import {
  fetchText,
  fetchUpstream,
  normalizeUpstream,
  UpstreamBodies,
} from "../../../.github/scripts/sync/writer/upstream.ts";
import { parseFilesConfig, upstreamRefs } from "../../../actions/plan/files_config.ts";
import { serveUpstream } from "../../shared/upstream_server.ts";

const FIXTURES = join(import.meta.dir, "../../ci/sync_end_to_end/fixtures");
const config = parseFilesConfig(readFileSync(join(FIXTURES, "files.yml"), "utf-8"));
const refs = upstreamRefs(config.files);
const SHA = "0123456789abcdef0123456789abcdef01234567";
const ref = (path: string) => ({ repository: "github/gitignore", sha: SHA, path });
const served = serveUpstream(join(FIXTURES, "upstream"));
afterAll(() => served.stop());

// A test that spawns the writer without --upstream passes online and fails offline, so the roster is pinned.
test("every test that runs the writer, directly or through a script, passes --upstream, so no test reaches the real host", () => {
  const root = join(import.meta.dir, "../../..");
  const read = (rel: string) => readFileSync(join(root, rel), "utf-8");
  const WRITER = ".github/scripts/sync/writer/sync.ts";
  const spawners = [
    WRITER,
    ...[...new Glob(".github/scripts/**/*.ts").scanSync(root)].filter(
      (rel) => rel !== WRITER && read(rel).includes("sync/writer/sync.ts"),
    ),
  ].map((rel) => rel.slice(rel.lastIndexOf("/") + 1));
  expect(spawners).toEqual(["sync.ts", "write_fleet_lint_tree.ts"]);
  const tests = [...new Glob("tests/**/*.test.ts").scanSync(root)]
    .filter((rel) => spawners.some((name) => read(rel).includes(`/${name}`)))
    .sort();
  expect(tests.length).toBeGreaterThanOrEqual(4);
  expect(tests.filter((rel) => !read(rel).includes("--upstream"))).toEqual([]);
});

describe("normalizeUpstream", () => {
  test.each([
    ["CRLF line endings", "a\r\nb\r\n", "a\nb"],
    ["a bare CR inside a line, which is not a line ending", "Icon[\r]\n", "Icon[\r]"],
    ["trailing spaces and tabs on any line", "# c  \nx\t\n", "# c\nx"],
    ["surrounding blank lines, whitespace-only ones included", " \n\nx\n \t\n", "x"],
    [
      "an indented first line, which a trim would flatten",
      "  - name: x\n    v: 1\n",
      "  - name: x\n    v: 1",
    ],
  ])("%s", (_case, input, expected) => {
    expect(normalizeUpstream(input)).toBe(expected);
  });
});

describe("fetchUpstream", () => {
  test("fetches every ref once from the host, normalized, and a ref named twice once", async () => {
    const urls: string[] = [];
    const bodies = await fetchUpstream([...refs, ...refs], served.host, (url) => {
      urls.push(url);
      return fetchText(url);
    });
    const paths = [
      "Global/Windows.gitignore",
      "Global/macOS.gitignore",
      "Global/Linux.gitignore",
      "Node.gitignore",
      "Bun.gitignore",
    ];
    expect(urls).toEqual(paths.map((path) => `${served.host}/github/gitignore/${SHA}/${path}`));
    expect(paths.map((path) => bodies.body(ref(path)))).toEqual([
      "Thumbs.db",
      ".DS_Store\nIcon[\r]",
      "*~",
      "*.log",
      "bun.lockb",
    ]);
    expect(() => bodies.body(ref("Rust.gitignore"))).toThrow(
      `github/gitignore/${SHA}/Rust.gitignore was not fetched`,
    );
    expect(() => new UpstreamBodies(new Map()).body(ref("x"))).toThrow(
      `github/gitignore/${SHA}/x was not fetched`,
    );
  });

  test("a path the host does not serve rejects with the fixed HTTP line, before any body is kept", async () => {
    await expect(
      fetchUpstream([ref("Node.gitignore"), ref("Gone.gitignore")], served.host),
    ).rejects.toThrow(`GET ${served.host}/github/gitignore/${SHA}/Gone.gitignore failed: HTTP 404`);
  });

  test("a 2xx that is not 200 rejects too: an empty 204 body would render a heading over nothing", async () => {
    const noContent = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(null, { status: 204 }),
    });
    try {
      await expect(fetchUpstream(refs, `http://127.0.0.1:${noContent.port}`)).rejects.toThrow(
        `GET http://127.0.0.1:${noContent.port}/github/gitignore/${SHA}/Global/Windows.gitignore failed: HTTP 204`,
      );
    } finally {
      noContent.stop(true);
    }
  });

  test("a body that breaks off after the headers rejects with the fixed body line", async () => {
    // A raw socket: Bun.serve computes Content-Length from the Response, so only a socket can announce 100 bytes and send 6.
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
      await expect(fetchUpstream(refs, `http://127.0.0.1:${truncating.port}`)).rejects.toThrow(
        `GET http://127.0.0.1:${truncating.port}/github/gitignore/${SHA}/Global/Windows.gitignore failed while its body was read`,
      );
    } finally {
      truncating.stop(true);
    }
  });

  test("a host that does not answer rejects with the fixed network line, never the runtime's text", async () => {
    const dead = serveUpstream(join(FIXTURES, "upstream"));
    dead.stop();
    await expect(fetchUpstream(refs, dead.host)).rejects.toThrow(
      `GET ${dead.host}/github/gitignore/${SHA}/Global/Windows.gitignore failed before a response (network, TLS, or timeout)`,
    );
  });
});
