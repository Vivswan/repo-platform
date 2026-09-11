// Ownership self-declarations: the managed header and the exactly-once
// region marker pair each rostered file must carry on the renders that own it.

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { boundedSpawnSync } from "../../../../shared/bounded_spawn.ts";
import { tempDirs } from "../../../../shared/temp_dir.ts";
import {
  B,
  BASELINE,
  E,
  gitFreeEnv,
  HB,
  HE,
  MANIFEST,
  manifestForTree,
  VALIDATOR,
  validatorRunner,
} from "./fixtures";

const temp = tempDirs();
const runValidator = validatorRunner(temp);

describe("ownership self-declarations", () => {
  const C1 =
    "# This file is managed by Vivswan/repo-platform.\n" +
    "# Local edits may be replaced during template updates.\n";

  // One anchored regex over the file's opening HEADER_WINDOW lines decides
  // the header: the pinned owner, then the canonical repo name and period
  // with no repo-name character after it (GitHub allows [A-Za-z0-9._-], so
  // every continuation character must fail the anchor).
  test.each([
    { reason: "no header at all", content: "extends: default\n" },
    {
      reason: "another owner's header",
      content: "# This file is managed by attacker/repo-platform.\nextends: default\n",
    },
    {
      reason: "a negated look-alike ('is not managed by')",
      content: "# This file is not managed by Vivswan/repo-platform.\nextends: default\n",
    },
    {
      reason: "a longer repo name continued with '-'",
      content: "# This file is managed by Vivswan/repo-platform-fork.\nextends: default\n",
    },
    {
      reason: "a longer repo name continued with '_'",
      content: "# This file is managed by Vivswan/repo-platform_fork.\nextends: default\n",
    },
    {
      reason: "a longer repo name continued with '.'",
      content: "# This file is managed by Vivswan/repo-platform.fork.\nextends: default\n",
    },
    {
      reason: "the header buried past the opening lines",
      content: `${"# filler\n".repeat(10)}${C1}extends: default\n`,
    },
  ])("a sync-managed file not opening with the managed header fails: $reason", ({ content }) => {
    const { exitCode, stderr } = runValidator({ ".yamllint": content });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(".yamllint: does not open with the managed header");
  });

  test("a sync-managed file opening with the managed header passes", () => {
    const { exitCode, stderr } = runValidator({ ".yamllint": `${C1}extends: default\n` });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("a split file carries each region marker exactly once, in order", () => {
    const missing = runValidator({ ".editorconfig": `${HB}\nroot = true\n` });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain(`.editorconfig: marker '${HE}' appears 0 times`);
    const once = runValidator({ ".editorconfig": `${HB}\nroot = true\n${HE}\n` });
    expect(once.stderr).toBe("");
    expect(once.exitCode).toBe(0);
    const twice = runValidator({ ".editorconfig": `${HB}\n${HB}\nroot = true\n${HE}\n` });
    expect(twice.exitCode).toBe(1);
    expect(twice.stderr).toContain("appears 2 times");
  });

  test("an ungated base region file's ABSENCE is an error (the template always lands it)", () => {
    const root = temp.dir("validate-template-");
    // The manifest is the render's (it lists .editorconfig); the file was
    // deleted afterwards.
    const tree: Record<string, string> = { ...BASELINE, [MANIFEST]: manifestForTree(BASELINE) };
    delete tree[".editorconfig"];
    for (const [rel, content] of Object.entries(tree)) {
      mkdirSync(join(root, dirname(rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    const result = boundedSpawnSync([process.execPath, VALIDATOR, root], { env: gitFreeEnv() });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(".editorconfig is missing - the template always generates it");
  });

  test("the OTHER marker spelling does not satisfy the declared one", () => {
    // .editorconfig declares the hash spelling; the HTML-comment pair is
    // not its pair (the table carries the exact lines, not a family).
    const { exitCode, stderr } = runValidator({
      ".editorconfig": `${B}\nroot = true\n${E}\n`,
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`.editorconfig: marker '${HB}' appears 0 times`);
  });

  test("a mid-line mention of a region marker counts as a duplicate (substring rule)", () => {
    // The fleet-wide region convention counts SUBSTRINGS: a buried mention
    // would confuse every reader about where the managed region runs, and
    // the sync's appendix neutralization counts the same way.
    const { exitCode, stderr } = runValidator({
      ".editorconfig": `${HB}\n# rules go below the ${HE} marker\nroot = true\n${HE}\n`,
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("appears 2 times");
  });

  test("an indented marker line still slices parity where the stamper stamped", () => {
    // Marker LINES match by trimmed equality (the slicing convention every
    // splitter shares), while exactly-once counts substrings: an indented
    // BEGIN is one substring occurrence AND the slice anchor, so the
    // auto-stamped manifest's region, sliced the same way, passes parity.
    const { exitCode, stderr } = runValidator({
      ".editorconfig": `above\n  ${HB}\nroot = true\n${HE}\nrepo tail\n`,
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("LICENSE.md needs the region markers unless custom-license owns licensing", () => {
    const fleet = runValidator({ "LICENSE.md": "# License\n" });
    expect(fleet.exitCode).toBe(1);
    expect(fleet.stderr).toContain(`LICENSE.md: marker '${B}' appears 0 times`);
    const custom = runValidator({
      "LICENSE.md": "# My own license\n",
      ".repo-platform.yml": `${BASELINE[".repo-platform.yml"]}`.replace(
        "modules: [uv]",
        "modules: [uv, custom-license]",
      ),
    });
    expect(custom.stderr).toBe("");
    expect(custom.exitCode).toBe(0);
  });

  test("a selected module's managed workflow needs the header", () => {
    const bunRender = {
      ".repo-platform.yml": BASELINE[".repo-platform.yml"].replace(
        "modules: [uv]",
        "modules: [bun]",
      ),
      ".bun-version": "1.4.0\n",
    };
    const bare = runValidator({
      ...bunRender,
      ".github/workflows/dependabot-bun-lockfile.yml": "name: x\non: [push]\n",
    });
    expect(bare.exitCode).toBe(1);
    expect(bare.stderr).toContain(".github/workflows/dependabot-bun-lockfile.yml: does not open");
    const headed = runValidator({
      ...bunRender,
      ".github/workflows/dependabot-bun-lockfile.yml": `${C1}name: x\non: [push]\n`,
    });
    expect(headed.stderr).toBe("");
    expect(headed.exitCode).toBe(0);
  });

  test("an unselected module's managed workflow is not required to declare", () => {
    const { exitCode, stderr } = runValidator({
      ".github/workflows/dependabot-bun-lockfile.yml": "name: x\non: [push]\n",
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("AGENTS.md carries the region markers on every render (an ungated base region)", () => {
    const bare = runValidator({ "AGENTS.md": "# AGENTS.md\n" });
    expect(bare.exitCode).toBe(1);
    expect(bare.stderr).toContain(`AGENTS.md: marker '${B}' appears 0 times`);
    const missing = runValidator({}, [], { omit: ["AGENTS.md"] });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("AGENTS.md is missing - the template always generates it");
    const marked = runValidator({ "AGENTS.md": `${B}\n# AGENTS.md\n${E}\n` });
    expect(marked.stderr).toBe("");
    expect(marked.exitCode).toBe(0);
  });

  test("self mode skips ownership declarations", () => {
    const { exitCode, stderr } = runValidator({ ".yamllint": "extends: default\n" }, ["--self"]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });
});
