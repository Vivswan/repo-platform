// Every repository file arrives through the injected reader (build.ts hands it treeFile at the tier's own ref), so a tagged
// version shows that tag's facts.
//   an absent or malformed file       -> null or [], never a failed build
//   a failed git read in the reader   -> still throws: a broken checkout is a build fault, not a missing fact
//   a failed license read at GitHub   -> throws too: a card never names a license GitHub did not answer

import { z } from "zod";
import { failureDetail, type RunResult, succeeded } from "../shared/action_runtime.ts";
import { SETTINGS_PATH } from "../shared/platform.ts";
import { isMapping } from "../shared/values.ts";

export interface ProjectFacts {
  /** owner/name */
  repository: string;

  /** The repository on its server, no trailing slash. */
  repoUrl: string;

  /** The settings file's `repository.description`; null when unset. */
  description: string | null;

  /** The settings file's `repository.homepage` as an http(s) URL; null when unset or neither a URL nor a host. */
  homepage: string | null;

  /** The settings file's `repository.topics`, trimmed and in order. */
  topics: string[];

  /** The toolchains the version dotfiles pin, in TOOLCHAIN_FILES order. */
  toolchains: { name: string; version: string }[];

  /** The license by name and file; null when GitHub detects no license file, and in the docs PR check. */
  license: { name: string; path: string } | null;

  /** The docs tree the pages render from, repo-relative: the prefix that turns a page's staged path into its repository path. */
  docsDir: string;

  /** The tier's ref as a label, its commit, and the commit's URL. */
  provenance: { label: string; sha: string; url: string };

  /** 0..5, a stable hash of the repository name: the theme's per-repo accent, so a repository keeps its color across theme updates. */
  hue: number;
}

/** What GitHub's license detection answered for one commit. */
export interface DetectedLicense {
  /** The license file GitHub picked, repo-relative. */
  path: string;

  /** The SPDX id of the license the text matches; null for a text that matches none. */
  spdxId: string | null;
}

/** `license` is GitHub's answer for `sha`: null for no license file, and for a build that asks no API. */
export interface FactsInput {
  repository: string;
  docsDir: string;
  defaultBranch: string;
  ref: string;
  sha: string;
  serverUrl: string;
  license: DetectedLicense | null;
}

type Identity = Pick<ProjectFacts, "description" | "homepage" | "topics">;

export type FactsReader = (path: string) => string | null;

/** How far into the license file a heading is looked for. */
const LICENSE_HEAD_LINES = 20;

/** The SPDX id GitHub answers for a license file whose text matches no known license. */
const UNDETECTED_SPDX_ID = "NOASSERTION";

/** The fields read from `GET /repos/{owner}/{repo}/license`; `license` is null or carries a null id where GitHub names none. */
const LICENSE_ANSWER = z.object({
  path: z.string().min(1),
  license: z.object({ spdx_id: z.string().nullable() }).nullable(),
});

/** GitHub's error body for a repository with no license file at the ref. */
const NOT_FOUND_ANSWER = z.object({ status: z.literal("404") });

/** The version dotfiles the card reads, in display order, each with the reader of its version. */
const TOOLCHAIN_FILES: { name: string; path: string; version: (text: string) => string | null }[] =
  [
    { name: "Bun", path: ".bun-version", version: pinnedVersion },
    { name: "Node.js", path: ".node-version", version: pinnedVersion },
    { name: "Python", path: ".python-version", version: pinnedVersion },
    { name: "Rust", path: "rust-toolchain.toml", version: rustChannel },
  ];

/** The leading v is dropped so every toolchain reads the same way. */
function pinnedVersion(text: string): string | null {
  const line = text
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry !== "");
  return line === undefined ? null : line.replace(/^v/, "");
}

