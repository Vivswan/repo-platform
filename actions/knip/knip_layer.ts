// The layering knip's configuration module applies, as a module: knip's loader reads the repository's configuration
// (an object, a function, a promise of either) and layers package.json's `knip` key under it with
// `Object.assign({}, manifest.knip, file)`; this does the same, then negates the platform checkout in the root
// workspace's configured `entry` and `project` lists. knip reads the root's lists under `workspaces["."]` when that key
// exists, else at the top level.
//
// A list stays as it came where knip reads it as its defaults: a falsy value, or knip's default patterns alone, so
// knip still reads the list as its own (a negation beside them would make it explicit, which changes how knip treats
// an entry's exports). The default entry patterns have no `**` to reach the checkout, and the default project glob
// honors git's excludes. Nothing is healed: a configuration that is no object, or a list that is neither a list nor a
// string, is returned as it came, for knip's schema to refuse.

import type { KnipConfig } from "knip";

type ConfigArguments = Parameters<Extract<KnipConfig, (...args: never) => unknown>>[0];
type PatternType = "entry" | "project";

/** Only `layer` is exported: in the fleet this file sits inside the caller's tree, reached from knip's configuration
 *  entry, and knip would report any other export of it unused. */
interface LayerOptions {
  /** The negated glob that keeps the checkout out, `!<dir>/**`. */
  negation: string;
  /** knip's own `isDefaultPattern`, the test its graph builder applies to a configured list. */
  isDefaultPattern: (type: PatternType, pattern: string) => boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function negated(
  type: PatternType,
  patterns: unknown,
  { negation, isDefaultPattern }: LayerOptions,
): unknown {
  const list = Array.isArray(patterns)
    ? patterns
    : typeof patterns === "string"
      ? [patterns]
      : undefined;
  if (!patterns || list === undefined) return patterns;
  const defaults = list.every(
    (pattern) => typeof pattern === "string" && isDefaultPattern(type, pattern),
  );
  return defaults ? patterns : [...new Set([...list, negation])];
}

function withNegation(config: unknown, options: LayerOptions): unknown {
  if (!isObject(config)) return config;
  return {
    ...config,
    ...("entry" in config ? { entry: negated("entry", config.entry, options) } : {}),
    ...("project" in config ? { project: negated("project", config.project, options) } : {}),
  };
}

/** The configuration knip runs: `own` is the repository's configuration module namespace, or knip's resolution of a
 *  data configuration; `manifest` is the repository's package.json. Returns knip's function form, so a function the
 *  repository exported is called with knip's arguments where knip calls it. The result is `unknown` because it is
 *  knip's schema's to judge: a configuration where the repository wrote one, else what the repository wrote as it
 *  came. */
export function layer(
  own: unknown,
  manifest: { knip?: unknown },
  options: LayerOptions,
): (args: ConfigArguments) => Promise<unknown> {
  return async (args) => {
    const config = await ((isObject(own) ? own.default : undefined) ?? own);
    const resolved = typeof config === "function" ? await config(args) : config;
    if (!isObject(resolved)) return resolved;
    const layered: Record<string, unknown> = Object.assign({}, manifest.knip, resolved);
    const { workspaces } = layered;
    return isObject(workspaces) && "." in workspaces
      ? { ...layered, workspaces: { ...workspaces, ".": withNegation(workspaces["."], options) } }
      : withNegation(layered, options);
  };
}
