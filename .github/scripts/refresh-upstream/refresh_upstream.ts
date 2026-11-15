#!/usr/bin/env bun
// The one writer of the upstream pins: a commit pin (an upstream ref's sha in files.yml, fetched at by every sync) moves
// to its repository's HEAD; a release pin (a module's version dotfile under files/, read by the sync, the operator's
// workflows, and the composite actions) moves to its repository's latest release; a tool pin (a release archive this
// repository's own workflow installs by version and sha256) moves to its repository's latest release and that archive's
// digest. The workflow around this script runs it once per kind and commits each kind on its own PR branch, so a
// toolchain bump is never held behind a gitignore diff.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setOutput } from "@actions/core";
import { CST, isScalar, Parser, parseDocument, visit } from "yaml";
import { z } from "zod";
import { GitHubClient, unansweredReason } from "../../../actions/github-client/github.ts";
import {
  type FilesConfig,
  type ModulePin,
  PIN_VERSION_TOKEN,
  parseFilesConfig,
  type UpstreamRef,
  upstreamRefs,
} from "../../../actions/plan/files_config.ts";
import { BUN_PIN_FILE, bunLockDirs } from "../../../scripts/bootstrap.ts";
import { must } from "../shared/proc.ts";
import { unifiedDiff } from "../sync/writer/report.ts";
import { type Fetch, fetchText, fetchUpstream, RAW_HOST } from "../sync/writer/upstream.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

export const PIN_KINDS = ["commit", "release", "tool"] as const;
export type PinKind = (typeof PIN_KINDS)[number];

const headCommit = z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) });

const latestReleaseReply = z.object({ tag_name: z.string() });

const latestAssetsReply = latestReleaseReply.extend({
  assets: z.array(z.object({ name: z.string(), digest: z.string().nullable() })),
});

/** A release archive one workflow step downloads and checks against a recorded sha256, both spelled in that step's `env`. */
interface ToolPin {
  /** What the PR calls the tool. */
  name: string;

  /** The github.com repository whose latest release the pin follows. */
  repository: string;

  /** The release tag, with `{version}` where the version stands. */
  tag: string;

  /** The archive's file name in the release, with `{version}` wherever it spells the version. */
  asset: string;

  /** The workflow that installs the tool. */
  file: string;

  /** The `env` key holding the version. */
  versionKey: string;

  /** The `env` key holding the archive's sha256. */
  sha256Key: string;
}

/** The tools this repository's own CI installs from a release archive. */
const TOOL_PINS: ToolPin[] = [
  {
    name: "pinact",
    repository: "suzuki-shunsuke/pinact",
    tag: "v{version}",
    asset: "pinact_linux_amd64.tar.gz",
    file: ".github/workflows/ci.yml",
    versionKey: "PINACT_VERSION",
    sha256Key: "PINACT_SHA256",
  },
  {
    name: "vale",
    repository: "vale-cli/vale",
    tag: "v{version}",
    asset: "vale_{version}_Linux_64-bit.tar.gz",
    file: ".github/workflows/ci.yml",
    versionKey: "VALE_VERSION",
    sha256Key: "VALE_SHA256",
  },
];

/** HEAD of the default branch.
 *
 * @throws {Error} the read failed or carried no full sha; the message is fixed text, never the reply
 */
export async function headSha(repository: string, github: GitHubClient): Promise<string> {
  const head = await github.get(`repos/${repository}/commits/HEAD`, headCommit);
  if (head.kind !== "ok") {
    throw new Error(`${repository}: commits/HEAD could not be read (${unansweredReason(head)})`);
  }
  return head.value.sha;
}

/** An upstream ref's pin and every file files.yml fetches at it, sorted. */
export interface CommitPin {
  repository: string;
  sha: string;
  paths: string[];
}

