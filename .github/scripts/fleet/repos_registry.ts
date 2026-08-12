// Fleet registry tooling for repos.yml - the single owner of the schema.
// Used by CI validation and by sync-repos/settings-repos to resolve which
// repos to target and which channel each one follows.
//
// Usage:
//   bun .github/scripts/fleet/repos_registry.ts validate [--file repos.yml]
//   bun .github/scripts/fleet/repos_registry.ts select [--repo owner/name]
//     [--discovered discovered.json] [--file repos.yml]
//   bun .github/scripts/fleet/repos_registry.ts excluded [--file repos.yml]
//
// `select` prints a JSON array of {repo, owner, name, channel} on stdout;
// channel is null when the registry resolves none (the sync then falls
// back to the repo's recorded copier answer). `--discovered` names a JSON
// file holding an array of "owner/name" strings or {repo, ...} objects
// (already filtered for archived repos by the caller); it is required
// whenever `managed` contains the "*" wildcard. `excluded` prints the
// exclude list as a JSON array of slugs (select_settings_repos.ts uses it
// to report paused repos that still carry an in-repo settings file).
// Slugs match case-insensitively everywhere, like GitHub repo identity;
// original casing is kept for display. Errors go to stderr as
// ::error:: workflow commands, all of them at once, and the exit code is
// nonzero.

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { parseFlags } from "../shared/flags.ts";

const SLUG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;
const WILDCARD = "*";
const CHANNELS = ["staging", "latest"] as const;
const TOP_LEVEL_KEYS = ["managed", "exclude", "defaults", "config"];

type Channel = (typeof CHANNELS)[number];

export interface Registry {
  managed: { wildcard: boolean; repos: string[] };
  exclude: string[];
  defaultChannel: Channel | null;
  // Keyed by the lowercased slug (the parse boundary normalizes case).
  config: Map<string, { channel: Channel }>;
}

export interface Selected {
  repo: string;
  owner: string;
  name: string;
  channel: Channel | null;
}

function isSlug(value: unknown): value is string {
  return typeof value === "string" && SLUG_RE.test(value);
}

