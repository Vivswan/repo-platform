// The GitHub CLI the platform's jobs run: the release and its two downloads are pinned in action.yml, which hands them
// here through the environment, so a job never depends on the gh its runner happens to carry.

import { dirname } from "node:path";
import * as core from "@actions/core";
import { messageOf, requireEnv } from "../shared/action_runtime.ts";
import { type ReleaseBinary, setUpReleaseBinary, thisRunner } from "../shared/release_binary.ts";

/** cli/cli's archive name for each `runner.arch` the platform pins. */
const ARCHIVE_ARCH = { X64: "amd64", ARM64: "arm64" } as const;

/** The pinned gh release: `sha256` holds each archive's digest under its `runner.arch`. */
export function ghRelease(
  version: string,
  sha256: Record<keyof typeof ARCHIVE_ARCH, string>,
): ReleaseBinary {
  const archive = (arch: keyof typeof ARCHIVE_ARCH) => {
    const folder = `gh_${version}_linux_${ARCHIVE_ARCH[arch]}`;
    return {
      url: `https://github.com/cli/cli/releases/download/v${version}/${folder}.tar.gz`,
      sha256: sha256[arch],
      member: `${folder}/bin/gh`,
    };
  };
  return {
    name: "gh",
    version,
    versionArgs: ["--version"],
    versionPattern: /^gh version (\S+)/,
    downloads: { X64: archive("X64"), ARM64: archive("ARM64") },
  };
}

function main(): void {
  const release = ghRelease(requireEnv("GH_VERSION"), {
    X64: requireEnv("GH_SHA256_X64"),
    ARM64: requireEnv("GH_SHA256_ARM64"),
  });
  const gh = setUpReleaseBinary(release, thisRunner());
  if (gh.installed) core.addPath(dirname(gh.path));
  core.setOutput("path", gh.path);
  core.setOutput("installed", String(gh.installed));
  core.setOutput("version", release.version);
}

if (import.meta.main) {
  try {
    main();
  } catch (cause) {
    core.setFailed(messageOf(cause));
  }
}
