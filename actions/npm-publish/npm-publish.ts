// The registry has no compare-and-set, so only the calling job's lane keeps a verdict true until its publish lands.
// Each write ends once the registry's record shows it, so the next holder of the lane judges against it.
// npm's error text is never branched on: after a failed write the record alone says whether it landed.
//
// Two phases around the repository's build hook:
//   plan    -> judge the record, stamp the next version   (the hook then builds what carries that version)
//   publish -> judge the record again, publish, check the dist-tags

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as core from "@actions/core";
import pWaitFor from "p-wait-for";
import { z } from "zod";
import {
  capture,
  env,
  failureDetail,
  messageOf,
  type RunOptions,
  type RunResult,
  requireEnv,
  succeeded,
} from "../shared/action_runtime.ts";

const NPM_CLI = join(import.meta.dir, "node_modules", "npm", "bin", "npm-cli.js");
const REGISTRY = "https://registry.npmjs.org";
const DEFAULT_TAG = "latest";
const PLAIN_RELEASE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const GIT_BOUND_MS = 60_000;
const NPM_BOUND_MS = 60_000;
const PUBLISH_BOUND_MS = 600_000;
const READ_BOUND_MS = 30_000;
const CONFIRM = { everyMs: 5_000, boundMs: 120_000 } as const;
const STAMP_FLAGS = ["--no-git-tag-version", "--ignore-scripts"] as const;
const BEHIND_RELEASE = {
  next: "the package.json on main is behind the registry",
  latest: "a release never moves latest back",
} as const;
const PUBLISH_ARGS = { next: ["publish", "--tag", "next"], latest: ["publish"] } as const;

const packageSchema = z.object({
  name: z.string().min(1),
  version: z.string(),
  private: z.unknown().optional(),
  tag: z.unknown().optional(),
  publishConfig: z.record(z.string(), z.unknown()).optional(),
});

const recordSchema = z.object({
  "versions": z.record(z.string(), z.unknown()),
  "dist-tags": z.record(z.string(), z.string()),
});

/** The dist-tag a run publishes under. */
export type Channel = keyof typeof PUBLISH_ARGS;

/** Runs one child with a deadline and returns its exit and output; a test hands in a recorder. */
export type Runner = (command: string[], options: RunOptions) => RunResult;

/** The run's log, @actions/core's own in main; a test hands in a recorder. */
export type Log = Pick<typeof core, "info" | "notice">;

/** What the registry holds for a package: every published version, and the version each dist-tag names. */
export type RegistryRecord = z.infer<typeof recordSchema>;

/** The package as its package.json names it. */
export interface Package {
  name: string;
  version: string;
}

/** Where the checked-out commit sits on main. */
export interface MainPosition {
  /** The commits on main's first-parent line up to this one, itself included. */
  count: number;

  /** The commit's committer date in UTC, as yyyymmdd. */
  date: string;

  /** The commit's full sha. */
  sha: string;
}

/** What to do with a version, judged against the registry's record. */
export type Verdict =
  | { action: "publish" }
  | { action: "skip"; reason: string }
  | { action: "fail"; reason: string };

/** What a phase reaches the outside world through. */
export interface Tools {
  /** Runs git and npm. */
  run: Runner;

  /** Reads a package's record from the registry, fresh on every call. */
  readRecord: (name: string) => Promise<RegistryRecord>;

  /** How often, and for how long, a write is looked for on the record. */
  confirm: { everyMs: number; boundMs: number };

  /** Takes the run's notices. */
  log: Log;
}

/** What the plan phase is asked. */
export interface PlanRequest {
  /** The dist-tag to publish under. */
  channel: Channel;

  /** The release's tag, read on the latest channel alone. */
  tag: string;

  /** The package's directory, inside a full checkout of the commit being published. */
  directory: string;
}

/** The plan phase's result, the action's outputs there. */
export interface Plan {
  /** The version the run judged: the minted pre-release on next, the release on latest. */
  version: string;

  /** Whether the record leaves this version to publish, so whether the build hook runs. */
  publish: boolean;
}

