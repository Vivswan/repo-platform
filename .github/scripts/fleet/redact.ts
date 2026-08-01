// Private-repo redaction for the fleet's public run logs. repo-platform is
// public, so everything the plan/select jobs and the per-repo legs print -
// job names, notices, step summaries - is world-readable. A private managed
// repo must not appear there by name or detail. This module owns the two
// mechanisms:
//
// - hintName/assignHints: the display placeholder for a redacted name.
//   "hidden-server" -> "h**-s**r": deterministic, so the operator can tell
//   which repo a job is without the log disclosing it. Hints are partial
//   pseudonymization, not encryption (docs/private-repos.md).
// - verifyTag: the resolution verifier. Matrix values become public job
//   names and reusable-workflow inputs are auto-printed, so a redacted
//   row carries the hint plus an HMAC tag instead of the slug; the leg
//   re-discovers the fleet and picks the unique tag match
//   (resolve_private_repo.sh). Keyed by a value derived from the fleet
//   PAT (domain-separated, never the raw PAT) and bound to GITHUB_RUN_ID,
//   the tag is safe to print: without the PAT it cannot be brute-forced
//   into a name, and it fingerprints nothing across runs.
//
// The `enrich` subcommand decorates a repos_registry selection with the
// redaction decision per row. Fail closed: a repo whose discovery entry
// does not positively say `private: false` is treated as private. A
// private repo whose name is already committed in this public repository
// (an explicit/exclude/config entry in repos.yml, or a
// settings/repos/<name>.yml file) is self-disclosed: its name stays
// visible - hinting a committed name would be theater - but its details
// are still hidden (redact_name=false, hide_details=true).
//
// Usage:
//   bun .github/scripts/fleet/redact.ts hint <name>
//   bun .github/scripts/fleet/redact.ts enrich --selection <selection.json>
//     --discovered <discovered.json> [--registry repos.yml]
//     [--central-dir settings/repos]
//
// `enrich` needs PAT and GITHUB_RUN_ID in the environment. It prints
// {rows}: one row per selection entry, in order, as
// {repo, channel, redact_name, hide_details, display, verify} (`repo` is
// always the real slug - the CALLER must emit `display` in its matrix
// instead for redact_name rows). Errors go to stderr as ::error::
// workflow commands with a nonzero exit.

import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFlags } from "../shared/flags.ts";
import { loadRegistry } from "./repos_registry.ts";

// Pinned against resolve_private_repo.sh by a check_ssot rule and the
// lockstep test in redact.test.ts: both sides must truncate identically.
export const VERIFY_HEX_LENGTH = 32;

// Domain-separation label for deriving the tag key from the fleet PAT, so
// the PAT itself never keys a second protocol.
export const KEY_DERIVATION_LABEL = "repo-platform-redact-key-v1";

/**
 * The display hint for one bare repo name: each [-_.]-separated segment
 * renders as its first character plus "**" (separators kept), and the
 * final segment also keeps its last character when it has at least five -
 * shorter finals would echo most of the name back. "hidden-server" ->
 * "h**-s**r"; "myrepo" -> "m**o"; "ab" -> "a**". An empty segment
 * (consecutive separators) renders as "**" alone. Case and digits pass
 * through. A hint can never collide with a real name: "*" is illegal in
 * GitHub repo names.
 */
export function hintName(name: string): string {
  const parts = name.split(/([-_.])/);
  const segments: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const segment = parts[i];
    const separator = parts[i + 1] ?? "";
    const isFinal = i + 2 >= parts.length;
    let rendered = segment === "" ? "**" : `${segment[0]}**`;
    if (isFinal && segment.length >= 5) {
      rendered += segment[segment.length - 1];
    }
    segments.push(rendered + separator);
  }
  return segments.join("");
}

/**
 * Assign hints to a set of slugs, disambiguating collisions: sorted by
 * slug ascending, the first taker keeps the base hint and later ones get
 * "#2", "#3"... Deterministic within one input set. Returns slug -> hint.
 */
export function assignHints(slugs: string[]): Map<string, string> {
  const taken = new Map<string, number>();
  const hints = new Map<string, string>();
  for (const slug of [...slugs].sort()) {
    if (hints.has(slug)) continue;
    const base = hintName(slug.split("/").pop() ?? slug);
    const n = (taken.get(base) ?? 0) + 1;
    taken.set(base, n);
    hints.set(slug, n === 1 ? base : `${base}#${n}`);
  }
  return hints;
}

/**
 * The resolution tag for one slug: HMAC-SHA256 keyed by the PAT-derived
 * key over "<run id>\0<lowercased slug>", truncated to VERIFY_HEX_LENGTH
 * hex chars. The slug is lowercased because GitHub repo identity is
 * case-insensitive; the resolver hashes API-canonical full_name values
 * the same way.
 */
export function verifyTag(pat: string, runId: string, slug: string): string {
  const key = createHmac("sha256", pat).update(KEY_DERIVATION_LABEL).digest();
  return createHmac("sha256", key)
    .update(`${runId}\0${slug.toLowerCase()}`)
    .digest("hex")
    .slice(0, VERIFY_HEX_LENGTH);
}

export interface DiscoveredRepo {
  repo: string;
  private: boolean;
}

export interface EnrichedRow {
  repo: string;
  channel: string;
  redact_name: boolean;
  hide_details: boolean;
  display: string;
  verify: string;
}

export interface Enriched {
  rows: EnrichedRow[];
}

