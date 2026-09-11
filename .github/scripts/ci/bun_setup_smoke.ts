#!/usr/bin/env bun
// CI entry for ci.yml's bun-setup-smoke job. `plant` writes two pins under
// RUNNER_TEMP (the manifests' version, first on PATH by then, and an earlier
// release that therefore is not); `judge` reads both calls' outputs.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { env, requireEnv, setOutput } from "../shared/gha.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");

/** A released version below `version` (one patch back, or the previous
 *  minor's .0: every bun minor line starts at .0), so it cannot be the bun
 *  first on PATH once `version` is. */
export function earlierRelease(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (match === null) throw new Error(`not a release version: '${version}'`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (patch > 0) return `${major}.${minor}.${patch - 1}`;
  if (minor > 0) return `${major}.${minor - 1}.0`;
  throw new Error(`no release before ${version}`);
}

export interface CallOutputs {
  path: string;
  ready: string;
  installed: string;
  /** The action's `version` output: what `path` printed when it was resolved. */
  version: string;
}

export interface SmokeReading {
  /** The manifests' pin, first on PATH before the first call. */
  current: string;
  /** An earlier release, so not the bun first on PATH before the second call. */
  previous: string;
  first: CallOutputs;
  second: CallOutputs;
}

/** Every way the two calls miss the contract (first: current bun reused;
 *  second: earlier release installed), judged on each call's own recorded
 *  outputs: the second install can overwrite the first call's binary. */
export function smokeProblems(reading: SmokeReading): string[] {
  const problems: string[] = [];
  const expect = (call: "first" | "second", pin: string, installed: string) => {
    const outputs = reading[call];
    if (!outputs.path.startsWith("/"))
      problems.push(`${call} path is not absolute: '${outputs.path}'`);
    if (outputs.version !== pin)
      problems.push(`${call} version is '${outputs.version}', pin is '${pin}'`);
    if (outputs.ready !== "true") problems.push(`${call} ready is '${outputs.ready}'`);
    if (outputs.installed !== installed) {
      problems.push(`${call} installed is '${outputs.installed}', expected ${installed}`);
    }
  };
  expect("first", reading.current, "false");
  expect("second", reading.previous, "true");
  return problems;
}

function plant(): number {
  const current = readFileSync(join(REPO_ROOT, "files/bun/.bun-version"), "utf8").trim();
  const previous = earlierRelease(current);
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
    ready: env(`${prefix}_READY`),
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
  for (const problem of problems) console.log(`::error::bun-setup smoke: ${problem}`);
  return problems.length === 0 ? 0 : 1;
}

function main(argv: string[]): number {
  if (argv.length === 1 && argv[0] === "plant") return plant();
  if (argv.length === 1 && argv[0] === "judge") return judge();
  console.error("usage: bun_setup_smoke.ts plant|judge");
  return 2;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
