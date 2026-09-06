// Data anchors: the manifest-derived contributions (dependabot
// ecosystems, codeql languages, gitleaks lockfiles, the agents toolchain
// block), the toolchain-setup prepend, and the rendered-separation
// invariant every anchor's contributions must satisfy.

import type { ModuleManifest } from "../lib/module_manifests.ts";
import { FRAGMENTS_DIR, JINJA_SUFFIX, MANIFEST_NAME } from "./entries.ts";

// A total module -> gate lookup: build() populates the gate map for every
// module in MODULE_ORDER before any generator runs, so a miss can only be
// a programming error and fails loudly instead of guessing a gate.
export type GateOf = (module: string) => string;

/** The gate for a group of contributing modules: each module's own gate
 *  expression, or-chained in the given (MODULE_ORDER) order. */
export function orChain(modules: string[], gateOf: GateOf): string {
  return modules.map((module) => gateOf(module)).join(" or ");
}

export type EcosystemGroup = { ecosystem: string; modules: string[] };

/** Distinct dependabot ecosystems with their contributing modules, in
 *  MODULE_ORDER of first contributor. */
export function ecosystemGroups(manifests: ModuleManifest[]): EcosystemGroup[] {
  const groups = new Map<string, EcosystemGroup>();
  for (const manifest of manifests) {
    if (!manifest.dependabot) continue;
    const { ecosystem } = manifest.dependabot;
    const group = groups.get(ecosystem) ?? { ecosystem, modules: [] };
    group.modules.push(manifest.module);
    groups.set(ecosystem, group);
  }
  return [...groups.values()];
}

export type CodeqlGroup = { language: string; modules: string[] };

/** Distinct CodeQL languages with their contributing modules, in
 *  MODULE_ORDER of first contributor. */
export function codeqlGroups(manifests: ModuleManifest[]): CodeqlGroup[] {
  const groups = new Map<string, CodeqlGroup>();
  for (const manifest of manifests) {
    if (!manifest.toolchain) continue;
    const language = manifest.toolchain.codeql_language;
    const group = groups.get(language) ?? { language, modules: [] };
    group.modules.push(manifest.module);
    groups.set(language, group);
  }
  return [...groups.values()];
}

export type DependabotLabel = {
  name: string;
  color: string;
  description: string;
  modules: string[];
};

/** Distinct dependabot PR labels with their contributing modules, in
 *  MODULE_ORDER of first contributor (shared labels agree on their color -
 *  the manifest loader asserts it). The settings baseline generator
 *  (.github/scripts/fleet/render_managed_settings.ts), check_ssot.ts, and
 *  the generated docs regions all read this one derivation, so the label
 *  rosters cannot drift apart. */
export function dependabotLabels(manifests: ModuleManifest[]): DependabotLabel[] {
  const groups = new Map<string, DependabotLabel>();
  for (const manifest of manifests) {
    if (!manifest.dependabot) continue;
    const { label, color } = manifest.dependabot;
    const group = groups.get(label) ?? {
      name: label,
      color,
      description: `Pull requests that update ${label} code`,
      modules: [],
    };
    group.modules.push(manifest.module);
    groups.set(label, group);
  }
  return [...groups.values()];
}

export type LockfileGroup = { patterns: string[]; modules: string[] };

/** Gitleaks lockfile patterns grouped for emission: each distinct pattern
 *  appears once with its declaring modules; consecutive patterns with the
 *  same module set share one group (one emitted line). */
export function lockfileGroups(manifests: ModuleManifest[]): LockfileGroup[] {
  const byPattern = new Map<string, string[]>();
  for (const manifest of manifests) {
    for (const pattern of manifest.lockfiles ?? []) {
      const modules = byPattern.get(pattern) ?? [];
      if (!modules.includes(manifest.module)) modules.push(manifest.module);
      byPattern.set(pattern, modules);
    }
  }
  const groups: LockfileGroup[] = [];
  for (const [pattern, modules] of byPattern) {
    const last = groups[groups.length - 1];
    if (
      last &&
      last.modules.length === modules.length &&
      last.modules.every((m, i) => m === modules[i])
    ) {
      last.patterns.push(pattern);
    } else {
      groups.push({ patterns: [pattern], modules });
    }
  }
  return groups;
}

