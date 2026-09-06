// The ownership roster this validator declares ITSELF: which rendered
// files the sync owns, how each declares that ownership in-file, and under
// which render conditions it lands. The four tables are generated from the
// module manifests and templates/base/ownership.yml (scripts/generate.ts);
// the checks read the roster through declaredOwnership().

/** How a declared file's ownership is enforced in the rendered repo:
 *  "header" files open with the managed header, "region" files carry
 *  their declared BEGIN/END managed-region marker lines exactly once each
 *  and in order (substring-counted, so a buried mention counts as a
 *  duplicate too), and "class-only" files are managed with no comment
 *  channel (pin dotfiles, JSON, symlinks) - nothing to check in-file, but
 *  the manifest cross-check still needs them on the roster, or a
 *  hand-flipped class would silently exempt them from byte parity. */
export type OwnedFile =
  | {
      readonly path: string;
      readonly kind: "header";
      readonly begin?: undefined;
      readonly end?: undefined;
    }
  | {
      readonly path: string;
      readonly kind: "class-only";
      readonly begin?: undefined;
      readonly end?: undefined;
    }
  | {
      readonly path: string;
      readonly kind: "region";
      readonly begin: string;
      readonly end: string;
    };

/** Render conditions translated from the templates' declared filename
 *  gates, evaluated against a render's answers and modules list. */
export type RenderWhen = { readonly publicOnly?: boolean; readonly withoutModule?: string };

export type BaseOwnedFile = OwnedFile & { readonly when?: RenderWhen };

/** A toolchain module's version dotfile and the version it must carry. */
export type ToolchainPin = { readonly file: string; readonly version: string };

// Starters stay out of both ownership tables (repo-owned; nothing to
// enforce); headerless comment-free managed files ride as class-only so the
// manifest cross-check covers them.
// BEGIN GENERATED: base-ownership (scripts/generate.ts - edit templates/base/ownership.yml and the base templates, not this block)
export const BASE_OWNERSHIP: readonly BaseOwnedFile[] = [
  {
    path: ".editorconfig",
    kind: "region",
    begin: "# BEGIN REPO-PLATFORM MANAGED",
    end: "# END REPO-PLATFORM MANAGED",
  },
  {
    path: ".gitattributes",
    kind: "region",
    begin: "# BEGIN REPO-PLATFORM MANAGED",
    end: "# END REPO-PLATFORM MANAGED",
  },
  { path: ".github/.copier-answers.yml", kind: "header" },
  { path: ".github/CODE_OF_CONDUCT.md", kind: "header", when: { publicOnly: true } },
  {
    path: ".github/CODEOWNERS",
    kind: "region",
    begin: "# BEGIN REPO-PLATFORM MANAGED",
    end: "# END REPO-PLATFORM MANAGED",
  },
  { path: ".github/dependabot.yml", kind: "header" },
  {
    path: ".github/SECURITY.md",
    kind: "region",
    begin: "<!-- BEGIN REPO-PLATFORM MANAGED -->",
    end: "<!-- END REPO-PLATFORM MANAGED -->",
  },
  { path: ".github/workflows/ci.yml", kind: "header" },
  {
    path: ".gitignore",
    kind: "region",
    begin: "# BEGIN REPO-PLATFORM MANAGED",
    end: "# END REPO-PLATFORM MANAGED",
  },
  { path: ".typography-allow", kind: "header" },
  { path: ".yamllint", kind: "header" },
  {
    path: "CONTRIBUTING.md",
    kind: "region",
    begin: "<!-- BEGIN REPO-PLATFORM MANAGED -->",
    end: "<!-- END REPO-PLATFORM MANAGED -->",
    when: { publicOnly: true },
  },
  {
    path: "LICENSE.md",
    kind: "region",
    begin: "<!-- BEGIN REPO-PLATFORM MANAGED -->",
    end: "<!-- END REPO-PLATFORM MANAGED -->",
    when: { withoutModule: "custom-license" },
  },
];
// END GENERATED: base-ownership

// BEGIN GENERATED: known-modules (scripts/generate.ts - edit module.yml manifests, not this block)
export const KNOWN_MODULES: ReadonlySet<string> = new Set([
  "agents",
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
  "auto-assign",
  "fuzzer",
  "nightly",
  "settings-sync",
  "custom-license",
]);
// END GENERATED: known-modules

