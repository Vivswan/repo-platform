#!/usr/bin/env bun
// Golden renders: committed snapshots of real copier output for a canonical
// matrix of module selections, kept under tests/golden-renders/<name>/ (the
// whole directory is generated - regen rewrites it). Any change to
// templates/ or the composer proves its fleet-facing effect here: unchanged
// goldens prove byte-identity, changed goldens show the exact rendered diff
// in the PR.
//
// The matrix:
// - all-modules: every module in MODULE_ORDER except custom-license. No
//   module pair conflicts (copier.yml's multiselect allows any
//   combination); custom-license is left out because its whole effect is
//   opting OUT of the fleet license render (no LICENSE.md, no
//   copyright_holder answer), which would hide the default path every
//   other selection exercises.
// - minimal: modules=[] - the smallest selection copier.yml's validators
//   allow (no validator requires a non-empty list; ci.yml's smoke "none"
//   row exercises the same floor).
// - uv-no-release-please: modules=[uv] - the dotfiles shape that exposed
//   the anchor blank-line bug (compose_template.ts's collapse guard);
//   its rendered .typography-allow must end with exactly one newline.
//
// DETERMINISM CONTRACT: a golden changes if and only if rendered content
// changes. Everything volatile is pinned at the source:
// - The scratch build tree (branch_tree.ts) is content-deterministic by
//   design: no timestamps or source SHAs in-tree.
// - Its git commit uses a pinned author/committer identity and date and a
//   fixed message, and git runs with GIT_CONFIG_GLOBAL/SYSTEM pointed at
//   /dev/null (a user's autocrlf or gpg-signing config must not leak into
//   blob or commit hashes). The commit sha - recorded as `_commit` in
//   .copier-answers.yml and stamped into the ownership manifest's
//   provenance slot - is still a pure function of the WHOLE tree content,
//   so every template edit would move it; normalizeRenderedTree therefore
//   rewrites the `_commit` answer to the fixed sentinel "xxxxxxx" before
//   the write/diff step and re-runs the manifest stamp hook against the
//   result (which carries the sentinel into the commit slot and the
//   answers hash), gated on the render's stamp being honest so the
//   re-stamp cannot heal a lying hook. Those two provenance fields are the
//   ONLY normalized bytes - everything else is snapshot verbatim - and
//   only the true sha is rewritten: a bug that stamps a WRONG sha shows as
//   drift, and a render already carrying the sentinel is rejected
//   outright.
// - copier runs from the scratch directory with a RELATIVE src path, so
//   the recorded `_src_path` is the fixed string "./tree", never a temp
//   path. The same /dev/null git config is passed to copier for its
//   internal clone, and COPIER_SETTINGS_PATH is pointed away from any
//   user settings file (its answer defaults would leak into the render).
// - The `-d` answers are the fixed values below; everything else takes
//   copier.yml defaults.
// The copier version itself is deliberately unpinned, matching the smoke
// legs and the fleet sync: a copier upgrade that changes rendered bytes is
// a real fleet-facing change and should surface here as golden drift.
//
// Requires copier and bun on PATH (copier runs the template's _tasks with
// bun), like ci.yml's smoke legs.
//
// Usage:
//   bun scripts/render_goldens.ts           # rewrite tests/golden-renders/
//   bun scripts/render_goldens.ts --check   # render to temp, exit 1 on drift

import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { must, mustCapture } from "../.github/scripts/shared/proc.ts";
import { MANIFEST_NAME, stampManifestText } from "../.github/scripts/sync/stamp_manifest.ts";
import { loadManifests } from "./module_manifests.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const GOLDEN_ROOT = "tests/golden-renders";

// The fixed answers every golden renders with (project_slug derives to
// "golden-render"); per-module questions take copier.yml defaults.
const PROJECT_NAME = "Golden Render";
const DESCRIPTION = "Golden render fixture";

/** The pinned git environment: identity, dates, the default (sha1) object
 *  format, and NO user/system config, so the scratch commit sha depends on
 *  tree content alone and copier's internal clone cannot pick up
 *  checkout-mangling options. COPIER_SETTINGS_PATH points at a path that
 *  never exists so a user's copier settings file cannot inject answer
 *  defaults into the render. */
const RENDER_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_DEFAULT_HASH: "sha1",
  GIT_AUTHOR_NAME: "repo-platform",
  GIT_AUTHOR_EMAIL: "goldens@localhost",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "repo-platform",
  GIT_COMMITTER_EMAIL: "goldens@localhost",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  COPIER_SETTINGS_PATH: "/var/empty/no-copier-settings.yml",
};

/** The matrix, named as committed under tests/golden-renders/. all-modules
 *  derives from the manifests so a new module joins the golden (and trips
 *  the drift check) without editing this file. */