/** What the publish phase is asked. */
export interface PublishRequest {
  /** The dist-tag to publish under. */
  channel: Channel;

  /** The version the plan phase judged, and on next stamped. */
  version: string;

  /** The package's directory, built by the hook. */
  directory: string;
}

/** The publish phase's result, the action's outputs there. */
export interface Outcome {
  /** The version the run judged. */
  version: string;

  /** Whether this run's publish put the version on the registry. */
  published: boolean;
}

/**
 * The package a package.json declares.
 *
 * @throws {Error} the text is not a publishable manifest: no name, `private: true`, a `tag` or `publishConfig.tag`,
 *   which npm takes over the channel's, or a registry in `publishConfig`, which the record is not read from
 */
export function parsePackage(text: string): Package {
  const parsed = packageSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    throw new Error(`${issue.path.join(".") || "(top level)"}: ${issue.message}`);
  }

  if (parsed.data.private === true) {
    throw new Error("the package is private: true, which npm never publishes");
  }

  const publishConfig = parsed.data.publishConfig ?? {};
  if (parsed.data.tag !== undefined || publishConfig.tag !== undefined) {
    throw new Error(
      "tag or publishConfig.tag is set: the channel decides the dist-tag, so remove it",
    );
  }

  const registryKey = Object.keys(publishConfig).find((key) => /(^|:)registry$/.test(key));
  if (registryKey !== undefined) {
    throw new Error(
      `publishConfig.${registryKey} is set: this module publishes to ${REGISTRY} alone, so remove it`,
    );
  }

  return { name: parsed.data.name, version: parsed.data.version };
}

/**
 * The pre-release version a main commit publishes under `next`: above the release on disk, below the next release
 * whatever its bump, and rising along main by the commit count.
 *
 * @param base - the version on disk, a plain release X.Y.Z
 */
export function nextVersion(base: string, position: MainPosition): string {
  const [major, minor, patch] = base.split(".");
  // The `g` keeps an all-digit short sha an identifier: npm reads 0123456 as the number 123456.
  const source = `g${position.sha.slice(0, 7)}`;

  return `${major}.${minor}.${Number(patch) + 1}-main.${position.count}.${position.date}.${source}`;
}

/** Why `channel`'s dist-tag ended behind `version` on a record that shows the version, or null when it did not. */
export function tagBehind(
  channel: Channel,
  version: string,
  record: RegistryRecord,
): string | null {
  const named = record["dist-tags"][channel];
  if (named !== undefined && Bun.semver.order(named, version) >= 0) return null;

  return `${version} is on the registry, but ${channel} names ${named ?? "nothing"}, which is behind it`;
}

/** Whether to publish `version` on `channel`, given what the registry holds before the publish. */
export function verdictOf(channel: Channel, version: string, record: RegistryRecord): Verdict {
  if (Object.hasOwn(record.versions, version)) {
    // A rerun of a run whose tag ended behind must not turn green on the version alone.
    const behind = tagBehind(channel, version, record);
    if (behind !== null) return { action: "fail", reason: behind };

    return { action: "skip", reason: `${version} is already on the registry (a rerun)` };
  }

  const releases = Object.keys(record.versions).filter((known) => PLAIN_RELEASE.test(known));
  const newest = releases.sort(Bun.semver.order).at(-1);
  if (newest !== undefined && Bun.semver.order(version, newest) <= 0) {
    return {
      action: "fail",
      reason: `${version} is not above the released ${newest}: ${BEHIND_RELEASE[channel]}`,
    };
  }

  const next = record["dist-tags"].next;
  if (channel === "next" && next !== undefined && Bun.semver.order(next, version) >= 0) {
    return {
      action: "skip",
      reason: `next names ${next}, which is not below this commit's ${version}: next never moves back`,
    };
  }

  return { action: "publish" };
}

function nextBelow(version: string, record: RegistryRecord): boolean {
  const next = record["dist-tags"].next;

  return next === undefined || Bun.semver.order(next, version) < 0;
}

