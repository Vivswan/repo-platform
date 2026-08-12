import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  carryGitignoreLocal,
  carryLocalContent,
  carryManagedTail,
} from "../../.github/scripts/sync/preserve_local_content.ts";

const script = join(import.meta.dir, "../../.github/scripts/sync/preserve_local_content.ts");
const repoRoot = join(import.meta.dir, "..", "..");

const SENTINEL = "<!-- repo-platform:local-section -->";
const HASH_SENTINEL = "# repo-platform:local-section";
const LOCAL_BEGIN = "# BEGIN REPOSITORY LOCAL";
const LOCAL_END = "# END REPOSITORY LOCAL";
const MANAGED_BEGIN = "# BEGIN REPO-PLATFORM MANAGED";
const MANAGED_END = "# END REPO-PLATFORM MANAGED";
const ALL_GITIGNORE_MARKERS = [LOCAL_BEGIN, LOCAL_END, MANAGED_BEGIN, MANAGED_END];

const agentsRender = `# AGENTS.md\n\nfresh managed guidance\n\n${SENTINEL}\n`;
const agentsTarget = `# AGENTS.md\n\nold managed guidance\n\n${SENTINEL}\n\n## Project docs\n\nrepo-local instructions\n`;

const gitignoreManagedNew = `${MANAGED_BEGIN}\n*.new\n${MANAGED_END}\n`;
const gitignoreRender = `${LOCAL_BEGIN}\n# Add repository-specific ignore patterns in this section only.\n\n${LOCAL_END}\n\n${gitignoreManagedNew}`;
const gitignoreTarget = `${LOCAL_BEGIN}\n/repo-local-cache/\nsecret.env\n\n${LOCAL_END}\n\n${MANAGED_BEGIN}\n*.old\n${MANAGED_END}\n`;

const contributingRender = `# Contributing\n\nfresh managed prefix\n\n${SENTINEL}\n`;
const contributingTarget = `# Contributing\n\nold managed prefix\n\n${SENTINEL}\n\n## Local dev setup\n\nrun the local thing\n`;

const editorconfigRender = `root = true\n\n[*]\ncharset = utf-8\n\n${HASH_SENTINEL}\n`;
const editorconfigTarget = `root = true\n\n[*]\nend_of_line = lf\n\n${HASH_SENTINEL}\n\n[legacy/**.js]\nindent_size = 3\n`;

const codeownersRender = `* @vivswan\n\n${HASH_SENTINEL}\n`;
const codeownersTarget = `* @oldname\n\n${HASH_SENTINEL}\n\n/security/ @security-team\n`;