export function goldenMatrix(): { name: string; modules: string[] }[] {
  const allModules = loadManifests()
    .map((manifest) => manifest.module)
    .filter((module) => module !== "custom-license");
  return [
    { name: "all-modules", modules: allModules },
    { name: "minimal", modules: [] },
    { name: "uv-no-release-please", modules: ["uv"] },
  ];
}

type Entry = { kind: "file"; bytes: Buffer; exec: boolean } | { kind: "symlink"; target: string };

/** The fixed value the `_commit` provenance is rewritten to in every
 *  golden: the width of the short sha copier stamps, in a NON-hex
 *  character, so no honest commit sha can ever read as the sentinel (a
 *  hex sentinel like "0000000" would reject a genuine scratch commit that
 *  happens to start with seven zeros via the pre-stamped guard below). */
export const SHA_SENTINEL = "xxxxxxx";

/** The answers file copier records the render provenance in; must match
 *  the name stamp_manifest.ts's recordedCommit reads. */
const ANSWERS_NAME = ".copier-answers.yml";

/** Rewrite the `_commit` answer's VALUE to SHA_SENTINEL when it records
 *  the scratch tree's commit sha (or any 7-plus-char prefix of it - copier
 *  stamps the short form). This is the ONLY substitution the runner
 *  performs, addressed to the one field that carries provenance by
 *  design: a tree-wide byte substitution would corrupt unrelated content,
 *  because 7-hex-char runs occur in English prose ("feedback" starts with
 *  hex "feedbac"). Three properties are the point: the `_commit` key stays
 *  in the goldens (dropping or renaming it still shows as drift), a value
 *  that is anything but the true sha is left alone and shows as drift, and
 *  a value already reading as the sentinel throws - a pre-stamped sentinel
 *  would false-match the committed goldens. */
export function normalizeAnswers(text: string, fullSha: string): string {
  if (!/^[0-9a-f]{40}$/.test(fullSha)) throw new Error(`not a full sha1: ${fullSha}`);
  return text.replace(/^(_commit:[ \t]*)(\S*)([ \t]*)$/m, (line, key, value, pad) => {
    if (value === SHA_SENTINEL) {
      throw new Error(
        `${ANSWERS_NAME}: _commit already reads as the sentinel "${SHA_SENTINEL}" - ` +
          "a render must stamp the real scratch sha (a pre-stamped sentinel would " +
          "false-match the committed goldens)",
      );
    }
    const isTrueSha = value.length >= 7 && fullSha.startsWith(value);
    return isTrueSha ? `${key}${SHA_SENTINEL}${pad}` : line;
  });
}

/** Normalize a rendered tree in place: rewrite the `_commit` answer to the
 *  sentinel, then re-run the manifest stamp hook against the result. The
 *  hook ran inside copier, hashing the answers file and stamping the
 *  manifest's commit slot BEFORE this normalization, so the manifest would
 *  otherwise keep its scratch-sha dependence (directly in the commit slot,
 *  indirectly through the answers file's hash); the re-stamp recomputes
 *  both from the now-sentinel answers file, with the stamper's own
 *  semantics for every hash class. Two safeguards keep that re-stamp from
 *  laundering a broken render: the manifest is honesty-gated FIRST (the
 *  hook is idempotent on a manifest it stamped honestly, so re-stamping
 *  against the pre-normalization tree must be a byte-level no-op - a hook
 *  that stamped a lying provenance or hash fails loudly here instead of
 *  being healed to the sentinel), and the stamper is the manifest's ONLY
 *  writer. Symlink targets are untouched: they are fixed template
 *  filenames, and one that somehow embedded a sha would show as drift. */
export function normalizeRenderedTree(root: string, scratchSha: string): void {
  const manifestPath = join(root, MANIFEST_NAME);
  let manifest: string | null;
  try {
    manifest = readFileSync(manifestPath, "utf-8");
  } catch {
    manifest = null; // a render without a manifest has nothing to re-stamp
  }
  if (manifest !== null) {
    // The stamper reports corruption soft (its sync-side contract); in a
    // fresh render both corruption and a dishonest stamp are template
    // bugs, so fail loudly here.
    const { out, problem } = stampManifestText(manifest, root);
    if (problem !== null) throw new Error(`${MANIFEST_NAME} ${problem}`);
    if (out !== manifest) {
      throw new Error(
        `${MANIFEST_NAME} is not honestly stamped: re-stamping it against the ` +
          "rendered tree changed it, so the render's stamp hook wrote a wrong " +
          "provenance or hash - normalizing would silently heal that to the sentinel",
      );
    }
  }
  const answersPath = join(root, ANSWERS_NAME);
  let answers: string | null;
  try {
    // latin1 round-trips every byte, so untouched content stays verbatim.
    answers = readFileSync(answersPath).toString("latin1");
  } catch {
    answers = null;
  }
  if (answers !== null) {
    const normalized = normalizeAnswers(answers, scratchSha);
    if (normalized !== answers) writeFileSync(answersPath, Buffer.from(normalized, "latin1"));
  }
  if (manifest === null) return;
  // Same text as the gate, so `problem` cannot reappear; only the answers
  // hash and the commit slot move, recomputed from the normalized file.
  const { out } = stampManifestText(manifest, root);
  if (out !== manifest) writeFileSync(manifestPath, out);
}