/**
 * Why the release `version` leaves `next` where it is, or null when it must move `next` to itself: `next` is never
 * older than `latest`, never moves back, and only the release `latest` names moves it.
 */
export function nextStays(version: string, record: RegistryRecord): string | null {
  const { latest, next } = record["dist-tags"];
  if (latest !== version) {
    return `latest names ${latest ?? "nothing"}, so ${version} is not the current release: next is left at ${next ?? "nothing"}`;
  }

  if (nextBelow(version, record)) return null;

  return `next names ${next}, not below ${version}: left there`;
}

function git(run: Runner, cwd: string, args: string[]): string {
  const result = run(["git", ...args], { cwd, timeoutMs: GIT_BOUND_MS });
  if (!succeeded(result.exit)) {
    throw new Error(`git ${args.join(" ")} failed: ${failureDetail(result)}`);
  }

  return result.stdout.trim();
}

function mainPosition(run: Runner, cwd: string): MainPosition {
  // A shallow checkout counts to its boundary, and the short count would sort below versions minted from the full history.
  if (git(run, cwd, ["rev-parse", "--is-shallow-repository"]) === "true") {
    throw new Error(
      "the checkout is shallow: the next version counts main's commits (fetch-depth: 0)",
    );
  }

  const count = Number(git(run, cwd, ["rev-list", "--count", "--first-parent", "HEAD"]));
  const committed = Number(git(run, cwd, ["show", "-s", "--format=%ct", "HEAD"]));
  const date = new Date(committed * 1000).toISOString().slice(0, 10).replaceAll("-", "");

  return { count, date, sha: git(run, cwd, ["rev-parse", "HEAD"]) };
}

function releasedVersion(version: string, tag: string): string {
  if (!tag.endsWith(`v${version}`)) {
    throw new Error(
      `the release tag '${tag}' does not end with v${version}: release-please did not bump this package.json`,
    );
  }

  return version;
}

/** The pinned npm with the package directory as its whole project, so every command reads one configuration. */
function npmCommand(args: readonly string[]): string[] {
  // Inside a workspace npm would read the root's .npmrc on publish, refuse `config get`, and resolve the workspace on `version`.
  return ["node", NPM_CLI, ...args, "--no-workspaces"];
}

function npm(tools: Tools, cwd: string, args: readonly string[], timeoutMs: number): RunResult {
  const result = tools.run(npmCommand(args), { cwd, timeoutMs });
  const said = `${result.stdout}${result.stderr}`.trim();
  if (said !== "") tools.log.info(said);

  return result;
}

function npmFailure(result: RunResult): string {
  if (result.exit.kind !== "exited") return failureDetail(result);

  const error = result.stderr.split("\n").find((line) => line.startsWith("npm error"));
  return error ?? failureDetail(result);
}

/** The first record on which `holds`, read within the confirmation bound; undefined when none did. */
function recordWhere(
  name: string,
  tools: Tools,
  holds: (record: RegistryRecord) => boolean,
): Promise<RegistryRecord | undefined> {
  return pWaitFor<RegistryRecord | undefined>(
    async () => {
      const record = await tools.readRecord(name);
      return holds(record) && pWaitFor.resolveWith(record);
    },
    {
      interval: tools.confirm.everyMs,
      timeout: { milliseconds: tools.confirm.boundMs, fallback: () => undefined },
    },
  );
}

function npmConfig(tools: Tools, cwd: string, key: string): string {
  const result = tools.run(npmCommand(["config", "get", key]), { cwd, timeoutMs: NPM_BOUND_MS });
  if (!succeeded(result.exit)) {
    throw new Error(`npm config get ${key} failed: ${failureDetail(result)}`);
  }

  return result.stdout.trim();
}

