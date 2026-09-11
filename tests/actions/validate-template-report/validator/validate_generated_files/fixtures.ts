// Fixtures shared by the validate_generated_files suites: the smallest
// passing render, the ownership-table mirror that stamps its manifest, the
// manifest builders, and the validator runner (bound to each file's TempDirs).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { boundedSpawnSync } from "../../../../shared/bounded_spawn.ts";
import type { TempDirs } from "../../../../shared/temp_dir.ts";

export const VALIDATOR_DIR = join(
  import.meta.dir,
  "../../../../../actions/validate-template-report/validator",
);
export const VALIDATOR = join(VALIDATOR_DIR, "validate_generated_files.ts");

// The smallest tree the validator accepts: registration files (opening with
// the managed header checks/headers.ts requires), the marked .gitignore, and a ci.yml
// carrying the all-green + typography convention.
export const MANAGED_HEADER = "# This file is managed by Vivswan/repo-platform.\n";
export const B = "<!-- BEGIN REPO-PLATFORM MANAGED -->";
export const E = "<!-- END REPO-PLATFORM MANAGED -->";
export const HB = "# BEGIN REPO-PLATFORM MANAGED";
export const HE = "# END REPO-PLATFORM MANAGED";
// The build commit a render records: the sync writes the full sha.
export const COMMIT = "a3f9c2e17b4d6c8f0a2e4b6d8c0f1a3b5d7e9f01";
export const ANSWERS = (extra = "") =>
  `${MANAGED_HEADER}_commit: ${COMMIT}\n_src_path: gh:Vivswan/repo-platform\ngithub_username: Vivswan\n${extra}`;
// A public render of the base alone (modules: [uv] adds no owned file):
// every roster path the tables expect is present, because the manifest
// cross-check errors on any roster path the manifest does not list. The
// agent-file aliases (symlinks in a real render) are content-hashed regular
// files here; the link tests in manifest_entries.test.ts plant real symlinks.
export const BASELINE: Record<string, string> = {
  ".github/.copier-answers.yml": ANSWERS(),
  // A repo-owned starter (generated once, never rewritten): no managed
  // header, no manifest hash.
  ".repo-platform.yml": "# Generated once by Vivswan/repo-platform; repo-owned.\nmodules: [uv]\n",
  ".gitignore": `# local patterns go here\n\n${HB}\n${HE}\n`,
  ".editorconfig": `${HB}\nroot = true\n${HE}\n`,
  ".gitattributes": `${HB}\n* text=auto eol=lf\n${HE}\n`,
  ".github/CODEOWNERS": `${HB}\n* @vivswan\n${HE}\n`,
  ".github/SECURITY.md": `${B}\n# Security policy\n${E}\n`,
  ".github/CODE_OF_CONDUCT.md": `${MANAGED_HEADER}\n# Contributor Covenant Code of Conduct\n`,
  ".github/dependabot.yml": `${MANAGED_HEADER}version: 2\nupdates: []\n`,
  ".typography-allow": MANAGED_HEADER,
  ".yamllint": `${MANAGED_HEADER}extends: default\n`,
  "CONTRIBUTING.md": `${B}\n# Contributing\n${E}\n`,
  "LICENSE.md": `${B}\n# License\n${E}\n`,
  "AGENTS.md": `${B}\n# AGENTS.md\n${E}\n`,
  "CLAUDE.md": "AGENTS.md\n",
  ".github/agents.md": "AGENTS.md\n",
  ".github/copilot-instructions.md": "AGENTS.md\n",
  ".github/instructions/review.instructions.md":
    '---\napplyTo: "**"\n---\n<!-- This file is managed by Vivswan/repo-platform. -->\n# Review\n',
  ".github/workflows/auto-assign.yml": `${MANAGED_HEADER}name: Auto Assign\non: [issues]\n`,
  ".github/workflows/ci.yml": [
    "# This file is managed by Vivswan/repo-platform.",
    "name: CI",
    "jobs:",
    "  checks:",
    "    uses: ./.github/workflows/checks.yml",
    "  ci:",
    "    uses: Vivswan/repo-platform/.github/workflows/fleet-ci.yml@build",
    "  all-green:",
    "    needs: [checks, ci]",
    "    if: always()",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: Vivswan/repo-platform/actions/all-green@build",
    "        with:",
    "          needs: ${{ toJSON(needs) }}",
    "",
  ].join("\n"),
};

export const MANIFEST = ".github/repo-platform-manifest.json";

