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
//   (resolve_private_repo.ts). Keyed by a value derived from the fleet
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
// instead for redact_name rows). Errors print as ::error:: workflow
// commands (on stdout, where the runner parses them) with a nonzero exit.

import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseFlags } from "../shared/flags.ts";
import { fail } from "../shared/gha.ts";
import { parseWith } from "../shared/json.ts";
import { loadRegistry } from "./repos_registry.ts";

// One implementation for both sides: the plan job tags rows here and the
// per-repo legs import verifyTag (fleet/resolve_private_repo.ts), so the
// truncation length lives in this file alone.
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
  // HMAC(key="") is publicly computable; never derive from an empty PAT.
  if (pat === "") throw new Error("verifyTag: refusing to derive the tag key from an empty PAT");
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

// The redaction invariant as a type, owned here alone: a redacted row
// hides its slug behind a hint plus a resolution tag, an unredacted row
// displays the slug itself and carries no tag. Consumers reading enrich's
// output back from a file re-enter a trust boundary and must parse it
// with parseEnriched/parseEnrichedRows instead of casting.
export const enrichedRowSchema = z
  .discriminatedUnion("redact_name", [
    z.object({
      repo: z.string(),
      channel: z.string(),
      redact_name: z.literal(true),
      hide_details: z.literal(true),
      display: z.string(),
      verify: z.string().min(1),
    }),
    z.object({
      repo: z.string(),
      channel: z.string(),
      redact_name: z.literal(false),
      hide_details: z.boolean(),
      display: z.string(),
      verify: z.literal(""),
    }),
  ])
  // A hint always contains "*" (illegal in repo names), so this rejects a
  // slug leaking through the display of a redacted row - and a hint
  // masquerading as the slug of an unredacted one. The issue names the
  // field but never the value: this fires exactly where quoting is unsafe.
  .refine((row) => (row.redact_name ? row.display.includes("*") : row.display === row.repo), {
    message: "display must be a masked hint on a redacted row (the slug itself otherwise)",
    path: ["display"],
  });

export type EnrichedRow = z.infer<typeof enrichedRowSchema>;

const enrichedSchema = z.object({ rows: z.array(enrichedRowSchema) });

export type Enriched = z.infer<typeof enrichedSchema>;

/** Parse enrich's {rows} output at a consumer boundary; a violation of
 * the row shape or the redaction invariant exits with ::error::. */
export function parseEnriched(data: unknown, label: string): Enriched {
  return parseWith(enrichedSchema, data, label);
}

/** Same boundary for a bare row array (the selector's in-repo target
 * file, which carries enriched rows verbatim). */
export function parseEnrichedRows(data: unknown, label: string): EnrichedRow[] {
  return parseWith(z.array(enrichedRowSchema), data, label);
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
    const channel = row.channel ?? "";
    return priv && !isSelfDisclosed(row.repo)
      ? {
          repo: row.repo,
          channel,
          redact_name: true,
          hide_details: true,
          display: hints.get(row.repo) ?? hintName(row.repo),
          verify: tagFor(row.repo),
        }
      : {
          repo: row.repo,
          channel,
          redact_name: false,
          hide_details: priv,
          display: row.repo,
          verify: "",
        };
  });
  return { rows };
}

// The discovered list a caller hands to `enrich`. Fail closed at the
// parse already: an entry without an explicit boolean `private` is
// rejected outright rather than defaulted, and one bad entry rejects the
// whole list - a silently dropped row would skip its repo's redaction
// decision. Loose on the rest: extra discovery fields pass through.
const discoveredListSchema = z.array(z.looseObject({ repo: z.string(), private: z.boolean() }));

/** Parse a discovered list at the trust boundary; null when the shape is
 * wrong (the CLI then fails without quoting the payload, which can carry
 * private repo names). */
export function parseDiscoveredList(data: unknown): DiscoveredRepo[] | null {
  const result = discoveredListSchema.safeParse(data);
  return result.success ? result.data : null;
}

// The selection rows from repos_registry select. Only `repo` is load
// bearing here; `channel` is deliberately NOT validated (enrich coalesces
// a nullish one to "" and passes anything else through untouched), and
// extra keys ride along - the legacy fail-open tolerance, kept exactly.
const selectionListSchema = z.array(z.looseObject({ repo: z.string() }));

/** Parse a selection list at the trust boundary; null when the shape is
 * wrong. */
export function parseSelectionList(
  data: unknown,
): { repo: string; channel: string | null }[] | null {
  const result = selectionListSchema.safeParse(data);
  return result.success ? (result.data as { repo: string; channel: string | null }[]) : null;
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
  const parsed = parseDiscoveredList(readJson(path, "the discovered list"));
  if (parsed === null) {
    fail(`${path}: the discovered list must be a JSON array of {repo, private} objects`);
  }
  return parsed;
}

function loadSelection(path: string): { repo: string; channel: string | null }[] {
  const parsed = parseSelectionList(readJson(path, "the selection"));
  if (parsed === null) {
    fail(`${path}: the selection must be a JSON array of {repo, ...} objects`);
  }
  return parsed;
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
        fail(errors);
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