function isChannel(value: unknown): value is Channel {
  return typeof value === "string" && (CHANNELS as readonly string[]).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Parse + validate raw YAML text. Returns every problem found, not just
// the first; `registry` is null unless the text is fully valid.
export function loadRegistry(
  text: string,
  label = "repos.yml",
): { registry: Registry | null; errors: string[] } {
  let data: unknown;
  try {
    data = parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return {
      registry: null,
      errors: [
        `${label}: YAML parse error: ${detail} - if managed uses the wildcard, ` +
          `write it quoted ("*"); a bare * is YAML alias syntax`,
      ],
    };
  }
  return validateRegistry(data, label);
}

export function validateRegistry(
  data: unknown,
  label = "repos.yml",
): { registry: Registry | null; errors: string[] } {
  const errors: string[] = [];
  if (!isPlainObject(data)) {
    return { registry: null, errors: [`${label}: top level must be a mapping`] };
  }

  for (const key of Object.keys(data)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      errors.push(
        `${label}: unknown top-level key "${key}" - allowed keys are ${TOP_LEVEL_KEYS.join(", ")}`,
      );
    }
  }

  let wildcard = false;
  const repos: string[] = [];
  if (!Array.isArray(data.managed)) {
    errors.push(`${label}: managed must be a list of owner/name slugs or the "*" wildcard`);
  } else {
    const seen = new Set<string>();
    for (const entry of data.managed) {
      if (entry === WILDCARD) {
        if (wildcard) {
          errors.push(`${label}: managed contains more than one "*" wildcard`);
        }
        wildcard = true;
        continue;
      }
      if (!isSlug(entry)) {
        errors.push(
          `${label}: managed entry ${JSON.stringify(entry)} is not an owner/name slug or "*"`,
        );
        continue;
      }
      if (seen.has(entry.toLowerCase())) {
        errors.push(`${label}: duplicate managed entry "${entry}" (slugs match ignoring case)`);
      }
      seen.add(entry.toLowerCase());
      repos.push(entry);
    }
  }

  const exclude: string[] = [];
  const excluded = new Set<string>();
  if (data.exclude !== undefined) {
    if (!Array.isArray(data.exclude)) {
      errors.push(`${label}: exclude must be a list of owner/name slugs`);
    } else {
      for (const entry of data.exclude) {
        if (!isSlug(entry)) {
          errors.push(`${label}: exclude entry ${JSON.stringify(entry)} is not an owner/name slug`);
          continue;
        }
        if (excluded.has(entry.toLowerCase())) {
          errors.push(`${label}: duplicate exclude entry "${entry}" (slugs match ignoring case)`);
        }
        excluded.add(entry.toLowerCase());
        exclude.push(entry);
      }
      if (exclude.length > 0 && !wildcard) {
        errors.push(
          `${label}: exclude has entries but managed has no "*" wildcard - ` +
            `nothing is auto-discovered, so exclusions are dead config; ` +
            `remove the entries from exclude (or just do not list them in managed)`,
        );
      }
    }
  }

  let defaultChannel: Channel | null = null;
  if (data.defaults !== undefined) {
    if (!isPlainObject(data.defaults)) {
      errors.push(`${label}: defaults must be a mapping`);
    } else {
      for (const key of Object.keys(data.defaults)) {
        if (key !== "channel") {
          errors.push(`${label}: unknown defaults key "${key}" - only channel is allowed`);
        }
      }
      if (data.defaults.channel !== undefined) {
        if (isChannel(data.defaults.channel)) {
          defaultChannel = data.defaults.channel;
        } else {
          errors.push(
            `${label}: defaults.channel ${JSON.stringify(data.defaults.channel)} ` +
              `must be one of: ${CHANNELS.join(", ")}`,
          );
        }
      }
    }
  }

  const config = new Map<string, { channel: Channel }>();
  if (data.config !== undefined) {
    if (!isPlainObject(data.config)) {
      errors.push(`${label}: config must be a mapping of owner/name slugs`);
    } else {
      const seen = new Set<string>();
      for (const [slug, value] of Object.entries(data.config)) {
        if (!isSlug(slug)) {
          errors.push(`${label}: config key "${slug}" is not an owner/name slug`);
          continue;
        }
        if (excluded.has(slug.toLowerCase())) {
          errors.push(
            `${label}: config entry "${slug}" is also in exclude - ` +
              `an excluded repo is never synced, so its config is dead; remove one of the two`,
          );
        }
        if (seen.has(slug.toLowerCase())) {
          errors.push(`${label}: duplicate config entry "${slug}" (slugs match ignoring case)`);
        }
        seen.add(slug.toLowerCase());
        if (!isPlainObject(value)) {
          errors.push(`${label}: config.${slug} must be a mapping`);
          continue;
        }
        for (const key of Object.keys(value)) {
          if (key !== "channel") {
            errors.push(`${label}: unknown config.${slug} key "${key}" - only channel is allowed`);
          }
        }
        if (value.channel !== undefined) {
          if (isChannel(value.channel)) {
            config.set(slug.toLowerCase(), { channel: value.channel });
          } else {
            errors.push(
              `${label}: config.${slug}.channel ${JSON.stringify(value.channel)} ` +
                `must be one of: ${CHANNELS.join(", ")}`,
            );
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    return { registry: null, errors };
  }
  return {
    registry: { managed: { wildcard, repos }, exclude, defaultChannel, config },
    errors: [],
  };
}

// Resolve the selection: (wildcard x discovered) union explicit slugs,
// minus exclude, with the effective channel per repo. `discovered` is
// null when --discovered was not provided.
export function selectRepos(
  registry: Registry,
  options: { repo?: string; discovered?: string[] | null } = {},
): { selection: Selected[]; errors: string[] } {
  const errors: string[] = [];
  const discovered = options.discovered ?? null;

  if (registry.managed.wildcard && discovered === null) {
    errors.push(
      'repos.yml: managed contains "*" but no --discovered file was provided - ' +
        "pass the caller's discovery output (a JSON array of owner/name strings)",
    );
  }

  // Keyed by lowercased slug so a case-variant entry cannot slip past the
  // exclude list or double-select a repo; values keep the listed casing.
  const pool = new Map<string, string>();
  for (const slug of registry.managed.repos) {
    pool.set(slug.toLowerCase(), slug);
  }
  if (registry.managed.wildcard && discovered !== null) {
    discovered.forEach((slug, index) => {
      if (!isSlug(slug)) {
        // Index only, never the value: a malformed entry may still be a
        // private repo's name, and this print is publicly readable.
        errors.push(`discovered list entry at index ${index} is not an owner/name slug`);
        return;
      }
      if (!pool.has(slug.toLowerCase())) pool.set(slug.toLowerCase(), slug);
    });
  }
  for (const slug of registry.exclude) {
    pool.delete(slug.toLowerCase());
  }

  if (errors.length > 0) {
    return { selection: [], errors };
  }

  let repos = [...pool.values()].sort();
  if (options.repo !== undefined) {
    const wanted = options.repo.toLowerCase();
    repos = repos.filter((slug) => slug.toLowerCase() === wanted);
    if (repos.length === 0) {
      // The requested value is withheld: this print is publicly readable
      // and the operator-typed slug may name a private repository.
      errors.push(
        "--repo matched no selected repository (value withheld - it may be a private " +
          "slug): the repo you dispatched with is not in managed (or the discovered " +
          "list), or it is listed in exclude; check the spelling (matching ignores case)",
      );
      return { selection: [], errors };
    }
  }

  const selection = repos.map((slug): Selected => {
    const [owner, name] = slug.split("/", 2);
    const channel = registry.config.get(slug.toLowerCase())?.channel ?? registry.defaultChannel;
    return { repo: slug, owner, name, channel };
  });
  return { selection, errors: [] };
}

function fail(errors: string[]): never {
  for (const message of errors) {
    console.error(`::error::${message}`);
  }
  process.exit(1);
}

function readRegistryFile(path: string): Registry {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    fail([`${path}: cannot read the registry file`]);
  }
  const { registry, errors } = loadRegistry(text, path);
  if (registry === null) {
    fail(errors);
  }
  return registry;
}

function main(args: string[]): void {
  const [command, ...rest] = args;
  switch (command) {
    case "validate": {
      const flags = parseFlags(rest, [], ["--file"]);
      const path = flags["--file"] ?? "repos.yml";
      const registry = readRegistryFile(path);
      console.log(
        `${path}: OK - explicit repos: ${registry.managed.repos.length}, ` +
          `wildcard: ${registry.managed.wildcard ? "yes" : "no"}, ` +
          `excluded: ${registry.exclude.length}, config entries: ${registry.config.size}`,
      );
      return;
    }
    case "select": {
      const flags = parseFlags(rest, [], ["--file", "--repo", "--discovered"]);
      const registry = readRegistryFile(flags["--file"] ?? "repos.yml");
      let discovered: string[] | null = null;
      const discoveredPath = flags["--discovered"];
      if (discoveredPath !== undefined) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(discoveredPath, "utf-8"));
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          fail([`${discoveredPath}: cannot read discovered list: ${detail}`]);
        }
        // Two accepted shapes: plain "owner/name" strings, or the
        // discovery objects the redaction-aware callers write
        // ({repo, private, ...} - only repo matters here; visibility is
        // the enricher's concern, keeping registry logic pure).
        if (!Array.isArray(parsed)) {
          fail([`${discoveredPath}: discovered list must be a JSON array`]);
        }
        discovered = parsed.map((entry, index): string => {
          if (typeof entry === "string") return entry;
          if (
            typeof entry === "object" &&
            entry !== null &&
            typeof (entry as { repo: unknown }).repo === "string"
          ) {
            return (entry as { repo: string }).repo;
          }
          return fail([
            `${discoveredPath}: entry at index ${index} is neither an "owner/name" ` +
              `string nor a {repo, ...} object`,
          ]);
        });
      }
      const { selection, errors } = selectRepos(registry, {
        repo: flags["--repo"],
        discovered,
      });
      if (errors.length > 0) {
        fail(errors);
      }
      console.log(JSON.stringify(selection));
      return;
    }
    case "excluded": {
      const flags = parseFlags(rest, [], ["--file"]);
      const registry = readRegistryFile(flags["--file"] ?? "repos.yml");
      console.log(JSON.stringify(registry.exclude));
      return;
    }
    default:
      fail([
        `unknown subcommand ${JSON.stringify(command ?? "")} - ` +
          `usage: repos_registry.ts validate|select|excluded [--file repos.yml] ` +
          `[--repo owner/name] [--discovered discovered.json]`,
      ]);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
