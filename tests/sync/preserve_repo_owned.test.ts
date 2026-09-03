// The fleet-license re-seed path of preserve_repo_owned.ts: a committed
// LICENSE.md deletion in a repo without the custom-license module is
// re-seeded from the target build ref, rendered from the repo's recorded
// answers. The happy path renders the repo's REAL template source, so a
// template edit that adds a variable the re-seed does not render fails
// here first instead of seeding template text into a fleet repo.

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decodeTrackedPathBytes } from "../../.github/scripts/sync/preserve_repo_owned.ts";
import { REMOVED_SPLITS_NAME } from "../../.github/scripts/sync/section_files.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";

const script = join(import.meta.dir, "../../.github/scripts/sync/preserve_repo_owned.ts");
const repoRoot = join(import.meta.dir, "..", "..");

// The build ref carries the license under the composed template/ prefix at
// its PLAIN name (conditional landing lives in copier.yml's _exclude, not
// in filenames); the source of truth lives under templates/base/, where the
// filename still declares the gate.
const sourceLicenseName = "{% if 'custom-license' not in modules %}LICENSE.md{% endif %}.jinja";
const fleetLicenseRel = join("template", "LICENSE.md.jinja");
const licenseTemplateSource = readFileSync(
  join(repoRoot, "templates/base", sourceLicenseName),
  "utf-8",
);

const goodAnswers = [
  'copyright_holder: "Vivswan Shah (https://github.com/Vivswan)"',
  "github_username: Vivswan",
  "",
].join("\n");

function gitFreeEnv(): Record<string, string> {
  // Hook-driven runs (husky pre-commit) export GIT_DIR/GIT_INDEX_FILE, which
  // would redirect every git subprocess these tests spawn away from their
  // scratch repositories.
  const env = { ...process.env } as Record<string, string>;
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  return env;
}

