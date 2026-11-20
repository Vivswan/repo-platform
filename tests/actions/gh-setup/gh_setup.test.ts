// A job's gh is the platform's pin or the step fails: a runner's own gh at another version would run the platform's
// calls against flags it may not have, and an archive that is not the pinned bytes would run with the job's token. Each
// row plants a runner (what is on PATH, what the download answers) and reads the whole outcome: what was returned or
// thrown, and what landed under the runner's temp directory. Only the download is planted: the tar is unpacked by the
// library the actions hand in.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as toolCache from "@actions/tool-cache";
import { ghRelease } from "../../../actions/gh-setup/gh-setup.ts";
import {
  type ReleaseBinary,
  type Runner,
  setUpReleaseBinary,
  type ToolCache,
} from "../../../actions/shared/release_binary.ts";
import { sha256 } from "../../../actions/shared/values.ts";
import { boundedSpawnSync } from "../../shared/bounded_spawn.ts";
import { tempDirs } from "../../shared/temp_dir.ts";

const temp = tempDirs();
const PINNED = "2.105.0";
const MEMBER = "tool_linux/bin/gh";

/** A `gh` that answers --version the way cli/cli's does, as a script so it runs on any host. */
function fakeGh(dir: string, version: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "gh");
  writeFileSync(
    path,
    `#!/bin/sh\necho "gh version ${version} (2026-01-01)"\necho "https://github.com/cli/cli/releases/tag/v${version}"\n`,
    { mode: 0o755 },
  );
  return path;
}

/** What a release publishes for one architecture: a tar, by its compression flag. */
type Published = "-z" | "-J";

/** The bytes a release would publish: a tar holds the binary under MEMBER beside a file the setup has no use for. */
function publishedOf(root: string, version: string, published: Published): Uint8Array {
  const tree = join(root, "tree");
  fakeGh(join(tree, "tool_linux/bin"), version);
  writeFileSync(join(tree, "tool_linux/LICENSE"), "MIT\n");
  const file = join(root, "archive.tar");
  const packed = boundedSpawnSync(["tar", "-c", published, "-f", file, "-C", tree, "tool_linux"]);
  if (packed.exitCode !== 0) throw new Error(`tar failed: ${packed.stderr}`);
  return new Uint8Array(readFileSync(file));
}

interface Planted {
  tool: ReleaseBinary;
  runner: Runner;
  bytes: Uint8Array;
  fetched: string[];
  toolCache: ToolCache;
}

/** The library with its download answered by `bytes`, so no test reaches the network. */
function answering(bytes: Uint8Array, fetched: string[] = []): ToolCache {
  return {
    ...toolCache,
    downloadTool: (url, file) => {
      fetched.push(url);
      writeFileSync(file, bytes);
      return Promise.resolve(file);
    },
  };
}

/** A runner whose PATH holds `onPath` (a gh version, or none) and a release whose X64 download holds `archived`. */
function plant(onPath: string | undefined, archived: string, published: Published = "-z"): Planted {
  const root = temp.dir("gh-setup-");
  const bytes = publishedOf(root, archived, published);
  const bin = join(root, "bin");
  if (onPath !== undefined) fakeGh(bin, onPath);
  const fetched: string[] = [];
  return {
    tool: {
      name: "gh",
      version: PINNED,
      versionArgs: ["--version"],
      versionPattern: /^gh version (\S+)/,
      downloads: {
        X64: {
          url: "https://example.com/x64.tar.gz",
          sha256: sha256(Buffer.from(bytes)),
          member: MEMBER,
        },
      },
    },
    runner: {
      os: "Linux",
      arch: "X64",
      temp: join(root, "runner-temp"),
      path: bin,
    },
    bytes,
    fetched,
    toolCache: answering(bytes, fetched),
  };
}

const landed = (planted: Planted) =>
  existsSync(planted.runner.temp) ? readdirSync(planted.runner.temp) : [];

