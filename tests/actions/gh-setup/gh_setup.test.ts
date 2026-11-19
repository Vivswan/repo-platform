// A job's gh is the platform's pin or the step fails: a runner's own gh at another version would run the platform's
// calls against flags it may not have, and an archive that is not the pinned bytes would run with the job's token. Each
// row plants a runner (what is on PATH, what the download answers) and reads the whole outcome: what was returned or
// thrown, and what landed under the runner's temp directory.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ghRelease } from "../../../actions/gh-setup/gh-setup.ts";
import {
  type ReleaseBinary,
  type Runner,
  setUpReleaseBinary,
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

/** The gzipped tar a release would publish: the binary under MEMBER beside a file the setup has no use for. */
function archiveOf(root: string, version: string): Uint8Array {
  const tree = join(root, "tree");
  fakeGh(join(tree, "tool_linux/bin"), version);
  writeFileSync(join(tree, "tool_linux/LICENSE"), "MIT\n");
  const file = join(root, "archive.tar.gz");
  const packed = boundedSpawnSync(["tar", "-czf", file, "-C", tree, "tool_linux"]);
  if (packed.exitCode !== 0) throw new Error(`tar failed: ${packed.stderr}`);
  return new Uint8Array(readFileSync(file));
}

interface Planted {
  tool: ReleaseBinary;
  runner: Runner;
  bytes: Uint8Array;
  fetched: string[];
  download: (url: string, file: string) => void;
}

/** A runner whose PATH holds `onPath` (a gh version, or none) and a release whose X64 archive holds `archived`. */
function plant(onPath: string | undefined, archived: string): Planted {
  const root = temp.dir("gh-setup-");
  const bytes = archiveOf(root, archived);
  const bin = join(root, "bin");
  if (onPath !== undefined) fakeGh(bin, onPath);
  const fetched: string[] = [];
  return {
    tool: {
      name: "gh",
      version: PINNED,
      versionArgs: ["--version"],
      versionPattern: /^gh version (\S+)/,
      archives: {
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
    download: (url, file) => {
      fetched.push(url);
      writeFileSync(file, bytes);
    },
  };
}

const landed = (planted: Planted) =>
  existsSync(planted.runner.temp) ? readdirSync(planted.runner.temp) : [];

describe("setUpReleaseBinary", () => {
  test("a gh on PATH printing the pinned version is reused and nothing is fetched", () => {
    const planted = plant(PINNED, PINNED);
    const setUp = setUpReleaseBinary(planted.tool, planted.runner, planted.download);
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
    "with $reason the pinned archive is fetched and only the binary is unpacked under the runner's temp",
    ({ onPath }) => {
      const planted = plant(onPath, PINNED);
      const setUp = setUpReleaseBinary(planted.tool, planted.runner, planted.download);
      const root = join(planted.runner.temp, `gh-${PINNED}`);
      expect([setUp, planted.fetched, readdirSync(join(root, "tool_linux"))]).toEqual([
        { path: join(root, MEMBER), installed: true },
        ["https://example.com/x64.tar.gz"],
        ["bin"],
      ]);
      const printed = boundedSpawnSync([setUp.path, "--version"]).stdout.split("\n")[0];
      expect(printed).toBe(`gh version ${PINNED} (2026-01-01)`);
    },
  );

  test("an archive whose bytes are not the pinned ones is refused and nothing is unpacked", () => {
    const planted = plant(undefined, PINNED);
    const tampered = Uint8Array.from(planted.bytes);
    tampered[tampered.length - 1] ^= 1;
    const refusal = () =>
      setUpReleaseBinary(planted.tool, planted.runner, (_, file) => writeFileSync(file, tampered));
    expect(refusal).toThrow(
      `gh ${PINNED}: https://example.com/x64.tar.gz has sha256 ${sha256(Buffer.from(tampered))}, and the pin is ${sha256(Buffer.from(planted.bytes))}; nothing was unpacked`,
    );
    expect(landed(planted)).toEqual([]);
  });

  test("an archive whose binary prints another version fails, though its sha256 is the pinned one", () => {
    const planted = plant(undefined, "2.104.0");
    const refusal = () => setUpReleaseBinary(planted.tool, planted.runner, planted.download);
    expect(refusal).toThrow(
      `gh ${PINNED}: the unpacked ${join(planted.runner.temp, `gh-${PINNED}`, MEMBER)} prints 2.104.0`,
    );
  });

  test.each<{ os: string; arch: string }>([
    { os: "Linux", arch: "ARM" },
    { os: "macOS", arch: "X64" },
    { os: "Windows", arch: "X64" },
  ])(
    "a $os $arch runner fails naming itself, though a gh at the pin is on PATH",
    ({ os, arch }) => {
      const planted = plant(PINNED, PINNED);
      const refusal = () =>
        setUpReleaseBinary(planted.tool, { ...planted.runner, os, arch }, planted.download);
      expect(refusal).toThrow(
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
