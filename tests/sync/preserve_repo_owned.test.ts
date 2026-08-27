// The fleet-license re-seed path of preserve_repo_owned.ts: a committed
// LICENSE.md deletion in a repo without the custom-license module is
// re-seeded from the target build ref, rendered from the repo's recorded
// answers. The happy path renders the repo's REAL template source, so a
// template edit that adds a variable the re-seed does not render fails
// here first instead of seeding template text into a fleet repo.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