describe("carryManagedTail", () => {
  test("unchanged managed content keeps the target whole", () => {
    const target = `${contributingRender}\n## Local dev setup\n\nrepo tail\n`;
    expect(carryManagedTail(contributingRender, target)).toEqual({
      kind: "kept-whole",
      content: target,
      extraSentinels: false,
    });
  });

  test("diverged managed content re-appends the target's tail", () => {
    expect(carryManagedTail(contributingRender, contributingTarget)).toEqual({
      content: `${contributingRender}\n## Local dev setup\n\nrun the local thing\n`,
      kind: "tail-appended",
      extraSentinels: false,
      managedHalfDiffers: true,
    });
  });

  test("never-customized target (blank tail below its sentinel) keeps the render", () => {
    expect(carryManagedTail(agentsRender, `old stuff\n${SENTINEL}\n\n`)).toBeNull();
  });

  test("identical target keeps the render", () => {
    expect(carryManagedTail(contributingRender, contributingRender)).toBeNull();
  });

  test("legacy target WITHOUT the sentinel is kept whole below a marked appendix", () => {
    // The sentinel is newer than many fleet repos' last successful sync;
    // a legacy copy with real guidance below a plain heading must not
    // lose it silently.
    const target = "# AGENTS.md\n\nold managed guidance\n\n## Project docs\n\nrepo-local notes\n";
    const carry = carryManagedTail(agentsRender, target);
    expect(carry?.kind).toBe("appendix");
    expect(carry?.content).toStartWith(agentsRender);
    expect(carry?.content).toContain("repo-platform:recovery-appendix");
    expect(carry?.content).toEndWith(target);
  });

  test("render not ending at a sentinel is never used as a split anchor", () => {
    const render = `docs\n${SENTINEL}\ntrailing managed line\n`;
    const carry = carryManagedTail(render, `docs\n${SENTINEL}\nrepo tail\n`);
    expect(carry?.kind).toBe("appendix");
  });

  test("duplicate sentinels in the target: split at the FIRST, flag the extras", () => {
    const target = `${SENTINEL}\nbetween the markers\n${SENTINEL}\nafter the last\n`;
    expect(carryManagedTail(agentsRender, target)).toEqual({
      content: `${agentsRender}between the markers\n${SENTINEL}\nafter the last\n`,
      kind: "tail-appended",
      extraSentinels: true,
      managedHalfDiffers: true,
    });
  });

  test("hash-comment sentinel works (.gitattributes spelling)", () => {
    const render = `*.png binary\n${HASH_SENTINEL}\n`;
    const target = `*.jpg binary\n${HASH_SENTINEL}\n*.dat binary\n`;
    expect(carryManagedTail(render, target)).toEqual({
      content: `${render}*.dat binary\n`,
      kind: "tail-appended",
      extraSentinels: false,
      managedHalfDiffers: true,
    });
  });

  test("appendix in a hash-sentinel file uses hash comments, not an HTML comment", () => {
    const render = `*.png binary\n${HASH_SENTINEL}\n`;
    const carry = carryManagedTail(render, "legacy attributes, no sentinel\n");
    expect(carry?.kind).toBe("appendix");
    expect(carry?.content).toContain("# repo-platform:recovery-appendix");
    expect(carry?.content).not.toContain("<!--");
  });

  test("render without a trailing newline still joins cleanly", () => {
    const render = `docs\n${SENTINEL}`;
    expect(carryManagedTail(render, `old\n${SENTINEL}\nrepo tail\n`)).toEqual({
      content: `docs\n${SENTINEL}\nrepo tail\n`,
      kind: "tail-appended",
      extraSentinels: false,
      managedHalfDiffers: true,
    });
  });

  test("target sentinel as the very last line (no trailing newline) means no tail", () => {
    expect(carryManagedTail(agentsRender, `old stuff\n${SENTINEL}`)).toBeNull();
  });

  test("kept-whole still flags duplicate sentinels in the tail", () => {
    const target = `${agentsRender}\nrepo tail\n${SENTINEL}\nstale duplicate\n`;
    expect(carryManagedTail(agentsRender, target)).toEqual({
      kind: "kept-whole",
      content: target,
      extraSentinels: true,
    });
  });

  test("a second recovery over an appendix result keeps it whole (same template)", () => {
    const legacy = "old copy without a sentinel\nrepo-local notes\n";
    const first = carryManagedTail(agentsRender, legacy);
    expect(first?.kind).toBe("appendix");
    expect(carryManagedTail(agentsRender, first?.content ?? "")?.kind).toBe("kept-whole");
  });

  test("a second recovery after the template moved keeps a single appendix", () => {
    const legacy = "old copy without a sentinel\nrepo-local notes\n";
    const first = carryManagedTail(agentsRender, legacy);
    const newerRender = `# AGENTS.md\n\nnewer managed guidance\n\n${SENTINEL}\n`;
    const second = carryManagedTail(newerRender, first?.content ?? "");
    expect(second?.kind).toBe("tail-appended");
    expect(second?.content.split("repo-platform:recovery-appendix").length).toBe(2);
    expect(second?.content).toStartWith(newerRender);
    expect(second?.content).toEndWith(legacy);
  });

  test("CRLF sentinel lines are recognized and the tail keeps its bytes", () => {
    const render = `docs\r\n${SENTINEL}\r\n`;
    const target = `old\r\n${SENTINEL}\r\nrepo tail\r\n`;
    expect(carryManagedTail(render, target)).toEqual({
      content: `${render}repo tail\r\n`,
      kind: "tail-appended",
      extraSentinels: false,
      managedHalfDiffers: true,
    });
  });

  test("a pristine managed half above the sentinel is not flagged", () => {
    // Blank lines below the render's sentinel keep the target from being a
    // plain prefix match, but the halves above the marker are identical.
    const render = `docs\n${SENTINEL}\n\n`;
    expect(carryManagedTail(render, `docs\n${SENTINEL}\nrepo tail\n`)).toEqual({
      content: `${render}repo tail\n`,
      kind: "tail-appended",
      extraSentinels: false,
      managedHalfDiffers: false,
    });
  });
});