/** A dependabot- or toolchain-carrying module lands in the managed
 *  AGENTS.md Toolchain section's audience; without an agents-toolchain
 *  fragment its bullets would just silently be missing. `withFragment` is
 *  the set of modules providing fragments/agents-toolchain.jinja. */
export function agentsToolchainErrors(
  manifests: ModuleManifest[],
  withFragment: Set<string>,
): string[] {
  const errors: string[] = [];
  for (const manifest of manifests) {
    const declares = [
      ...(manifest.dependabot ? ["dependabot"] : []),
      ...(manifest.toolchain ? ["a toolchain"] : []),
    ];
    if (declares.length === 0 || withFragment.has(manifest.module)) continue;
    errors.push(
      `templates/${manifest.module}/${MANIFEST_NAME} declares ${declares.join(" and ")} but ` +
        `templates/${manifest.module}/${FRAGMENTS_DIR}/agents-toolchain${JINJA_SUFFIX} ` +
        "is missing - AGENTS.md's Toolchain section would silently skip the " +
        "module; add the fragment with its toolchain bullets",
    );
  }
  return errors;
}

// One spliced piece of an anchor's replacement, already carrying its gate
// tags in `text`. `gate` is the condition under which the text renders
// anything at all - null when the contribution manages its own whitespace
// (it must then keep the anchor line sensible in every render itself).
// `order` is the MODULE_ORDER position of the (first) contributing module,
// so generated groups interleave with fragment contributions exactly where
// the contributing modules sit.
export type Contribution = { order: number; source: string; gate: string | null; text: Buffer };

/** A generator's own validation failure (bad manifest data): reported as a
 *  clean composition error. Anything else escaping a generator is a bug and
 *  is rethrown with its stack preserved via `cause`. */
export class GeneratorValidationError extends Error {}

/** Rendered-separation invariant for an anchor's ordered contributions:
 *  every NON-LAST contribution, once its trailing closing tags are
 *  stripped, must end with a newline - otherwise two selected
 *  contributions render onto one line (adjacent `{% if %}...{% endif %}`
 *  wrappers emit no separator of their own). On a plain anchor the last
 *  contribution may end mid-line (the skeleton's own newline terminates
 *  the block - the collapse guard re-emits it whenever any contribution
 *  is selected, so guarding changes nothing here); on a TIGHT anchor
 *  (`-#}`) that newline is consumed, so the last contribution must supply
 *  the line ending itself. */
export function renderedSeparationErrors(
  anchor: string,
  contributions: { source: string; text: Buffer }[],
  tight = false,
): string[] {
  const errors: string[] = [];
  const last = contributions.length - (tight ? 0 : 1);
  for (let i = 0; i < last; i++) {
    const { source, text } = contributions[i];
    let body = text.toString("latin1");
    for (;;) {
      const stripped = body.replace(/\{%-?\s*endif\s*-?%\}$/, "");
      if (stripped === body) break;
      body = stripped;
    }
    if (!body.endsWith("\n")) {
      errors.push(
        i + 1 < contributions.length
          ? `anchor '${anchor}': ${source} renders without a trailing newline ` +
              `(after its closing tags) but a later contribution follows - when ` +
              "both are selected they render onto one line; end the fragment " +
              "body with a newline"
          : `anchor '${anchor}': ${source} renders without a trailing newline ` +
              `(after its closing tags) but the anchor is tight (-#}), so the ` +
              "block supplies its own line ending; end the fragment body " +
              "with a newline",
      );
    }
  }
  return errors;
}

type GeneratorContext = { manifests: ModuleManifest[]; gateOf: GateOf };

/** The non-anchor fragment name carrying a module's toolchain setup steps
 *  and the two anchors those steps are prepended to. */
export const TOOLCHAIN_SETUP_FRAGMENT = "toolchain-setup";
export const TOOLCHAIN_SETUP_TARGETS = ["auto-format", "copilot-setup-steps"];

