// The per-tier project facts the theme renders. Pure by construction: every
// repository file arrives through the injected reader (build.ts hands it
// treeFile at the tier's own ref, so a tagged version shows that tag's
// toolchains and license). An absent or malformed file degrades to null or
// [] instead of failing the build; a failed git read inside the reader still
// throws, because a broken checkout is a build fault, not a missing fact.

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
  /** Which commit this tier was built from: the default branch for HEAD
   *  tiers, the tag for tag tiers, and the commit it resolved to. */
  provenance: { label: string; sha: string; url: string };
  /** 0..5, a stable hash of the repository name: the theme's per-repo
   *  accent, so a repository keeps its color across theme updates. */
  hue: number;
}

export interface FactsInput {
  repository: string;
  defaultBranch: string;
  ref: string;
  sha: string;
}

/** The file's content at the tier's ref, or null when absent. */
export type FactsReader = (path: string) => string | null;

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

/** The homepage answer has no URL validator: a bare host gets https://,
 *  anything that is neither a URL nor a host reads as no homepage. */
function homepageUrl(value: unknown): string | null {
  const text = nonEmptyString(value);
  if (text === null) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return null;
  return /^[^\s/]+\.[^\s]*$/.test(text) ? `https://${text}` : null;
}

/** Copier stores the topics answer as one comma-separated string. */
function splitTopics(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((topic) => topic.trim())
    .filter((topic) => topic !== "");
}

function parseAnswers(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = Bun.YAML.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readAnswers(read: FactsReader): Pick<ProjectFacts, "description" | "homepage" | "topics"> {
  for (const path of ANSWERS_FILES) {
    const text = read(path);
    if (text === null) continue;
    const answers = parseAnswers(text);
    if (answers === null) continue;
    return {
      description: nonEmptyString(answers.description),
      homepage: homepageUrl(answers.homepage),
      topics: splitTopics(answers.topics),
    };
  }
  return { description: null, homepage: null, topics: [] };
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

/** The first non-empty lines up to a blank one, joined: the title block
 *  of a plain-text license (Apache and the GPL center theirs over two
 *  lines). */
function openingParagraph(lines: string[]): string | null {
  const trimmed = lines.map((line) => line.trim());
  const start = trimmed.findIndex((line) => line !== "");
  if (start === -1) return null;
  const end = trimmed.indexOf("", start);
  return trimmed.slice(start, end === -1 ? undefined : end).join(" ");
}

function knownLicense(title: string): string | null {
  const bare = title.replace(/^the\s+/i, "");
  return KNOWN_LICENSES.find(([pattern]) => pattern.test(bare))?.[1] ?? null;
}

function licenseName(text: string): string {
  const lines = text.split("\n").slice(0, LICENSE_HEAD_LINES);
  const heading = firstHeading(lines);
  const title = heading ?? openingParagraph(lines);
  return (title === null ? null : knownLicense(title)) ?? heading ?? LICENSE_FALLBACK;
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
  const repoUrl = `https://github.com/${input.repository}`;
  return {
    repository: input.repository,
    repoUrl,
    name,
    ...readAnswers(read),
    toolchains: TOOLCHAIN_FILES.flatMap((toolchain) => {
      const text = read(toolchain.path);
      const version = text === null ? null : toolchain.version(text);
      return version === null ? [] : [{ name: toolchain.name, version }];
    }),
    license: readLicense(read),
    provenance: {
      label: input.ref === "HEAD" ? input.defaultBranch : input.ref,
      sha: input.sha,
      url: `${repoUrl}/commit/${input.sha}`,
    },
    hue: hueOf(name),
  };
}