describe("carryGitignoreLocal", () => {
  test("carries the target's LOCAL section body into the fresh render", () => {
    expect(carryGitignoreLocal(gitignoreRender, gitignoreTarget)).toEqual({
      content: `${LOCAL_BEGIN}\n/repo-local-cache/\nsecret.env\n\n${LOCAL_END}\n\n${gitignoreManagedNew}`,
      disposition: "spliced",
    });
  });

  test("an emptied LOCAL body carries too (the repo removed the placeholder)", () => {
    const target = `${LOCAL_BEGIN}\n${LOCAL_END}\n`;
    expect(carryGitignoreLocal(gitignoreRender, target)).toEqual({
      content: `${LOCAL_BEGIN}\n${LOCAL_END}\n\n${gitignoreManagedNew}`,
      disposition: "spliced",
    });
  });

  test("identical bodies keep the render", () => {
    expect(carryGitignoreLocal(gitignoreRender, gitignoreRender)).toBeNull();
  });

  test("render without the markers keeps the render", () => {
    expect(carryGitignoreLocal("*.new\n", gitignoreTarget)).toBeNull();
  });

  test("a blank previous copy has nothing to preserve and keeps the render", () => {
    expect(carryGitignoreLocal(gitignoreRender, "\n\n")).toBeNull();
  });

  test("a second recovery over an appendix result is stable (single appendix)", () => {
    const first = carryGitignoreLocal(gitignoreRender, "/repo-local-cache/\n*.old\n");
    expect(first?.disposition).toBe("appendix");
    const second = carryGitignoreLocal(gitignoreRender, first?.content ?? "");
    expect(second?.disposition).toBe("spliced");
    expect(second?.content).toBe(first?.content ?? "");
    expect(second?.content.split("repo-platform:recovery-appendix").length).toBe(2);
  });

  // No shape of previous copy may lose local entries silently: every
  // mangled-marker form lands inside the fresh LOCAL section below the
  // appendix comment, commented out, with marker text neutralized so the
  // validator's exactly-once rule holds for ALL FOUR markers.
  const oldManaged = `${MANAGED_BEGIN}\n*.old\n${MANAGED_END}\n`;
  const mangledShapes: Record<string, string> = {
    "markers absent (target differs from the render)": `/repo-local-cache/\n${oldManaged}`,
    "duplicate BEGIN": `${LOCAL_BEGIN}\n/repo-local-cache/\n${LOCAL_BEGIN}\n${LOCAL_END}\n${oldManaged}`,
    "missing END": `${LOCAL_BEGIN}\n/repo-local-cache/\n${oldManaged}`,
    "reversed markers": `${LOCAL_END}\n/repo-local-cache/\n${LOCAL_BEGIN}\n${oldManaged}`,
    // The validator counts SUBSTRINGS: a second BEGIN with trailing
    // whitespace is not an exact marker line, but classifying this clean
    // would silently discard the content between the two BEGINs.
    "duplicate BEGIN with trailing whitespace": `${LOCAL_BEGIN} \n/repo-local-cache/\n${LOCAL_BEGIN}\n${LOCAL_END}\n${oldManaged}`,
  };
  for (const [shape, target] of Object.entries(mangledShapes)) {
    test(`${shape} preserves the previous copy in the LOCAL section`, () => {
      const carry = carryGitignoreLocal(gitignoreRender, target);
      expect(carry?.disposition).toBe("appendix");
      expect(carry?.content).toContain("# repo-platform:recovery-appendix");
      // Carried entries are inert: commented out, never silently active.
      expect(carry?.content).toContain("# /repo-local-cache/");
      // The appendix sits INSIDE the region: content still ends with the
      // render's END marker and managed section.
      expect(carry?.content).toEndWith(`${LOCAL_END}\n\n${gitignoreManagedNew}`);
      // validate_generated_files' exactly-once rule (substring-counted)
      // must hold for all four markers on the result.
      for (const marker of ALL_GITIGNORE_MARKERS) {
        expect(carry?.content.split(marker).length).toBe(2);
      }
    });
  }

  test("marker text buried mid-line in the previous copy is neutralized", () => {
    const target = `dir/${LOCAL_BEGIN}\n/repo-local-cache/\n`;
    const carry = carryGitignoreLocal(gitignoreRender, target);
    expect(carry?.disposition).toBe("appendix");
    expect(carry?.content).toContain("# dir/BEGIN-REPOSITORY-LOCAL");
    for (const marker of ALL_GITIGNORE_MARKERS) {
      expect(carry?.content.split(marker).length).toBe(2);
    }
  });

  test("marker text inside a clean-looking LOCAL body still takes the appendix", () => {
    // Splicing a body that carries MANAGED marker text would duplicate it
    // next to the render's own managed section and fail validation.
    const target = `${LOCAL_BEGIN}\npath/${MANAGED_BEGIN}\n${LOCAL_END}\n`;
    const carry = carryGitignoreLocal(gitignoreRender, target);
    expect(carry?.disposition).toBe("appendix");
    for (const marker of ALL_GITIGNORE_MARKERS) {
      expect(carry?.content.split(marker).length).toBe(2);
    }
  });
});

