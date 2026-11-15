#!/usr/bin/env bun

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { error, setOutput } from "@actions/core";
import { z } from "zod";
import { env, requireEnv } from "../shared/gha.ts";
import { GitHubClient, unansweredReason } from "../shared/github.ts";

/** The checkout holding the pin file. */
const REPO_ROOT = resolve(import.meta.dir, "../../..");

/** Where bun publishes its releases. */
const BUN_REPOSITORY = "oven-sh/bun";

/** A release tag that names a version; the canary tag does not. */
const RELEASE_TAG = /^bun-v(\d+\.\d+\.\d+)$/;

/** The fields of a listed release that decide whether it counts. */
const listedRelease = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
});

/** The newest published bun release older than the pin, read from bun's release list.
 *
 * @throws {Error} the list could not be read, or holds no release older than the pin
 */
export async function earlierRelease(pin: string, github: GitHubClient): Promise<string> {
  const releases = await github.paginate(`repos/${BUN_REPOSITORY}/releases`, listedRelease);
  if (releases.kind !== "ok") {
    throw new Error(
      `${BUN_REPOSITORY}: releases could not be read (${unansweredReason(releases)})`,
    );
  }

  const older = releases.value
    .filter((release) => !release.draft && !release.prerelease)
    .flatMap((release) => RELEASE_TAG.exec(release.tag_name)?.slice(1) ?? [])
    .filter((version) => Bun.semver.order(version, pin) < 0)
    .sort(Bun.semver.order);
  const newest = older.at(-1);
  if (newest === undefined) throw new Error(`${BUN_REPOSITORY}: no release before ${pin}`);

  return newest;
}

/** The action's outputs from one call; `version` is what `path` printed when it was resolved. */
export interface CallOutputs {
  path: string;
  installed: string;
  version: string;
}

export interface SmokeReading {
  /** The manifests' pin, first on PATH before the first call. */
  current: string;

  /** The release before the pin, so not the bun first on PATH before the second call. */
  previous: string;

  /** The call made with `current` first on PATH. */
  first: CallOutputs;

  /** The call made with `previous` first on PATH. */
  second: CallOutputs;
}

/** Judged on each call's recorded outputs, not a live probe: the second install can overwrite the first call's binary. */
export function smokeProblems(reading: SmokeReading): string[] {
  const problems: string[] = [];
  const expect = (call: "first" | "second", pin: string, installed: string) => {
    const outputs = reading[call];
    if (!outputs.path.startsWith("/")) {
      problems.push(`${call} path is not absolute: '${outputs.path}'`);
    }
    if (outputs.version !== pin) {
      problems.push(`${call} version is '${outputs.version}', pin is '${pin}'`);
    }
    if (outputs.installed !== installed) {
      problems.push(`${call} installed is '${outputs.installed}', expected ${installed}`);
    }
  };
  expect("first", reading.current, "false");
  expect("second", reading.previous, "true");
  return problems;
}

async function plant(): Promise<number> {
  const current = readFileSync(join(REPO_ROOT, "files/bun/.bun-version"), "utf8").trim();
  const previous = await earlierRelease(current, new GitHubClient());
  const root = join(requireEnv("RUNNER_TEMP"), "bun-setup-smoke");
  for (const [name, version] of [
    ["current", current],
    ["previous", previous],
  ]) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, ".bun-version"), `${version}\n`);
  }
  setOutput("current", current);
  setOutput("previous", previous);
  return 0;
}

function judge(): number {
  const call = (prefix: string): CallOutputs => ({
    path: env(`${prefix}_PATH`),
    installed: env(`${prefix}_INSTALLED`),
    version: env(`${prefix}_VERSION`),
  });
  const reading: SmokeReading = {
    current: requireEnv("CURRENT"),
    previous: requireEnv("PREVIOUS"),
    first: call("FIRST"),
    second: call("SECOND"),
  };
  console.log(JSON.stringify(reading, null, 2));
  const problems = smokeProblems(reading);
  for (const problem of problems) error(`bun-setup smoke: ${problem}`);
  return problems.length === 0 ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  if (argv.length === 1 && argv[0] === "plant") return plant();
  if (argv.length === 1 && argv[0] === "judge") return judge();
  console.error("usage: bun_setup_smoke.ts plant|judge");
  return 2;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