export function pins(refs: UpstreamRef[]): CommitPin[] {
  const seen = new Map<string, CommitPin>();
  for (const { repository, sha, path } of refs) {
    const key = `${repository}@${sha}`;
    const pin = seen.get(key) ?? { repository, sha, paths: [] };
    if (!pin.paths.includes(path)) pin.paths.push(path);
    seen.set(key, pin);
  }
  return [...seen.values()].map((pin) => ({ ...pin, paths: [...pin.paths].sort() }));
}

/** Every mapping spelling the pin (an entry's source or a block's source) moves together, by the sha scalar's own text range so the
 *  document keeps its bytes outside the sha scalar; a quoted pin comes back bare. The repository is part of the match,
 *  so another repository at the same sha stays put. */
export function repin(
  text: string,
  pin: Pick<CommitPin, "repository" | "sha">,
  to: string,
): string {
  const spans: [number, number][] = [];
  visit(parseDocument(text), {
    Map(_, map) {
      const repository = map.get("repository", true);
      const sha = map.get("sha", true);
      if (
        isScalar(repository) &&
        repository.value === pin.repository &&
        isScalar(sha) &&
        sha.value === pin.sha &&
        sha.range
      ) {
        spans.push([sha.range[0], sha.range[1]]);
      }
    },
  });
  if (spans.length === 0) {
    throw new Error(`files.yml names no pin ${pin.repository}@${pin.sha}`);
  }
  return spans
    .sort(([a], [b]) => b - a)
    .reduce((out, [start, end]) => `${out.slice(0, start)}${to}${out.slice(end)}`, text);
}

/** `name` is the repository of a commit pin, the module of a release pin, or the tool of a tool pin. `diffs` maps each fetched path whose body,
 *  normalized as the writer fetches it, differs between the two commits to its unified diff; `refreshCommitPins`, the
 *  one constructor, builds a commit bump only from a non-empty map. */
export type Bump =
  | {
      kind: "commit";
      name: string;
      from: string;
      to: string;
      diffs: Map<string, string>;
    }
  | {
      kind: "release" | "tool";
      name: string;
      from: string;
      to: string;
    };

/** Each fetched path whose normalized body differs between the two commits, to its unified diff. */
async function commitDiffs(
  pin: CommitPin,
  to: string,
  host: string,
  fetch: Fetch,
): Promise<Map<string, string>> {
  const refs = (sha: string) =>
    pin.paths.map((path) => ({ repository: pin.repository, sha, path }));
  const before = await fetchUpstream(refs(pin.sha), host, fetch);
  const after = await fetchUpstream(refs(to), host, fetch);
  const diffs = new Map<string, string>();
  // normalizeUpstream drops the final newline the renderer puts back, so the diff is of the rendered lines.
  for (const [old, next] of refs(pin.sha).map((ref, i) => [ref, refs(to)[i]] as const)) {
    if (before.body(old) !== after.body(next)) {
      diffs.set(old.path, unifiedDiff(old.path, `${before.body(old)}\n`, `${after.body(next)}\n`));
    }
  }
  return diffs;
}

function versionFrom(value: unknown, pattern: RegExp, what: string): string {
  if (typeof value !== "string") {
    throw new Error(`${what}: expected a string, got ${typeof value}`);
  }
  const match = pattern.exec(value);
  if (!match) throw new Error(`${what}: '${value}' does not match ${pattern}`);
  return match[1];
}

/** The version a release tag spells under the pin's `tag` template, anchored and escaped: a tag of another shape (a
 *  canary, a foreign prefix) is refused, so it can never land in the dotfile. */
export function tagVersion(tag: unknown, template: string, what: string): string {
  const [before, after] = template.split(PIN_VERSION_TOKEN);
  return versionFrom(
    tag,
    new RegExp(`^${RegExp.escape(before)}(\\d+\\.\\d+\\.\\d+)${RegExp.escape(after)}$`),
    what,
  );
}

/** Exactly the version plus a newline, what the setup actions' version-file inputs read. */
export function pinnedVersion(text: string, where: string): string {
  return versionFrom(text, /^(\d+\.\d+\.\d+)\n$/, where);
}

