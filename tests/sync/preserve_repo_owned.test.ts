// The fleet-license re-seed path of preserve_repo_owned.ts: a committed
// LICENSE.md deletion in a repo without the custom-license module is
// re-seeded from the target build ref, rendered from the repo's recorded
// answers. The happy path renders the repo's REAL template source, so a
// template edit that adds a variable the re-seed does not render fails
// here first instead of seeding template text into a fleet repo.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { REMOVED_SPLITS_NAME } from "../../.github/scripts/sync/section_files.ts";

const script = join(import.meta.dir, "../../.github/scripts/sync/preserve_repo_owned.ts");
const repoRoot = join(import.meta.dir, "..", "..");

// The build ref carries the license under the composed template/ prefix;
// the source of truth lives under templates/base/.
const licenseName = "{% if 'custom-license' not in modules %}LICENSE.md{% endif %}.jinja";
const fleetLicenseRel = join("template", licenseName);
const licenseTemplateSource = readFileSync(join(repoRoot, "templates/base", licenseName), "utf-8");

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
    const proc = Bun.spawnSync(["git", "-C", dir, ...args], {
      env: gitFreeEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
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
// precondition.
function makeTarget(files: Record<string, string>): string {
  const base = mkdtempSync(join(tmpdir(), "preserve-owned-target-"));
  const root = join(base, "target");
  mkdirSync(root);
  writeFileSync(join(root, "README.md"), "readme\n");
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  initGitRepo(root);
  return root;
}

function runPreserve(
  workspace: string,
  target: string,
): { exitCode: number | null; stdout: string; license: string | null } {
  const runnerTemp = mkdtempSync(join(tmpdir(), "preserve-owned-rt-"));
  const proc = Bun.spawnSync(["bun", script], {
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
    stdout: "pipe",
    stderr: "pipe",
  });
  const licensePath = join(target, "LICENSE.md");
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    license: existsSync(licensePath) ? readFileSync(licensePath, "utf-8") : null,
  };
}

describe("preserve_repo_owned fleet-license re-seed", () => {
  test("re-seeds the CURRENT template with every variable rendered", () => {
    const workspace = makeWorkspace(licenseTemplateSource);
    const target = makeTarget({ ".copier-answers.yml": goodAnswers });
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
      ".copier-answers.yml": `copyright_holder: "${holder}"\ngithub_username: Vivswan\n`,
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
    const target = makeTarget({ ".copier-answers.yml": goodAnswers });
    const result = runPreserve(workspace, target);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("unrendered template expressions remain");
    expect(result.license).toBeNull();
  });

  test("a missing answers file fails loudly instead of seeding template text", () => {
    const workspace = makeWorkspace(licenseTemplateSource);
    const target = makeTarget({});
    const result = runPreserve(workspace, target);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("records no copyright_holder");
    expect(result.license).toBeNull();
  });

  test("an answers file that is not a YAML mapping fails as unreadable", () => {
    const workspace = makeWorkspace(licenseTemplateSource);
    const target = makeTarget({ ".copier-answers.yml": "- not\n- a\n- mapping\n" });
    const result = runPreserve(workspace, target);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(".copier-answers.yml is unreadable");
    expect(result.license).toBeNull();
  });

  const badHolders: Record<string, string> = {
    missing: "github_username: Vivswan\n",
    empty: 'copyright_holder: ""\ngithub_username: Vivswan\n',
    "non-string": "copyright_holder: 42\ngithub_username: Vivswan\n",
  };
  for (const [shape, answers] of Object.entries(badHolders)) {
    test(`${shape} copyright_holder fails loudly`, () => {
      const workspace = makeWorkspace(licenseTemplateSource);
      const target = makeTarget({ ".copier-answers.yml": answers });
      const result = runPreserve(workspace, target);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("records no copyright_holder");
      expect(result.license).toBeNull();
    });
  }

  const badUsernames: Record<string, string> = {
    missing: `copyright_holder: "Vivswan Shah"\n`,
    empty: `copyright_holder: "Vivswan Shah"\ngithub_username: ""\n`,
    // Malformed but NON-EMPTY values must trip the owner-pin shape guard
    // (/^[A-Za-z0-9-]+$/): each would pass the unrendered-expression check
    // yet seed a wrong owner into the managed-marker line.
    "space-carrying": `copyright_holder: "Vivswan Shah"\ngithub_username: "Vivswan Shah"\n`,
    "slug-shaped": `copyright_holder: "Vivswan Shah"\ngithub_username: "Vivswan/repo-platform"\n`,
  };
  for (const [shape, answers] of Object.entries(badUsernames)) {
    test(`${shape} github_username fails loudly`, () => {
      const workspace = makeWorkspace(licenseTemplateSource);
      const target = makeTarget({ ".copier-answers.yml": answers });
      const result = runPreserve(workspace, target);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("records no github_username");
      expect(result.license).toBeNull();
    });
  }
});

describe("preserve_repo_owned removed-splits hold", () => {
  const SENTINEL = "<!-- repo-platform:local-section -->";
  const MANIFEST_REL = ".github/repo-platform-manifest.json";
  const manifest = JSON.stringify({
    files: {
      "AGENTS.md": {
        class: "split",
        grammar: "tail-marker",
        marker: SENTINEL,
        managed: "above",
        hash: null,
      },
      "CLAUDE.md": { class: "managed", hash: null },
    },
  });
  const agentsWithTail = `# AGENTS.md\n\nmanaged\n\n${SENTINEL}\n\n## Local agent docs\n\nlocal agents tail\n`;

  function runHold(
    headFiles: Record<string, string>,
    removedFromTree: string[],
  ): { exitCode: number | null; stdout: string; report: string } {
    // LICENSE.md present keeps the fleet-license re-seed out of the way;
    // TARGET_REF is empty so the re-seed block never resolves a build ref.
    const target = makeTarget({ "LICENSE.md": "fleet license\n", ...headFiles });
    for (const rel of removedFromTree) {
      rmSync(join(target, rel));
    }
    const runnerTemp = mkdtempSync(join(tmpdir(), "preserve-owned-hold-"));
    const proc = Bun.spawnSync(["bun", script], {
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
      stdout: "pipe",
      stderr: "pipe",
    });
    const reportPath = join(runnerTemp, REMOVED_SPLITS_NAME);
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout.toString() + proc.stderr.toString(),
      report: existsSync(reportPath) ? readFileSync(reportPath, "utf-8") : "",
    };
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
    const noTail = `# AGENTS.md\n\nmanaged\n\n${SENTINEL}\n`;
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

  test("a previous copy that does not split at its marker is held as unlocatable", () => {
    const markerless = "# AGENTS.md\n\nno marker here\n";
    const result = runHold({ [MANIFEST_REL]: manifest, "AGENTS.md": markerless }, ["AGENTS.md"]);
    expect(result.exitCode).toBe(0);
    expect(result.report).toContain("`AGENTS.md`");
    expect(result.report).toContain("could not be located");
  });

  test("an unreadable HEAD manifest fails closed: a deleted split file still holds the PR", () => {
    // HEAD's manifest is damaged past parsing, so the split map cannot be
    // enumerated. Checking only the two license names would auto-merge a
    // retired split file's repository-owned content away, and the tail
    // tripwire cannot cover it (it skips post-sync split paths absent at
    // HEAD before it consults HEAD's manifest). Fail closed: every deleted
    // tracked path becomes an unclassifiable candidate that forces review.
    const result = runHold({ [MANIFEST_REL]: "{ not valid json", "AGENTS.md": agentsWithTail }, [
      "AGENTS.md",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.report).not.toBe("");
    expect(result.report).toContain("`AGENTS.md`");
    expect(result.report).toContain("does not class this file");
    expect(result.report).toContain("ownership manifest was rejected");
    expect(result.stdout).toContain("manual-review");
  });

  test("a duplicate-key HEAD manifest fails closed with the reason in the report", () => {
    // JSON.parse keeps the LAST duplicate: split-then-managed for the same
    // path would silently reclassify the file managed and drop it from the
    // candidates while a retirement deletes its repository-owned half.
    const dup = `{"files": {"AGENTS.md": {"class": "split", "grammar": "tail-marker", "marker": ${JSON.stringify(SENTINEL)}, "managed": "above", "hash": null}, "AGENTS.md": {"class": "managed", "hash": null}}}`;
    const result = runHold({ [MANIFEST_REL]: dup, "AGENTS.md": agentsWithTail }, ["AGENTS.md"]);
    expect(result.exitCode).toBe(0);
    expect(result.report).toContain("`AGENTS.md`");
    expect(result.report).toContain("ownership manifest was rejected");
    expect(result.report).toContain("same key twice");
    expect(result.stdout).toContain("manual-review");
  });

  test("an unknown ownership class fails closed with the reason in the report", () => {
    // A damaged class ("spllt") read as merely non-split would drop the
    // file from the candidates and let the retirement auto-merge.
    const damaged = JSON.stringify({
      files: { "AGENTS.md": { class: "spllt", marker: SENTINEL, managed: "above", hash: null } },
    });
    const result = runHold({ [MANIFEST_REL]: damaged, "AGENTS.md": agentsWithTail }, ["AGENTS.md"]);
    expect(result.exitCode).toBe(0);
    expect(result.report).toContain("`AGENTS.md`");
    expect(result.report).toContain("ownership manifest was rejected");
    expect(result.report).toContain("ownership class");
    expect(result.stdout).toContain("manual-review");
  });

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
      files[rel] = `# managed\n\n${SENTINEL}\n\n${tail}\n`;
      manifestFiles[rel] = {
        class: "split",
        grammar: "tail-marker",
        marker: SENTINEL,
        managed: "above",
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
