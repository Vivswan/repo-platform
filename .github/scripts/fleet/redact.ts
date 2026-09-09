// Private-repo redaction for the fleet's public run logs (the model:
// docs/private-repos.md). repo-platform is public, so everything the plan
// and select jobs and the per-repo legs print is world-readable, and a
// private managed repo must not appear there by name or detail. Two
// mechanisms live here:
//
// - hintName/assignHints: the display placeholder ("hidden-server" ->
//   "h**-s**r"), deterministic so the operator can tell jobs apart; partial
//   pseudonymization, not encryption.
// - verifyTag: matrix values become public job names and reusable-workflow
//   inputs are auto-printed, so a private row carries the hint plus an HMAC
//   tag instead of the slug, and the leg re-discovers the fleet and picks
//   the unique match (resolve_private_repo.ts). Keyed by a value derived
//   from the fleet PAT (domain-separated, never the raw PAT) and bound to
//   GITHUB_RUN_ID, the tag is safe to print: it cannot be brute-forced into
//   a name without the PAT and fingerprints nothing across runs.
// `enrich` turns the discovered fleet into the plan's rows. Visibility is
// fail-closed: a repo whose discovery entry does not positively say
// `private: false` is private, hinted AND hidden.
// CLI: bun .github/scripts/fleet/redact.ts hint <name>

import { createHmac } from "node:crypto";
import { z } from "zod";
import { fail } from "../shared/gha.ts";
import { parseWith } from "../shared/json.ts";

// One implementation for both sides: the plan job tags rows here and the
// per-repo legs import verifyTag (fleet/resolve_private_repo.ts), so the
// truncation length lives in this file alone.
export const VERIFY_HEX_LENGTH = 32;

// Domain-separation label for deriving the tag key from the fleet PAT, so
// the PAT itself never keys a second protocol.
export const KEY_DERIVATION_LABEL = "repo-platform-redact-key-v1";

/** The display hint for one bare repo name: each [-_.]-separated segment
 * renders as its first character plus "**" (separators kept), and the final
 * segment also keeps its last character when it has at least five (shorter
 * finals would echo most of the name back): "hidden-server" -> "h**-s**r",
 * "myrepo" -> "m**o", "ab" -> "a**". An empty segment renders as "**"
 * alone; case and digits pass through. A hint can never collide with a
 * real name: "*" is illegal in GitHub repo names. */
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

// The redaction invariant as a type: a private row is a hint plus a resolution
// tag (details hidden by run_hidden.ts), a public row is the bare slug and no
// tag. Rows read back from a file go through parseEnrichedRows, never a cast.
export const enrichedRowSchema = z
  .discriminatedUnion("private", [
    z.object({
      repo: z.string(),
      private: z.literal(true),
      display: z.string(),
      verify: z.string().min(1),
    }),
    z.object({
      repo: z.string(),
      private: z.literal(false),
      display: z.string(),
      verify: z.literal(""),
    }),
  ])
  // A hint always contains "*" (illegal in repo names), so this rejects a
  // slug leaking through the display of a private row - and a hint
  // masquerading as the slug of a public one. The issue names the field
  // but never the value: this fires exactly where quoting is unsafe.
  .refine((row) => (row.private ? row.display.includes("*") : row.display === row.repo), {
    message: "display must be a masked hint on a private row (the slug itself otherwise)",
    path: ["display"],
  });

export type EnrichedRow = z.infer<typeof enrichedRowSchema>;

/** Omit distributed over a union, so each arm keeps its discriminant
 *  instead of collapsing into one widened object. */
type DistributedOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** The redaction pair alone, DERIVED from the row schema so a consumer
 *  carrying it (build_settings_matrix.ts's Target) can never drift from
 *  the invariant: a private row carries a resolution tag, a public one
 *  carries none. */
export type RedactionState = DistributedOmit<EnrichedRow, "repo" | "display">;

/** Parse a row array at a consumer boundary (the settings selector's
 * target file carries enriched rows verbatim); a violation of the row
 * shape or the redaction invariant exits with ::error::. */
export function parseEnrichedRows(data: unknown, label: string): EnrichedRow[] {
  return parseWith(z.array(enrichedRowSchema), data, label);
}

/**
 * The plan rows for the discovered fleet, sorted by slug: a private repo
 * is hinted and tagged, a public one displays its slug. The hint table
 * spans every private repo discovered, so a hint stays stable however a
 * scope later narrows the run (a single-repo dispatch numbers collisions
 * the same way a full run does).
 */
export function enrich(
  discovered: DiscoveredRepo[],
  tagFor: (slug: string) => string,
): EnrichedRow[] {
  const hints = assignHints(discovered.filter((d) => d.private).map((d) => d.repo));
  return [...discovered]
    .sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0))
    .map(
      (entry): EnrichedRow =>
        entry.private
          ? {
              repo: entry.repo,
              private: true,
              display: hints.get(entry.repo) ?? hintName(entry.repo),
              verify: tagFor(entry.repo),
            }
          : { repo: entry.repo, private: false, display: entry.repo, verify: "" },
    );
}

// The discovered list a caller hands to `enrich`. Fail closed at the
// parse already: an entry without an explicit boolean `private` is
// rejected outright rather than defaulted, and one bad entry rejects the
// whole list - a silently dropped row would skip its repo's redaction
// decision. Loose on the rest: extra discovery fields pass through.
const discoveredListSchema = z.array(z.looseObject({ repo: z.string(), private: z.boolean() }));

/** Parse a discovered list at the trust boundary; null when the shape is
 * wrong (the caller then fails without quoting the payload, which can
 * carry private repo names). */
export function parseDiscoveredList(data: unknown): DiscoveredRepo[] | null {
  const result = discoveredListSchema.safeParse(data);
  return result.success ? result.data : null;
}

function main(args: string[]): void {
  const [command, ...rest] = args;
  if (command !== "hint") {
    fail(`unknown subcommand ${JSON.stringify(command ?? "")} - usage: redact.ts hint <name>`);
  }
  const name = rest[0];
  if (name === undefined || name === "" || rest.length > 1) {
    fail("usage: redact.ts hint <bare-repo-name>");
  }
  console.log(hintName(name.includes("/") ? (name.split("/").pop() ?? name) : name));
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
