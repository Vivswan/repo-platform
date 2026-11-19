// The jq the pinned typos action formats its annotations with: that action calls `jq` by name and prints no annotation without one,
// so the release pinned in action.yml goes on PATH before it runs.

import { dirname } from "node:path";
import * as core from "@actions/core";
import * as toolCache from "@actions/tool-cache";
import { messageOf, requireEnv } from "../shared/action_runtime.ts";
import { type ReleaseBinary, setUpReleaseBinary, thisRunner } from "../shared/release_binary.ts";

type Arch = "X64" | "ARM64";

/** The pinned jqlang/jq release, whose downloads are the binaries themselves: `sha256` holds each one's digest under
 *  its `runner.arch`. */
export function jqRelease(version: string, sha256: Record<Arch, string>): ReleaseBinary {
  const binary = (arch: Arch, named: string) => ({
    url: `https://github.com/jqlang/jq/releases/download/jq-${version}/jq-linux-${named}`,
    sha256: sha256[arch],
  });
  return {
    name: "jq",
    version,
    versionArgs: ["--version"],
    versionPattern: /^jq-(\S+)/,
    downloads: { X64: binary("X64", "amd64"), ARM64: binary("ARM64", "arm64") },
  };
}

async function main(): Promise<void> {
  const release = jqRelease(requireEnv("JQ_VERSION"), {
    X64: requireEnv("JQ_SHA256_X64"),
    ARM64: requireEnv("JQ_SHA256_ARM64"),
  });
  const jq = await setUpReleaseBinary(release, thisRunner(), toolCache);
  if (jq.installed) core.addPath(dirname(jq.path));
}

if (import.meta.main) {
  try {
    await main();
  } catch (cause) {
    core.setFailed(messageOf(cause));
  }
}
