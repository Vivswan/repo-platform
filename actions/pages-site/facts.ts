// The per-tier project facts the theme renders. Pure by construction: every
// repository file arrives through the injected reader (build.ts hands it
// treeFile at the tier's own ref, so a tagged version shows that tag's
// toolchains and license). An absent or malformed file degrades to null or
// [] instead of failing the build; a failed git read inside the reader still
// throws, because a broken checkout is a build fault, not a missing fact.
//
// Identity (description, homepage, topics) comes from .github/settings.yml's
// repository block first: the copier answers only seed that file, and the
// repository edits its identity there afterwards (the file is repo-owned
// after its first render). The answers files fill in only the keys the
// settings file lacks, or everything when it is absent or malformed.

export interface ProjectFacts {
  /** owner/name */
  repository: string;
  repoUrl: string;
  /** The repository name alone. */
  name: string;
  description: string | null;
  homepage: string | null;
  topics: string[];
  toolchains: { name: string; version: string }[];
  license: { name: string; path: string } | null;
  /** The docs tree the pages render from, repo-relative: the prefix that
   *  turns a page.filePath into its repository path. */
  docsDir: string;
  /** Which commit this tier was built from: the default branch for HEAD
   *  tiers, the tag for tag tiers, and the commit it resolved to. */
  provenance: { label: string; sha: string; url: string };
  /** 0..5, a stable hash of the repository name: the theme's per-repo
   *  accent, so a repository keeps its color across theme updates. */
  hue: number;
}

export interface FactsInput {
  repository: string;
  docsDir: string;
  defaultBranch: string;
  ref: string;
  sha: string;
  /** The GitHub server the repository lives on, e.g. https://github.com. */
  serverUrl: string;
}

type Identity = Pick<ProjectFacts, "description" | "homepage" | "topics">;

/** The file's content at the tier's ref, or null when absent. */
export type FactsReader = (path: string) => string | null;

const SETTINGS_FILE = ".github/settings.yml";

/** The copier answers file a managed repository carries, then
 *  repo-platform's own equivalent (the operator renders no copier
 *  answers of its own). */
const ANSWERS_FILES = [".github/.copier-answers.yml", ".repo-platform-answers.yml"];

const LICENSE_FILE = "LICENSE.md";
const LICENSE_HEAD_LINES = 20;
const LICENSE_FALLBACK = "See LICENSE.md";

/** Known licenses by the wording their standard texts open with, anchored
 *  so only a title that starts with the name canonicalizes: "Not the MIT
 *  License" and a body line mentioning MIT keep a custom license's name. */
const KNOWN_LICENSES: [RegExp, string][] = [
  [/^MIT License\b/i, "MIT"],
  [/^Apache License,?\s+(?:Version\s+)?2\.0\b/i, "Apache-2.0"],
  [/^BSD 2-Clause\b/i, "BSD-2-Clause"],
  [/^BSD 3-Clause\b/i, "BSD-3-Clause"],
  [/^GNU GENERAL PUBLIC LICENSE\s+Version 3\b/i, "GPL-3.0"],
  [/^GNU LESSER GENERAL PUBLIC LICENSE\b/i, "LGPL"],
  [/^Mozilla Public License,?\s+(?:Version\s+)?2\.0\b/i, "MPL-2.0"],
  [/^ISC License\b/i, "ISC"],
  [/^Unlicense\b/i, "Unlicense"],
  [/^CC0\b/, "CC0"],
];

const TOOLCHAIN_FILES: { name: string; path: string; version: (text: string) => string | null }[] =
  [
    { name: "Bun", path: ".bun-version", version: pinnedVersion },
    { name: "Node.js", path: ".node-version", version: pinnedVersion },
    { name: "Deno", path: ".dvmrc", version: pinnedVersion },
    { name: "Python", path: ".python-version", version: pinnedVersion },
    { name: "Rust", path: "rust-toolchain.toml", version: rustChannel },
  ];

/** A one-line version pin (.bun-version and kin), with the optional
 *  leading v dropped so every toolchain reads the same way. */
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

/** The text when it parses as an http(s) URL with a host, else null. */
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

/** The homepage answer has no URL validator: a bare host gets https://,
 *  anything that is neither a URL nor a host reads as no homepage. */