/** Every file and symlink below root (repo-relative, sorted), with content
 *  or link target, plus the executable bit - the one mode distinction git
 *  tracks, and copier copies it over from the template. Directories are
 *  structure, not content: git cannot track an empty one, so they carry no
 *  golden identity. */
function readTree(root: string): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  const visit = (rel: string) => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const childRel = rel ? `${rel}/${name}` : name;
      const path = join(root, childRel);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        entries.set(childRel, { kind: "symlink", target: readlinkSync(path) });
      } else if (stat.isDirectory()) {
        visit(childRel);
      } else if (stat.isFile()) {
        entries.set(childRel, {
          kind: "file",
          bytes: readFileSync(path),
          exec: (stat.mode & 0o111) !== 0,
        });
      }
    }
  };
  visit("");
  return entries;
}

function writeTree(root: string, entries: Map<string, Entry>): void {
  for (const [rel, entry] of entries) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    if (entry.kind === "symlink") symlinkSync(entry.target, path);
    else writeFileSync(path, entry.bytes, { mode: entry.exec ? 0o755 : 0o644 });
  }
}

/** One-line drift description per differing path, or [] when identical. */
export function diffTrees(fresh: Map<string, Entry>, committed: Map<string, Entry>): string[] {
  const drift: string[] = [];
  const paths = [...new Set([...fresh.keys(), ...committed.keys()])].sort();
  for (const rel of paths) {
    const now = fresh.get(rel);
    const was = committed.get(rel);
    if (!was) drift.push(`${rel}: new in the fresh render (missing from the committed golden)`);
    else if (!now) drift.push(`${rel}: retired in the fresh render (still committed)`);
    else if (now.kind !== was.kind) drift.push(`${rel}: ${was.kind} became ${now.kind}`);
    else if (now.kind === "symlink" && was.kind === "symlink" && now.target !== was.target)
      drift.push(`${rel}: symlink target changed (${was.target} -> ${now.target})`);
    else if (now.kind === "file" && was.kind === "file") {
      if (!now.bytes.equals(was.bytes)) drift.push(`${rel}: content differs`);
      else if (now.exec !== was.exec)
        drift.push(`${rel}: executable bit ${now.exec ? "gained" : "lost"}`);
    }
  }
  return drift;
}

/** Golden paths matching a git ignore rule (the repo's, or a rendered
 *  .gitignore inside a golden - nested ignore files apply to the committed
 *  tree), as error lines; [] when clean. --no-index, because plain
 *  check-ignore reports nothing for already-tracked paths and the committed
 *  goldens are tracked: an ignored golden would silently drop from future
 *  `git add` runs and the drift check would chase a phantom. */
function ignoreRuleHits(paths: string[]): string[] {
  const proc = Bun.spawnSync(["git", "-C", REPO_ROOT, "check-ignore", "--no-index", "--stdin"], {
    stdin: Buffer.from(`${paths.join("\n")}\n`),
    stdout: "pipe",
    stderr: "pipe",
  });
  // check-ignore exits 1 when no path is ignored - the pass case.
  if (proc.exitCode === 1) return [];
  if (proc.exitCode === 0) {
    return proc.stdout
      .toString()
      .trim()
      .split("\n")
      .map((path) => `${path}: matches a git ignore rule`);
  }
  throw new Error(`git check-ignore failed: ${proc.stderr.toString().trim()}`);
}

/** 0 on success, 1 on drift or an ignored golden path - returned, not
 *  process.exit()ed, so the temp-dir cleanup in the caller's finally runs
 *  on the expected failure paths (must() still exits directly when a
 *  subprocess fails, leaving the temp tree behind for debugging). */