describe("carryLocalContent", () => {
  test("identical render and target is a no-op", () => {
    expect(carryLocalContent("AGENTS.md", agentsRender, agentsRender)).toBeNull();
  });

  test("a de-rendered sentinel file (render == HEAD after recopy) is untouched", () => {
    // recopy deletes nothing: a module-deselected file keeps its HEAD
    // content, so render === target and nothing changes.
    expect(carryLocalContent("AGENTS.md", agentsTarget, agentsTarget)).toBeNull();
  });

  test("a non-prefix render that dropped the sentinel does not resurrect the tail", () => {
    expect(carryLocalContent("AGENTS.md", "no marker anymore\n", agentsTarget)).toBeNull();
  });

  test("a prefix doc is routed even when its render lacks the sentinel", () => {
    // Prefix-ness, not the sentinel, is the trio's mechanism: the carry
    // still runs and falls back loudly instead of dropping the tail.
    const carried = carryLocalContent("SECURITY.md", "redesigned, no marker\n", contributingTarget);
    expect(carried?.note).toContain("recovery-appendix");
  });

  test("carry into an unchanged managed prefix keeps the target whole", () => {
    const render = `A\n${SENTINEL}\n`;
    const target = `A\n${SENTINEL}\nsame tail\n`;
    expect(carryLocalContent("AGENTS.md", render, target)?.note).toContain("kept whole");
  });

  test("routes .gitignore to the LOCAL-section carry", () => {
    expect(carryLocalContent(".gitignore", gitignoreRender, gitignoreTarget)?.note).toContain(
      "REPOSITORY LOCAL",
    );
  });

  test("a mangled-marker .gitignore gets the appendix note", () => {
    const target = `${LOCAL_BEGIN}\n/repo-local-cache/\n`;
    expect(carryLocalContent(".gitignore", gitignoreRender, target)?.note).toContain(
      "recovery-appendix",
    );
  });

  test("routes the prefix docs to the managed-tail carry", () => {
    for (const rel of ["SECURITY.md", "CONTRIBUTING.md", "LICENSE.md"]) {
      expect(carryLocalContent(rel, contributingRender, contributingTarget)?.note).toContain(
        "repository tail re-appended",
      );
    }
  });

  test("routes other sentinel files to the managed-tail carry", () => {
    expect(carryLocalContent(".gitattributes", agentsRender, agentsTarget)?.note).toContain(
      "repository tail re-appended",
    );
  });

  test("routes a customized-below-sentinel .editorconfig to the managed-tail carry", () => {
    const carried = carryLocalContent(".editorconfig", editorconfigRender, editorconfigTarget);
    expect(carried?.note).toContain("repository tail re-appended");
    expect(carried?.content).toBe(`${editorconfigRender}\n[legacy/**.js]\nindent_size = 3\n`);
  });

  test("routes a customized-below-sentinel CODEOWNERS to the managed-tail carry", () => {
    const carried = carryLocalContent(".github/CODEOWNERS", codeownersRender, codeownersTarget);
    expect(carried?.note).toContain("repository tail re-appended");
    expect(carried?.content).toBe(`${codeownersRender}\n/security/ @security-team\n`);
  });

  test("an edited managed half is flagged as not carried on the tail carry", () => {
    // codeownersTarget's above-marker half differs from the render: the
    // tail is carried, the managed-half edit is dropped, and the drop is
    // loud in the summary.
    const carried = carryLocalContent(".github/CODEOWNERS", codeownersRender, codeownersTarget);
    expect(carried?.note).toContain("managed half above the marker differed");
  });

  test("a pristine managed half gets no managed-half note", () => {
    const render = `docs\n${SENTINEL}\n\n`;
    const carried = carryLocalContent("AGENTS.md", render, `docs\n${SENTINEL}\nrepo tail\n`);
    expect(carried?.note).toContain("repository tail re-appended");
    expect(carried?.note).not.toContain("managed half");
  });

  test("legacy sentinel-less .editorconfig takes a hash-comment appendix", () => {
    const legacy = "root = true\n\n[*]\nindent_size = 3\n";
    const carried = carryLocalContent(".editorconfig", editorconfigRender, legacy);
    expect(carried?.note).toContain("recovery-appendix");
    expect(carried?.content).toContain("# repo-platform:recovery-appendix");
    expect(carried?.content).not.toContain("<!--");
    expect(carried?.content).toEndWith(legacy);
  });

  test("legacy sentinel-less CODEOWNERS takes a hash-comment appendix", () => {
    const legacy = "* @oldname\n/security/ @security-team\n";
    const carried = carryLocalContent(".github/CODEOWNERS", codeownersRender, legacy);
    expect(carried?.note).toContain("recovery-appendix");
    expect(carried?.content).toContain("# repo-platform:recovery-appendix");
    expect(carried?.content).not.toContain("<!--");
    expect(carried?.content).toEndWith(legacy);
  });

  test("legacy sentinel-less target gets the appendix note", () => {
    const target = "old file, marker predates it\nrepo-local notes\n";
    expect(carryLocalContent("AGENTS.md", agentsRender, target)?.note).toContain(
      "recovery-appendix",
    );
  });

  test("duplicate target sentinels add the review note", () => {
    const target = `${SENTINEL}\nbetween\n${SENTINEL}\nafter\n`;
    expect(carryLocalContent("AGENTS.md", agentsRender, target)?.note).toContain(
      "more than one local-section marker",
    );
  });
});

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

