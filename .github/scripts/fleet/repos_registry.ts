// Fleet registry tooling for repos.yml - the single owner of the schema.
// Used by CI validation and by sync-repos/settings-repos to resolve which
// repos to target and which channel each one follows.
//
// Usage:
//   bun .github/scripts/fleet/repos_registry.ts validate [--file repos.yml]
//   bun .github/scripts/fleet/repos_registry.ts select [--repo owner/name]
//     [--discovered discovered.json] [--file repos.yml]
//
// `select` prints a JSON array of {repo, owner, name, channel} on stdout;
// channel is null when the registry resolves none (the sync then falls
// back to the repo's recorded copier answer). `--discovered` names a JSON
// file holding an array of "owner/name" strings (already filtered for
// archived repos by the caller); it is required whenever `managed`
// contains the "*" wildcard. Errors go to stderr as ::error:: workflow
// commands, all of them at once, and the exit code is nonzero.

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

  // managed
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
      if (seen.has(entry)) {
        errors.push(`${label}: duplicate managed entry "${entry}"`);
      }
      seen.add(entry);
      repos.push(entry);
    }
  }

  // exclude
  const exclude: string[] = [];
  if (data.exclude !== undefined) {
    if (!Array.isArray(data.exclude)) {
      errors.push(`${label}: exclude must be a list of owner/name slugs`);
    } else {
      const seen = new Set<string>();
      for (const entry of data.exclude) {
        if (!isSlug(entry)) {
          errors.push(`${label}: exclude entry ${JSON.stringify(entry)} is not an owner/name slug`);
          continue;
        }
        if (seen.has(entry)) {
          errors.push(`${label}: duplicate exclude entry "${entry}"`);
        }
        seen.add(entry);
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

  // defaults
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

  // config
  const config = new Map<string, { channel: Channel }>();
  if (data.config !== undefined) {
    if (!isPlainObject(data.config)) {
      errors.push(`${label}: config must be a mapping of owner/name slugs`);
    } else {
      for (const [slug, value] of Object.entries(data.config)) {
        if (!isSlug(slug)) {
          errors.push(`${label}: config key "${slug}" is not an owner/name slug`);
          continue;
        }
        if (exclude.includes(slug)) {
          errors.push(
            `${label}: config entry "${slug}" is also in exclude - ` +
              `an excluded repo is never synced, so its config is dead; remove one of the two`,
          );
        }
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
            config.set(slug, { channel: value.channel });
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

  const pool = new Set<string>(registry.managed.repos);
  if (registry.managed.wildcard && discovered !== null) {
    for (const slug of discovered) {
      if (!isSlug(slug)) {
        errors.push(`discovered list entry ${JSON.stringify(slug)} is not an owner/name slug`);
        continue;
      }
      pool.add(slug);
    }
  }
  for (const slug of registry.exclude) {
    pool.delete(slug);
  }

  if (errors.length > 0) {
    return { selection: [], errors };
  }

  let repos = [...pool].sort();
  if (options.repo !== undefined) {
    repos = repos.filter((slug) => slug === options.repo);
    if (repos.length === 0) {
      errors.push(
        `--repo ${options.repo} matched no selected repository - it is not in ` +
          `managed (or the discovered list), or it is listed in exclude`,
      );
      return { selection: [], errors };
    }
  }

  const selection = repos.map((slug): Selected => {
    const [owner, name] = slug.split("/", 2);
    const channel = registry.config.get(slug)?.channel ?? registry.defaultChannel;
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
        if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) {
          fail([`${discoveredPath}: discovered list must be a JSON array of "owner/name" strings`]);
        }
        discovered = parsed;
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
    default:
      fail([
        `unknown subcommand ${JSON.stringify(command ?? "")} - ` +
          `usage: repos_registry.ts validate|select [--file repos.yml] ` +
          `[--repo owner/name] [--discovered discovered.json]`,
      ]);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