function run(checkMode: boolean): number {
  const matrix = goldenMatrix();
  const work = mkdtempSync(join(tmpdir(), "repo-platform-goldens-"));
  try {
    // One scratch build tree, shared by every selection (the smoke recipe
    // in ci.yml's smoke legs, with the commit inputs pinned).
    const tree = join(work, "tree");
    must(["bun", ".github/scripts/build-branches/branch_tree.ts", "--dest", tree], {
      cwd: REPO_ROOT,
    });
    const git = (...args: string[]) => must(["git", "-C", tree, ...args], { env: RENDER_ENV });
    git("init", "-q", "-b", "build");
    git("add", "-A");
    git("commit", "-q", "-m", "chore: golden build tree");
    const scratchSha = mustCapture(["git", "-C", tree, "rev-parse", "HEAD"], { env: RENDER_ENV });

    // Render every selection BEFORE touching the committed goldens, so a
    // failing copier leg (which must() turns into an exit) can never leave
    // tests/golden-renders/ deleted or half-rebuilt.
    const rendered: { name: string; fresh: Map<string, Entry> }[] = [];
    for (const golden of matrix) {
      must(
        [
          "copier",
          "copy",
          "./tree",
          `./out-${golden.name}`,
          "--vcs-ref",
          "HEAD",
          "--defaults",
          "--trust",
          "-d",
          `project_name=${PROJECT_NAME}`,
          "-d",
          `description=${DESCRIPTION}`,
          "-d",
          `modules=[${golden.modules.join(", ")}]`,
          "-d",
          "private=false",
        ],
        { cwd: work, env: RENDER_ENV },
      );
      // Normalize here, before the write/diff step, so BOTH modes (regen
      // writes, --check diffs) see sentinel-stamped trees from the same
      // code path - CI's fresh render must normalize identically or the
      // drift check would fail forever.
      const outDir = join(work, `out-${golden.name}`);
      normalizeRenderedTree(outDir, scratchSha);
      rendered.push({ name: golden.name, fresh: readTree(outDir) });
    }

    // Regen rewrites the whole directory, so a golden the matrix no longer
    // names (a rename, a retired selection) does not linger.
    if (!checkMode) rmSync(join(REPO_ROOT, GOLDEN_ROOT), { recursive: true, force: true });

    const drifted: string[] = [];
    for (const { name, fresh } of rendered) {
      const goldenDir = join(REPO_ROOT, GOLDEN_ROOT, name);
      if (checkMode) {
        let committed: Map<string, Entry>;
        try {
          committed = readTree(goldenDir);
        } catch {
          committed = new Map();
        }
        drifted.push(
          ...diffTrees(fresh, committed).map((line) => `${GOLDEN_ROOT}/${name}/${line}`),
        );
      } else {
        writeTree(goldenDir, fresh);
        console.log(`wrote ${GOLDEN_ROOT}/${name} (${fresh.size} files)`);
      }
    }
    // After the writes, so the guard sees the rendered .gitignore files a
    // fresh regen just put on disk.
    const ignored = rendered.flatMap(({ name, fresh }) =>
      ignoreRuleHits([...fresh.keys()].map((rel) => `${GOLDEN_ROOT}/${name}/${rel}`)),
    );

    if (checkMode) {
      // A committed golden the matrix no longer names is drift too.
      const known = new Set(matrix.map((golden) => golden.name));
      let staleDirs: string[] = [];
      try {
        staleDirs = readdirSync(join(REPO_ROOT, GOLDEN_ROOT)).filter((name) => !known.has(name));
      } catch {
        // No golden directory at all: every matrix entry already reported.
      }
      drifted.push(
        ...staleDirs.map((name) => `${GOLDEN_ROOT}/${name}: not in the golden matrix (stale)`),
      );
    }
    if (drifted.length > 0) {
      console.error("golden renders drifted from the committed snapshots:");
      for (const line of drifted) console.error(`  ${line}`);
      console.error("run `bun run renders` and commit the result if the change is intended");
      return 1;
    }
    if (ignored.length > 0) {
      console.error("error: these golden render paths match a git ignore rule:");
      for (const line of ignored) console.error(`  ${line}`);
      console.error(
        "an ignored golden silently drops from future `git add` runs; fix the " +
          "colliding pattern at its source (the repo .gitignore local section, " +
          "or the template whose rendered .gitignore matches its own sibling)",
      );
      return 1;
    }
    if (checkMode) console.log(`golden renders match (${matrix.length} selections)`);
    return 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const checkMode = args[0] === "--check";
  if (args.length > 1 || (args.length === 1 && !checkMode)) {
    console.error(`usage: bun scripts/render_goldens.ts [--check] (got: ${args.join(" ")})`);
    process.exit(2);
  }
  if (!Bun.which("copier")) {
    console.error(
      "error: copier is not on PATH - the golden renders are real copier output. " +
        "Install it (pipx install copier) and rerun.",
    );
    process.exit(1);
  }
  process.exit(run(checkMode));
}

if (import.meta.main) main();