// The registration the sync writer's cutover leaves: the project block
// beside the module list. A key outside the template's `modules`/`mirrors`
// pair is what tells the validator the answers file has been retired.
export const V2_REGISTRATION =
  "# Generated once by repo-platform and repo-owned from then on.\nmodules: [uv]\nproject:\n  name: Demo\n  slug: demo\n  description: A demo\n";
// What the cutover takes out of BASELINE: the answers file itself, and the
// public-only files, which stand down once no answers record the
// visibility (the writer retires both anyway).
export const CUT_OVER_OMIT = [
  ".github/.copier-answers.yml",
  ".github/CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
];

// Absence and provenance checks are STRICT (every build ships the
// manifest, and the roster cross-check errors on any roster path the
// manifest does not list), so every client-render fixture carries each
// roster path it selects and a manifest listing them. This mirror of the
// validator's ownership tables stamps that manifest from the fixture's
// final tree; the mirror test (roster.test.ts) pins it equal to the
// generated tables. Tests probing manifest behavior itself pass their own
// manifest (which wins) or opt out via `noManifest`.
export type MirrorEntry = {
  path: string;
  kind: "header" | "region" | "class-only";
  begin?: string;
  end?: string;
  publicOnly?: boolean;
  withoutModule?: string;
};
export const MIRROR_BASE: MirrorEntry[] = [
  { path: ".github/.copier-answers.yml", kind: "header" },
  { path: ".editorconfig", kind: "region", begin: HB, end: HE },
  { path: ".gitattributes", kind: "region", begin: HB, end: HE },
  { path: ".github/CODEOWNERS", kind: "region", begin: HB, end: HE },
  { path: ".github/dependabot.yml", kind: "header" },
  { path: ".github/agents.md", kind: "class-only" },
  { path: ".github/copilot-instructions.md", kind: "class-only" },
  { path: ".github/instructions/review.instructions.md", kind: "header" },
  { path: ".github/workflows/auto-assign.yml", kind: "header" },
  { path: "AGENTS.md", kind: "region", begin: B, end: E },
  { path: "CLAUDE.md", kind: "class-only" },
  { path: ".github/workflows/ci.yml", kind: "header" },
  { path: ".gitignore", kind: "region", begin: HB, end: HE },
  { path: ".typography-allow", kind: "header" },
  { path: ".yamllint", kind: "header" },
  { path: ".github/CODE_OF_CONDUCT.md", kind: "header", publicOnly: true },
  { path: "CONTRIBUTING.md", kind: "region", begin: B, end: E, publicOnly: true },
  { path: "LICENSE.md", kind: "region", begin: B, end: E, withoutModule: "custom-license" },
  { path: ".github/SECURITY.md", kind: "region", begin: B, end: E },
];
export const MIRROR_MODULES: Record<string, MirrorEntry[]> = {
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
  skills: [{ path: ".github/workflows/validate-skills.yml", kind: "header" }],
  "pr-title": [{ path: ".github/workflows/pr-title.yml", kind: "header" }],
};

export const shaLatin1 = (text: string) =>
  new Bun.CryptoHasher("sha256").update(Buffer.from(text, "latin1")).digest("hex");

/** Twin of the validator's splitManagedRegion: the managed region from the
 *  first BEGIN marker line through the first END marker line after it
 *  (newline included). */
export function regionOf(content: string, begin: string, end: string): string | null {
  const lines = content.split("\n");
  let offset = 0;
  let start = -1;
  for (const line of lines) {
    const lineEnd = offset + line.length;
    if (start === -1) {
      if (line.trim() === begin) start = offset;
    } else if (line.trim() === end) {
      return content.slice(start, Math.min(lineEnd + 1, content.length));
    }
    offset = lineEnd + 1;
  }
  return null;
}

export const managedEntry = (content: string) =>
  `{"class": "managed", "hash": "${shaLatin1(content)}"}`;

export function manifestOf(entries: Record<string, string>): string {
  return `{\n  "$comment": "test-stamped", "files": {\n${Object.entries(entries)
    .map(([path, body]) => `    ${JSON.stringify(path)}: ${body}`)
    .join(",\n")}\n  }\n}\n`;
}

/** The entries the stamper would write for `tree`: the self entry carrying
 *  the recorded _commit (the writer's build, COMMIT, once no answers file
 *  records one), the starter registration file, and one entry per
 *  mirror-roster path the tree carries. */
