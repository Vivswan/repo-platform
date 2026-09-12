import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { boundedSpawnSync } from "../../../shared/bounded_spawn.ts";
import type { TempDirs } from "../../../shared/temp_dir.ts";

export const VALIDATOR_DIR = join(
  import.meta.dir,
  "../../../../actions/validate-managed-files/validator",
);
export const VALIDATOR = join(VALIDATOR_DIR, "validate_managed_files.ts");

export const B = "<!-- BEGIN REPO-PLATFORM MANAGED -->";
export const E = "<!-- END REPO-PLATFORM MANAGED -->";
export const HB = "# BEGIN REPO-PLATFORM MANAGED";
export const HE = "# END REPO-PLATFORM MANAGED";
// The build commit a sync records: the writer stamps the full sha.
export const COMMIT = "a3f9c2e17b4d6c8f0a2e4b6d8c0f1a3b5d7e9f01";

export const FILES_YML = [
  "placeholders: []",
  "modules:",
  "  bun: {}",
  "  uv: {}",
  "  pages: {}",
  "  release-please: {}",
  "files: []",
  "",
].join("\n");

export const BASELINE: Record<string, string> = {
  ".repo-platform.yml": "modules: [uv]\n",
  ".gitignore": `# local patterns go here\n\n${HB}\nnode_modules/\n${HE}\n`,
  ".editorconfig": `${HB}\nroot = true\n${HE}\n`,
  "LICENSE.md": `${B}\n# License\n${E}\n`,
  "AGENTS.md": `${B}\n# AGENTS.md\n${E}\n`,
  ".github/workflows/ci.yml": "name: CI\non: [push]\njobs: {}\n",
};

export const MANIFEST = ".github/repo-platform-manifest.json";

export const shaLatin1 = (text: string) =>
  new Bun.CryptoHasher("sha256").update(Buffer.from(text, "latin1")).digest("hex");

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

export const splitEntry = (content: string, begin: string, end: string) => {
  const region = regionOf(content, begin, end);
  if (region === null) throw new Error("fixture lost its marker lines");
  return (
    `{"class": "split", "grammar": "managed-region", "begin": ${JSON.stringify(begin)}, ` +
    `"end": ${JSON.stringify(end)}, "hash": "${shaLatin1(region)}"}`
  );
};

export function manifestOf(entries: Record<string, string>): string {
  return `{\n  "files": {\n${Object.entries(entries)
    .map(([path, body]) => `    ${JSON.stringify(path)}: ${body}`)
    .join(",\n")}\n  }\n}\n`;
}

export function stampedBaseline(): Record<string, string> {
  return {
    [MANIFEST]: `{"class": "managed", "hash": null, "commit": "${COMMIT}"}`,
    ".gitignore": splitEntry(BASELINE[".gitignore"], HB, HE),
    ".editorconfig": splitEntry(BASELINE[".editorconfig"], HB, HE),
    "LICENSE.md": splitEntry(BASELINE["LICENSE.md"], B, E),
    "AGENTS.md": splitEntry(BASELINE["AGENTS.md"], B, E),
    ".github/workflows/ci.yml": managedEntry(BASELINE[".github/workflows/ci.yml"]),
  };
}

export const SELF_ENTRY = {
  [MANIFEST]: `{"class": "managed", "hash": null, "commit": "${COMMIT}"}`,
};

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
  filesYml?: string | null;
  filesPath?: string;
}

export interface ValidatorResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** tests/shared/temp_dir.ts binds its afterAll to the registering file, so each suite hands in its own TempDirs
 *  and this module never calls tempDirs() itself. */
export function validatorRunner(temp: TempDirs) {
  return function runValidator(
    extra: Record<string, string> = {},
    args: string[] = [],
    opts: RunValidatorOptions = {},
  ): ValidatorResult {
    const root = temp.dir("validate-managed-");
    const tree: Record<string, string> = { ...BASELINE, ...extra };
    for (const rel of opts.omit ?? []) delete tree[rel];
    const selfMode = args.includes("--self");
    // Managed repositories need a stamped manifest (absence is strict);
    // self mode must NOT have one, and manifest-behavior tests bring their
    // own.
    if (!opts.noManifest && !selfMode && !Object.hasOwn(tree, MANIFEST)) {
      tree[MANIFEST] = manifestOf(stampedBaseline());
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
    // The module data file sits beside the tree in self mode (the
    // operator's own files.yml) and outside it otherwise (the build
    // branch's, named with --files).
    const filesArgs: string[] = [];
    if (opts.filesPath !== undefined) filesArgs.push("--files", opts.filesPath);
    else if (opts.filesYml !== null) {
      const text = opts.filesYml ?? FILES_YML;
      if (selfMode) writeFileSync(join(root, "files.yml"), text);
      else {
        const dataFile = join(temp.dir("validate-managed-data-"), "files.yml");
        writeFileSync(dataFile, text);
        filesArgs.push("--files", dataFile);
      }
    }
    const result = boundedSpawnSync([process.execPath, VALIDATOR, ...args, ...filesArgs, root], {
      env: { ...gitFreeEnv(), ...opts.env },
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
}