describe("setUpReleaseBinary", () => {
  test("a gh on PATH printing the pinned version is reused and nothing is fetched", async () => {
    const planted = plant(PINNED, PINNED);
    const setUp = await setUpReleaseBinary(planted.tool, planted.runner, planted.toolCache);
    expect([setUp, planted.fetched, landed(planted)]).toEqual([
      { path: join(planted.runner.path, "gh"), installed: false },
      [],
      [],
    ]);
  });

  test.each<{ reason: string; onPath: string | undefined }>([
    { reason: "no gh on PATH", onPath: undefined },
    { reason: "a newer gh on PATH", onPath: "2.106.0" },
    { reason: "an older gh on PATH", onPath: "2.50.0" },
  ])(
    "with $reason the pinned archive is fetched and its whole tree is unpacked under the runner's temp",
    async ({ onPath }) => {
      const planted = plant(onPath, PINNED);
      const setUp = await setUpReleaseBinary(planted.tool, planted.runner, planted.toolCache);
      const root = join(planted.runner.temp, `gh-${PINNED}`);
      const tree = readdirSync(root, { recursive: true }).sort();
      expect([setUp, planted.fetched, tree]).toEqual([
        { path: join(root, MEMBER), installed: true },
        ["https://example.com/x64.tar.gz"],
        ["tool_linux", "tool_linux/LICENSE", "tool_linux/bin", "tool_linux/bin/gh"],
      ]);
      expect(readFileSync(join(root, "tool_linux/LICENSE"), "utf8")).toBe("MIT\n");
      const printed = boundedSpawnSync([setUp.path, "--version"]).stdout.split("\n")[0];
      expect(printed).toBe(`gh version ${PINNED} (2026-01-01)`);
    },
  );

  test("a release that publishes an xz tar is fetched and leaves no download behind, and its binary runs", async () => {
    const planted = plant(undefined, PINNED, "-J");
    const setUp = await setUpReleaseBinary(planted.tool, planted.runner, planted.toolCache);
    const root = join(planted.runner.temp, `gh-${PINNED}`);
    expect([setUp, readdirSync(root)]).toEqual([
      { path: join(root, MEMBER), installed: true },
      ["tool_linux"],
    ]);
    const printed = boundedSpawnSync([setUp.path, "--version"]).stdout.split("\n")[0];
    expect(printed).toBe(`gh version ${PINNED} (2026-01-01)`);
  });

  test.each<{ kind: string; published: Published }>([
    { kind: "a gzipped tar", published: "-z" },
    { kind: "an xz tar", published: "-J" },
  ])(
    "$kind whose bytes are not the pinned ones is refused and nothing lands",
    async ({ published }) => {
      const planted = plant(undefined, PINNED, published);
      const tampered = Uint8Array.from(planted.bytes);
      tampered[tampered.length - 1] ^= 1;
      const refusal = setUpReleaseBinary(planted.tool, planted.runner, answering(tampered));
      await expect(refusal).rejects.toThrow(
        `gh ${PINNED}: https://example.com/x64.tar.gz has sha256 ${sha256(Buffer.from(tampered))}, and the pin is ${sha256(Buffer.from(planted.bytes))}; nothing was installed`,
      );
      expect(landed(planted)).toEqual([]);
    },
  );

  test("an archive whose binary prints another version fails, though its sha256 is the pinned one", async () => {
    const planted = plant(undefined, "2.104.0");
    const refusal = setUpReleaseBinary(planted.tool, planted.runner, planted.toolCache);
    await expect(refusal).rejects.toThrow(
      `gh ${PINNED}: the fetched ${join(planted.runner.temp, `gh-${PINNED}`, MEMBER)} prints 2.104.0`,
    );
  });

  test.each<{ os: string; arch: string }>([
    { os: "Linux", arch: "ARM" },
    { os: "macOS", arch: "X64" },
    { os: "Windows", arch: "X64" },
  ])(
    "a $os $arch runner fails naming itself, though a gh at the pin is on PATH",
    async ({ os, arch }) => {
      const planted = plant(PINNED, PINNED);
      const refusal = setUpReleaseBinary(
        planted.tool,
        { ...planted.runner, os, arch },
        planted.toolCache,
      );
      await expect(refusal).rejects.toThrow(
        `gh ${PINNED} is pinned for Linux X64, and this runner is ${os} ${arch}`,
      );
      expect([planted.fetched, landed(planted)]).toEqual([[], []]);
    },
  );
});

describe("ghRelease", () => {
  const release = ghRelease(PINNED, { X64: "a".repeat(64), ARM64: "b".repeat(64) });

  test("the version is read from what gh prints, the release date and URL lines ignored", () => {
    const printed =
      "gh version 2.105.0 (2026-11-17)\nhttps://github.com/cli/cli/releases/tag/v2.105.0\n";
    expect(release.versionPattern.exec(printed)?.[1]).toBe("2.105.0");
  });
});