export function stampedEntries(tree: Record<string, string>): Record<string, string> {
  const answers = tree[".github/.copier-answers.yml"];
  const isPrivate = answers !== undefined && /^private:\s*true\b/m.test(answers);
  const commit =
    answers === undefined ? COMMIT : (/^_commit:[ \t]*(.+?)[ \t]*$/m.exec(answers)?.[1] ?? null);
  const modules = (/^modules:\s*\[([^\]]*)\]/m.exec(tree[".repo-platform.yml"] ?? "")?.[1] ?? "")
    .split(",")
    .map((name) => name.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  const entries: Record<string, string> = {
    [MANIFEST]: `{"class": "managed", "hash": null, "commit": ${
      commit === null ? "null" : JSON.stringify(commit)
    }}`,
    // The registration file is a repo-owned starter and every render's
    // manifest lists it hash-free, like the real stamp.
    ".repo-platform.yml": '{"class": "starter"}',
  };
  const expected = [
    ...MIRROR_BASE.filter(
      (entry) =>
        !(entry.publicOnly && isPrivate) &&
        !(entry.withoutModule !== undefined && modules.includes(entry.withoutModule)),
    ),
    ...modules.flatMap((name) => MIRROR_MODULES[name] ?? []),
  ];
  for (const { path, kind, begin, end } of expected) {
    const content = tree[path];
    if (content === undefined) continue;
    if (kind === "header" || kind === "class-only") {
      entries[path] = managedEntry(content);
    } else {
      // A missing or duplicated marker is that check's own report; the
      // manifest still lists the first region the marker pair delimits.
      const region = regionOf(content, begin as string, end as string);
      if (region === null) continue;
      entries[path] =
        `{"class": "split", "grammar": "managed-region", "begin": ${JSON.stringify(begin)}, ` +
        `"end": ${JSON.stringify(end)}, "hash": "${shaLatin1(region)}"}`;
    }
  }
  return entries;
}

export const manifestForTree = (tree: Record<string, string>) => manifestOf(stampedEntries(tree));

// The manifest suites' shared shorthands: the self entry of a render
// recording COMMIT, and the full roster for the BASELINE tree (the
// cross-check errors on any roster path the manifest does not list, so a
// passing fixture lists every one).
export const SELF_ENTRY = {
  [MANIFEST]: `{"class": "managed", "hash": null, "commit": "${COMMIT}"}`,
};
export const stampedBaseline = () => stampedEntries(BASELINE);

export function gitFreeEnv(): Record<string, string> {
  // Hook-driven runs (husky pre-commit) export GIT_DIR/GIT_INDEX_FILE, which
  // would make the spawned validator's git calls resolve the enclosing repo
  // instead of the scratch tree (or lack thereof).
  const env = { ...process.env } as Record<string, string>;
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  return env;
}

export interface RunValidatorOptions {
  gitInit?: boolean;
  gitAddForce?: string[];
  env?: Record<string, string>;
  noManifest?: boolean;
  omit?: string[];
}

export interface ValidatorResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** The runner bound to one file's TempDirs (tests/shared/temp_dir.ts
 *  binds its afterAll to the registering file, so this module never calls
 *  tempDirs() itself). The returned function writes BASELINE plus `extra`
 *  into a fresh temp repo and runs the validator against it, with any extra
 *  CLI `args` (e.g. --self). `opts.gitInit` makes the tree a real git
 *  checkout first, so the --self gitignore skip has ignore rules to consult;
 *  `opts.gitAddForce` force-tracks paths despite matching an ignore pattern;
 *  `opts.omit` drops BASELINE files from the tree. */
export function validatorRunner(temp: TempDirs) {
  return function runValidator(
    extra: Record<string, string> = {},
    args: string[] = [],
    opts: RunValidatorOptions = {},
  ): ValidatorResult {
    const root = temp.dir("validate-template-");
    const tree: Record<string, string> = { ...BASELINE, ...extra };
    for (const rel of opts.omit ?? []) delete tree[rel];
    // Client renders need a stamped manifest (absence is strict); self mode
    // must NOT have one, and manifest-behavior tests bring their own.
    if (!opts.noManifest && !args.includes("--self") && !Object.hasOwn(tree, MANIFEST)) {
      tree[MANIFEST] = manifestForTree(tree);
    }
    for (const [rel, content] of Object.entries(tree)) {
      mkdirSync(join(root, dirname(rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    if (opts.gitInit) {
      const init = boundedSpawnSync(["git", "-C", root, "init", "-q"], { env: gitFreeEnv() });
      if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr}`);
    }
    if (opts.gitAddForce?.length) {
      const add = boundedSpawnSync(["git", "-C", root, "add", "-f", "--", ...opts.gitAddForce], {
        env: gitFreeEnv(),
      });
      if (add.exitCode !== 0) throw new Error(`git add -f failed: ${add.stderr}`);
    }
    const result = boundedSpawnSync([process.execPath, VALIDATOR, ...args, root], {
      env: { ...gitFreeEnv(), ...opts.env },
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
}