/** A configured tag moves the bare release publish off `latest`, and a configured registry moves the upload away from the record read here. */
function requireDefaultConfig(pkg: Package, cwd: string, tools: Tools): void {
  const tag = npmConfig(tools, cwd, "tag");
  if (tag !== DEFAULT_TAG) {
    throw new Error(
      `npm's tag is configured as '${tag}': the channel decides the dist-tag, so remove the setting`,
    );
  }

  const keys = ["registry"];
  if (pkg.name.startsWith("@")) keys.push(`${pkg.name.split("/")[0]}:registry`);

  for (const key of keys) {
    const configured = npmConfig(tools, cwd, key).replace(/\/+$/, "");
    if (configured === REGISTRY || configured === "undefined") continue;

    throw new Error(
      `npm's ${key} is configured as ${configured}: this module publishes to ${REGISTRY} alone`,
    );
  }
}

/**
 * Judges the package against the registry before anything is built, and on next stamps the version it will publish.
 *
 * @throws {Error} the version on disk is not a plain release, npm is configured with a tag or another registry, the
 *   release tag names another version, the checkout is shallow, or the verdict is a refusal
 */
export async function planPublish(pkg: Package, request: PlanRequest, tools: Tools): Promise<Plan> {
  const { channel, directory } = request;
  if (!PLAIN_RELEASE.test(pkg.version)) {
    throw new Error(`the version on disk, ${pkg.version}, must be a plain release X.Y.Z`);
  }

  requireDefaultConfig(pkg, directory, tools);

  const version =
    channel === "next"
      ? nextVersion(pkg.version, mainPosition(tools.run, directory))
      : releasedVersion(pkg.version, request.tag);
  const verdict = verdictOf(channel, version, await tools.readRecord(pkg.name));

  if (verdict.action === "fail") throw new Error(verdict.reason);

  if (verdict.action === "skip") {
    tools.log.notice(`${pkg.name}: nothing to publish, ${verdict.reason}`);
    return { version, publish: false };
  }

  if (channel === "next") {
    // The stamp runs before the hook installed anything, so it runs no lifecycle script.
    const stamped = npm(tools, directory, ["version", version, ...STAMP_FLAGS], NPM_BOUND_MS);
    if (!succeeded(stamped.exit)) {
      throw new Error(`npm version ${version} failed: ${failureDetail(stamped)}`);
    }
  }

  return { version, publish: true };
}

async function publishVersion(
  pkg: Package,
  request: PublishRequest,
  tools: Tools,
): Promise<RegistryRecord> {
  const { channel, version, directory } = request;
  const id = `${pkg.name}@${version}`;
  // latest passes no tag: any tag, `latest` included, switches off npm's own refusal of a version below the newest release.
  const result = npm(tools, directory, PUBLISH_ARGS[channel], PUBLISH_BOUND_MS);
  const record = await recordWhere(pkg.name, tools, (held) =>
    Object.hasOwn(held.versions, version),
  );

  if (record === undefined && succeeded(result.exit)) {
    throw new Error(
      `npm reported ${id} published, but the registry did not show it within ${tools.confirm.boundMs / 1000} s: re-run the job`,
    );
  }

  if (record === undefined) {
    throw new Error(
      [
        `npm publish failed and ${id} is not on the registry: ${npmFailure(result)}`,
        "Check the package's trusted publisher on npmjs.com:",
        "  its workflow file is ci.yml",
        '  it allows "npm publish"',
        "  its repository is this one, and the package is the one named here",
      ].join("\n"),
    );
  }

  if (!succeeded(result.exit)) {
    tools.log.notice(`npm publish failed (${npmFailure(result)}), yet ${id} is on the registry`);
  }

  const behind = tagBehind(channel, version, record);
  if (behind !== null) throw new Error(behind);

  return record;
}

async function moveNextToRelease(
  pkg: Package,
  request: PublishRequest,
  record: RegistryRecord,
  tools: Tools,
): Promise<void> {
  const { version, directory } = request;
  const stays = nextStays(version, record);
  if (stays !== null) {
    tools.log.notice(`${pkg.name}: ${stays}`);
    return;
  }

  const result = npm(
    tools,
    directory,
    ["dist-tag", "add", `${pkg.name}@${version}`, "next"],
    NPM_BOUND_MS,
  );
  const moved = await recordWhere(pkg.name, tools, (held) => !nextBelow(version, held));
  if (moved !== undefined) return;

  const said = succeeded(result.exit) ? "npm reported it moved" : npmFailure(result);
  throw new Error(
    [
      `next was not moved to ${version}: ${said}`,
      'Check the package\'s trusted publisher on npmjs.com: it must allow "npm dist-tag", which is off by default.',
      "Then re-run the job: the release is published, and only the tag is left to move.",
    ].join("\n"),
  );
}