function rustChannel(text: string): string | null {
  try {
    const parsed: unknown = Bun.TOML.parse(text);
    const toolchain =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>).toolchain
        : undefined;
    return typeof toolchain === "object" && toolchain !== null
      ? nonEmptyString((toolchain as Record<string, unknown>).channel)
      : null;
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function httpUrl(text: string): string | null {
  try {
    return new URL(text).hostname === "" ? null : text;
  } catch {
    return null;
  }
}

/** A dotted host or a host:port, then an optional path, query, or
 *  fragment: what a homepage typed without its scheme looks like. A bare
 *  word, an email, and a scheme (letters, a colon, then non-digits) are
 *  not hosts. */
function looksLikeHost(text: string): boolean {
  const authority = /^([^\s/?#@:]+)(?::(\d+))?(?:[/?#]\S*)?$/.exec(text);
  return authority !== null && (authority[1].includes(".") || authority[2] !== undefined);
}

/** The homepage value has no URL validator: a bare host gets https://,
 *  anything that is neither a URL nor a host reads as no homepage. */
function homepageUrl(value: unknown): string | null {
  const text = nonEmptyString(value);
  if (text === null) return null;

  if (/^https?:\/\//i.test(text)) return httpUrl(text);

  return looksLikeHost(text) ? httpUrl(`https://${text}`) : null;
}

/** Topics as one comma-separated string or a YAML list, the two shapes
 *  the settings apply accepts. */
function topicEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;

  if (typeof value === "string") return value.split(",");

  return [];
}

function splitTopics(value: unknown): string[] {
  return topicEntries(value)
    .filter((topic): topic is string => typeof topic === "string")
    .map((topic) => topic.trim())
    .filter((topic) => topic !== "");
}

function parseYamlRecord(text: string): Record<string, unknown> | null {
  try {
    const doc: unknown = Bun.YAML.parse(text);
    return isMapping(doc) ? doc : null;
  } catch {
    return null;
  }
}

/** Null for a missing block too: older tags predate the settings file. */
function readSettingsIdentity(read: FactsReader): Record<string, unknown> | null {
  const text = read(SETTINGS_PATH);
  if (text === null) return null;

  const settings = parseYamlRecord(text);
  return settings !== null && isMapping(settings.repository) ? settings.repository : null;
}

function readIdentity(read: FactsReader): Identity {
  const settings = readSettingsIdentity(read) ?? {};
  return {
    description: nonEmptyString(settings.description),
    homepage: homepageUrl(settings.homepage),
    topics: splitTopics(settings.topics),
  };
}

/** The first markdown heading, ATX (any level) or setext. */
function firstHeading(lines: string[]): string | null {
  for (const [index, line] of lines.entries()) {
    const atx = /^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
    if (atx !== null) return atx[1];

    if (line.trim() !== "" && /^\s*(=+|-+)\s*$/.test(lines[index + 1] ?? "")) return line.trim();
  }

  return null;
}

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Reads the answer of `gh api repos/{owner}/{repo}/license?ref={sha}`.
 *
 * @param what - the repository and commit asked about, for the error
 * @returns the detected license; null when GitHub finds no license file at the commit
 * @throws {Error} the read failed for any reason but a missing license, or answered another shape
 */
export function detectedLicense(answer: RunResult, what: string): DetectedLicense | null {
  const body = parsedJson(answer.stdout);
  if (!succeeded(answer.exit)) {
    if (NOT_FOUND_ANSWER.safeParse(body).success) return null;

    throw new Error(`cannot read the license of ${what} from GitHub (${failureDetail(answer)})`);
  }

  const parsed = LICENSE_ANSWER.safeParse(body);
  if (!parsed.success) {
    throw new Error(`GitHub's license answer for ${what} has an unexpected shape`);
  }

  const spdxId = parsed.data.license?.spdx_id ?? null;
  return { path: parsed.data.path, spdxId: spdxId === UNDETECTED_SPDX_ID ? null : spdxId };
}

/** A text GitHub matches to no license is named by its own first heading, as a custom license titles itself. */
function licenseName(read: FactsReader, detected: DetectedLicense): string {
  if (detected.spdxId !== null) return detected.spdxId;

  const text = read(detected.path) ?? "";
  return firstHeading(text.split("\n").slice(0, LICENSE_HEAD_LINES)) ?? `See ${detected.path}`;
}

/** FNV-1a over the UTF-8 bytes, folded to the six theme hues. */
export function hueOf(name: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(name)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }

  return hash % 6;
}

export function collectFacts(read: FactsReader, input: FactsInput): ProjectFacts {
  const repoUrl = `${input.serverUrl}/${input.repository}`;
  return {
    repository: input.repository,
    repoUrl,
    ...readIdentity(read),
    toolchains: TOOLCHAIN_FILES.flatMap((toolchain) => {
      const text = read(toolchain.path);
      const version = text === null ? null : toolchain.version(text);
      return version === null ? [] : [{ name: toolchain.name, version }];
    }),
    license:
      input.license === null
        ? null
        : { name: licenseName(read, input.license), path: input.license.path },
    docsDir: input.docsDir,
    provenance: {
      label: input.ref === "HEAD" ? input.defaultBranch : input.ref,
      sha: input.sha,
      url: `${repoUrl}/commit/${input.sha}`,
    },
    hue: hueOf(input.repository.split("/")[1]),
  };
}