/** Prepend each module's toolchain-setup fragment to its own auto-format
 *  and copilot-setup-steps contributions (in place), then drop the
 *  toolchain-setup entry - it is generator input, never spliced itself. A
 *  module carrying setup steps without both target fragments errors (the
 *  steps would silently reach only one of the workflows), and a module
 *  carrying both target fragments without setup steps errors too - that is
 *  the hand-duplication this rule exists to prevent. */
export function applyToolchainSetup(fragments: Map<string, [ModuleManifest, Buffer][]>): string[] {
  const errors: string[] = [];
  for (const [manifest, setup] of fragments.get(TOOLCHAIN_SETUP_FRAGMENT) ?? []) {
    const path = `templates/${manifest.module}/${FRAGMENTS_DIR}/${TOOLCHAIN_SETUP_FRAGMENT}${JINJA_SUFFIX}`;
    if (setup.length === 0 || setup[setup.length - 1] !== 0x0a) {
      errors.push(
        `${path}: the fragment must end with a newline - prepending would ` +
          "fuse its last line with the target fragment's first step",
      );
      continue;
    }
    for (const target of TOOLCHAIN_SETUP_TARGETS) {
      const entry = (fragments.get(target) ?? []).find(([m]) => m.module === manifest.module);
      if (!entry) {
        errors.push(
          `${path}: the module ships no ${FRAGMENTS_DIR}/${target}${JINJA_SUFFIX} to prepend ` +
            "the setup steps to - add that fragment or inline the steps and delete this one",
        );
        continue;
      }
      entry[1] = Buffer.concat([setup, entry[1]]);
    }
  }
  const withSetup = new Set(
    (fragments.get(TOOLCHAIN_SETUP_FRAGMENT) ?? []).map(([manifest]) => manifest.module),
  );
  const targetModules = TOOLCHAIN_SETUP_TARGETS.map(
    (target) => new Set((fragments.get(target) ?? []).map(([manifest]) => manifest.module)),
  );
  for (const module of targetModules[0]) {
    if (targetModules.every((modules) => modules.has(module)) && !withSetup.has(module)) {
      errors.push(
        `templates/${module}/${FRAGMENTS_DIR}: the module ships both ` +
          `${TOOLCHAIN_SETUP_TARGETS.join(" and ")} fragments without a ` +
          `${TOOLCHAIN_SETUP_FRAGMENT} fragment - hoist the shared setup steps into ` +
          `${FRAGMENTS_DIR}/${TOOLCHAIN_SETUP_FRAGMENT}${JINJA_SUFFIX} so the two copies cannot drift`,
      );
    }
  }
  fragments.delete(TOOLCHAIN_SETUP_FRAGMENT);
  return errors;
}
// Discriminated on `kind` so the shapes stay honest: only a consume
// generator ever sees fragment bytes.
type DataAnchorSpec = { data: string } & (
  | {
      /** Any fragment file for the anchor is an error. */
      kind: "reject";
      generate: (ctx: GeneratorContext) => Contribution[];
    }
  | {
      /** Fragments become the generator's input instead of being spliced. */
      kind: "consume";
      generate: (ctx: GeneratorContext & { fragments: [string, Buffer][] }) => Contribution[];
    }
);

/** A contribution body wrapped whole in one gate, with the gate recorded
 *  so spliceContributions can collapse an anchor line whose contributions
 *  all render false. */
function gated(gate: string, body: string): { gate: string; text: Buffer } {
  return { gate, text: Buffer.from(`{% if ${gate} %}${body}{% endif %}`) };
}

function generatorSource(anchor: string, data: string): string {
  return `the built-in '${anchor}' generator (module.yml ${data})`;
}

function orderOf(manifests: ModuleManifest[], module: string): number {
  return manifests.findIndex((manifest) => manifest.module === module);
}

function ecosystemBlock(ecosystem: string): string {
  return `
  - package-ecosystem: "${ecosystem}"
    directory: "/"
    schedule:
      interval: "monthly"
    cooldown:
      default-days: 7
    commit-message:
      prefix: "build"
      include: "scope"
`;
}

