// The module and visibility gating a smoke render must show, as data: each
// row names a condition on the matrix row's selection and the checks that
// hold under it. tests/ci/smoke_gating/smoke_gating.test.ts evaluates the
// applicable rows against a smoke_generate.ts render; the ssot module-list
// rule imports GATED_MODULES to prove every module is conditioned here.
// Kept free of bun:test and of the code under test so both importers stay
// independent of it. Every literal below is hand-authored: the render is
// the code under test, so nothing here derives from the templates.

import { parse as parseYaml } from "yaml";

// Copier normalizes the multiselect to its choices order, so rendered
// module lists are rebuilt in this order; a new module joins this tuple
// (the ssot module-list rule compares it with the manifests).
export const MODULES = [
  "bun",
  "node",
  "deno",
  "uv",
  "rust",
  "pages",
  "docs-site",
  "release-please",
  "issue-templates",
  "skills",
  "pr-title",
  "fuzzer",
  "nightly",
  "custom-license",
] as const;

export type Module = (typeof MODULES)[number];

export interface Selection {
  readonly modules: ReadonlySet<Module>;
  readonly isPrivate: boolean;
  /** The skills_dir answer: the copier default unless EXTRA_DATA overrides it. */
  readonly skillsDir: string;
}

/** A predicate over the selection that also NAMES the modules it reads, so
 * the table can report which modules it conditions on. */
export interface Condition {
  readonly label: string;
  readonly modules: readonly Module[];
  holds(selection: Selection): boolean;
}

export const ALWAYS: Condition = { label: "always", modules: [], holds: () => true };
export const PUBLIC: Condition = {
  label: "public",
  modules: [],
  holds: (s) => !s.isPrivate,
};
export const PRIVATE: Condition = {
  label: "private",
  modules: [],
  holds: (s) => s.isPrivate,
};

export function has(module: Module): Condition {
  return { label: module, modules: [module], holds: (s) => s.modules.has(module) };
}

export function anyOf(...modules: Module[]): Condition {
  return {
    label: modules.join(" or "),
    modules,
    holds: (s) => modules.some((m) => s.modules.has(m)),
  };
}

export function not(condition: Condition): Condition {
  return {
    label: `not ${condition.label}`,
    modules: condition.modules,
    holds: (s) => !condition.holds(s),
  };
}

export function and(...conditions: Condition[]): Condition {
  return {
    label: conditions.map((c) => `(${c.label})`).join(" and "),
    modules: conditions.flatMap((c) => c.modules),
    holds: (s) => conditions.every((c) => c.holds(s)),
  };
}

export function or(...conditions: Condition[]): Condition {
  return {
    label: conditions.map((c) => `(${c.label})`).join(" or "),
    modules: conditions.flatMap((c) => c.modules),
    holds: (s) => conditions.some((c) => c.holds(s)),
  };
}

// CodeQL-analyzable toolchains drive enable_codeql and the auto-format
// starter; rust joins only the any-toolchain gates.
export const CODEQL_TOOLCHAIN = anyOf("bun", "node", "deno", "uv");
export const ANY_TOOLCHAIN = or(CODEQL_TOOLCHAIN, has("rust"));
export const ENABLE_CODEQL = and(PUBLIC, CODEQL_TOOLCHAIN);

/** Wraps a substring in a partial match: the actual string must contain it. */
export class Includes {
  constructor(readonly text: string) {}
}
export const includes = (text: string): Includes => new Includes(text);

/** A path into a parsed YAML/JSON document. */
export type DocPath = readonly (string | number)[];

export type Check =
  | { kind: "exists"; path: string }
  | { kind: "missing"; path: string }
  | { kind: "symlink"; path: string; target: string }
  | {
      kind: "text";
      path: string;
      has?: string[];
      lacks?: string[];
      hasLine?: string[];
      lacksLine?: string[];
    }
  /** Occurrences of a substring, or of a whole line, never both. */
  | { kind: "count"; path: string; substring: string; line?: never; expected: number }
  | { kind: "count"; path: string; line: string; substring?: never; expected: number }
  | { kind: "line-matching"; path: string; pattern: RegExp }
  | { kind: "json"; path: string }
  /** Deep equality of the value at `at`. */
  | { kind: "yaml-equals"; path: string; at: DocPath; equals: unknown }
  /** Partial match at `at`: object keys are a subset, every expected array
   * element matches some actual element, Includes matches a substring. */
  | { kind: "yaml-matches"; path: string; at: DocPath; matches: unknown }
  /** The value at `at` is a JSON string that parses to `equals`. */
  | { kind: "yaml-json"; path: string; at: DocPath; equals: unknown }
  /** Each element of the array at `at`, projected to the values at
   * `pluck`, in order, deep-equals `equals`. */
  | { kind: "yaml-pluck"; path: string; at: DocPath; pluck: DocPath[]; equals: unknown }
  /** The mapping at `at` has exactly these keys, in order. */
  | { kind: "yaml-keys"; path: string; at: DocPath; equals: string[] }
  | { kind: "yaml-defined"; path: string; at: DocPath }
  | { kind: "yaml-absent"; path: string; at: DocPath }
  /** The subtree at `at`, flattened to its keys and scalars, contains or
   * lacks each substring (comments never count). */
  | { kind: "yaml-text"; path: string; at: DocPath; has?: string[]; lacks?: string[] }
  /** The document minus the named jobs, flattened, lacks each substring. */
  | { kind: "outside-jobs"; path: string; jobs: string[]; lacks: string[] }
  /** Every `deno fmt` in every workflow carries --prose-wrap preserve. */
  | { kind: "deno-fmt-prose-preserved"; dir: string };

export interface Row {
  readonly name: string;
  readonly when: Condition;
  readonly checks: (selection: Selection) => Check[];
}

const WF = ".github/workflows";
const CI = `${WF}/ci.yml`;

// The post-green legs' conditions, pinned whole: results are spelled out so
// no leg depends on GitHub's implied-success() rule, and the event clauses
// keep PR, dispatch, and schedule runs from ever deploying or releasing. The
// !cancelled() form is the deploy legs' whose needs edges are an ORDER, not
// a gate: a red or skipped upstream leg still deploys.
const GREEN_PUSH_TO_MAIN =
  "needs.all-green.result == 'success' && github.event_name == 'push' && github.ref == 'refs/heads/main'";
const GREEN_PUSH_TO_MAIN_UNLESS_CANCELLED = `!cancelled() && ${GREEN_PUSH_TO_MAIN}`;

const YAML_LIST = (modules: readonly string[]) => `[${modules.map((m) => `"${m}"`).join(", ")}]`;

/** The fleet-ci `modules` input: the selection as a JSON array in MODULES order. */
export function orderedModulesJson(selection: Selection): string {
  return YAML_LIST(MODULES.filter((m) => selection.modules.has(m)));
}

/** The fleet-ci `codeql-languages` input: shared languages appear once. */
export function codeqlLanguages(selection: Selection): string {
  if (!ENABLE_CODEQL.holds(selection)) return "[]";
  const langs: string[] = [];
  if (anyOf("bun", "node", "deno").holds(selection)) langs.push("javascript-typescript");
  if (selection.modules.has("uv")) langs.push("python");
  return YAML_LIST(langs);
}

/** The tracking-labels input: the selected streams' default labels, in
 * module order; empty when no stream module is selected. */
