import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  carryLocalRegion,
  carryManagedTail,
  splitEntries,
} from "../../.github/scripts/sync/preserve_local_content.ts";
import { GITIGNORE_REGION } from "../../scripts/gitignore_local.ts";

const script = join(import.meta.dir, "../../.github/scripts/sync/preserve_local_content.ts");
const repoRoot = join(import.meta.dir, "..", "..");

const SENTINEL = "<!-- repo-platform:local-section -->";
const HASH_SENTINEL = "# repo-platform:local-section";
const LOCAL_BEGIN = "# BEGIN REPOSITORY LOCAL";
const LOCAL_END = "# END REPOSITORY LOCAL";
const MANAGED_BEGIN = "# BEGIN REPO-PLATFORM MANAGED";
const MANAGED_END = "# END REPO-PLATFORM MANAGED";
const ALL_GITIGNORE_MARKERS = [LOCAL_BEGIN, LOCAL_END, MANAGED_BEGIN, MANAGED_END];

const MANIFEST_REL = ".github/repo-platform-manifest.json";

interface SplitSpec {
  path: string;
  grammar: "tail-marker" | "bounded-region";
  marker: string;
}

/** A manifest carrying the given split entries, in the shape
 * compose_template.ts emits (grammar next to the legacy marker/managed
 * pair; bounded-region entries carry the region marker strings). */
function manifestJson(entries: SplitSpec[]): string {
  return JSON.stringify({
    files: Object.fromEntries(
      entries.map((e) => [
        e.path,
        e.grammar === "tail-marker"
          ? { class: "split", grammar: e.grammar, marker: e.marker, managed: "above", hash: null }
          : {
              class: "split",
              grammar: e.grammar,
              marker: e.marker,
              managed: "below",
              managed_end: MANAGED_END,
              local_begin: LOCAL_BEGIN,
              local_end: LOCAL_END,
              hash: null,
            },
      ]),
    ),
  });
}

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
    expect(carryManagedTail(contributingRender, target, SENTINEL)).toEqual({
      kind: "kept-whole",
      content: target,
      extraMarkers: false,
    });
  });

  test("diverged managed content re-appends the target's tail", () => {
    expect(carryManagedTail(contributingRender, contributingTarget, SENTINEL)).toEqual({
      content: `${contributingRender}\n## Local dev setup\n\nrun the local thing\n`,
      kind: "tail-appended",
      extraMarkers: false,
      managedHalfDiffers: true,
    });
  });

  test("never-customized target (empty tail below its marker) keeps the render", () => {
    expect(carryManagedTail(agentsRender, `old stuff\n${SENTINEL}\n`, SENTINEL)).toBeNull();
  });

  test("a whitespace-only tail is carried, not silently dropped", () => {
    // The tail is byte-owned by the repository: even blanks below the
    // marker ride through rather than vanish without a disposition.
    expect(carryManagedTail(agentsRender, `old stuff\n${SENTINEL}\n\n`, SENTINEL)).toEqual({
      content: `${agentsRender}\n`,
      kind: "tail-appended",
      extraMarkers: false,
      managedHalfDiffers: true,
    });
  });

  test("identical target keeps the render", () => {
    expect(carryManagedTail(contributingRender, contributingRender, SENTINEL)).toBeNull();
  });

  test("legacy target WITHOUT the marker is kept whole below a marked appendix", () => {
    // The marker is newer than many fleet repos' last successful sync;
    // a legacy copy with real guidance below a plain heading must not
    // lose it silently.
    const target = "# AGENTS.md\n\nold managed guidance\n\n## Project docs\n\nrepo-local notes\n";
    const carry = carryManagedTail(agentsRender, target, SENTINEL);
    expect(carry?.kind).toBe("appendix");
    expect(carry?.content).toStartWith(agentsRender);
    expect(carry?.content).toContain("repo-platform:recovery-appendix");
    expect(carry?.content).toEndWith(target);
  });

  test("render not ending at the marker is never used as a split anchor", () => {
    const render = `docs\n${SENTINEL}\ntrailing managed line\n`;
    const carry = carryManagedTail(render, `docs\n${SENTINEL}\nrepo tail\n`, SENTINEL);
    expect(carry?.kind).toBe("appendix");
  });

  test("only the DECLARED marker anchors the split (another spelling does not)", () => {
    // The target carries the hash spelling; the entry declares the HTML
    // one. Nothing anchors, so the loud appendix carries the whole copy.
    const carry = carryManagedTail(agentsRender, `old\n${HASH_SENTINEL}\nrepo tail\n`, SENTINEL);
    expect(carry?.kind).toBe("appendix");
  });

  test("duplicate markers in the target: split at the FIRST, flag the extras", () => {
    const target = `${SENTINEL}\nbetween the markers\n${SENTINEL}\nafter the last\n`;
    expect(carryManagedTail(agentsRender, target, SENTINEL)).toEqual({
      content: `${agentsRender}between the markers\n${SENTINEL}\nafter the last\n`,
      kind: "tail-appended",
      extraMarkers: true,
      managedHalfDiffers: true,
    });
  });

  test("hash-comment marker works (.gitattributes spelling)", () => {
    const render = `*.png binary\n${HASH_SENTINEL}\n`;
    const target = `*.jpg binary\n${HASH_SENTINEL}\n*.dat binary\n`;
    expect(carryManagedTail(render, target, HASH_SENTINEL)).toEqual({
      content: `${render}*.dat binary\n`,
      kind: "tail-appended",
      extraMarkers: false,
      managedHalfDiffers: true,
    });
  });

  test("appendix in a hash-marker file uses hash comments, not an HTML comment", () => {
    const render = `*.png binary\n${HASH_SENTINEL}\n`;
    const carry = carryManagedTail(render, "legacy attributes, no marker\n", HASH_SENTINEL);
    expect(carry?.kind).toBe("appendix");
    expect(carry?.content).toContain("# repo-platform:recovery-appendix");
    expect(carry?.content).not.toContain("<!--");
  });

  test("render without a trailing newline still joins cleanly", () => {
    const render = `docs\n${SENTINEL}`;
    expect(carryManagedTail(render, `old\n${SENTINEL}\nrepo tail\n`, SENTINEL)).toEqual({
      content: `docs\n${SENTINEL}\nrepo tail\n`,
      kind: "tail-appended",
      extraMarkers: false,
      managedHalfDiffers: true,
    });
  });

  test("target marker as the very last line (no trailing newline) means no tail", () => {
    expect(carryManagedTail(agentsRender, `old stuff\n${SENTINEL}`, SENTINEL)).toBeNull();
  });

  test("kept-whole still flags duplicate markers in the tail", () => {
    const target = `${agentsRender}\nrepo tail\n${SENTINEL}\nstale duplicate\n`;
    expect(carryManagedTail(agentsRender, target, SENTINEL)).toEqual({
      kind: "kept-whole",
      content: target,
      extraMarkers: true,
    });
  });

  test("a second recovery over an appendix result keeps it whole (same template)", () => {
    const legacy = "old copy without a marker\nrepo-local notes\n";
    const first = carryManagedTail(agentsRender, legacy, SENTINEL);
    expect(first?.kind).toBe("appendix");
    expect(carryManagedTail(agentsRender, first?.content ?? "", SENTINEL)?.kind).toBe("kept-whole");
  });

  test("a second recovery after the template moved keeps a single appendix", () => {
    const legacy = "old copy without a marker\nrepo-local notes\n";
    const first = carryManagedTail(agentsRender, legacy, SENTINEL);
    const newerRender = `# AGENTS.md\n\nnewer managed guidance\n\n${SENTINEL}\n`;
    const second = carryManagedTail(newerRender, first?.content ?? "", SENTINEL);
    expect(second?.kind).toBe("tail-appended");
    expect(second?.content.split("repo-platform:recovery-appendix").length).toBe(2);
    expect(second?.content).toStartWith(newerRender);
    expect(second?.content).toEndWith(legacy);
  });

  test("CRLF marker lines are recognized and the tail keeps its bytes", () => {
    const render = `docs\r\n${SENTINEL}\r\n`;
    const target = `old\r\n${SENTINEL}\r\nrepo tail\r\n`;
    expect(carryManagedTail(render, target, SENTINEL)).toEqual({
      content: `${render}repo tail\r\n`,
      kind: "tail-appended",
      extraMarkers: false,
      managedHalfDiffers: true,
    });
  });

  test("a pristine managed half above the marker is not flagged", () => {
    // Blank lines below the render's marker keep the target from being a
    // plain prefix match, but the halves above the marker are identical.
    const render = `docs\n${SENTINEL}\n\n`;
    expect(carryManagedTail(render, `docs\n${SENTINEL}\nrepo tail\n`, SENTINEL)).toEqual({
      content: `${render}repo tail\n`,
      kind: "tail-appended",
      extraMarkers: false,
      managedHalfDiffers: false,
    });
  });
});