export const DATA_ANCHORS: Record<string, DataAnchorSpec> = {
  "dependabot-ecosystems": {
    data: "dependabot.ecosystem",
    kind: "reject",
    generate: ({ manifests, gateOf }) =>
      ecosystemGroups(manifests).map((group) => ({
        order: orderOf(manifests, group.modules[0]),
        source: generatorSource("dependabot-ecosystems", "dependabot.ecosystem"),
        ...gated(orChain(group.modules, gateOf), ecosystemBlock(group.ecosystem)),
      })),
  },
  "codeql-languages": {
    data: "toolchain.codeql_language",
    kind: "reject",
    generate: ({ manifests, gateOf }) => {
      // The fleet-ci call's codeql-languages input: jinja that builds the
      // selected languages list (one append per language group, gated on
      // the or-chain of its contributing modules, inside the
      // enable_codeql guard) and emits the quoted JSON input line. The
      // line renders in EVERY selection - '[]' when CodeQL is off, which
      // fleet-ci's codeql job skips on.
      const groups = codeqlGroups(manifests);
      if (groups.length === 0) return [];
      const appends = groups.map(
        (group) =>
          `{%- if ${orChain(group.modules, gateOf)} %}{% set _ = codeql_languages.append('${group.language}') %}{% endif %}`,
      );
      const lines = [
        "{%- set codeql_languages = [] %}",
        "{%- if enable_codeql %}",
        ...appends,
        "{%- endif %}",
        "      codeql-languages: '{{ codeql_languages | tojson }}'",
      ];
      return [
        {
          order: orderOf(manifests, groups[0].modules[0]),
          source: generatorSource("codeql-languages", "toolchain.codeql_language"),
          // The leading {%- tags manage the anchor's whitespace; the input
          // line itself renders unconditionally, so no collapse gate.
          gate: null,
          text: Buffer.from(lines.join("\n")),
        },
      ];
    },
  },
  "gitleaks-locks": {
    data: "lockfiles",
    kind: "reject",
    generate: ({ manifests, gateOf }) => {
      const groups = lockfileGroups(manifests);
      if (groups.length === 0) return [];
      const lines = groups.map(
        ({ patterns, modules }) =>
          `{%- if ${orChain(modules, gateOf)} %}${patterns
            .map((pattern) => `{% set _ = locks.append('${pattern}') %}`)
            .join("")}{% endif %}`,
      );
      return [
        {
          order: orderOf(manifests, groups[0].modules[0]),
          source: generatorSource("gitleaks-locks", "lockfiles"),
          // Renders nothing in every selection (append statements only);
          // the leading {%- on each line manages the anchor's whitespace.
          gate: null,
          text: Buffer.from(lines.join("\n")),
        },
      ];
    },
  },
  // The generator owns the whole Toolchain block: the outer guard is the
  // or-chain over the modules that ship an agents-toolchain fragment, so a
  // new toolchain module extends it by adding its fragment - nothing
  // hand-written to keep in sync. The bullet text itself stays free-form in
  // the fragments (which must end with a newline - the closing tag needs its
  // own line).
  "agents-toolchain": {
    data: "fragments/agents-toolchain.jinja",
    kind: "consume",
    generate: ({ manifests, gateOf, fragments }) => {
      if (fragments.length === 0) return [];
      const modules = fragments.map(([module]) => module);
      const parts: Buffer[] = [
        Buffer.from(`{% if ${orChain(modules, gateOf)} %}\n## Toolchain\n\n`),
      ];
      for (const [module, body] of fragments) {
        parts.push(
          Buffer.from(`{% if ${gateOf(module)} -%}\n`),
          body,
          Buffer.from("{% endif -%}\n"),
        );
      }
      parts.push(Buffer.from("{% endif %}"));
      return [
        {
          order: orderOf(manifests, modules[0]),
          source: generatorSource("agents-toolchain", "fragments"),
          // No collapse gate: with no toolchain module selected the anchor
          // line's newline IS the blank line separating the Project section
          // from ## Conventions in AGENTS.md - collapsing it would fuse them.
          gate: null,
          text: Buffer.concat(parts),
        },
      ];
    },
  },
};