export function streamLabels(selection: Selection): string {
  const streams: [Module, string][] = [
    ["docs-site", "docs-link-rot"],
    ["fuzzer", "fuzz-nightly"],
    ["nightly", "nightly-failure"],
  ];
  return streams
    .filter(([m]) => selection.modules.has(m))
    .map(([, label]) => label)
    .join(",");
}

/** The matrix row's env as a Selection. MODULES is the YAML list string
 * ci.yml passes; EXTRA_DATA may carry `-d skills_dir=<dir>`. */
export function selectionFromEnv(modules: string, isPrivate: string, extraData: string): Selection {
  const parsed: unknown = parseYaml(modules);
  if (!Array.isArray(parsed)) throw new Error(`MODULES must be a YAML list, got ${modules}`);
  const known = new Set<string>(MODULES);
  const selected = new Set<Module>();
  for (const entry of parsed) {
    const name = String(entry);
    if (!known.has(name)) throw new Error(`MODULES names an unknown module '${name}'`);
    selected.add(name as Module);
  }
  if (isPrivate !== "true" && isPrivate !== "false") {
    throw new Error(`PRIVATE must be 'true' or 'false', got '${isPrivate}'`);
  }
  // copier keeps the last -d occurrence.
  const skillsDir = [...extraData.matchAll(/(?:^|\s)skills_dir=(\S+)/g)].at(-1)?.[1] ?? "skills";
  return { modules: selected, isPrivate: isPrivate === "true", skillsDir };
}

function pinnedBySync(dotfile: string): string {
  return `- \`${dotfile}\` is managed by sync; pin another version in a repo-owned workflow's version input, not in the dotfile.`;
}

const TOOLCHAIN_BULLETS: { module: Module; bullet: string; lacks: string[]; dotfile?: string }[] = [
  {
    module: "bun",
    bullet: "- bun: `bun install`, `bun test`, `bun run <script>` (scripts in `package.json`)",
    lacks: ["`bun install`", ".bun-version"],
    dotfile: ".bun-version",
  },
  {
    module: "node",
    bullet:
      "- Node.js with npm: `npm install`, `npm test`, `npm run <script>` (scripts in `package.json`)",
    lacks: ["`npm install`", ".node-version"],
    dotfile: ".node-version",
  },
  {
    module: "deno",
    bullet:
      "- Deno: `deno install`, `deno test`, `deno task <task>` (tasks, imports, and lint/format settings in `deno.json`)",
    lacks: ["`deno install`", ".dvmrc"],
    dotfile: ".dvmrc",
  },
  {
    module: "uv",
    bullet:
      "- Python with uv: `uv sync`, `uv run <command>` (metadata and dependencies in `pyproject.toml`)",
    lacks: ["`uv sync`"],
  },
  {
    module: "rust",
    bullet:
      "- Rust with cargo: `cargo build`, `cargo test`, `cargo clippy` (crate layout and dependencies in `Cargo.toml`)",
    lacks: ["`cargo build`"],
  },
];

const DEPENDABOT_ECOSYSTEMS: [Module, string][] = [
  ["bun", "bun"],
  ["node", "npm"],
  ["deno", "deno"],
  ["uv", "uv"],
  ["rust", "cargo"],
];

const VERSION_LINE = /^[0-9]+\.[0-9]+\.[0-9]+$/;

// The checks.yml example comments and the auto-format formatter steps
// splice from the toolchain fragments; markers are command-specific (a bare
// "biome" would false-positive between the bun and node steps), and the
// deno markers pin the exact rendered line (the prose-wrap sweep covers
// every other spelling).
const TOOLCHAIN_STARTERS: {
  module: Module;
  example: string;
  checksLine?: string[];
  checksLacks: string[];
  formatter: string;
  formatterLine?: string[];
  setup: string;
}[] = [
  {
    module: "bun",
    example: "Example bun checks",
    checksLacks: ["Example bun checks"],
    formatter: "bun x @biomejs/biome",
    setup: "oven-sh/setup-bun",
  },
  {
    module: "node",
    example: "Example node checks",
    checksLacks: ["Example node checks"],
    formatter: "npx --yes @biomejs/biome",
    setup: "actions/setup-node",
  },
  {
    module: "deno",
    example: "Example deno checks",
    checksLine: ["      # - run: deno fmt --check --prose-wrap preserve"],
    checksLacks: ["Example deno checks", "deno fmt"],
    formatter: "deno fmt",
    formatterLine: ["          deno fmt --prose-wrap preserve"],
    setup: "denoland/setup-deno",
  },
  {
    module: "uv",
    example: "Example uv checks",
    checksLacks: ["Example uv checks"],
    formatter: "ruff",
    setup: "astral-sh/setup-uv",
  },
];

/** Every rendered-tree expectation, grouped by concern. A row applies when
 * its condition holds for the selection; rows for a module's absent leg
 * carry the negated condition so both legs are conditioned on it. */