// BEGIN GENERATED: toolchain-pins (scripts/generate.ts - edit module.yml manifests, not this block)
export const TOOLCHAIN_PINS: Readonly<Partial<Record<string, ToolchainPin>>> = {
  bun: { file: ".bun-version", version: "1.4.0" },
  node: { file: ".node-version", version: "24.19.0" },
  deno: { file: ".dvmrc", version: "2.9.5" },
};
// END GENERATED: toolchain-pins

// How each rendered module file declares its ownership while its module is
// selected (derived from the module.yml ownership declarations by
// moduleOwnershipEntries in scripts/ownership.ts).
// BEGIN GENERATED: module-ownership (scripts/generate.ts - edit the module.yml ownership declarations and the module templates, not this block)
export const MODULE_OWNERSHIP: Readonly<Partial<Record<string, readonly OwnedFile[]>>> = {
  agents: [
    { path: ".github/agents.md", kind: "class-only" },
    { path: ".github/copilot-instructions.md", kind: "class-only" },
    { path: ".github/instructions/review.instructions.md", kind: "header" },
    {
      path: "AGENTS.md",
      kind: "region",
      begin: "<!-- BEGIN REPO-PLATFORM MANAGED -->",
      end: "<!-- END REPO-PLATFORM MANAGED -->",
    },
    { path: "CLAUDE.md", kind: "class-only" },
  ],
  bun: [
    { path: ".bun-version", kind: "class-only" },
    { path: ".github/workflows/dependabot-bun-lockfile.yml", kind: "header" },
  ],
  node: [{ path: ".node-version", kind: "class-only" }],
  deno: [
    { path: ".dvmrc", kind: "class-only" },
    { path: ".github/workflows/deno-audit.yml", kind: "header" },
  ],
  pages: [{ path: ".github/workflows/pages.yml", kind: "header" }],
  "docs-site": [{ path: ".github/workflows/docs-site.yml", kind: "header" }],
  "release-please": [{ path: ".github/workflows/release.yml", kind: "header" }],
  skills: [{ path: ".github/workflows/validate-skills.yml", kind: "header" }],
  "pr-title": [{ path: ".github/workflows/pr-title.yml", kind: "header" }],
  "auto-assign": [{ path: ".github/workflows/auto-assign.yml", kind: "header" }],
  "settings-sync": [{ path: ".github/workflows/settings-sync.yml", kind: "header" }],
};
// END GENERATED: module-ownership

/** The facts of a render that decide which table entries apply to it.
 *  `selectedModules` is null while the modules list is missing or
 *  malformed (the registration check's own error) and in self mode: the
 *  module-gated and module-conditioned entries then stand down. */
export interface RenderSelection {
  isPrivateRender: boolean;
  selectedModules: string[] | null;
}

function whenHolds(when: RenderWhen | undefined, render: RenderSelection): boolean {
  if (when === undefined) return true;
  if (when.publicOnly && render.isPrivateRender) return false;
  if (when.withoutModule !== undefined) {
    if (render.selectedModules === null || render.selectedModules.includes(when.withoutModule)) {
      return false;
    }
  }
  return true;
}

/** Every file the tables expect on this render: the base entries whose
 *  render condition holds plus the selected modules' entries. */
export function declaredOwnership(render: RenderSelection): readonly OwnedFile[] {
  const declared: OwnedFile[] = BASE_OWNERSHIP.filter((entry) => whenHolds(entry.when, render)).map(
    ({ when: _when, ...entry }) => entry,
  );
  for (const module of render.selectedModules ?? []) {
    declared.push(...(MODULE_OWNERSHIP[module] ?? []));
  }
  return declared;
}

/** Base region files with no render condition: the template always
 *  generates them, so their absence from a render is damage. */
export function ungatedBaseRegionPaths(): ReadonlySet<string> {
  return new Set(
    BASE_OWNERSHIP.filter((entry) => entry.kind === "region" && entry.when === undefined).map(
      (entry) => entry.path,
    ),
  );
}

/** Every path the tables cover on SOME render this validator can judge: a
 *  manifest entry for one of these whose render condition is off on this
 *  render cannot come from the template. Module-conditioned paths (module
 *  entries, base entries gated on a module's absence) count only while
 *  the modules list is known. */
export function coveredPaths(selectedModules: readonly string[] | null): ReadonlySet<string> {
  return new Set<string>([
    ...BASE_OWNERSHIP.filter(
      (entry) => entry.when?.withoutModule === undefined || selectedModules !== null,
    ).map((entry) => entry.path),
    ...(selectedModules !== null
      ? Object.values(MODULE_OWNERSHIP).flatMap((entries) => (entries ?? []).map((f) => f.path))
      : []),
  ]);
}