/** GitHub's /releases/latest is most-recent-by-DATE, so a backport patch on an older line can surface as "latest". A genuine
 *  rollback is a deliberate hand edit, never an automated downgrade, and a run that saw one cannot tell whether main is
 *  behind upstream, so it aborts instead of reporting "nothing moved" (the workflow's PR step would close a valid PR on that). */
export function decideBump(pinned: string, fetched: string, what: string): "bump" | "current" {
  const order = Bun.semver.order(fetched, pinned);
  if (order < 0) {
    throw new Error(
      `${what}: upstream latest ${fetched} is OLDER than the pinned ${pinned} ` +
        "(a backport release surfacing as latest?) - refusing to refresh on a view that cannot see upstream's newest",
    );
  }
  return order === 0 ? "current" : "bump";
}

/** Every package declaring @types/bun: the types are published per bun release and ride the runtime pin exactly, so this
 *  script is their one writer (dependabot.yml ignores the package). A run before the matching types publish fails at the
 *  add and the next scheduled run retries. Types are a dev dependency; a declaration under `dependencies` would be
 *  re-added under devDependencies here, so it is refused instead. */
export function typesBunDirs(root: string): string[] {
  return bunLockDirs(root).filter((dir) => {
    const pkg = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf-8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    if (pkg.dependencies?.["@types/bun"] !== undefined) {
      throw new Error(`${dir}/package.json: @types/bun belongs under devDependencies`);
    }
    return pkg.devDependencies?.["@types/bun"] !== undefined;
  });
}

interface ReleasePin extends ModulePin {
  module: string;
  version: string;
}

function releasePins(config: FilesConfig, root: string): ReleasePin[] {
  return Object.entries(config.modules).flatMap(([module, data]) =>
    data.pin === undefined
      ? []
      : [
          {
            module,
            ...data.pin,
            version: pinnedVersion(readFileSync(join(root, data.pin.file), "utf-8"), data.pin.file),
          },
        ],
  );
}

/** releases/latest never returns a prerelease, so this is the latest stable; `version` is what its tag spells under the pin's template. */
async function latestRelease<T extends { tag_name: string }>(
  pin: Pick<ModulePin, "repository" | "tag">,
  reply: z.ZodType<T>,
  github: GitHubClient,
): Promise<T & { version: string }> {
  const latest = await github.get(`repos/${pin.repository}/releases/latest`, reply);
  if (latest.kind !== "ok") {
    throw new Error(
      `${pin.repository}: releases/latest could not be read (${unansweredReason(latest)})`,
    );
  }
  const version = tagVersion(
    latest.value.tag_name,
    pin.tag,
    `${pin.repository} latest release tag`,
  );
  return { ...latest.value, version };
}

/** The one scalar a workflow spells under `key`, as the token `CST.setScalarValue` rewrites in place.
 *
 * @throws {Error} the key is spelled nowhere, or more than once
 */
function envScalar(workflow: CST.Token[], key: string, file: string): CST.FlowScalar {
  const found: CST.FlowScalar[] = [];
  for (const token of workflow) {
    if (token.type !== "document") continue;

    CST.visit(token, (item) => {
      if (!CST.isScalar(item.key) || item.key.source !== key) return;
      if (item.value?.type === "scalar") found.push(item.value);
    });
  }
  if (found.length !== 1) {
    throw new Error(`${file}: ${key} is spelled ${found.length} times, not once`);
  }

  return found[0];
}

/** The sha256 GitHub recorded for the pinned archive of a release.
 *
 * @throws {Error} the release holds no such asset, or its digest is null: GitHub recorded none for an asset uploaded before it kept them
 */
function assetSha256(
  assets: z.infer<typeof latestAssetsReply>["assets"],
  name: string,
  repository: string,
): string {
  const digest = assets.find((asset) => asset.name === name)?.digest;
  const sha256 = /^sha256:([0-9a-f]{64})$/.exec(digest ?? "")?.[1];
  if (sha256 === undefined)
    throw new Error(`${repository}: the latest release records no sha256 for ${name}`);
  return sha256;
}