export const EXPECTATIONS: Row[] = [
  {
    // The rendered ci.yml is a thin caller of fleet-ci.yml at the
    // green-gated @build ref: module membership in the gate IS the modules
    // input, the caller job's permission ceiling is unconditional (GitHub
    // validates skipped called jobs' grants too), and none of the merged
    // base checks or the old aggregate's status-function gate may render.
    name: "ci.yml calls fleet-ci at @build with the selection and the full permission ceiling",
    when: ALWAYS,
    checks: (s) => [
      { kind: "exists", path: CI },
      { kind: "exists", path: `${WF}/checks.yml` },
      {
        kind: "yaml-matches",
        path: CI,
        at: ["jobs", "ci", "uses"],
        matches: includes("repo-platform/.github/workflows/fleet-ci.yml@build"),
      },
      {
        kind: "yaml-equals",
        path: CI,
        at: ["jobs", "checks", "uses"],
        equals: "./.github/workflows/checks.yml",
      },
      {
        kind: "yaml-equals",
        path: CI,
        at: ["jobs", "ci", "with", "modules"],
        equals: orderedModulesJson(s),
      },
      { kind: "yaml-equals", path: CI, at: ["jobs", "ci", "with", "private"], equals: s.isPrivate },
      { kind: "yaml-equals", path: CI, at: ["permissions"], equals: { contents: "read" } },
      {
        kind: "yaml-equals",
        path: CI,
        at: ["jobs", "ci", "permissions"],
        equals: {
          contents: "read",
          "pull-requests": "write",
          "security-events": "write",
          actions: "read",
          issues: "read",
          "vulnerability-alerts": "read",
        },
      },
      { kind: "outside-jobs", path: CI, jobs: ["pages", "docs-site"], lacks: ["cancelled()"] },
      { kind: "text", path: CI, lacks: ["base-checks", "check-typography"] },
    ],
  },
  {
    // The gate needs BOTH caller jobs, runs on always() so a failed caller
    // fails it rather than skipping it, and judges through the shared
    // action; the retired verdict wrapper must not render.
    name: "the all-green gate needs both callers, runs always, judges through the action",
    when: ALWAYS,
    checks: () => [
      {
        kind: "yaml-equals",
        path: CI,
        at: ["jobs", "all-green", "needs"],
        equals: ["checks", "ci"],
      },
      { kind: "yaml-equals", path: CI, at: ["jobs", "all-green", "if"], equals: "always()" },
      {
        kind: "yaml-matches",
        path: CI,
        at: ["jobs", "all-green", "steps"],
        matches: [
          {
            uses: includes("repo-platform/actions/all-green@build"),
            with: { needs: "${{ toJSON(needs) }}" },
          },
        ],
      },
      { kind: "missing", path: `${WF}/all-green.yml` },
      { kind: "text", path: CI, lacks: ["reusable-all-green"] },
    ],
  },
  {
    // The repo-owned hook runs downstream of the gate on a push to main
    // with the judged sha and no lane of its own.
    name: "the post-green hook is called downstream of the gate with the judged sha",
    when: ALWAYS,
    checks: () => [
      { kind: "exists", path: `${WF}/post-green.yml` },
      { kind: "yaml-equals", path: CI, at: ["jobs", "post-green", "needs"], equals: ["all-green"] },
      {
        kind: "yaml-equals",
        path: CI,
        at: ["jobs", "post-green", "if"],
        equals: GREEN_PUSH_TO_MAIN,
      },
      {
        kind: "yaml-equals",
        path: CI,
        at: ["jobs", "post-green", "uses"],
        equals: "./.github/workflows/post-green.yml",
      },
      {
        kind: "yaml-equals",
        path: CI,
        at: ["jobs", "post-green", "with", "sha"],
        equals: "${{ github.sha }}",
      },
      {
        kind: "yaml-defined",
        path: `${WF}/post-green.yml`,
        at: ["on", "workflow_call", "inputs", "sha"],
      },
      { kind: "text", path: `${WF}/post-green.yml`, has: ["Repo-owned: generated once"] },
    ],
  },
  {
    // pr-title is its own natively-required workflow; the modules input
    // still records the selection.
    name: "pr-title renders its required workflow on every title-changing event",
    when: has("pr-title"),
    checks: () => [
      { kind: "exists", path: `${WF}/pr-title.yml` },
      {
        kind: "yaml-equals",
        path: `${WF}/pr-title.yml`,
        at: ["on", "pull_request", "types"],
        equals: ["opened", "edited", "reopened", "synchronize"],
      },
      { kind: "yaml-defined", path: `${WF}/pr-title.yml`, at: ["jobs", "pr-title"] },
      { kind: "text", path: CI, has: ['"pr-title"'] },
    ],
  },
  {
    name: "no pr-title workflow or membership without the module",
    when: not(has("pr-title")),
    checks: () => [
      { kind: "missing", path: `${WF}/pr-title.yml` },
      { kind: "text", path: CI, lacks: ['"pr-title"'] },
    ],
  },
  {
    // Copilot reviews are advisory (nothing gates on them), and the gate
    // waits by failing, never by sleeping on a billed runner.
    name: "nothing Copilot-shaped and no sleep renders into CI",
    when: ALWAYS,
    checks: () => [
      { kind: "text", path: CI, lacks: ["copilot-review", "copilot-rearm", "sleep "] },
      { kind: "missing", path: `${WF}/rerun-copilot-gate.yml` },
    ],
  },
  {
    name: "issue-templates lands the chooser config",
    when: has("issue-templates"),
    checks: () => [{ kind: "exists", path: ".github/ISSUE_TEMPLATE/config.yml" }],
  },
  {
    name: "no issue templates without the module",
    when: not(has("issue-templates")),
    checks: () => [{ kind: "missing", path: ".github/ISSUE_TEMPLATE" }],
  },
  {
    // The deploy pipeline: called by ci.yml's pages leg with the judged
    // commit (never push: a push deploy would bypass the gate), plus the
    // nightly rebuild and dispatch, never pull_request; a called run keys
    // its lane per run and the caller grants the called ceiling.
    name: "pages renders the deploy workflow and ci.yml's pages leg under the pages lane",
    when: has("pages"),
    checks: () => [
      { kind: "exists", path: `${WF}/pages.yml` },
      {
        kind: "yaml-defined",
        path: `${WF}/pages.yml`,
        at: ["on", "workflow_call", "inputs", "sha"],
      },
      {
        kind: "yaml-equals",
        path: `${WF}/pages.yml`,
        at: ["jobs", "deploy", "with", "sha"],
        equals: "${{ inputs.sha }}",
      },
      {
        kind: "yaml-matches",
        path: `${WF}/pages.yml`,
        at: ["concurrency", "group"],
        matches: includes("pages-called-"),
      },
      { kind: "yaml-absent", path: `${WF}/pages.yml`, at: ["on", "push"] },
      {
        kind: "yaml-equals",
        path: `${WF}/pages.yml`,
        at: ["on", "schedule"],
        equals: [{ cron: "23 4 * * *" }],
      },
      { kind: "yaml-defined", path: `${WF}/pages.yml`, at: ["on", "workflow_dispatch"] },
      {
        kind: "yaml-equals",
        path: `${WF}/pages.yml`,
        at: ["jobs", "deploy", "permissions", "issues"],
        equals: "write",
      },
      { kind: "text", path: `${WF}/pages.yml`, lacks: ["pull_request"] },
      {
        kind: "yaml-equals",
        path: CI,
        at: ["jobs", "pages", "uses"],
        equals: "./.github/workflows/pages.yml",
      },
      {
        kind: "yaml-equals",
        path: CI,
        at: ["jobs", "pages", "concurrency", "group"],
        equals: "pages",
      },
    ],
  },
  {
    // Ordered behind the release leg: the needs edge plus !cancelled(), so
    // a red or skipped release still deploys.
    name: "the pages leg is ordered behind the release leg",
    when: and(has("pages"), has("release-please")),
    checks: () => [
      {
        kind: "yaml-equals",
        path: CI,
        at: ["jobs", "pages", "needs"],
        equals: ["all-green", "release"],
      },
      {
        kind: "yaml-equals",
        path: CI,
        at: ["jobs", "pages", "if"],
        equals: GREEN_PUSH_TO_MAIN_UNLESS_CANCELLED,
      },
    ],
  },
  {
    name: "the pages leg needs only the gate without release-please",
    when: and(has("pages"), not(has("release-please"))),
    checks: () => [
      { kind: "yaml-equals", path: CI, at: ["jobs", "pages", "needs"], equals: ["all-green"] },
      { kind: "yaml-equals", path: CI, at: ["jobs", "pages", "if"], equals: GREEN_PUSH_TO_MAIN },
      { kind: "yaml-text", path: CI, at: ["jobs", "pages"], lacks: ["cancelled()", "release"] },
    ],
  },
  {
    name: "no pages workflow or leg without the module",
    when: not(has("pages")),
    checks: () => [
      { kind: "missing", path: `${WF}/pages.yml` },
      { kind: "yaml-absent", path: CI, at: ["jobs", "pages"] },
      { kind: "text", path: CI, lacks: ["workflows/pages.yml"] },
    ],
  },
  {
    // The managed docs workflow always carries the strict PR check job.
    name: "docs-site renders the strict PR check job",
    when: has("docs-site"),
    checks: () => [
      { kind: "exists", path: `${WF}/docs-site.yml` },
      {
        kind: "yaml-matches",
        path: `${WF}/docs-site.yml`,
        at: ["jobs", "check", "steps"],
        matches: [{ uses: includes("actions/pages-site@build"), with: { check: "true" } }],
      },
    ],
  },
  {
    // Composed with pages, the docs ride pages.yml as the versioned
    // vitepress mount and the website mount turns unversioned; docs-site.yml
    // renders down to the check job with no deploy call at any ref.
    name: "docs-site composed with pages rides pages.yml as the docs mount",
    when: and(has("docs-site"), has("pages")),
    checks: () => [
      {
        kind: "text",
        path: `${WF}/docs-site.yml`,
        lacks: ["reusable-pages.yml@", "schedule:", "workflow_call"],
      },
      { kind: "yaml-absent", path: CI, at: ["jobs", "docs-site"] },
      { kind: "text", path: CI, lacks: ["workflows/docs-site.yml"] },
      {
        kind: "yaml-json",
        path: `${WF}/pages.yml`,
        at: ["jobs", "deploy", "with", "mounts"],
        equals: [
          { path: "/", source: "command", versioned: false },
          { path: "/docs/", source: "vitepress", versioned: true },
        ],
      },
      {
        kind: "yaml-equals",
        path: `${WF}/pages.yml`,
        at: ["jobs", "deploy", "with", "link_rot_label"],
        equals: "docs-link-rot",
      },
    ],
  },
  {
    // Standalone: docs-site.yml carries the deploy (workflow_call from
    // ci.yml's leg with the judged commit, nightly, dispatch, never push)
    // and ci.yml's docs-site leg runs under the pages lane behind the hook.
    name: "docs-site alone carries the deploy and ci.yml's docs-site leg",
    when: and(has("docs-site"), not(has("pages"))),
    checks: () => [
      {
        kind: "yaml-matches",
        path: `${WF}/docs-site.yml`,
        at: ["jobs", "deploy", "uses"],
        matches: includes("reusable-pages.yml@build"),
      },
      {
        kind: "yaml-json",
        path: `${WF}/docs-site.yml`,
        at: ["jobs", "deploy", "with", "mounts"],
        equals: [{ path: "/", source: "vitepress", versioned: true }],
      },
      {
        kind: "yaml-equals",
        path: `${WF}/docs-site.yml`,
        at: ["jobs", "deploy", "with", "link_rot_label"],
        equals: "docs-link-rot",
      },
      {
        kind: "yaml-equals",
        path: `${WF}/docs-site.yml`,
        at: ["on", "schedule"],
        equals: [{ cron: "41 4 * * *" }],
      },
      {
        kind: "yaml-equals",
        path: `${WF}/docs-site.yml`,
        at: ["jobs", "deploy", "permissions", "issues"],
        equals: "write",
      },
      {
        kind: "yaml-defined",
        path: `${WF}/docs-site.yml`,
        at: ["on", "workflow_call", "inputs", "sha"],
      },
      {
        kind: "yaml-equals",
        path: `${WF}/docs-site.yml`,
        at: ["jobs", "deploy", "with", "sha"],
        equals: "${{ inputs.sha }}",
      },
      {
        kind: "yaml-matches",
        path: `${WF}/docs-site.yml`,
        at: ["jobs", "deploy", "concurrency", "group"],
        matches: includes("pages-called-"),
      },
      { kind: "yaml-absent", path: `${WF}/docs-site.yml`, at: ["on", "push"] },
      {
        kind: "yaml-equals",
        path: CI,
        at: ["jobs", "docs-site", "uses"],
        equals: "./.github/workflows/docs-site.yml",
      },
      {
        kind: "yaml-equals",
        path: CI,
        at: ["jobs", "docs-site", "concurrency", "group"],
        equals: "pages",
      },
      {
        kind: "yaml-equals",
        path: CI,
        at: ["jobs", "docs-site", "if"],
        equals: GREEN_PUSH_TO_MAIN_UNLESS_CANCELLED,
      },
    ],
  },
  {
    name: "the docs-site leg is ordered behind the hook and the release leg",
    when: and(has("docs-site"), not(has("pages")), has("release-please")),
    checks: () => [
      {
        kind: "yaml-equals",
        path: CI,
        at: ["jobs", "docs-site", "needs"],
        equals: ["all-green", "post-green", "release"],
      },
    ],
  },
  {
    name: "the docs-site leg is ordered behind the hook alone without release-please",
    when: and(has("docs-site"), not(has("pages")), not(has("release-please"))),
    checks: () => [
      {
        kind: "yaml-equals",
        path: CI,
        at: ["jobs", "docs-site", "needs"],
        equals: ["all-green", "post-green"],
      },
      { kind: "yaml-text", path: CI, at: ["jobs", "docs-site"], lacks: ["release"] },
    ],
  },
  {
    name: "no docs-site workflow or leg without the module",
    when: not(has("docs-site")),
    checks: () => [
      { kind: "missing", path: `${WF}/docs-site.yml` },
      { kind: "yaml-absent", path: CI, at: ["jobs", "docs-site"] },
    ],
  },
  {
    name: "pages without docs-site mounts the versioned website alone",
    when: and(has("pages"), not(has("docs-site"))),
    checks: () => [
      { kind: "text", path: `${WF}/pages.yml`, lacks: ["vitepress", "link_rot_label"] },
      {
        kind: "yaml-json",
        path: `${WF}/pages.yml`,
        at: ["jobs", "deploy", "with", "mounts"],
        equals: [{ path: "/", source: "command", versioned: true }],
      },
    ],
  },
  {
    // The repo-owned nightly-fuzz starter: the fuzz-issue action in both
    // modes, the dispatch replay inputs, and the auto-assign dispatch.
    name: "fuzzer renders the nightly-fuzz starter with both fuzz-issue modes",
    when: has("fuzzer"),
    checks: () => [
      { kind: "exists", path: `${WF}/nightly-fuzz.yml` },
      {
        kind: "yaml-matches",
        path: `${WF}/nightly-fuzz.yml`,
        at: ["jobs", "fuzz", "steps"],
        matches: [
          { uses: includes("actions/fuzz-issue@build"), with: { mode: "report" } },
          { uses: includes("actions/fuzz-issue@build"), with: { mode: "resolve" } },
          { run: includes("auto-assign.yml") },
        ],
      },
      { kind: "yaml-defined", path: `${WF}/nightly-fuzz.yml`, at: ["on", "workflow_dispatch"] },
      {
        kind: "yaml-equals",
        path: `${WF}/nightly-fuzz.yml`,
        at: ["permissions", "actions"],
        equals: "write",
      },
    ],
  },
  {
    name: "no nightly-fuzz starter without the fuzzer module",
    when: not(has("fuzzer")),
    checks: () => [{ kind: "missing", path: `${WF}/nightly-fuzz.yml` }],
  },
  {
    // The plain-CI nightly starter: both fuzz-issue modes on the generic
    // stream with NO artifacts contract, a cancelled checks job (a timeout)
    // treated as red, and the auto-assign dispatch.
    name: "nightly renders the generic-stream starter that treats a cancelled checks job as red",
    when: has("nightly"),
    checks: () => [
      { kind: "exists", path: `${WF}/nightly.yml` },
      {
        kind: "yaml-matches",
        path: `${WF}/nightly.yml`,
        at: ["jobs", "report", "steps"],
        matches: [
          {
            uses: includes("actions/fuzz-issue@build"),
            with: { mode: "report" },
            if: "needs.checks.result == 'failure' || needs.checks.result == 'cancelled'",
          },
          {
            uses: includes("actions/fuzz-issue@build"),
            with: { mode: "resolve", stream: "generic" },
          },
          { run: includes("auto-assign.yml") },
        ],
      },
      { kind: "yaml-defined", path: `${WF}/nightly.yml`, at: ["on", "workflow_dispatch"] },
      { kind: "text", path: `${WF}/nightly.yml`, lacks: ["artifacts-dir"] },
      {
        kind: "yaml-equals",
        path: `${WF}/nightly.yml`,
        at: ["jobs", "report", "permissions", "actions"],
        equals: "write",
      },
    ],
  },
  {
    name: "no nightly starter without the module",
    when: not(has("nightly")),
    checks: () => [{ kind: "missing", path: `${WF}/nightly.yml` }],
  },
  {
    // The repo-owned plugin manifests (real JSON, an empty seeded
    // catalog), the gating structure job's membership and dir input in
    // ci.yml, and the standalone advisory discovery workflow.
    name: "skills renders the plugin manifests, the skills-dir input, and the discovery workflow",
    when: has("skills"),
    checks: (s) => [
      { kind: "json", path: ".claude-plugin/plugin.json" },
      { kind: "json", path: ".claude-plugin/marketplace.json" },
      { kind: "yaml-equals", path: ".claude-plugin/plugin.json", at: ["skills"], equals: [] },
      { kind: "text", path: CI, has: ['"skills"'] },
      {
        kind: "yaml-equals",
        path: CI,
        at: ["jobs", "ci", "with", "skills-dir"],
        equals: s.skillsDir,
      },
      { kind: "exists", path: `${WF}/validate-skills.yml` },
      {
        kind: "yaml-matches",
        path: `${WF}/validate-skills.yml`,
        at: ["jobs", "discovery", "steps"],
        matches: [
          {
            uses: includes("actions/validate-skills@build"),
            with: { "skills-dir": s.skillsDir, mode: "discovery" },
          },
        ],
      },
      {
        kind: "yaml-equals",
        path: `${WF}/validate-skills.yml`,
        at: ["on", "pull_request", "paths"],
        equals: [`${s.skillsDir}/**`, ".claude-plugin/**", ".github/workflows/validate-skills.yml"],
      },
    ],
  },
  {
    name: "no plugin manifests, skills input, or discovery workflow without the module",
    when: not(has("skills")),
    checks: () => [
      { kind: "missing", path: ".claude-plugin" },
      { kind: "missing", path: `${WF}/validate-skills.yml` },
      { kind: "text", path: CI, lacks: ["skills-dir:", '"skills"'] },
    ],
  },
  {
    // The repo-owned identity starter: the four identity keys and nothing
    // else (homepage and topics declared even when empty, visibility even
    // when public); the centrally assembled baseline never renders into
    // it, and the retired mergeable marker never returns.
    name: "settings.yml is the identity starter and no apply workflow renders",
    when: ALWAYS,
    checks: (s) => [
      { kind: "missing", path: `${WF}/settings-sync.yml` },
      { kind: "yaml-keys", path: ".github/settings.yml", at: [], equals: ["repository"] },
      {
        kind: "yaml-equals",
        path: ".github/settings.yml",
        at: ["repository"],
        equals: {
          description: "Smoke-test project",
          homepage: "",
          topics: "",
          private: s.isPrivate,
        },
      },
      {
        kind: "text",
        path: ".github/settings.yml",
        lacks: ["type: code_scanning", "security_and_analysis:", "repo-platform:mergeable"],
        lacksLine: ["labels:", "rulesets:"],
      },
    ],
  },
  {
    // The issues/PR call grants only its scopes and the workflow level
    // grants nothing, so a scope moving back up fails here.
    name: "auto-assign renders with no workflow-level grants",
    when: ALWAYS,
    checks: () => [
      { kind: "text", path: `${WF}/auto-assign.yml`, lacks: ["code_scanning:"] },
      {
        kind: "yaml-matches",
        path: `${WF}/auto-assign.yml`,
        at: ["jobs", "auto-assign", "uses"],
        matches: includes("reusable-auto-assign.yml"),
      },
      { kind: "yaml-equals", path: `${WF}/auto-assign.yml`, at: ["permissions"], equals: {} },
    ],
  },
  {
    // Alert assignment watches CI completions (the CodeQL jobs run inside
    // CI's gate); only the alerts caller job may carry security-events.
    name: "auto-assign carries the alerts call exactly once under enable_codeql",
    when: ENABLE_CODEQL,
    checks: () => [
      {
        kind: "yaml-equals",
        path: `${WF}/auto-assign.yml`,
        at: ["on", "workflow_run", "workflows"],
        equals: ["CI"],
      },
      {
        kind: "yaml-matches",
        path: `${WF}/auto-assign.yml`,
        at: ["jobs", "assign-alerts", "uses"],
        matches: includes("reusable-auto-assign-alerts.yml"),
      },
      {
        kind: "count",
        path: `${WF}/auto-assign.yml`,
        substring: "security-events: write",
        expected: 1,
      },
    ],
  },
  {
    name: "auto-assign carries no alerts call without enable_codeql",
    when: not(ENABLE_CODEQL),
    checks: () => [
      {
        kind: "text",
        path: `${WF}/auto-assign.yml`,
        lacks: ["workflow_run:", "reusable-auto-assign-alerts.yml", "security-events: write"],
      },
    ],
  },
  {
    // The analysis jobs live in fleet-ci; the render carries the exact
    // languages input (shared languages once) and the weekly re-scan.
    name: "CodeQL gates ci.yml with the languages input and the weekly schedule",
    when: ENABLE_CODEQL,
    checks: (s) => [
      { kind: "missing", path: `${WF}/codeql.yml` },
      {
        kind: "yaml-equals",
        path: CI,
        at: ["jobs", "ci", "with", "codeql-languages"],
        equals: codeqlLanguages(s),
      },
      { kind: "yaml-equals", path: CI, at: ["on", "schedule"], equals: [{ cron: "3 8 * * 1" }] },
    ],
  },
  {
    name: "no CodeQL languages or schedule without enable_codeql",
    when: not(ENABLE_CODEQL),
    checks: () => [
      { kind: "missing", path: `${WF}/codeql.yml` },
      {
        kind: "yaml-equals",
        path: CI,
        at: ["jobs", "ci", "with", "codeql-languages"],
        equals: "[]",
      },
      { kind: "text", path: CI, lacks: ["schedule:"] },
    ],
  },
  {
    name: "custom-license opts out of the fleet LICENSE",
    when: has("custom-license"),
    checks: () => [{ kind: "missing", path: "LICENSE.md" }],
  },
  {
    name: "the fleet LICENSE ships without custom-license",
    when: not(has("custom-license")),
    checks: () => [{ kind: "exists", path: "LICENSE.md" }],
  },
  {
    // SECURITY.md is visibility-independent; the contributor-facing files
    // are public-only.
    name: "the security policy renders under .github for every visibility",
    when: ALWAYS,
    checks: () => [
      { kind: "exists", path: ".github/SECURITY.md" },
      { kind: "missing", path: "SECURITY.md" },
      { kind: "missing", path: "CODE_OF_CONDUCT.md" },
    ],
  },
  {
    name: "the contributor-facing community files render on a public repo",
    when: PUBLIC,
    checks: () => [
      { kind: "exists", path: "CONTRIBUTING.md" },
      { kind: "exists", path: ".github/CODE_OF_CONDUCT.md" },
    ],
  },
  {
    name: "no contributor-facing community files render on a private repo",
    when: PRIVATE,
    checks: () => [
      { kind: "missing", path: "CONTRIBUTING.md" },
      { kind: "missing", path: ".github/CODE_OF_CONDUCT.md" },
    ],
  },
  {
    // bun, node, and deno share upstream Node.gitignore: the section
    // renders exactly once under any co-selection (each later module's
    // fragment suppresses its copy when an earlier declarer is selected).
    name: "the shared Node gitignore section renders exactly once",
    when: anyOf("bun", "node", "deno"),
    checks: () => [
      {
        kind: "count",
        path: ".gitignore",
        line: "## Node (github/gitignore Node.gitignore)",
        expected: 1,
      },
    ],
  },
  {
    name: "no Node gitignore section without a Node-based toolchain",
    when: not(anyOf("bun", "node", "deno")),
    checks: () => [{ kind: "text", path: ".gitignore", lacks: ["## Node "] }],
  },
  {
    name: "deno lands its gitignore section",
    when: has("deno"),
    checks: () => [
      { kind: "text", path: ".gitignore", hasLine: ["## Deno (github/gitignore Deno.gitignore)"] },
    ],
  },
  {
    name: "no Deno gitignore section without the module",
    when: not(has("deno")),
    checks: () => [{ kind: "text", path: ".gitignore", lacks: ["## Deno "] }],
  },
  {
    name: "uv lands the Python gitignore section",
    when: has("uv"),
    checks: () => [{ kind: "text", path: ".gitignore", has: ["## Python "] }],
  },
  {
    name: "no Python gitignore section without uv",
    when: not(has("uv")),
    checks: () => [{ kind: "text", path: ".gitignore", lacks: ["## Python "] }],
  },
  {
    name: "rust lands the Rust gitignore section",
    when: has("rust"),
    checks: () => [{ kind: "text", path: ".gitignore", has: ["## Rust "] }],
  },
  {
    name: "no Rust gitignore section without the module",
    when: not(has("rust")),
    checks: () => [{ kind: "text", path: ".gitignore", lacks: ["## Rust "] }],
  },
  {
    // Ecosystems follow the toolchain modules in module order, each with a
    // Conventional Commits prefix: ci for the base github-actions entry,
    // build for every package manifest.
    name: "dependabot lists the github-actions entry plus exactly the selected ecosystems",
    when: ALWAYS,
    checks: (s) => [
      {
        kind: "text",
        path: ".github/dependabot.yml",
        has: ['package-ecosystem: "github-actions"', 'prefix: "ci"'],
        lacks: [
          ...DEPENDABOT_ECOSYSTEMS.filter(([m]) => !s.modules.has(m)).map(
            ([, eco]) => `package-ecosystem: "${eco}"`,
          ),
          ...(ANY_TOOLCHAIN.holds(s) ? [] : ['prefix: "build"']),
        ],
      },
      {
        kind: "yaml-pluck",
        path: ".github/dependabot.yml",
        at: ["updates"],
        pluck: [["package-ecosystem"], ["commit-message", "prefix"]],
        equals: [
          ["github-actions", "ci"],
          ...DEPENDABOT_ECOSYSTEMS.filter(([m]) => s.modules.has(m)).map(([, eco]) => [
            eco,
            "build",
          ]),
        ],
      },
    ],
  },
  {
    // The symlinks prove copier preserves links; the merge policy, the
    // gate bullet, and the settings bullet are managed for every render.
    name: "AGENTS.md and its three symlinks carry the managed conventions",
    when: ALWAYS,
    checks: () => [
      { kind: "exists", path: "AGENTS.md" },
      { kind: "symlink", path: "CLAUDE.md", target: "AGENTS.md" },
      { kind: "symlink", path: ".github/copilot-instructions.md", target: "../AGENTS.md" },
      { kind: "symlink", path: ".github/agents.md", target: "../AGENTS.md" },
      {
        kind: "text",
        path: "AGENTS.md",
        has: ["PRs are squash-merged, so the PR title becomes the commit subject."],
        hasLine: [
          "- CI gates on the `all-green` check, required by the managed ruleset. Under `.github/workflows/`, this repository's test and lint jobs go in `checks.yml`, its green-gated work on main in `post-green.yml` (both repo-owned); `ci.yml` is managed.",
          "- Repository settings are applied from Vivswan/repo-platform's layers plus this repository's own `.github/settings.yml`. Edit that file, never the GitHub UI; the merge rules are in repo-platform's docs/settings.md.",
        ],
      },
    ],
  },
  {
    name: "AGENTS.md carries a Toolchain section with a toolchain module",
    when: ANY_TOOLCHAIN,
    checks: () => [{ kind: "text", path: "AGENTS.md", has: ["## Toolchain"] }],
  },
  {
    name: "AGENTS.md carries no Toolchain section without a toolchain module",
    when: not(ANY_TOOLCHAIN),
    checks: () => [{ kind: "text", path: "AGENTS.md", lacks: ["## Toolchain"] }],
  },
  ...TOOLCHAIN_BULLETS.flatMap(({ module, bullet, lacks, dotfile }): Row[] => [
    {
      // The pinned-toolchain modules also emit their dotfile line: the
      // dotfile carries no header, so this is where an agent learns it is
      // managed.
      name: `AGENTS.md carries the ${module} toolchain bullet${dotfile ? " and its dotfile line" : ""}`,
      when: has(module),
      checks: () => [
        {
          kind: "text",
          path: "AGENTS.md",
          hasLine: dotfile ? [bullet, pinnedBySync(dotfile)] : [bullet],
        },
      ],
    },
    {
      name: `AGENTS.md carries no ${module} toolchain mention without the module`,
      when: not(has(module)),
      checks: () => [{ kind: "text", path: "AGENTS.md", lacks }],
    },
  ]),
  {
    // The tracking-labels input feeds fleet-ci's release-health job; the
    // exact quoted list (selected streams in module order) is pinned. The
    // legacy fuzz-label spelling must never render.
    name: "ci.yml passes the selected streams' tracking labels",
    when: anyOf("docs-site", "fuzzer", "nightly"),
    checks: (s) => [
      {
        kind: "yaml-equals",
        path: CI,
        at: ["jobs", "ci", "with", "tracking-labels"],
        equals: streamLabels(s),
      },
      { kind: "text", path: CI, lacks: ["fuzz-label:"] },
    ],
  },
  {
    name: "ci.yml passes no tracking labels without a stream module",
    when: not(anyOf("docs-site", "fuzzer", "nightly")),
    checks: () => [{ kind: "text", path: CI, lacks: ["tracking-labels:", "fuzz-label:"] }],
  },
  {
    // The release leg splices downstream of the gate AND the hook,
    // released only by a green push to main with the judged commit; the
    // managed release.yml carries the head gate, the release-health
    // pre-flight, and the three-stage draft flow with the repo-owned hooks.
    name: "release-please renders the release leg and the managed three-stage release.yml",
    when: has("release-please"),
    checks: (s) => [
      { kind: "exists", path: `${WF}/release.yml` },
      { kind: "exists", path: `${WF}/update-release.yml` },
      { kind: "exists", path: `${WF}/update-release-pr.yml` },
      { kind: "exists", path: "release-please-config.json" },
      { kind: "exists", path: ".release-please-manifest.json" },
      {
        kind: "yaml-equals",
        path: CI,
        at: ["jobs", "release", "uses"],
        equals: "./.github/workflows/release.yml",
      },
      {
        kind: "yaml-equals",
        path: CI,
        at: ["jobs", "release", "needs"],
        equals: ["all-green", "post-green"],
      },
      {
        kind: "yaml-equals",
        path: CI,
        at: ["jobs", "release", "if"],
        equals:
          "needs.all-green.result == 'success' && needs.post-green.result == 'success' && github.event_name == 'push' && github.ref == 'refs/heads/main'",
      },
      {
        kind: "yaml-equals",
        path: CI,
        at: ["jobs", "release", "with", "sha"],
        equals: "${{ github.sha }}",
      },
      { kind: "text", path: CI, has: ['"release-please"'], lacks: ["info-release"] },
      {
        kind: "yaml-matches",
        path: `${WF}/release.yml`,
        at: ["jobs", "release-please", "steps"],
        matches: [
          { env: { JUDGED: "${{ inputs.sha || github.sha }}" } },
          {
            uses: includes("release-health@build"),
            with:
              streamLabels(s) === ""
                ? { mode: "release" }
                : { mode: "release", "tracking-labels": streamLabels(s) },
          },
        ],
      },
      {
        kind: "text",
        path: `${WF}/release.yml`,
        lacks: streamLabels(s) === "" ? ["fuzz-label:", "tracking-labels:"] : ["fuzz-label:"],
      },
      {
        kind: "yaml-equals",
        path: `${WF}/release.yml`,
        at: ["jobs", "update-release", "needs"],
        equals: ["release-please"],
      },
      {
        kind: "yaml-equals",
        path: `${WF}/release.yml`,
        at: ["jobs", "update-release", "uses"],
        equals: "./.github/workflows/update-release.yml",
      },
      {
        kind: "yaml-equals",
        path: `${WF}/release.yml`,
        at: ["jobs", "publish-release", "needs"],
        equals: ["release-please", "update-release"],
      },
      {
        kind: "yaml-matches",
        path: `${WF}/release.yml`,
        at: ["jobs", "publish-release", "permissions"],
        matches: { attestations: "write", "id-token": "write" },
      },
      {
        kind: "yaml-matches",
        path: `${WF}/release.yml`,
        at: ["jobs", "publish-release", "steps"],
        matches: [{ uses: includes("attest-build-provenance") }],
      },
      {
        kind: "yaml-equals",
        path: `${WF}/release.yml`,
        at: ["jobs", "update-release-pr", "uses"],
        equals: "./.github/workflows/update-release-pr.yml",
      },
      {
        kind: "yaml-equals",
        path: `${WF}/release.yml`,
        at: ["jobs", "update-release-pr", "if"],
        equals: "needs.release-please.outputs.prs_created == 'true'",
      },
    ],
  },
  {
    name: "no release workflows, leg, or config without release-please",
    when: not(has("release-please")),
    checks: () => [
      { kind: "missing", path: `${WF}/release.yml` },
      { kind: "missing", path: `${WF}/update-release.yml` },
      { kind: "missing", path: `${WF}/update-release-pr.yml` },
      { kind: "missing", path: "release-please-config.json" },
      { kind: "missing", path: ".release-please-manifest.json" },
      { kind: "yaml-absent", path: CI, at: ["jobs", "release"] },
      {
        kind: "text",
        path: CI,
        lacks: ["uses: ./.github/workflows/release.yml", '"release-please"'],
      },
    ],
  },
  ...TOOLCHAIN_STARTERS.flatMap((t): Row[] => [
    {
      name: `${t.module} splices its checks example, formatter step, and Copilot setup`,
      when: has(t.module),
      checks: () => [
        { kind: "text", path: `${WF}/checks.yml`, has: [t.example], hasLine: t.checksLine },
        {
          kind: "text",
          path: `${WF}/auto-format.yml`,
          has: t.formatterLine ? [] : [t.formatter],
          hasLine: t.formatterLine,
        },
        { kind: "text", path: `${WF}/copilot-setup-steps.yml`, has: [t.setup] },
      ],
    },
    {
      name: `no ${t.module} checks example or Copilot setup without the module`,
      when: not(has(t.module)),
      checks: () => [
        { kind: "text", path: `${WF}/checks.yml`, lacks: t.checksLacks },
        { kind: "text", path: `${WF}/copilot-setup-steps.yml`, lacks: [t.setup] },
      ],
    },
    {
      name: `no ${t.module} formatter step without the module`,
      when: and(CODEQL_TOOLCHAIN, not(has(t.module))),
      checks: () => [{ kind: "text", path: `${WF}/auto-format.yml`, lacks: [t.formatter] }],
    },
  ]),
  {
    name: "the auto-format starter renders with a CodeQL toolchain",
    when: CODEQL_TOOLCHAIN,
    checks: () => [{ kind: "exists", path: `${WF}/auto-format.yml` }],
  },
  {
    // rust is deliberately outside the auto-format gate.
    name: "no auto-format starter without a CodeQL toolchain",
    when: not(CODEQL_TOOLCHAIN),
    checks: () => [{ kind: "missing", path: `${WF}/auto-format.yml` }],
  },
  {
    // The default hard-wraps markdown prose at 80 columns and documents
    // carry no width limit; a new bare spelling in any fragment fails here.
    name: "no rendered workflow runs a bare deno fmt",
    when: ALWAYS,
    checks: () => [{ kind: "deno-fmt-prose-preserved", dir: WF }],
  },
  {
    // Base content every render carries; the per-repo sync caller is gone
    // (repo-platform's sync-repos workflow pushes template updates).
    name: "base starters render for every selection and no sync caller does",
    when: ALWAYS,
    checks: () => [
      { kind: "exists", path: `${WF}/auto-assign.yml` },
      { kind: "exists", path: `${WF}/copilot-setup-steps.yml` },
      { kind: "exists", path: ".github/settings.yml" },
      { kind: "missing", path: `${WF}/template-sync.yml` },
    ],
  },
  {
    // Managed machinery (always overwritten by sync): the dedupe action
    // regenerates bun.lock on Dependabot PRs and pushes the fix.
    name: "bun renders the Dependabot lockfile fixer and its version pin",
    when: has("bun"),
    checks: () => [
      { kind: "exists", path: `${WF}/dependabot-bun-lockfile.yml` },
      {
        kind: "text",
        path: `${WF}/dependabot-bun-lockfile.yml`,
        has: [
          "/repo-platform/actions/dedupe-bun-lockfile@build",
          "github.actor == 'dependabot[bot]'",
          "REPO_PLATFORM_TOKEN || github.token",
        ],
      },
      { kind: "line-matching", path: ".bun-version", pattern: VERSION_LINE },
    ],
  },
  {
    name: "no lockfile fixer or bun pin without the module",
    when: not(has("bun")),
    checks: () => [
      { kind: "missing", path: `${WF}/dependabot-bun-lockfile.yml` },
      { kind: "missing", path: ".bun-version" },
    ],
  },
  {
    name: "node ships its version pin",
    when: has("node"),
    checks: () => [{ kind: "line-matching", path: ".node-version", pattern: VERSION_LINE }],
  },
  {
    name: "no node pin without the module",
    when: not(has("node")),
    checks: () => [{ kind: "missing", path: ".node-version" }],
  },
  {
    // A weekly advisory re-scan plus an audit of every push that changes
    // deno.lock.
    name: "deno renders the dependency audit and its version pin",
    when: has("deno"),
    checks: () => [
      { kind: "exists", path: `${WF}/deno-audit.yml` },
      {
        kind: "text",
        path: `${WF}/deno-audit.yml`,
        has: ["deno audit --frozen", "deno-version-file: .dvmrc"],
      },
      {
        kind: "yaml-equals",
        path: `${WF}/deno-audit.yml`,
        at: ["on", "push", "paths"],
        equals: ["**/deno.lock"],
      },
      {
        kind: "yaml-equals",
        path: `${WF}/deno-audit.yml`,
        at: ["on", "pull_request", "paths"],
        equals: ["**/deno.lock"],
      },
      {
        kind: "yaml-equals",
        path: `${WF}/deno-audit.yml`,
        at: ["on", "schedule"],
        equals: [{ cron: "37 7 * * 1" }],
      },
      { kind: "line-matching", path: ".dvmrc", pattern: VERSION_LINE },
    ],
  },
  {
    name: "no deno audit or pin without the module",
    when: not(has("deno")),
    checks: () => [
      { kind: "missing", path: `${WF}/deno-audit.yml` },
      { kind: "missing", path: ".dvmrc" },
    ],
  },
];