function homepageUrl(value: unknown): string | null {
  const text = nonEmptyString(value);
  if (text === null) return null;
  if (/^https?:\/\//i.test(text)) return httpUrl(text);
  return looksLikeHost(text) ? httpUrl(`https://${text}`) : null;
}

/** Copier stores the topics answer as one comma-separated string; the
 *  settings file also accepts a YAML list, like the settings apply does. */
function splitTopics(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return entries
    .filter((topic): topic is string => typeof topic === "string")
    .map((topic) => topic.trim())
    .filter((topic) => topic !== "");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseYamlRecord(text: string): Record<string, unknown> | null {
  try {
    return asRecord(Bun.YAML.parse(text));
  } catch {
    return null;
  }
}

/** The settings file's repository block, or null when the file is absent,
 *  malformed, or carries no such block (older tags predate it). */
function readSettingsIdentity(read: FactsReader): Record<string, unknown> | null {
  const text = read(SETTINGS_FILE);
  if (text === null) return null;
  const settings = parseYamlRecord(text);
  return settings === null ? null : asRecord(settings.repository);
}

function readAnswers(read: FactsReader): Record<string, unknown> {
  for (const path of ANSWERS_FILES) {
    const text = read(path);
    if (text === null) continue;
    const answers = parseYamlRecord(text);
    if (answers !== null) return answers;
  }
  return {};
}

/** Each key from the settings block when it declares the key at all (an
 *  empty value there means empty, not "ask the answers"), else from the
 *  answers. */
function readIdentity(read: FactsReader): Identity {
  const settings = readSettingsIdentity(read) ?? {};
  const answers = readAnswers(read);
  const pick = (key: string) => (key in settings ? settings[key] : answers[key]);
  return {
    description: nonEmptyString(pick("description")),
    homepage: homepageUrl(pick("homepage")),
    topics: splitTopics(pick("topics")),
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

/** The head's paragraphs: runs of non-empty trimmed lines. */
function paragraphs(lines: string[]): string[][] {
  const result: string[][] = [];
  let current: string[] = [];
  for (const line of lines.map((entry) => entry.trim())) {
    if (line !== "") {
      current.push(line);
    } else if (current.length > 0) {
      result.push(current);
      current = [];
    }
  }
  return current.length > 0 ? [...result, current] : result;
}

function knownLicense(title: string): string | null {
  const bare = title.replace(/^the\s+/i, "");
  return KNOWN_LICENSES.find(([pattern]) => pattern.test(bare))?.[1] ?? null;
}

/** A markdown heading is authoritative: canonicalized when it starts
 *  with a known name, kept verbatim otherwise ("# Not the MIT License"
 *  stays a custom license whatever the body says). Plain text names the
 *  license in its opening paragraph (Apache and the GPL center theirs
 *  over two lines) or, under a publisher banner, at the start of the
 *  next one (GitHub's CC0 opens "Creative Commons Legal Code"). */
function licenseName(text: string): string {
  const lines = text.split("\n").slice(0, LICENSE_HEAD_LINES);
  const heading = firstHeading(lines);
  if (heading !== null) return knownLicense(heading) ?? heading;
  const [opening, next] = paragraphs(lines);
  const candidates = [opening?.join(" "), next?.[0]].filter((entry) => entry !== undefined);
  return candidates.map(knownLicense).find((name) => name !== null) ?? LICENSE_FALLBACK;
}

function readLicense(read: FactsReader): ProjectFacts["license"] {
  const text = read(LICENSE_FILE);
  return text === null ? null : { name: licenseName(text), path: LICENSE_FILE };
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
  const name = input.repository.split("/")[1];
  const repoUrl = `${input.serverUrl}/${input.repository}`;
  return {
    repository: input.repository,
    repoUrl,
    name,
    ...readIdentity(read),
    toolchains: TOOLCHAIN_FILES.flatMap((toolchain) => {
      const text = read(toolchain.path);
      const version = text === null ? null : toolchain.version(text);
      return version === null ? [] : [{ name: toolchain.name, version }];
    }),
    license: readLicense(read),
    docsDir: input.docsDir,
    provenance: {
      label: input.ref === "HEAD" ? input.defaultBranch : input.ref,
      sha: input.sha,
      url: `${repoUrl}/commit/${input.sha}`,
    },
    hue: hueOf(name),
  };
}