/**
 * Publishes the built package when the record still allows it, waits for the record to show it, and checks the
 * channel's dist-tag. A release also moves `next` to itself, on a rerun too.
 *
 * @throws {Error} the hook changed the version, the verdict is a refusal, a write did not land, or a dist-tag ended
 *   behind the version
 */
export async function publishPackage(
  pkg: Package,
  request: PublishRequest,
  tools: Tools,
): Promise<Outcome> {
  const { channel, version } = request;
  if (pkg.version !== version) {
    throw new Error(
      `package.json is at ${pkg.version}, not the planned ${version}: the build hook must leave the version alone`,
    );
  }

  const before = await tools.readRecord(pkg.name);
  const verdict = verdictOf(channel, version, before);

  if (verdict.action === "fail") throw new Error(verdict.reason);

  if (verdict.action === "skip") {
    tools.log.notice(`${pkg.name}: not published, ${verdict.reason}`);
  }

  const record = verdict.action === "publish" ? await publishVersion(pkg, request, tools) : before;
  if (channel === "latest") await moveNextToRelease(pkg, request, record, tools);

  return { version, published: verdict.action === "publish" };
}

function channelOf(value: string): Channel {
  if (value !== "next" && value !== "latest") {
    throw new Error(`channel must be next or latest; got '${value}'`);
  }

  return value;
}

function readPackage(directory: string): Package {
  const path = join(directory, "package.json");
  try {
    return parsePackage(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error(`${path}: ${messageOf(cause)}`);
  }
}

/** A fresh query string makes the read a cache miss: the registry serves a record for five minutes otherwise. */
async function readRecord(name: string): Promise<RegistryRecord> {
  const url = `${REGISTRY}/${name.replaceAll("/", "%2F")}?fresh=${Date.now()}`;
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(READ_BOUND_MS),
  });

  if (response.status === 404) {
    throw new Error(
      `${name} is not on ${REGISTRY}: the package must exist on npm, with a trusted publisher, before this leg publishes it`,
    );
  }

  if (response.status !== 200) {
    throw new Error(`reading ${name} from ${REGISTRY} answered ${response.status}`);
  }

  const parsed = recordSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error(`the record ${REGISTRY} holds for ${name} has no versions or dist-tags`);
  }

  return parsed.data;
}

async function main(): Promise<void> {
  if (env("ACTIONS_ID_TOKEN_REQUEST_URL") === "") {
    throw new Error(
      "the job has no OIDC token to publish with: its permissions need id-token: write",
    );
  }

  const phase = requireEnv("PHASE");
  const channel = channelOf(requireEnv("CHANNEL"));
  const directory = join(process.cwd(), requireEnv("PACKAGE_PATH"));
  const pkg = readPackage(directory);
  const tools: Tools = {
    run: capture,
    readRecord,
    confirm: CONFIRM,
    log: core,
  };

  if (phase === "plan") {
    const plan = await planPublish(pkg, { channel, tag: env("TAG"), directory }, tools);
    core.setOutput("version", plan.version);
    core.setOutput("publish", String(plan.publish));
    return;
  }

  if (phase !== "publish") throw new Error(`phase must be plan or publish; got '${phase}'`);

  const request = { channel, version: requireEnv("VERSION"), directory };
  const outcome = await publishPackage(pkg, request, tools);
  core.setOutput("version", outcome.version);
  core.setOutput("published", String(outcome.published));
}

if (import.meta.main) {
  try {
    await main();
  } catch (cause) {
    core.setFailed(messageOf(cause));
  }
}