/** The ownership class the manifest must record per path, or "absent". */
export interface ManifestClassRow {
  readonly when: Condition;
  readonly path: string;
  readonly class: "managed" | "split" | "starter" | "absent";
}

export const MANIFEST_CLASSES: ManifestClassRow[] = [
  { when: ALWAYS, path: ".github/workflows/ci.yml", class: "managed" },
  { when: ALWAYS, path: ".github/workflows/checks.yml", class: "starter" },
  { when: ALWAYS, path: ".github/workflows/post-green.yml", class: "starter" },
  { when: ALWAYS, path: ".repo-platform.yml", class: "starter" },
  { when: ALWAYS, path: ".github/SECURITY.md", class: "split" },
  { when: ALWAYS, path: ".gitignore", class: "split" },
  { when: ALWAYS, path: ".github/repo-platform-manifest.json", class: "managed" },
  { when: ALWAYS, path: "AGENTS.md", class: "split" },
  { when: ALWAYS, path: "CLAUDE.md", class: "managed" },
  { when: ALWAYS, path: ".github/workflows/auto-assign.yml", class: "managed" },
  { when: ALWAYS, path: ".github/workflows/settings-sync.yml", class: "absent" },
  { when: ALWAYS, path: ".github/workflows/copilot-setup-steps.yml", class: "starter" },
  { when: ALWAYS, path: ".github/settings.yml", class: "starter" },
  { when: has("release-please"), path: ".github/workflows/release.yml", class: "managed" },
  { when: has("release-please"), path: "release-please-config.json", class: "starter" },
  { when: not(has("release-please")), path: ".github/workflows/release.yml", class: "absent" },
  { when: not(has("release-please")), path: "release-please-config.json", class: "absent" },
  { when: has("custom-license"), path: "LICENSE.md", class: "absent" },
  { when: not(has("custom-license")), path: "LICENSE.md", class: "split" },
];