function initGitRepo(dir: string, tag?: string): void {
  const run = (...args: string[]) => {
    const proc = boundedSpawnSync(["git", "-C", dir, ...args], { env: gitFreeEnv() });
    if (proc.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${proc.stderr}`);
    }
  };
  run("init", "-b", "main");
  run("config", "user.name", "test");
  run("config", "user.email", "test@example.com");
  run("add", "-A");
  run("commit", "-qm", "fixture state");
  if (tag !== undefined) run("tag", tag);
}

const TARGET_REF = "templates/v9.9.9";

// The workspace repo stands in for the sync runner's repo-platform
// checkout: the script resolves TARGET_REF:template/... against its CWD.
function makeWorkspace(templateContent: string | Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "preserve-owned-ws-"));
  const path = join(dir, fleetLicenseRel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, templateContent);
  initGitRepo(dir, TARGET_REF);
  return dir;
}

// The target repo whose committed state already deleted LICENSE.md: the
// file is in neither the worktree nor HEAD, which is exactly the re-seed
// precondition. A `symlinkTo` value plants a symlink instead of a file
// (the shape managed repos carry by design: CLAUDE.md -> AGENTS.md).
function makeTarget(files: Record<string, string | { symlinkTo: string }>): string {
  const base = mkdtempSync(join(tmpdir(), "preserve-owned-target-"));
  const root = join(base, "target");
  mkdirSync(root);
  writeFileSync(join(root, "README.md"), "readme\n");
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    if (typeof content === "string") writeFileSync(join(root, rel), content);
    else symlinkSync(content.symlinkTo, join(root, rel));
  }
  initGitRepo(root);
  return root;
}

function runPreserve(
  workspace: string,
  target: string,
): { exitCode: number; stdout: string; license: string | null } {
  const runnerTemp = mkdtempSync(join(tmpdir(), "preserve-owned-rt-"));
  const proc = boundedSpawnSync(["bun", script], {
    cwd: workspace,
    env: {
      ...gitFreeEnv(),
      TARGET_DIR: target,
      TARGET_REF,
      MODULES: '["uv"]',
      RUNNER_TEMP: runnerTemp,
      RECOVER: "",
      TARGET_DISPLAY: "",
      TARGET: "",
    },
  });
  const licensePath = join(target, "LICENSE.md");
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout,
    license: existsSync(licensePath) ? readFileSync(licensePath, "utf-8") : null,
  };
}

describe("preserve_repo_owned fleet-license re-seed", () => {
  test("re-seeds the CURRENT template with every variable rendered", () => {
    const workspace = makeWorkspace(licenseTemplateSource);
    const target = makeTarget({ ".github/.copier-answers.yml": goodAnswers });
    const result = runPreserve(workspace, target);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("re-seeded");
    expect(result.license).not.toBeNull();
    expect(result.license).toContain("Copyright Vivswan Shah (https://github.com/Vivswan)");
    expect(result.license).toContain("Vivswan/repo-platform");
    // The whole point of rendering from the live template: no expression
    // may survive into a fleet repo's license. If the template gained a
    // variable, teach the re-seed to render it.
    expect(result.license).not.toContain("{{");
    expect(result.license).not.toContain("{%");
  });

  test("template bytes round-trip and a multi-byte holder lands as real UTF-8", () => {
    // A non-UTF-8 byte in the template (0xE9) must survive verbatim - a
    // utf-8 decode would fold it onto U+FFFD - while a holder beyond
    // latin1 must land as its UTF-8 bytes, not be masked to a low byte.
    const marked = Buffer.concat([
      Buffer.from(licenseTemplateSource, "utf-8"),
      Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]), // caf\xe9\n
    ]);
    const workspace = makeWorkspace(marked);
    const holder = "Vivswan \u0160ah \u7814"; // beyond latin1: S-caron and a CJK ideograph
    const target = makeTarget({
      ".github/.copier-answers.yml": `copyright_holder: "${holder}"\ngithub_username: Vivswan\n`,
    });
    const result = runPreserve(workspace, target);
    expect(result.exitCode).toBe(0);
    const bytes = readFileSync(join(target, "LICENSE.md"));
    expect(bytes.includes(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toBe(true);
    expect(bytes.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false); // no U+FFFD
    expect(bytes.includes(Buffer.from(`Copyright ${holder}`, "utf-8"))).toBe(true);
  });

  test("a template variable the re-seed does not render fails loudly", () => {
    const workspace = makeWorkspace(
      `${licenseTemplateSource}\nGenerated for {{ project_name }}.\n`,
    );
    const target = makeTarget({ ".github/.copier-answers.yml": goodAnswers });
    const result = runPreserve(workspace, target);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("unrendered template expressions remain");
    expect(result.license).toBeNull();
  });

  // Every bad-answers shape fails the same way: exit 1, the one message
  // naming what is missing, no license seeded. `answers: null` is no
  // answers file at all.
  test.each([
    { reason: "no answers file", answers: null, message: "records no copyright_holder" },
    {
      reason: "answers that are not a YAML mapping",
      answers: "- not\n- a\n- mapping\n",
      message: ".github/.copier-answers.yml is unreadable",
    },
    {
      reason: "missing copyright_holder",
      answers: "github_username: Vivswan\n",
      message: "records no copyright_holder",
    },
    {
      reason: "empty copyright_holder",
      answers: 'copyright_holder: ""\ngithub_username: Vivswan\n',
      message: "records no copyright_holder",
    },
    {
      reason: "non-string copyright_holder",
      answers: "copyright_holder: 42\ngithub_username: Vivswan\n",
      message: "records no copyright_holder",
    },
    {
      reason: "missing github_username",
      answers: 'copyright_holder: "Vivswan Shah"\n',
      message: "records no github_username",
    },
    {
      reason: "empty github_username",
      answers: 'copyright_holder: "Vivswan Shah"\ngithub_username: ""\n',
      message: "records no github_username",
    },
    // Malformed but NON-EMPTY values must trip the owner-pin shape guard
    // (/^[A-Za-z0-9-]+$/): each would pass the unrendered-expression check
    // yet seed a wrong owner into the managed-marker line.
    {
      reason: "space-carrying github_username",
      answers: 'copyright_holder: "Vivswan Shah"\ngithub_username: "Vivswan Shah"\n',
      message: "records no github_username",
    },
    {
      reason: "slug-shaped github_username",
      answers: 'copyright_holder: "Vivswan Shah"\ngithub_username: "Vivswan/repo-platform"\n',
      message: "records no github_username",
    },
  ])(
    "bad recorded answers fail loudly instead of seeding template text: $reason",
    ({ answers, message }) => {
      const workspace = makeWorkspace(licenseTemplateSource);
      const target = makeTarget(answers === null ? {} : { ".github/.copier-answers.yml": answers });
      const result = runPreserve(workspace, target);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain(message);
      expect(result.license).toBeNull();
    },
  );
});

describe("preserve_repo_owned removed-splits hold", () => {
  const B = "<!-- BEGIN REPO-PLATFORM MANAGED -->";
  const E = "<!-- END REPO-PLATFORM MANAGED -->";
  const MANIFEST_REL = ".github/repo-platform-manifest.json";
  const manifest = JSON.stringify({
    files: {
      "AGENTS.md": {
        class: "split",
        grammar: "managed-region",
        begin: B,
        end: E,
        hash: null,
      },
      "CLAUDE.md": { class: "managed", hash: null },
    },
  });
  const agentsWithTail = `${B}\nmanaged\n${E}\n\n## Local agent docs\n\nlocal agents tail\n`;

  /** Run the script against a prepared target and read the hold report. */
  function runOn(target: string): { exitCode: number; stdout: string; report: string } {
    const runnerTemp = mkdtempSync(join(tmpdir(), "preserve-owned-hold-"));
    const proc = boundedSpawnSync(["bun", script], {
      cwd: dirname(target),
      env: {
        ...gitFreeEnv(),
        TARGET_DIR: target,
        TARGET_REF: "",
        MODULES: '["uv"]',
        RUNNER_TEMP: runnerTemp,
        RECOVER: "",
        TARGET_DISPLAY: "",
        TARGET: "",
        HIDE_DETAILS: "",
      },
    });
    const reportPath = join(runnerTemp, REMOVED_SPLITS_NAME);
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout + proc.stderr,
      report: existsSync(reportPath) ? readFileSync(reportPath, "utf-8") : "",
    };
  }

  function runHold(
    headFiles: Record<string, string | { symlinkTo: string }>,
    removedFromTree: string[],
  ): { exitCode: number; stdout: string; report: string } {
    // LICENSE.md present keeps the fleet-license re-seed out of the way;
    // TARGET_REF is empty so the re-seed block never resolves a build ref.
    const target = makeTarget({ "LICENSE.md": "fleet license\n", ...headFiles });
    for (const rel of removedFromTree) {
      rmSync(join(target, rel), { recursive: true });
    }
    return runOn(target);
  }

  test("a deleted split-classed file raises the hold and names the leaving half", () => {
    const result = runHold({ [MANIFEST_REL]: manifest, "AGENTS.md": agentsWithTail }, [
      "AGENTS.md",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.report).toContain("This update DELETES");
    expect(result.report).toContain("`AGENTS.md`");
    expect(result.report).toContain("local agents tail");
    expect(result.stdout).toContain("manual-review");
  });

  test("nothing removed writes an empty report (auto-merge stays possible)", () => {
    const result = runHold({ [MANIFEST_REL]: manifest, "AGENTS.md": agentsWithTail }, []);
    expect(result.exitCode).toBe(0);
    expect(result.report).toBe("");
  });

  test("a deleted managed-classed file never raises the hold (class-level rule)", () => {
    const result = runHold(
      { [MANIFEST_REL]: manifest, "AGENTS.md": agentsWithTail, "CLAUDE.md": "claude\n" },
      ["CLAUDE.md"],
    );
    expect(result.exitCode).toBe(0);
    expect(result.report).toBe("");
  });

  test("an empty repository-owned section still holds, saying nothing leaves", () => {
    const noTail = `${B}\nmanaged\n${E}\n`;
    const result = runHold({ [MANIFEST_REL]: manifest, "AGENTS.md": noTail }, ["AGENTS.md"]);
    expect(result.exitCode).toBe(0);
    expect(result.report).toContain("`AGENTS.md`");
    expect(result.report).toContain("repository-owned section is empty");
  });

  test("a deleted license without a manifest answer is held pointwise", () => {
    // No manifest at HEAD at all: the class rule cannot answer, but a
    // license deletion must still hold the PR.
    const result = runHold({ LICENSE: "old license\nlocal notice\n" }, ["LICENSE"]);
    expect(result.exitCode).toBe(0);
    expect(result.report).toContain("`LICENSE`");
    expect(result.report).toContain("does not class this file");
  });

  test("a previous copy that does not split at its markers is held as unlocatable", () => {
    const markerless = "# AGENTS.md\n\nno marker here\n";
    const result = runHold({ [MANIFEST_REL]: manifest, "AGENTS.md": markerless }, ["AGENTS.md"]);
    expect(result.exitCode).toBe(0);
    expect(result.report).toContain("`AGENTS.md`");
    expect(result.report).toContain("could not be located");
  });

  test("a symlinked HEAD manifest is unusable, never parsed as manifest text", () => {
    // `git show` answers a symlink with its TARGET TEXT, which could parse
    // as JSON (a link target literally spelled '{"files":{}}'): reading it
    // would fail OPEN with zero split declarations. headEntry's blob-only
    // read routes the shape to the fail-closed deletion axis instead.
    const result = runHold(
      {
        "manifest-real.json": manifest,
        [MANIFEST_REL]: { symlinkTo: "../manifest-real.json" },
        "AGENTS.md": agentsWithTail,
      },
      ["AGENTS.md"],
    );
    expect(result.exitCode).toBe(0);
    expect(result.report).toContain("`AGENTS.md`");
    expect(result.report).toContain("not a regular file");
  });

  test.each([
    {
      // The old bytes probe fed the answer to the marker parser as if it
      // were the previous copy.
      reason: "git show answers a symlink with its target path string",
      object: "symlink",
      head: { "REAL.md": agentsWithTail, "AGENTS.md": { symlinkTo: "REAL.md" } },
    },
    {
      reason: "git show answers a directory with tree-listing prose",
      object: "directory",
      head: { "AGENTS.md/inner.md": agentsWithTail },
    },
  ])(
    "a deleted split path that was a $object at HEAD is held as a non-blob: $reason",
    ({ object, head }) => {
      // There is no file content to split - the bullet must say that, not
      // diagnose a marker mismatch.
      const result = runHold({ [MANIFEST_REL]: manifest, ...head }, ["AGENTS.md"]);
      expect(result.exitCode).toBe(0);
      expect(result.report).toContain("`AGENTS.md`");
      expect(result.report).toContain(`carries a ${object} at this path, not a regular file`);
      expect(result.report).not.toContain("could not be located");
      expect(result.stdout).toContain("manual-review");
    },
  );

  // HEAD's manifest is damaged past reading, so the split map cannot be
  // enumerated. Checking only the two license names would auto-merge a
  // retired split file's repository-owned content away, and the tail
  // tripwire cannot cover it (it skips post-sync split paths absent at
  // HEAD before it consults HEAD's manifest). Fail closed: every deleted
  // tracked path becomes an unclassifiable candidate that forces review,
  // with headSplitEntries' refusal quoted in the report (the refusal text
  // per shape is head_manifest.test.ts's to pin).
  test.each([
    {
      reason: "not JSON",
      damaged: "{ not valid json",
      fragments: ["does not class this file"],
    },
    {
      // The one-time conversion machinery is deleted: a straggler manifest
      // still declaring a retired vintage is refused, never converted, and
      // the refusal's recovery advice rides into the body.
      reason: "a retired tail-marker grammar",
      damaged: JSON.stringify({
        files: {
          "AGENTS.md": {
            class: "split",
            grammar: "tail-marker",
            marker: "<!-- repo-platform:local-section -->",
            managed: "above",
            hash: null,
          },
        },
      }),
      fragments: ['split grammar "tail-marker"', "recover=recopy"],
    },
    {
      // JSON.parse keeps the LAST duplicate: split-then-managed for the
      // same path would silently reclassify the file managed and drop it
      // from the candidates while a retirement deletes its half.
      reason: "a duplicated key",
      damaged: `{"files": {"AGENTS.md": {"class": "split", "grammar": "managed-region", "begin": ${JSON.stringify(B)}, "end": ${JSON.stringify(E)}, "hash": null}, "AGENTS.md": {"class": "managed", "hash": null}}}`,
      fragments: ["same key twice"],
    },
    {
      // A damaged class ("spllt") read as merely non-split would drop the
      // file from the candidates and let the retirement auto-merge.
      reason: "an unknown ownership class",
      damaged: JSON.stringify({
        files: { "AGENTS.md": { class: "spllt", begin: B, end: E, hash: null } },
      }),
      fragments: ["ownership class"],
    },
  ])(
    "a damaged HEAD manifest fails closed on a deleted split file: $reason",
    ({ damaged, fragments }) => {
      const result = runHold({ [MANIFEST_REL]: damaged, "AGENTS.md": agentsWithTail }, [
        "AGENTS.md",
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.report).not.toBe("");
      expect(result.report).toContain("`AGENTS.md`");
      expect(result.report).toContain("ownership manifest was rejected");
      for (const fragment of fragments) expect(result.report).toContain(fragment);
      expect(result.stdout).toContain("manual-review");
    },
  );

  test("a hostile rejection reason is clipped and control-escaped in the report", () => {
    // The rejection message embeds decoded manifest keys, which are
    // target-controlled: a huge key must not blow the section budget and a
    // NUL must not survive into the report (it would kill gh's --body
    // argv later). The key here is 2000 chars with an embedded NUL escape.
    const hugeKey = `A\\u0000${"x".repeat(2000)}`;
    const damaged = `{"files": {"${hugeKey}": {"class": "spllt", "hash": null}}}`;
    const result = runHold({ [MANIFEST_REL]: damaged, "AGENTS.md": agentsWithTail }, ["AGENTS.md"]);
    expect(result.exitCode).toBe(0);
    expect(result.report).toContain("ownership manifest was rejected");
    expect(result.report).not.toContain("\u0000");
    expect(result.report).toContain("[clipped]");
    expect(Buffer.byteLength(result.report, "utf-8")).toBeLessThanOrEqual(16384);
    expect(result.stdout).toContain("manual-review");
  });

  test("an unreadable HEAD manifest with no deletions writes no report (no spurious hold)", () => {
    // Fail closed on the DELETION axis, not unconditionally: a damaged
    // manifest on a sync that deleted nothing has no content that could
    // have left, so it must not force review on every no-op run.
    const result = runHold({ [MANIFEST_REL]: "{ not valid json", "AGENTS.md": agentsWithTail }, []);
    expect(result.exitCode).toBe(0);
    expect(result.report).toBe("");
  });

  test("a deleted tracked name that is not valid UTF-8 is held, never read as absent", () => {
    // The unreadable-manifest fallback is the deletion axis's only
    // consumer, so the fixture damages the manifest AND carries a
    // non-UTF-8 tracked name at HEAD. macOS APFS refuses non-UTF-8
    // filenames, so the name can never touch the filesystem on the
    // machines running this suite: it enters HEAD through the index alone
    // (update-index --index-info reads raw bytes from stdin), which also
    // leaves it absent from the working tree - exactly a deletion.
    const target = makeTarget({
      "LICENSE.md": "fleet license\n",
      [MANIFEST_REL]: "{ not valid json",
    });
    const git = (args: string[], stdin?: Buffer): string => {
      const proc = boundedSpawnSync(["git", "-C", target, ...args], {
        env: gitFreeEnv(),
        stdin: stdin ?? "ignore",
      });
      if (proc.exitCode !== 0) {
        throw new Error(`git ${args[0]} failed: ${proc.stderr}`);
      }
      return proc.stdout.trim();
    };
    const oid = git(["hash-object", "-w", "--stdin"], Buffer.from("previous copy\n"));
    git(
      ["update-index", "-z", "--index-info"],
      Buffer.concat([
        Buffer.from(`100644 ${oid} 0\t`),
        Buffer.from([0x63, 0x61, 0x66, 0xe9]), // caf\xe9: 0xe9 is not valid UTF-8
        Buffer.from(" a.txt\0"), // the space pins \x20-escaping in the rendering
      ]),
    );
    git(["commit", "-qm", "carry a non-UTF-8 tracked name"]);
    const result = runOn(target);
    expect(result.exitCode).toBe(0);
    // The old behavior: the U+FFFD-mangled name probed as absent-at-HEAD,
    // the candidate was skipped, and the report stayed empty (auto-merge).
    // The space renders as \x20: CommonMark strips a code span's boundary
    // spaces, so a literal one could silently change the shown name.
    expect(result.report).toContain("caf\\xe9\\x20a.txt");
    expect(result.report).toContain("not valid UTF-8");
    expect(result.report).not.toContain(String.fromCharCode(0xfffd));
    expect(result.stdout).toContain("manual-review");
  });

  test("the whole removed-splits section stays within its byte budget with an omission notice", () => {
    // The section is bounded by BYTES as a whole (intro, bullets, fences,
    // paths, notes), not just excerpt lines - so no number of deletions
    // can blow the 64 KiB PR body.
    const files: Record<string, string> = {};
    const manifestFiles: Record<string, unknown> = {};
    const removed: string[] = [];
    for (let i = 0; i < 60; i++) {
      const rel = `doc-${i}.md`;
      const tail = Array.from(
        { length: 50 },
        (_, j) => `local line ${i}-${j} ${"x".repeat(120)}`,
      ).join("\n");
      files[rel] = `${B}\nmanaged\n${E}\n\n${tail}\n`;
      manifestFiles[rel] = {
        class: "split",
        grammar: "managed-region",
        begin: B,
        end: E,
        hash: null,
      };
      removed.push(rel);
    }
    const result = runHold(
      { [MANIFEST_REL]: JSON.stringify({ files: manifestFiles }), ...files },
      removed,
    );
    expect(result.exitCode).toBe(0);
    expect(result.report).not.toBe("");
    // The whole section - intro, bullets, framing, and the omission item -
    // is charged against the 16 KiB budget.
    expect(Buffer.byteLength(result.report, "utf-8")).toBeLessThanOrEqual(16384);
    expect(result.report).toContain("more deleted file(s) omitted");
  });
});

describe("deleted-path decode boundary", () => {
  // macOS APFS refuses non-UTF-8 filenames, so no filesystem fixture can
  // carry these names on the machines running this suite: the boundary is
  // exercised with synthetic `git diff -z`-shaped bytes here, and
  // end-to-end above via an index-only fixture that never touches disk.
  const REPLACEMENT = String.fromCharCode(0xfffd);
  const nonUtf8 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x2e, 0x74, 0x78, 0x74]); // caf\xe9.txt
  const fffdName = `weird-${REPLACEMENT}.txt`;
  const bomName = `${String.fromCharCode(0xfeff)}secret.txt`;

  test.each([
    {
      reason: "valid entries decode; a non-UTF-8 entry comes back as raw bytes, never mangled",
      input: Buffer.concat([
        Buffer.from("good.txt\0", "utf-8"),
        nonUtf8,
        Buffer.from("\0", "utf-8"),
        Buffer.from("dir/more.md\0", "utf-8"),
      ]),
      expected: { paths: ["good.txt", "dir/more.md"], undecodable: [nonUtf8] },
    },
    {
      // The discriminant is UTF-8 validity, not the replacement character:
      // a legal U+FFFD-carrying name must not be misreported as mangled.
      reason: "a name that genuinely CONTAINS U+FFFD is valid UTF-8 and stays a path",
      input: Buffer.from(`${fffdName}\0`, "utf-8"),
      expected: { paths: [fffdName], undecodable: [] },
    },
    {
      // TextDecoder's default silently drops a leading BOM; the probe would
      // then read the BOM-less spelling as absent and skip the hold.
      reason: "a leading U+FEFF survives: a BOM-stripped name is a DIFFERENT path",
      input: Buffer.from(`${bomName}\0`, "utf-8"),
      expected: { paths: [bomName], undecodable: [] },
    },
    {
      reason: "empty output yields nothing",
      input: Buffer.alloc(0),
      expected: { paths: [], undecodable: [] },
    },
    {
      reason: "bare NULs yield nothing",
      input: Buffer.from("\0\0", "utf-8"),
      expected: { paths: [], undecodable: [] },
    },
    {
      reason: "a final entry without a trailing NUL still decodes",
      input: Buffer.from("a.txt\0b.txt", "utf-8"),
      expected: { paths: ["a.txt", "b.txt"], undecodable: [] },
    },
  ])("decodeTrackedPathBytes: $reason", ({ input, expected }) => {
    expect(decodeTrackedPathBytes(input)).toEqual(expected);
  });
});