function initGitRepo(dir: string): void {
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
  run("commit", "-qm", "pre-render state");
}

function runScript(
  root: string,
  extraArgs: string[] = [],
): { exitCode: number | null; stdout: string; stderr: string; summary: string } {
  const summaryPath = join(root, "..", "local-carryover.md");
  const proc = Bun.spawnSync(
    ["bun", script, "--summary", summaryPath, "--root", root, ...extraArgs],
    { env: gitFreeEnv(), stdout: "pipe", stderr: "pipe" },
  );
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    summary: existsSync(summaryPath) ? readFileSync(summaryPath, "utf-8") : "",
  };
}

function makeTarget(files: Record<string, string>): string {
  const base = mkdtempSync(join(tmpdir(), "preserve-local-"));
  const root = join(base, "target");
  mkdirSync(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

describe("preserve_local_content script", () => {
  test("carries all repo-local regions over a simulated recopy", () => {
    const root = makeTarget({
      // Pre-render target state, committed as HEAD below.
      "AGENTS.md": agentsTarget,
      ".gitignore": gitignoreTarget,
      "CONTRIBUTING.md": contributingTarget,
      "SECURITY.md": `old security prefix\n${SENTINEL}\n\n`,
      ".editorconfig": editorconfigTarget,
      ".github/CODEOWNERS": codeownersTarget,
      ".typography-allow.local": "docs/legacy/\n",
    });
    initGitRepo(root);
    // The recopy overwrites the managed files in the worktree.
    writeFileSync(join(root, "AGENTS.md"), agentsRender);
    writeFileSync(join(root, ".gitignore"), gitignoreRender);
    writeFileSync(join(root, "CONTRIBUTING.md"), contributingRender);
    writeFileSync(join(root, "SECURITY.md"), `fresh security prefix\n${SENTINEL}\n`);
    writeFileSync(join(root, ".editorconfig"), editorconfigRender);
    writeFileSync(join(root, ".github/CODEOWNERS"), codeownersRender);

    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toBe(
      `${agentsRender}\n## Project docs\n\nrepo-local instructions\n`,
    );
    expect(readFileSync(join(root, ".gitignore"), "utf-8")).toContain("/repo-local-cache/");
    expect(readFileSync(join(root, ".gitignore"), "utf-8")).toContain(gitignoreManagedNew);
    expect(readFileSync(join(root, "CONTRIBUTING.md"), "utf-8")).toBe(
      `${contributingRender}\n## Local dev setup\n\nrun the local thing\n`,
    );
    // The hash-sentinel pair from the live incident: local indent rules
    // and the security-critical owners block survive under fresh renders.
    expect(readFileSync(join(root, ".editorconfig"), "utf-8")).toBe(
      `${editorconfigRender}\n[legacy/**.js]\nindent_size = 3\n`,
    );
    expect(readFileSync(join(root, ".github/CODEOWNERS"), "utf-8")).toBe(
      `${codeownersRender}\n/security/ @security-team\n`,
    );
    // Never customized below the marker: the fresh render stands.
    expect(readFileSync(join(root, "SECURITY.md"), "utf-8")).toBe(
      `fresh security prefix\n${SENTINEL}\n`,
    );
    // Separate repo-owned file, never rendered: untouched.
    expect(readFileSync(join(root, ".typography-allow.local"), "utf-8")).toBe("docs/legacy/\n");
    expect(result.summary).toContain("- `AGENTS.md`:");
    expect(result.summary).toContain("- `.gitignore`:");
    expect(result.summary).toContain("- `CONTRIBUTING.md`:");
    expect(result.summary).toContain("- `.editorconfig`:");
    expect(result.summary).toContain("- `.github/CODEOWNERS`:");
    expect(result.summary).not.toContain("SECURITY.md");
  });

  test("legacy sentinel-less AGENTS.md flows through to a marked appendix", () => {
    const legacy = "# AGENTS.md\n\nold guidance\n\n## Project docs\n\nrepo-local notes\n";
    const root = makeTarget({ "AGENTS.md": legacy });
    initGitRepo(root);
    writeFileSync(join(root, "AGENTS.md"), agentsRender);
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    const agents = readFileSync(join(root, "AGENTS.md"), "utf-8");
    expect(agents).toStartWith(agentsRender);
    expect(agents).toContain("repo-platform:recovery-appendix");
    expect(agents).toEndWith(legacy);
    expect(result.summary).toContain("recovery-appendix");
  });

  test("a sentinel file new in the render (absent from HEAD) is left as rendered", () => {
    const root = makeTarget({ "README.md": "readme\n" });
    initGitRepo(root);
    writeFileSync(join(root, "AGENTS.md"), agentsRender);
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toBe(agentsRender);
    expect(result.summary).toBe("");
  });

  test("--hide-details prints a count, not paths", () => {
    const root = makeTarget({ "AGENTS.md": agentsTarget });
    initGitRepo(root);
    writeFileSync(join(root, "AGENTS.md"), agentsRender);
    const result = runScript(root, ["--hide-details", "true"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("carried repo-local content back into 1 file(s)");
    expect(result.stdout).not.toContain("AGENTS.md");
    expect(result.summary).toContain("- `AGENTS.md`:");
  });

  test("fails closed when HEAD is unreadable (not a git repository)", () => {
    const root = makeTarget({ "AGENTS.md": agentsRender });
    const result = runScript(root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("cannot resolve HEAD");
  });

  test("writes an empty summary when nothing needed carrying", () => {
    const root = makeTarget({ "AGENTS.md": agentsRender });
    initGitRepo(root);
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("");
    expect(result.stdout).toContain("no repo-local content needed carrying over");
  });
});

// End-to-end against a REAL template render and a REAL `copier recopy
// --overwrite`, mirroring reusable-template-sync.yml's recovery path:
// build the staging tree, generate a repo from it, customize the
// sanctioned repo-local regions, commit, recopy (which resets them - the
// live defect), then assert the carry restores every region. Requires
// copier on PATH, so it runs where copier exists (locally and on the sync
// runner); CI's script-tests job skips it, and the always-on CI coverage
// is upgrade_path_test.sh's recovery leg, which drives the same carry
// against a real recopy in the upgrade-path job.
const hasCopier = Bun.which("copier") !== null;

describe.skipIf(!hasCopier)("preserve_local_content end-to-end (copier recopy)", () => {
  test(
    "restores the repo-local regions a recovery re-render wipes",
    () => {
      const base = mkdtempSync(join(tmpdir(), "preserve-local-e2e-"));
      const tree = join(base, "bt");
      const target = join(base, "out");
      const run = (cmd: string[], cwd?: string) => {
        const proc = Bun.spawnSync(cmd, { cwd, env: gitFreeEnv(), stdout: "pipe", stderr: "pipe" });
        if (proc.exitCode !== 0) {
          throw new Error(
            `${cmd.join(" ")} failed:\n${proc.stdout.toString()}\n${proc.stderr.toString()}`,
          );
        }
        return proc.stdout.toString();
      };
      run([
        "bun",
        join(repoRoot, ".github/scripts/build-branches/branch_tree.ts"),
        "--dest",
        tree,
        "--channel",
        "staging",
      ]);
      run(["git", "-C", tree, "init", "-b", "build"]);
      run(["git", "-C", tree, "add", "-A"]);
      run(["git", "-C", tree, "-c", "user.name=t", "-c", "user.email=t@e.c", "commit", "-qm", "b"]);
      const copierArgs = [
        "--defaults",
        "--trust",
        "-d",
        "project_name=X",
        "-d",
        "description=Y",
        "-d",
        "modules=[agents, uv]",
        "-d",
        "private=false",
      ];
      run(["copier", "copy", tree, target, "--vcs-ref", "HEAD", ...copierArgs]);

      // Customize every sanctioned repo-local region, plus the repo-owned
      // exemptions file, and commit: this is the pre-recovery repo state.
      const tails: Record<string, string> = {
        "AGENTS.md": "\n## Project docs\n\nrepo-local agent guidance\n",
        "CONTRIBUTING.md": "\n## Local dev setup\n\nbun install && bun test\n",
        "SECURITY.md": "\n## Scope\n\nrepo-local threat model\n",
        "LICENSE.md": "\nThird-party components: repo-local notice\n",
        ".gitattributes": "*.repo-local binary\n",
        ".editorconfig": "\n[legacy/**.js]\nindent_size = 3\n",
        ".github/CODEOWNERS": "\n/security/ @security-team\n",
      };
      for (const [rel, tail] of Object.entries(tails)) {
        const path = join(target, rel);
        writeFileSync(path, readFileSync(path, "utf-8") + tail);
      }
      const gitignorePath = join(target, ".gitignore");
      writeFileSync(
        gitignorePath,
        readFileSync(gitignorePath, "utf-8").replace(
          `\n${LOCAL_END}`,
          `/repo-local-cache/\n\n${LOCAL_END}`,
        ),
      );
      writeFileSync(join(target, ".typography-allow.local"), "docs/legacy/\n");
      initGitRepo(target);

      // The recovery re-render, exactly as apply_update.ts issues it.
      run(["copier", "recopy", "--overwrite", "--vcs-ref", "HEAD", ...copierArgs], target);
      // Defect reproduced: the re-render reset the local regions.
      expect(readFileSync(join(target, "AGENTS.md"), "utf-8")).not.toContain(
        "repo-local agent guidance",
      );
      expect(readFileSync(gitignorePath, "utf-8")).not.toContain("/repo-local-cache/");
      // recopy deletes nothing: the separate repo-owned file survives.
      expect(existsSync(join(target, ".typography-allow.local"))).toBe(true);

      const summaryPath = join(base, "local-carryover.md");
      run(["bun", script, "--summary", summaryPath, "--root", target]);

      for (const [rel, tail] of Object.entries(tails)) {
        expect(readFileSync(join(target, rel), "utf-8")).toEndWith(tail);
      }
      expect(readFileSync(join(target, "AGENTS.md"), "utf-8")).toContain(SENTINEL);
      expect(readFileSync(gitignorePath, "utf-8")).toContain("/repo-local-cache/");
      const summary = readFileSync(summaryPath, "utf-8");
      for (const rel of [...Object.keys(tails), ".gitignore"]) {
        expect(summary).toContain(`- \`${rel}\`:`);
      }
      // The whole carried tree must still validate.
      const validate = Bun.spawnSync(
        ["bun", join(repoRoot, "actions/validate-template/validate_generated_files.ts"), target],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(validate.exitCode).toBe(0);
    },
    { timeout: 300000 },
  );
});