const shown = (bump: Bump, sha: string) => (bump.kind === "commit" ? sha.slice(0, 7) : sha);

const LIST = new Intl.ListFormat("en-US", { style: "long", type: "conjunction" });

export function proseBumps(bumps: Bump[]): string {
  return LIST.format(bumps.map((b) => `${b.name} to ${shown(b, b.to)}`));
}

function majorJumps(bumps: Bump[]): string {
  return bumps
    .filter((b) => b.kind !== "commit" && b.from.split(".")[0] !== b.to.split(".")[0])
    .map((b) => `${b.name} ${b.from.split(".")[0]} -> ${b.to.split(".")[0]}`)
    .join(", ");
}

function section(bump: Bump): string {
  const head = `## ${bump.name}: \`${shown(bump, bump.from)}\` -> \`${shown(bump, bump.to)}\``;
  if (bump.kind !== "commit") return head;
  const blocks = [...bump.diffs].map(
    ([path, diff]) => `### ${path}\n\n\`\`\`\`diff\n${diff}\n\`\`\`\``,
  );
  return `${head}\n\n${blocks.join("\n\n")}`;
}

const FOOTER: Record<PinKind, string> = {
  commit:
    "The next sync renders these files wherever files.yml names them as a source or a block, one sync PR per repository whose rendered bytes moved (auto-merged when clean). Merging this moves the stable tag once green.",
  release:
    "The next sync writes each dotfile to every repository selecting its module (docs/toolchains.md). Merging this moves the stable tag once green.",
  tool: "This pull request's own checks install each tool at its new version, by the sha256 GitHub records for the release archive, so a green run is the proof the bump works. Nothing here reaches the fleet (docs/toolchains.md).",
};

export function prBody(kind: PinKind, bumps: Bump[]): string {
  const major = majorJumps(bumps);
  const banner = major === "" ? [] : [`**MAJOR VERSION JUMP: ${major} - review before merging.**`];
  return [...banner, ...bumps.map(section), FOOTER[kind]].join("\n\n");
}

/** `root` is the checkout holding files.yml and the files/ tree; `host` the raw-content host commit pins are diffed through. */
export interface Refresh {
  kind: PinKind;
  root: string;
  host: string;
  fetch: Fetch;
  github: GitHubClient;
}

/** files.yml as read: the parsed config beside the text the commit pins are rewritten in. */
interface FilesSource {
  path: string;
  text: string;
  config: FilesConfig;
}

/** A commit pin moves only when a fetched file's normalized body moved with it: a HEAD that changes other paths alone leaves the pin. */
async function refreshCommitPins(
  files: FilesSource,
  { host, fetch, github }: Pick<Refresh, "host" | "fetch" | "github">,
): Promise<Bump[]> {
  const bumps: Bump[] = [];
  let rewritten = files.text;
  for (const pin of pins(upstreamRefs(files.config.files))) {
    const head = await headSha(pin.repository, github);
    if (head === pin.sha) {
      console.log(`${pin.repository}: ${pin.sha} is HEAD`);
      continue;
    }
    const diffs = await commitDiffs(pin, head, host, fetch);
    if (diffs.size === 0) {
      console.log(
        `${pin.repository}: ${pin.sha} -> ${head} changes no fetched file; the pin stays`,
      );
      continue;
    }
    console.log(`${pin.repository}: ${pin.sha} -> ${head}`);
    bumps.push({ kind: "commit", name: pin.repository, from: pin.sha, to: head, diffs });
    rewritten = repin(rewritten, pin, head);
  }
  if (bumps.length > 0) writeFileSync(files.path, rewritten);
  return bumps;
}