/** The settings LAYER LIST the central apply hands github-settings-as-code's
 * merge for this render (settings_layers.ts on the rendered tree), one path
 * per line, plus the tracking-labels scratch layer it writes. The module and
 * visibility gating that used to render into settings.yml lives in the layer
 * selection now; the merge itself is the action's, proven by its own suite
 * and the fleet's check_only runs. */
export const SETTINGS_LAYERS = "settings-layers.txt";
export const TRACKING_LAYER = "settings-layers/tracking-labels.yml";

const label = (name: string) => ({ name });
const STREAMS = anyOf("docs-site", "fuzzer", "nightly");
const moduleLayer = (module: Module) => `templates/${module}/settings.yml`;
const publicOverlay = (module: Module) => `templates/${module}/settings-public.yml`;

export const SETTINGS_LAYER_EXPECTATIONS: Row[] = [
  {
    // Every stack opens on the fleet baseline, carries the rendered
    // starter as its repo layer, and closes on the fleet override.
    name: "the stack carries the baseline, the repo layer, and the override",
    when: ALWAYS,
    checks: () => [
      {
        kind: "text",
        path: SETTINGS_LAYERS,
        hasLine: [".github/settings-baseline.yml", ".github/settings-override.yml"],
        has: ["/.github/settings.yml"],
      },
    ],
  },
  {
    // security_and_analysis and the Copilot review request live in the
    // public overlay; the private one carries the report marker label.
    name: "a public render takes the public fleet overlay",
    when: PUBLIC,
    checks: () => [
      {
        kind: "text",
        path: SETTINGS_LAYERS,
        hasLine: [".github/settings-public.yml"],
        lacksLine: [".github/settings-private.yml"],
      },
    ],
  },
  {
    name: "a private render takes the private fleet overlay and no public module overlay",
    when: PRIVATE,
    checks: () => [
      {
        kind: "text",
        path: SETTINGS_LAYERS,
        hasLine: [".github/settings-private.yml"],
        lacksLine: [".github/settings-public.yml"],
        lacks: ["settings-public.yml"],
      },
    ],
  },
  ...(
    [
      "bun",
      "node",
      "deno",
      "uv",
      "rust",
      "release-please",
      "pages",
      "docs-site",
      "pr-title",
    ] as Module[]
  ).flatMap((module): Row[] => [
    {
      name: `${module} contributes its settings layer`,
      when: has(module),
      checks: () => [{ kind: "text", path: SETTINGS_LAYERS, hasLine: [moduleLayer(module)] }],
    },
    {
      name: `no ${module} settings layer without the module`,
      when: not(has(module)),
      checks: () => [{ kind: "text", path: SETTINGS_LAYERS, lacksLine: [moduleLayer(module)] }],
    },
  ]),
  ...(["bun", "node", "deno", "uv"] as Module[]).flatMap((module): Row[] => [
    {
      // GitHub 422s the code_scanning rule on a private personal repo, so
      // the overlay carrying it joins only under enable_codeql.
      name: `${module}'s code_scanning overlay joins under enable_codeql`,
      when: and(PUBLIC, has(module)),
      checks: () => [{ kind: "text", path: SETTINGS_LAYERS, hasLine: [publicOverlay(module)] }],
    },
    {
      name: `no ${module} code_scanning overlay otherwise`,
      when: not(and(PUBLIC, has(module))),
      checks: () => [{ kind: "text", path: SETTINGS_LAYERS, lacksLine: [publicOverlay(module)] }],
    },
  ]),
  {
    name: "the tracking scratch layer sits between the module layers and the repo layer",
    when: STREAMS,
    checks: () => [
      { kind: "exists", path: TRACKING_LAYER },
      { kind: "text", path: SETTINGS_LAYERS, has: ["/settings-layers/tracking-labels.yml"] },
    ],
  },
  {
    name: "no tracking scratch layer without a stream module",
    when: not(STREAMS),
    checks: () => [
      { kind: "missing", path: TRACKING_LAYER },
      { kind: "text", path: SETTINGS_LAYERS, lacks: ["tracking-labels.yml"] },
    ],
  },
  ...(
    [
      ["docs-site", "docs-link-rot"],
      ["fuzzer", "fuzz-nightly"],
      ["nightly", "nightly-failure"],
    ] as [Module, string][]
  ).flatMap(([module, name]): Row[] => [
    {
      name: `${module} declares its ${name} tracking label`,
      when: has(module),
      checks: () => [
        { kind: "yaml-matches", path: TRACKING_LAYER, at: ["labels"], matches: [label(name)] },
      ],
    },
    {
      name: `no ${name} tracking label without ${module}`,
      when: and(STREAMS, not(has(module))),
      checks: () => [{ kind: "text", path: TRACKING_LAYER, lacks: [name] }],
    },
  ]),
];

/** The modules some row conditions on, across every table. */
export const GATED_MODULES: ReadonlySet<Module> = new Set(
  [...EXPECTATIONS, ...SETTINGS_LAYER_EXPECTATIONS, ...MANIFEST_CLASSES].flatMap(
    (row) => row.when.modules,
  ),
);
