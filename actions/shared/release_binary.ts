// A tool a job needs as one binary from a release: reused when the runner already has the pinned version, fetched and
// checked against the pinned sha256 otherwise. The sha256 is the pin, since a release's own checksums file comes from
// the same place as its download.
//
// DEPENDENCY-FREE ZONE (see grammar.ts): node builtins and zone-internal imports only.

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { capture, failureDetail, requireEnv, succeeded } from "./action_runtime.ts";
import { sha256 } from "./values.ts";

/** One architecture's download of a release: a tar, or the binary itself. */
export interface ReleaseDownload {
  /** Where the tar, or the binary, is downloaded from. */
  url: string;

  /** Of the downloaded bytes, lowercase hex. */
  sha256: string;

  /** The binary's path inside the tar, gzipped or xz; absent when the download is the binary. */
  member?: string;
}

export interface ReleaseBinary {
  /** The command's name on PATH. */
  name: string;

  /** The pinned release, as the binary prints it. */
  version: string;

  /** The arguments that make the binary print its version. */
  versionArgs: string[];

  /** Reads the version, as capture group 1, out of what the binary printed. */
  versionPattern: RegExp;

  /** Keyed by `runner.arch`. */
  downloads: Record<string, ReleaseDownload>;
}

/** The job the binary is set up for, as the runner describes it. */
export interface Runner {
  /** `runner.os` */
  os: string;

  /** `runner.arch` */
  arch: string;

  /** `runner.temp`: the fetched binary lands under it and nowhere else. */
  temp: string;

  /** The PATH searched for a binary to reuse. */
  path: string;
}

/** The runner of the job this process is a step of. */
export function thisRunner(): Runner {
  return {
    os: requireEnv("RUNNER_OS"),
    arch: requireEnv("RUNNER_ARCH"),
    temp: requireEnv("RUNNER_TEMP"),
    path: requireEnv("PATH"),
  };
}

export interface SetUp {
  /** Absolute path of a binary that printed the pinned version. */
  path: string;

  /** Whether the release was fetched: false for a binary reused from PATH. */
  installed: boolean;
}

/** Writes the bytes at `url` to `file`. */
export type Download = (url: string, file: string) => void;

const VERSION_BOUND_MS = 30_000;
const UNPACK_BOUND_MS = 120_000;
const DOWNLOAD_BOUND_MS = 600_000;

/** The version the binary at `path` prints, or undefined when it does not run or prints none. */
function printedVersion(tool: ReleaseBinary, path: string): string | undefined {
  const result = capture([path, ...tool.versionArgs], { timeoutMs: VERSION_BOUND_MS });
  if (!succeeded(result.exit)) return undefined;

  return tool.versionPattern.exec(result.stdout)?.[1];
}

/** To a file, never a pipe: curl starts the file over on a retry, and a pipe would keep the failed attempt's bytes. */
export const download: Download = (url, file) => {
  const curl = capture(
    ["curl", "-fsSL", "--retry", "3", "--retry-all-errors", "--max-time", "120", "-o", file, url],
    { timeoutMs: DOWNLOAD_BOUND_MS },
  );
  if (!succeeded(curl.exit)) {
    throw new Error(`${url} could not be downloaded (${failureDetail(curl)})`);
  }
};

/** The pinned binary for the job: the one on PATH when it prints the pinned version, a fetched one otherwise.
 *
 * @throws {Error} the runner is not one the release is pinned for, the download failed or its sha256 is not the pin,
 *   or what was fetched does not print the pinned version
 */
export function setUpReleaseBinary(
  tool: ReleaseBinary,
  runner: Runner,
  fetchRelease: Download = download,
): SetUp {
  const what = `${tool.name} ${tool.version}`;
  const release = runner.os === "Linux" ? tool.downloads[runner.arch] : undefined;
  if (release === undefined) {
    const pinned = Object.keys(tool.downloads).join(" and ");
    throw new Error(
      `${what} is pinned for Linux ${pinned}, and this runner is ${runner.os} ${runner.arch}`,
    );
  }

  const onPath = Bun.which(tool.name, { PATH: runner.path });
  if (onPath?.startsWith("/") && printedVersion(tool, onPath) === tool.version) {
    return { path: onPath, installed: false };
  }

  const root = join(runner.temp, `${tool.name}-${tool.version}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const file = join(root, `${tool.name}.download`);
  fetchRelease(release.url, file);
  const fetched = sha256(readFileSync(file));
  if (fetched !== release.sha256) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(
      `${what}: ${release.url} has sha256 ${fetched}, and the pin is ${release.sha256}; nothing was installed`,
    );
  }

  const path = join(root, release.member ?? tool.name);
  if (release.member === undefined) {
    renameSync(file, path);
    chmodSync(path, 0o755);
  } else {
    // tar reads the compression from the file, so one command unpacks a gzipped tar and an xz one.
    const unpacked = capture(["tar", "-xf", file, "-C", root, release.member], {
      timeoutMs: UNPACK_BOUND_MS,
    });
    rmSync(file);
    if (!succeeded(unpacked.exit)) {
      throw new Error(
        `${what}: ${release.member} could not be unpacked (${failureDetail(unpacked)})`,
      );
    }
  }

  const printed = printedVersion(tool, path);
  if (printed !== tool.version) {
    throw new Error(
      `${what}: the fetched ${path} ${printed === undefined ? "did not print a version" : `prints ${printed}`}`,
    );
  }

  return { path, installed: true };
}