/** The bun pin also moves every package's `@types/bun`, so the types never trail the runtime. */
async function refreshReleasePins(
  config: FilesConfig,
  root: string,
  github: GitHubClient,
): Promise<Bump[]> {
  const moved: (ReleasePin & { latest: string })[] = [];
  for (const pin of releasePins(config, root)) {
    const { version: latest } = await latestRelease(pin, latestReleaseReply, github);
    if (decideBump(pin.version, latest, pin.module) === "current") {
      console.log(`${pin.module}: ${pin.version} is current`);
      continue;
    }
    console.log(`${pin.module}: ${pin.version} -> ${latest}`);
    moved.push({ ...pin, latest });
  }
  for (const pin of moved) {
    writeFileSync(join(root, pin.file), `${pin.latest}\n`);
    if (pin.file !== BUN_PIN_FILE) continue;
    for (const dir of typesBunDirs(root)) {
      must(["bun", "add", "--dev", "--exact", `@types/bun@${pin.latest}`], {
        cwd: join(root, dir),
      });
    }
  }
  return moved.map(({ module, version, latest }) => ({
    kind: "release",
    name: module,
    from: version,
    to: latest,
  }));
}

/** A tool's version and sha256 move together, each in the `env` of the step that installs it. */
async function refreshToolPins(root: string, github: GitHubClient): Promise<Bump[]> {
  const moved: (ToolPin & { from: string; to: string; digest: string })[] = [];
  for (const pin of TOOL_PINS) {
    const workflow = [...new Parser().parse(readFileSync(join(root, pin.file), "utf-8"))];
    const from = versionFrom(
      CST.resolveAsScalar(envScalar(workflow, pin.versionKey, pin.file)).value,
      /^(\d+\.\d+\.\d+)$/,
      `${pin.file} ${pin.versionKey}`,
    );
    const latest = await latestRelease(pin, latestAssetsReply, github);
    if (decideBump(from, latest.version, pin.name) === "current") {
      console.log(`${pin.name}: ${from} is current`);
      continue;
    }
    const asset = pin.asset.replaceAll(PIN_VERSION_TOKEN, latest.version);
    const digest = assetSha256(latest.assets, asset, pin.repository);
    console.log(`${pin.name}: ${from} -> ${latest.version}`);
    moved.push({ ...pin, from, to: latest.version, digest });
  }
  for (const pin of moved) {
    const path = join(root, pin.file);
    const workflow = [...new Parser().parse(readFileSync(path, "utf-8"))];
    CST.setScalarValue(envScalar(workflow, pin.versionKey, pin.file), pin.to);
    CST.setScalarValue(envScalar(workflow, pin.sha256Key, pin.file), pin.digest);
    writeFileSync(path, workflow.map((token) => CST.stringify(token)).join(""));
  }
  return moved.map(({ name, from, to }) => ({ kind: "tool", name, from, to }));
}

/** Moves every pin of the kind that upstream moved and returns the bumps. Every fetch and every verdict come before any
 *  write: an unreachable upstream or a downgrade aborts before a pin moves, so "nothing moved" (which lets the workflow
 *  close a stale refresh PR) is never a view that could not look. */
export async function refresh({ kind, root, host, fetch, github }: Refresh): Promise<Bump[]> {
  if (kind === "tool") return refreshToolPins(root, github);

  const path = join(root, "files.yml");
  const text = readFileSync(path, "utf-8");
  const config = parseFilesConfig(text);
  if (kind === "commit") return refreshCommitPins({ path, text, config }, { host, fetch, github });
  return refreshReleasePins(config, root, github);
}

function isPinKind(value: string | undefined): value is PinKind {
  return (PIN_KINDS as readonly string[]).includes(value ?? "");
}

async function main(argv: string[]): Promise<number> {
  const kind = argv[2];
  if (!isPinKind(kind)) {
    console.error(`usage: refresh_upstream.ts <${PIN_KINDS.join("|")}>`);
    return 2;
  }
  const bumps = await refresh({
    kind,
    root: REPO_ROOT,
    host: RAW_HOST,
    fetch: fetchText,
    github: new GitHubClient(),
  });
  if (bumps.length === 0) console.log(`every ${kind} pin is current`);
  if (process.env.GITHUB_OUTPUT) {
    setOutput("bumps", proseBumps(bumps));
    setOutput("body", prBody(kind, bumps));
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv));
}