/**
 * Decorate a selection with the redaction decision per row. Visibility
 * fails closed: a discovery entry decides when present; a selected repo
 * absent from discovery (an explicit registry entry under another owner,
 * which the owner-filtered discovery never lists) is asked of
 * `probePrivate`, whose default answers private. `isSelfDisclosed`
 * answers whether the slug's name is already committed in this
 * repository.
 */
export function enrich(
  selection: { repo: string; channel: string | null }[],
  discovered: DiscoveredRepo[],
  isSelfDisclosed: (slug: string) => boolean,
  tagFor: (slug: string) => string,
  probePrivate: (slug: string) => boolean = () => true,
): Enriched {
  const known = new Map(discovered.map((d) => [d.repo.toLowerCase(), d.private]));
  const probed = new Map<string, boolean>();
  const isPrivate = (slug: string) => {
    const listed = known.get(slug.toLowerCase());
    if (listed !== undefined) return listed;
    let answer = probed.get(slug.toLowerCase());
    if (answer === undefined) {
      answer = probePrivate(slug);
      probed.set(slug.toLowerCase(), answer);
    }
    return answer;
  };

  // One hint table over every discovered private name that is not
  // self-disclosed, selected or not: hints stay stable when the
  // selection narrows (a single-repo dispatch numbers collisions the
  // same way a full run does).
  const hinted = discovered
    .map((d) => d.repo)
    .filter((slug) => isPrivate(slug) && !isSelfDisclosed(slug));
  for (const row of selection) {
    // A selected repo absent from discovery (single-repo dispatch of an
    // explicit registry entry) still needs a hint when redacted.
    if (isPrivate(row.repo) && !isSelfDisclosed(row.repo) && !hinted.includes(row.repo)) {
      hinted.push(row.repo);
    }
  }
  const hints = assignHints(hinted);

  const rows = selection.map((row): EnrichedRow => {
    const priv = isPrivate(row.repo);
    const redactName = priv && !isSelfDisclosed(row.repo);
    return {
      repo: row.repo,
      channel: row.channel ?? "",
      redact_name: redactName,
      hide_details: priv,
      display: redactName ? (hints.get(row.repo) ?? hintName(row.repo)) : row.repo,
      verify: redactName ? tagFor(row.repo) : "",
    };
  });
  return { rows };
}

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

function readJson(path: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    fail(`${path}: cannot read ${what}: ${detail}`);
  }
}

function loadDiscovered(path: string): DiscoveredRepo[] {
  const parsed = readJson(path, "the discovered list");
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (v) =>
        typeof v === "object" &&
        v !== null &&
        typeof (v as DiscoveredRepo).repo === "string" &&
        typeof (v as DiscoveredRepo).private === "boolean",
    )
  ) {
    fail(`${path}: the discovered list must be a JSON array of {repo, private} objects`);
  }
  return parsed as DiscoveredRepo[];
}

function loadSelection(path: string): { repo: string; channel: string | null }[] {
  const parsed = readJson(path, "the selection");
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (v) =>
        typeof v === "object" && v !== null && typeof (v as { repo: unknown }).repo === "string",
    )
  ) {
    fail(`${path}: the selection must be a JSON array of {repo, ...} objects`);
  }
  return parsed as { repo: string; channel: string | null }[];
}

function main(args: string[]): void {
  const [command, ...rest] = args;
  switch (command) {
    case "hint": {
      const name = rest[0];
      if (name === undefined || name === "" || rest.length > 1) {
        fail("usage: redact.ts hint <bare-repo-name>");
      }
      console.log(hintName(name.includes("/") ? (name.split("/").pop() ?? name) : name));
      return;
    }
    case "enrich": {
      const flags = parseFlags(
        rest,
        ["--selection", "--discovered"],
        ["--registry", "--central-dir"],
      );
      const pat = process.env.PAT;
      const runId = process.env.GITHUB_RUN_ID;
      if (!pat || !runId) {
        fail("enrich needs PAT and GITHUB_RUN_ID in the environment");
      }
      const registryPath = flags["--registry"] ?? "repos.yml";
      const centralDir = flags["--central-dir"] ?? "settings/repos";
      const { registry, errors } = loadRegistry(readFileSync(registryPath, "utf-8"), registryPath);
      if (registry === null) {
        for (const message of errors) console.error(`::error::${message}`);
        process.exit(1);
      }
      const committed = new Set(
        [...registry.managed.repos, ...registry.exclude, ...registry.config.keys()].map((slug) =>
          slug.toLowerCase(),
        ),
      );
      const isSelfDisclosed = (slug: string) =>
        committed.has(slug.toLowerCase()) ||
        existsSync(join(centralDir, `${slug.split("/").pop() ?? slug}.yml`));
      const result = enrich(
        loadSelection(flags["--selection"]),
        loadDiscovered(flags["--discovered"]),
        isSelfDisclosed,
        (slug) => verifyTag(pat, runId, slug),
        // A selected repo the owner-filtered discovery never saw (an
        // explicit cross-owner entry): one live probe, failing closed.
        (slug) => {
          const proc = Bun.spawnSync(["gh", "api", `repos/${slug}`, "--jq", ".private"]);
          return proc.exitCode !== 0 || proc.stdout.toString().trim() !== "false";
        },
      );
      console.log(JSON.stringify(result));
      return;
    }
    default:
      fail(`unknown subcommand ${JSON.stringify(command ?? "")} - usage: redact.ts hint|enrich`);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