describe("carryLocalRegion", () => {
  test("carries the target's local region body into the fresh render", () => {
    expect(carryLocalRegion(gitignoreRender, gitignoreTarget, GITIGNORE_REGION)).toEqual({
      content: `${LOCAL_BEGIN}\n/repo-local-cache/\nsecret.env\n\n${LOCAL_END}\n\n${gitignoreManagedNew}`,
      disposition: "spliced",
    });
  });

  test("an emptied local body carries too (the repo removed the placeholder)", () => {
    const target = `${LOCAL_BEGIN}\n${LOCAL_END}\n`;
    expect(carryLocalRegion(gitignoreRender, target, GITIGNORE_REGION)).toEqual({
      content: `${LOCAL_BEGIN}\n${LOCAL_END}\n\n${gitignoreManagedNew}`,
      disposition: "spliced",
    });
  });

  test("identical bodies keep the render", () => {
    expect(carryLocalRegion(gitignoreRender, gitignoreRender, GITIGNORE_REGION)).toBeNull();
  });

  test("render without the markers keeps the render", () => {
    expect(carryLocalRegion("*.new\n", gitignoreTarget, GITIGNORE_REGION)).toBeNull();
  });

  test("a blank previous copy has nothing to preserve and keeps the render", () => {
    expect(carryLocalRegion(gitignoreRender, "\n\n", GITIGNORE_REGION)).toBeNull();
  });

  test("a second recovery over an appendix result is stable (single appendix)", () => {
    const first = carryLocalRegion(
      gitignoreRender,
      "/repo-local-cache/\n*.old\n",
      GITIGNORE_REGION,
    );
    expect(first?.disposition).toBe("appendix");
    const second = carryLocalRegion(gitignoreRender, first?.content ?? "", GITIGNORE_REGION);
    expect(second?.disposition).toBe("spliced");
    expect(second?.content).toBe(first?.content ?? "");
    expect(second?.content.split("repo-platform:recovery-appendix").length).toBe(2);
  });

  test("a different declared marker set slices the same way (grammar as data)", () => {
    // A future bounded-region file with its own marker lines: the carry
    // takes the grammar from the entry, so nothing degrades to appendix.
    const markers = {
      begin: "// BEGIN LOCAL",
      end: "// END LOCAL",
      all: ["// BEGIN LOCAL", "// END LOCAL", "// BEGIN MANAGED", "// END MANAGED"],
    };
    const render = `// BEGIN LOCAL\n// default\n// END LOCAL\n// BEGIN MANAGED\nnew\n// END MANAGED\n`;
    const target = `// BEGIN LOCAL\nlocal-entry\n// END LOCAL\n// BEGIN MANAGED\nold\n// END MANAGED\n`;
    expect(carryLocalRegion(render, target, markers)).toEqual({
      content: `// BEGIN LOCAL\nlocal-entry\n// END LOCAL\n// BEGIN MANAGED\nnew\n// END MANAGED\n`,
      disposition: "spliced",
    });
  });

  // No shape of previous copy may lose local entries silently: every
  // mangled-marker form lands inside the fresh local region below the
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
    test(`${shape} preserves the previous copy in the local region`, () => {
      const carry = carryLocalRegion(gitignoreRender, target, GITIGNORE_REGION);
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
    const carry = carryLocalRegion(gitignoreRender, target, GITIGNORE_REGION);
    expect(carry?.disposition).toBe("appendix");
    expect(carry?.content).toContain("# dir/BEGIN-REPOSITORY-LOCAL");
    for (const marker of ALL_GITIGNORE_MARKERS) {
      expect(carry?.content.split(marker).length).toBe(2);
    }
  });

  test("marker text inside a clean-looking local body still takes the appendix", () => {
    // Splicing a body that carries MANAGED marker text would duplicate it
    // next to the render's own managed section and fail validation.
    const target = `${LOCAL_BEGIN}\npath/${MANAGED_BEGIN}\n${LOCAL_END}\n`;
    const carry = carryLocalRegion(gitignoreRender, target, GITIGNORE_REGION);
    expect(carry?.disposition).toBe("appendix");
    for (const marker of ALL_GITIGNORE_MARKERS) {
      expect(carry?.content.split(marker).length).toBe(2);
    }
  });

  test("a space-free marker is still neutralized in the appendix", () => {
    const markers = {
      begin: "#LOCAL-BEGIN",
      end: "#LOCAL-END",
      all: ["#LOCAL-BEGIN", "#LOCAL-END"],
    };
    const render = "#LOCAL-BEGIN\n# default\n#LOCAL-END\nmanaged\n";
    const carry = carryLocalRegion(render, "#LOCAL-BEGIN\n/entry/\n", markers);
    expect(carry?.disposition).toBe("appendix");
    expect(carry?.content.split("#LOCAL-BEGIN").length).toBe(2);
  });

  test("markers whose neutralized forms collide fail loudly, never invalidly", () => {
    // "# X Y" neutralizes to "X-Y", which the line-commenting then turns
    // into "# X-Y" - recreating the OTHER marker. The postcondition must
    // refuse to deliver a file the validator's exactly-once rule rejects.
    const markers = { begin: "# X-Y", end: "# X Y", all: ["# X-Y", "# X Y"] };
    const render = "# X-Y\n# default\n# X Y\nmanaged\n";
    expect(() => carryLocalRegion(render, "# X Y\n/entry/\n", markers)).toThrow(
      "collide under neutralization",
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

/** Write the post-recopy state into the working tree: the fresh renders
 * plus the fresh render's manifest (recopy always writes both). */
function writeRecopy(root: string, entries: SplitSpec[], renders: Record<string, string>): void {
  mkdirSync(join(root, dirname(MANIFEST_REL)), { recursive: true });
  writeFileSync(join(root, MANIFEST_REL), manifestJson(entries));
  for (const [rel, content] of Object.entries(renders)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
}

const RECOPY_ENTRIES: SplitSpec[] = [
  { path: "AGENTS.md", grammar: "tail-marker", marker: SENTINEL },
  { path: ".gitignore", grammar: "bounded-region", marker: MANAGED_BEGIN },
  { path: "CONTRIBUTING.md", grammar: "tail-marker", marker: SENTINEL },
  { path: "SECURITY.md", grammar: "tail-marker", marker: SENTINEL },
  { path: ".editorconfig", grammar: "tail-marker", marker: HASH_SENTINEL },
  { path: ".github/CODEOWNERS", grammar: "tail-marker", marker: HASH_SENTINEL },
];

describe("preserve_local_content script (recopy mode)", () => {
  test("carries all repo-local regions over a simulated recopy", () => {
    const root = makeTarget({
      // Pre-render target state, committed as HEAD below.
      "AGENTS.md": agentsTarget,
      ".gitignore": gitignoreTarget,
      "CONTRIBUTING.md": contributingTarget,
      "SECURITY.md": `old security prefix\n${SENTINEL}\n`,
      ".editorconfig": editorconfigTarget,
      ".github/CODEOWNERS": codeownersTarget,
      ".typography-allow.local": "docs/legacy/\n",
    });
    initGitRepo(root);
    // The recopy overwrites the managed files in the worktree and renders
    // the manifest naming every split file.
    writeRecopy(root, RECOPY_ENTRIES, {
      "AGENTS.md": agentsRender,
      ".gitignore": gitignoreRender,
      "CONTRIBUTING.md": contributingRender,
      "SECURITY.md": `fresh security prefix\n${SENTINEL}\n`,
      ".editorconfig": editorconfigRender,
      ".github/CODEOWNERS": codeownersRender,
    });

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
    // The hash-marker pair from the live incident: local indent rules
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

  test("non-UTF-8 bytes survive the recopy carry byte-for-byte", () => {
    const agentsOld = `# AGENTS.md\n\nold managed guidance\n\n${SENTINEL}\n`;
    const tailBytes = Buffer.concat([Buffer.from("\ncaf"), Buffer.from([0xe9]), Buffer.from("\n")]);
    const root = makeTarget({});
    writeFileSync(join(root, "AGENTS.md"), Buffer.concat([Buffer.from(agentsOld), tailBytes]));
    initGitRepo(root);
    // The recopy overwrites the file with the fresh render.
    writeRecopy(root, [{ path: "AGENTS.md", grammar: "tail-marker", marker: SENTINEL }], {
      "AGENTS.md": agentsRender,
    });
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    const carried = readFileSync(join(root, "AGENTS.md"));
    expect(carried.equals(Buffer.concat([Buffer.from(agentsRender), tailBytes]))).toBe(true);
  });

  test("legacy marker-less AGENTS.md flows through to a marked appendix", () => {
    const legacy = "# AGENTS.md\n\nold guidance\n\n## Project docs\n\nrepo-local notes\n";
    const root = makeTarget({ "AGENTS.md": legacy });
    initGitRepo(root);
    writeRecopy(root, [{ path: "AGENTS.md", grammar: "tail-marker", marker: SENTINEL }], {
      "AGENTS.md": agentsRender,
    });
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    const agents = readFileSync(join(root, "AGENTS.md"), "utf-8");
    expect(agents).toStartWith(agentsRender);
    expect(agents).toContain("repo-platform:recovery-appendix");
    expect(agents).toEndWith(legacy);
    expect(result.summary).toContain("recovery-appendix");
  });

  test("a split file new in the render (absent from HEAD) is left as rendered", () => {
    const root = makeTarget({ "README.md": "readme\n" });
    initGitRepo(root);
    writeRecopy(root, [{ path: "AGENTS.md", grammar: "tail-marker", marker: SENTINEL }], {
      "AGENTS.md": agentsRender,
    });
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toBe(agentsRender);
    expect(result.summary).toBe("");
  });

  test("a marker-bearing file not declared split in the manifest is untouched", () => {
    // The manifest, not a marker scan, drives the file list.
    const root = makeTarget({ "NOTES.md": `note\n${SENTINEL}\nlocal tail\n` });
    initGitRepo(root);
    writeRecopy(root, [], { "NOTES.md": `fresh note\n${SENTINEL}\n` });
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "NOTES.md"), "utf-8")).toBe(`fresh note\n${SENTINEL}\n`);
    expect(result.summary).toBe("");
  });

  test("a working tree without the recopied manifest fails loudly", () => {
    const root = makeTarget({ "AGENTS.md": agentsTarget });
    initGitRepo(root);
    const result = runScript(root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("needs the recopied render's manifest");
  });

  test("a split entry whose file is missing from the recopied tree fails loudly", () => {
    const root = makeTarget({ "AGENTS.md": agentsTarget });
    initGitRepo(root);
    writeRecopy(root, [{ path: "GHOST.md", grammar: "tail-marker", marker: SENTINEL }], {});
    const result = runScript(root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("manifest and render disagree");
  });

  test("--hide-details prints a count, not paths", () => {
    const root = makeTarget({ "AGENTS.md": agentsTarget });
    initGitRepo(root);
    writeRecopy(root, [{ path: "AGENTS.md", grammar: "tail-marker", marker: SENTINEL }], {
      "AGENTS.md": agentsRender,
    });
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
    writeRecopy(root, [{ path: "AGENTS.md", grammar: "tail-marker", marker: SENTINEL }], {
      "AGENTS.md": agentsRender,
    });
    const result = runScript(root);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("");
    expect(result.stdout).toContain("no repo-local content needed carrying over");
  });
});

describe("splitEntries", () => {
  const tailEntry = (over: Record<string, unknown> = {}) => ({
    class: "split",
    grammar: "tail-marker",
    marker: SENTINEL,
    managed: "above",
    hash: null,
    ...over,
  });

  test("returns the split entries with their grammar union shapes", () => {
    const manifest = JSON.stringify({
      files: {
        "AGENTS.md": tailEntry(),
        ".gitignore": {
          class: "split",
          grammar: "bounded-region",
          marker: MANAGED_BEGIN,
          managed: "below",
          managed_end: MANAGED_END,
          local_begin: LOCAL_BEGIN,
          local_end: LOCAL_END,
          hash: null,
        },
        ".github/workflows/ci.yml": { class: "managed", hash: null },
        ".github/workflows/checks.yml": { class: "starter" },
      },
    });
    expect(splitEntries(manifest, "m")).toEqual([
      { path: "AGENTS.md", grammar: "tail-marker", marker: SENTINEL },
      {
        path: ".gitignore",
        grammar: "bounded-region",
        marker: MANAGED_BEGIN,
        begin: LOCAL_BEGIN,
        end: LOCAL_END,
        all: [LOCAL_BEGIN, LOCAL_END, MANAGED_BEGIN, MANAGED_END],
      },
    ]);
  });

  test("throws on a split entry with no grammar (a pre-grammar manifest)", () => {
    const manifest = JSON.stringify({
      files: { "AGENTS.md": { class: "split", marker: SENTINEL, managed: "above", hash: null } },
    });
    expect(() => splitEntries(manifest, "m")).toThrow("declares no grammar");
  });

  test("throws on an unknown grammar instead of degrading", () => {
    const manifest = JSON.stringify({
      files: { "AGENTS.md": tailEntry({ grammar: "prefix" }) },
    });
    expect(() => splitEntries(manifest, "m")).toThrow('unknown grammar "prefix"');
  });

  test("throws when the grammar and the managed side disagree", () => {
    const manifest = JSON.stringify({ files: { "AGENTS.md": tailEntry({ managed: "below" }) } });
    expect(() => splitEntries(manifest, "m")).toThrow("manifest is inconsistent");
  });

  test("throws on a bounded-region entry missing its region marker strings", () => {
    const manifest = JSON.stringify({
      files: {
        ".gitignore": {
          class: "split",
          grammar: "bounded-region",
          marker: MANAGED_BEGIN,
          managed: "below",
          hash: null,
        },
      },
    });
    expect(() => splitEntries(manifest, "m")).toThrow("region marker strings");
  });

  test("throws on a non-ASCII marker (latin1 file bytes could never match it)", () => {
    const manifest = JSON.stringify({
      files: { "AGENTS.md": tailEntry({ marker: "# local § section" }) },
    });
    expect(() => splitEntries(manifest, "m")).toThrow("printable-ASCII");
  });

  test("throws on a split path that could escape the target root", () => {
    for (const path of ["../victim", "a/../../victim", "/etc/victim", "a//b"]) {
      const manifest = JSON.stringify({ files: { [path]: tailEntry() } });
      expect(() => splitEntries(manifest, "m")).toThrow("not a clean relative path");
    }
  });

  test("throws on non-JSON input and on a files-less document", () => {
    expect(() => splitEntries("not json", "m")).toThrow("does not parse as JSON");
    expect(() => splitEntries("{}", "m")).toThrow("no top-level 'files' mapping");
  });
});

// The managed-tail carry anchors its split on the render ENDING at the
// declared marker line, so every tail-marker template source must keep the
// marker as its last non-empty line - managed content below it would be
// carried into repositories' local tails as if it were repo-owned.
describe("split-above templates end at the marker", () => {
  test("the templates with repository-owned tails end with the exact marker line", () => {
    const templatesDir = join(repoRoot, "templates");
    const templated: [string, string][] = [
      [
        join(templatesDir, "base", "{% if not private %}CONTRIBUTING.md{% endif %}.jinja"),
        SENTINEL,
      ],
      [join(templatesDir, "base", "SECURITY.md.jinja"), SENTINEL],
      [
        join(
          templatesDir,
          "base",
          "{% if 'custom-license' not in modules %}LICENSE.md{% endif %}.jinja",
        ),
        SENTINEL,
      ],
      [join(templatesDir, "base", ".gitattributes.jinja"), HASH_SENTINEL],
      [join(templatesDir, "base", ".editorconfig.jinja"), HASH_SENTINEL],
      [join(templatesDir, "base", ".github", "CODEOWNERS.jinja"), HASH_SENTINEL],
      [join(templatesDir, "agents", "AGENTS.md.jinja"), SENTINEL],
    ];
    for (const [path, sentinel] of templated) {
      const lines = readFileSync(path, "utf-8").split("\n");
      const lastNonEmpty = lines.filter((line) => line.trim().length > 0).at(-1);
      expect(lastNonEmpty).toBe(sentinel);
    }
  });
});

// Render mode: the primary sync path. The working tree holds copier's
// MERGED result, which the rebuild must DISCARD - every fixture below
// plants junk there to prove the output comes from (render-new, HEAD)
// only. HEAD is the committed pre-update state; render-old/render-new are
// clean renders at the old and new template refs.
describe("preserve_local_content render mode", () => {
  const agentsOld = `# AGENTS.md\n\nold managed guidance\n\n${SENTINEL}\n`;
  const securityOld = `old security prefix\n${SENTINEL}\n`;
  const securityNew = `fresh security prefix\n${SENTINEL}\n`;
  const gitignoreOldRender = `${LOCAL_BEGIN}\n# Add repository-specific ignore patterns in this section only.\n\n${LOCAL_END}\n\n${MANAGED_BEGIN}\n*.old\n${MANAGED_END}\n`;
  const MERGE_JUNK = "merged result to discard\n";
  const AGENTS_ENTRY: SplitSpec = { path: "AGENTS.md", grammar: "tail-marker", marker: SENTINEL };
  const SECURITY_ENTRY: SplitSpec = {
    path: "SECURITY.md",
    grammar: "tail-marker",
    marker: SENTINEL,
  };
  const GITIGNORE_ENTRY: SplitSpec = {
    path: ".gitignore",
    grammar: "bounded-region",
    marker: MANAGED_BEGIN,
  };

  function makeRenderPair(
    entries: SplitSpec[],
    newFiles: Record<string, string>,
    oldFiles: Record<string, string>,
  ): { renderDir: string; oldRenderDir: string } {
    const base = mkdtempSync(join(tmpdir(), "preserve-render-"));
    const renderDir = join(base, "render-new");
    const oldRenderDir = join(base, "render-old");
    for (const [dir, files] of [
      [renderDir, { ...newFiles, [MANIFEST_REL]: manifestJson(entries) }],
      [oldRenderDir, oldFiles],
    ] as const) {
      mkdirSync(dir, { recursive: true });
      for (const [rel, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), content);
      }
    }
    return { renderDir, oldRenderDir };
  }

  function runRender(root: string, renderDir: string, oldRenderDir: string) {
    const reviewPath = join(root, "..", "carry-review.txt");
    const rebuiltPath = join(root, "..", "rebuilt-paths.txt");
    const result = runScript(root, [
      "--render-dir",
      renderDir,
      "--old-render-dir",
      oldRenderDir,
      "--needs-review",
      reviewPath,
      "--rebuilt-paths",
      rebuiltPath,
    ]);
    return {
      ...result,
      review: existsSync(reviewPath) ? readFileSync(reviewPath, "utf-8") : "",
      rebuilt: existsSync(rebuiltPath) ? readFileSync(rebuiltPath, "utf-8") : "",
    };
  }

  test("rebuilds a split file from the clean render and HEAD, discarding the merge", () => {
    const root = makeTarget({ "AGENTS.md": agentsTarget });
    initGitRepo(root);
    writeFileSync(join(root, "AGENTS.md"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [AGENTS_ENTRY],
      { "AGENTS.md": agentsRender },
      { "AGENTS.md": agentsOld },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    // Managed half byte-equal to render-new, tail byte-equal to HEAD's.
    expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toBe(
      `${agentsRender}\n## Project docs\n\nrepo-local instructions\n`,
    );
    expect(result.summary).toContain("- `AGENTS.md`:");
    expect(result.summary).toContain("rebuilt structurally");
    // A template change to the managed half is routine, not a local edit:
    // nothing to review, the PR stays auto-merge-eligible.
    expect(result.review).toBe("");
  });

  test("a marker-bearing file not declared split in the manifest is untouched", () => {
    const root = makeTarget({ "AGENTS.md": agentsTarget, "NOTES.md": `note\n${SENTINEL}\n` });
    initGitRepo(root);
    writeFileSync(join(root, "NOTES.md"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [AGENTS_ENTRY],
      { "AGENTS.md": agentsRender },
      { "AGENTS.md": agentsOld },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    // The manifest, not a marker scan, drives the file list.
    expect(readFileSync(join(root, "NOTES.md"), "utf-8")).toBe(MERGE_JUNK);
  });

  test("an edit inside the managed half is reset to the fresh render and flagged", () => {
    const root = makeTarget({ "SECURITY.md": `old security prefix EDITED\n${SENTINEL}\n` });
    initGitRepo(root);
    writeFileSync(join(root, "SECURITY.md"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [SECURITY_ENTRY],
      { "SECURITY.md": securityNew },
      { "SECURITY.md": securityOld },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    // Managed halves are template-owned: byte-equal to render-new.
    expect(readFileSync(join(root, "SECURITY.md"), "utf-8")).toBe(securityNew);
    expect(result.summary).toContain("RESET to the fresh render");
    expect(result.review).toContain("SECURITY.md: managed-half edits reset");
  });

  test("a routine template change to the managed half is not read as a local edit", () => {
    const root = makeTarget({ "SECURITY.md": `${securityOld}\n## Scope\n\nrepo tail\n` });
    initGitRepo(root);
    writeFileSync(join(root, "SECURITY.md"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [SECURITY_ENTRY],
      { "SECURITY.md": securityNew },
      { "SECURITY.md": securityOld },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "SECURITY.md"), "utf-8")).toBe(
      `${securityNew}\n## Scope\n\nrepo tail\n`,
    );
    expect(result.review).toBe("");
    expect(result.summary).not.toContain("RESET");
  });

  test("a bounded-region entry routes to the local-region carry", () => {
    const root = makeTarget({ ".gitignore": gitignoreTarget });
    initGitRepo(root);
    writeFileSync(join(root, ".gitignore"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [GITIGNORE_ENTRY],
      { ".gitignore": gitignoreRender },
      { ".gitignore": gitignoreOldRender },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    const rebuilt = readFileSync(join(root, ".gitignore"), "utf-8");
    expect(rebuilt).toContain("/repo-local-cache/");
    expect(rebuilt).toEndWith(gitignoreManagedNew);
    expect(result.summary).toContain("repository-local region restored");
    expect(result.review).toBe("");
  });

  test("an edit inside .gitignore's managed section is reset and flagged", () => {
    const target = `${LOCAL_BEGIN}\n# Add repository-specific ignore patterns in this section only.\n\n${LOCAL_END}\n\n${MANAGED_BEGIN}\n*.old\nhand-added-in-managed/\n${MANAGED_END}\n`;
    const root = makeTarget({ ".gitignore": target });
    initGitRepo(root);
    writeFileSync(join(root, ".gitignore"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [GITIGNORE_ENTRY],
      { ".gitignore": gitignoreRender },
      { ".gitignore": gitignoreOldRender },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    const rebuilt = readFileSync(join(root, ".gitignore"), "utf-8");
    expect(rebuilt).toEndWith(gitignoreManagedNew);
    expect(rebuilt).not.toContain("hand-added-in-managed/");
    expect(result.review).toContain(".gitignore: managed-half edits reset");
  });

  test("a split file absent from HEAD is written as the clean render", () => {
    const root = makeTarget({ "README.md": "readme\n" });
    initGitRepo(root);
    writeFileSync(join(root, "AGENTS.md"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [AGENTS_ENTRY],
      { "AGENTS.md": agentsRender },
      {},
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toBe(agentsRender);
    expect(result.summary).toBe("");
    expect(result.review).toBe("");
  });

  test("an unsplittable previous copy takes the appendix and flags review", () => {
    const legacy = "# AGENTS.md\n\nold guidance, no marker\n\nrepo-local notes\n";
    const root = makeTarget({ "AGENTS.md": legacy });
    initGitRepo(root);
    writeFileSync(join(root, "AGENTS.md"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [AGENTS_ENTRY],
      { "AGENTS.md": agentsRender },
      { "AGENTS.md": agentsOld },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    const rebuilt = readFileSync(join(root, "AGENTS.md"), "utf-8");
    expect(rebuilt).toStartWith(agentsRender);
    expect(rebuilt).toContain("repo-platform:recovery-appendix");
    expect(rebuilt).toEndWith(legacy);
    expect(result.review).toContain("AGENTS.md: recovery-appendix");
  });

  test("duplicate markers in the previous copy flag review", () => {
    const target = `${agentsOld}\ntail\n${SENTINEL}\nstale duplicate\n`;
    const root = makeTarget({ "AGENTS.md": target });
    initGitRepo(root);
    writeFileSync(join(root, "AGENTS.md"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [AGENTS_ENTRY],
      { "AGENTS.md": agentsRender },
      { "AGENTS.md": agentsOld },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    expect(result.review).toContain("AGENTS.md: duplicate split markers");
  });

  test("a previous copy whose managed marker is gone is unverifiable, not clean", () => {
    // Clean LOCAL markers, but the managed BEGIN marker is missing: the
    // LOCAL body splices fine, yet whatever sat where the managed section
    // should be is dropped - that drop must reach review, not auto-merge.
    const target = `${LOCAL_BEGIN}\n/repo-local-cache/\n${LOCAL_END}\n\nunmarked old managed content\n`;
    const root = makeTarget({ ".gitignore": target });
    initGitRepo(root);
    writeFileSync(join(root, ".gitignore"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [GITIGNORE_ENTRY],
      { ".gitignore": gitignoreRender },
      { ".gitignore": gitignoreOldRender },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    expect(result.review).toContain(".gitignore: managed half unverifiable");
    expect(result.summary).toContain("could not be located");
  });

  test("a HEAD file with no old-render baseline is unverifiable, not clean", () => {
    // The template starts splitting a path the repo already owned: the
    // tail carries, but the pre-marker content is replaced with no old
    // render to prove it was template content - review, not auto-merge.
    const root = makeTarget({ "AGENTS.md": agentsTarget });
    initGitRepo(root);
    writeFileSync(join(root, "AGENTS.md"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [AGENTS_ENTRY],
      { "AGENTS.md": agentsRender },
      {},
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    expect(result.review).toContain("AGENTS.md: managed half unverifiable");
  });

  test("a repo that pre-applied the new managed half is kept whole without a reset flag", () => {
    // Nothing is dropped (the delivered half equals HEAD's), so neither
    // the reset nor the unverifiable flag may fire even though HEAD's
    // half differs from the OLD render's.
    const target = `${agentsRender}\nrepo tail\n`;
    const root = makeTarget({ "AGENTS.md": target });
    initGitRepo(root);
    writeFileSync(join(root, "AGENTS.md"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [AGENTS_ENTRY],
      { "AGENTS.md": agentsRender },
      { "AGENTS.md": agentsOld },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toBe(target);
    expect(result.review).toBe("");
  });

  test("non-UTF-8 bytes in the repo-owned half survive byte-for-byte", () => {
    // A Latin-1 0xe9 ("caf<e9>") is not valid UTF-8; a utf-8 decode would
    // fold it onto U+FFFD and grow the file - silent corruption of the
    // byte-owned half.
    const tailBytes = Buffer.concat([
      Buffer.from("\n## Notes\n\ncaf"),
      Buffer.from([0xe9]),
      Buffer.from("\n"),
    ]);
    const root = makeTarget({});
    writeFileSync(join(root, "AGENTS.md"), Buffer.concat([Buffer.from(agentsOld), tailBytes]));
    initGitRepo(root);
    writeFileSync(join(root, "AGENTS.md"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [AGENTS_ENTRY],
      { "AGENTS.md": agentsRender },
      { "AGENTS.md": agentsOld },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    const rebuilt = readFileSync(join(root, "AGENTS.md"));
    expect(rebuilt.equals(Buffer.concat([Buffer.from(agentsRender), tailBytes]))).toBe(true);
    expect(result.review).toBe("");
  });

  test("a carried tail keeps conflict-marker-shaped text byte-for-byte", () => {
    // The resolver skips rebuilt files (--skip); the rebuild itself must
    // also carry such a tail untouched.
    const markerish = [`${"<".repeat(7)} before updating`, "=".repeat(7)].join("\n");
    const target = `${agentsOld}\n## Notes on merges\n\n${markerish}\n`;
    const root = makeTarget({ "AGENTS.md": target });
    initGitRepo(root);
    writeFileSync(join(root, "AGENTS.md"), MERGE_JUNK);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [AGENTS_ENTRY],
      { "AGENTS.md": agentsRender },
      { "AGENTS.md": agentsOld },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toBe(
      `${agentsRender}\n## Notes on merges\n\n${markerish}\n`,
    );
  });

  test("--rebuilt-paths lists every split entry for the resolver's skip list", () => {
    const root = makeTarget({ "AGENTS.md": agentsTarget, ".gitignore": gitignoreTarget });
    initGitRepo(root);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [AGENTS_ENTRY, GITIGNORE_ENTRY],
      { "AGENTS.md": agentsRender, ".gitignore": gitignoreRender },
      { "AGENTS.md": agentsOld, ".gitignore": gitignoreOldRender },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    expect(result.rebuilt).toBe("AGENTS.md\n.gitignore\n");
  });

  test("a split path replaced by a symlink is rebuilt as a regular file, never through the link", () => {
    // writeFileSync follows an existing symlink: without the guard, the
    // rebuild would overwrite the link TARGET (potentially outside the
    // checkout) and leave the symlink in place.
    const root = makeTarget({ "AGENTS.md": agentsTarget, "victim.txt": "victim content\n" });
    initGitRepo(root);
    unlinkSync(join(root, "AGENTS.md"));
    symlinkSync("victim.txt", join(root, "AGENTS.md"));
    const { renderDir, oldRenderDir } = makeRenderPair(
      [AGENTS_ENTRY],
      { "AGENTS.md": agentsRender },
      { "AGENTS.md": agentsOld },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).toBe(0);
    expect(lstatSync(join(root, "AGENTS.md")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toBe(
      `${agentsRender}\n## Project docs\n\nrepo-local instructions\n`,
    );
    expect(readFileSync(join(root, "victim.txt"), "utf-8")).toBe("victim content\n");
  });

  test("a split entry whose file is missing from the render fails loudly", () => {
    const root = makeTarget({ "AGENTS.md": agentsTarget });
    initGitRepo(root);
    const { renderDir, oldRenderDir } = makeRenderPair([AGENTS_ENTRY], {}, {});
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("manifest and render disagree");
  });

  test("a bounded-region render without its declared local region fails loudly", () => {
    // The manifest and the render are generated together: a render missing
    // its declared region means damage, and keeping it would silently drop
    // HEAD's local body.
    const root = makeTarget({ ".gitignore": gitignoreTarget });
    initGitRepo(root);
    const { renderDir, oldRenderDir } = makeRenderPair(
      [GITIGNORE_ENTRY],
      { ".gitignore": "no region markers here\n" },
      { ".gitignore": gitignoreOldRender },
    );
    const result = runRender(root, renderDir, oldRenderDir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("carries no such local region - manifest and render disagree");
  });

  test("a render tree without the ownership manifest fails loudly", () => {
    const root = makeTarget({ "AGENTS.md": agentsTarget });
    initGitRepo(root);
    const base = mkdtempSync(join(tmpdir(), "preserve-render-"));
    mkdirSync(join(base, "render-new"));
    mkdirSync(join(base, "render-old"));
    const result = runRender(root, join(base, "render-new"), join(base, "render-old"));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("needs the new render's manifest");
  });

  test("a pre-grammar manifest fails loudly instead of guessing the carry", () => {
    const root = makeTarget({ "AGENTS.md": agentsTarget });
    initGitRepo(root);
    const base = mkdtempSync(join(tmpdir(), "preserve-render-"));
    const renderDir = join(base, "render-new");
    mkdirSync(join(renderDir, ".github"), { recursive: true });
    mkdirSync(join(base, "render-old"));
    writeFileSync(
      join(renderDir, MANIFEST_REL),
      JSON.stringify({
        files: {
          "AGENTS.md": { class: "split", marker: SENTINEL, managed: "above", hash: null },
        },
      }),
    );
    const result = runRender(root, renderDir, join(base, "render-old"));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("declares no grammar");
  });

  test("--render-dir without --old-render-dir is rejected", () => {
    const root = makeTarget({ "AGENTS.md": agentsTarget });
    initGitRepo(root);
    const result = runScript(root, ["--render-dir", root]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--render-dir and --old-render-dir come together");
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
