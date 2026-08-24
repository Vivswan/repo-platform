// Unit tests for the forgotten-migration tripwire: landing-path and
// gate-signature extraction, semver-ordered release-tag selection (local
// and ls-remote-listed tags), and transition classification - managed
// retirements, generated-once removals (the rename-strands-a-copy case),
// gate changes (a path surviving under a different render condition), and
// ownership flips. Skip-list matching goes through scripts/generate.ts's
// gitwildmatch-faithful matchers, so the depth semantics here are the ones
// copier applies (a bare filename matches at any depth).

import { describe, expect, test } from "bun:test";
import {
  collectTransitions,
  landingPath,
  latestReleaseTag,
  migrationErrors,
  ownershipFlips,
  remoteTagNames,
  renderedPath,
  renderMap,
  type Transition,
} from "../../scripts/check_migrations";
import { skipIfExistsMatchers } from "../../scripts/generate";

function matchers(patterns: string[]): RegExp[] {
  return patterns.length === 0
    ? []
    : skipIfExistsMatchers(`_skip_if_exists:\n${patterns.map((p) => `  - ${p}\n`).join("")}`);
}

describe("landingPath / renderedPath", () => {
  test("passes a plain path through, unconditional signature", () => {
    expect(renderedPath("README.md")).toEqual({ landing: "README.md", signature: "" });
    expect(landingPath(".github/workflows/checks.yml")).toBe(".github/workflows/checks.yml");
  });

  test("strips the .jinja suffix", () => {
    expect(landingPath(".github/workflows/ci.yml.jinja")).toBe(".github/workflows/ci.yml");
  });

  test("captures a module filename gate as the signature", () => {
    expect(renderedPath("{% if 'uv' in modules %}pyproject.toml{% endif %}")).toEqual({
      landing: "pyproject.toml",
      signature: "'uv' in modules",
    });
  });

  test("gate wrapping a .jinja file (suffix sits outside the gate)", () => {
    expect(renderedPath("{% if not private %}CONTRIBUTING.md{% endif %}.jinja")).toEqual({
      landing: "CONTRIBUTING.md",
      signature: "not private",
    });
  });

  test("a gated directory segment joins the signature in path order", () => {
    expect(
      renderedPath(".claude/{% if 'skills' in modules %}skills{% endif %}/style/SKILL.md"),
    ).toEqual({
      landing: ".claude/skills/style/SKILL.md",
      signature: "'skills' in modules",
    });
  });

  test("gate whitespace is normalized so formatting is not a transition", () => {
    expect(renderedPath("{% if  'uv'   in modules %}x{% endif %}").signature).toBe(
      "'uv' in modules",
    );
  });
});

describe("renderMap", () => {
  test("keys by landing path with sorted deduplicated signatures", () => {
    const map = renderMap([
      "README.md",
      "{% if 'uv' in modules %}tool.cfg{% endif %}",
      "{% if 'bun' in modules %}tool.cfg{% endif %}",
    ]);
    expect(map.get("README.md")).toEqual([""]);
    expect(map.get("tool.cfg")).toEqual(["'bun' in modules", "'uv' in modules"]);
  });
});

describe("latestReleaseTag", () => {
  test("orders numerically, not lexically", () => {
    expect(latestReleaseTag(["templates/v9.0.0", "templates/v10.0.0"])).toEqual({
      tag: "templates/v10.0.0",
      version: "10.0.0",
    });
  });

  test("ignores tags of any other shape", () => {
    expect(latestReleaseTag(["v1.0.0", "templates/staging", "templates/v1.2"])).toBeNull();
    expect(latestReleaseTag(["templates/v1.2.3-rc.1", "templates/v0.1.0"])).toEqual({
      tag: "templates/v0.1.0",
      version: "0.1.0",
    });
  });

  test("no tags at all: null (nothing released yet)", () => {
    expect(latestReleaseTag([])).toBeNull();
  });
});

describe("remoteTagNames", () => {
  test("strips refs/tags/ and drops peeled ^{} duplicates", () => {
    const stdout =
      "1111\trefs/tags/templates/v0.1.0\n" +
      "2222\trefs/tags/templates/v0.1.0^{}\n" +
      "3333\trefs/tags/templates/v0.2.0\n";
    expect(remoteTagNames(stdout)).toEqual(["templates/v0.1.0", "templates/v0.2.0"]);
  });

  test("empty output (no remote tags): empty list", () => {
    expect(remoteTagNames("")).toEqual([]);
  });
});

describe("ownershipFlips", () => {
  const oldPaths = new Set([".github/workflows/checks.yml", "ci.yml", "gone.yml"]);
  const stillRendered = new Set([".github/workflows/checks.yml", "ci.yml"]);

  test("a still-rendered path leaving the skip list is a flip", () => {
    expect(ownershipFlips(oldPaths, stillRendered, matchers(["checks.yml"]), [])).toEqual([
      ".github/workflows/checks.yml",
    ]);
  });

  test("a still-rendered path entering the skip list is a flip", () => {
    expect(ownershipFlips(oldPaths, stillRendered, [], matchers(["ci.yml"]))).toEqual(["ci.yml"]);
  });

  test("unchanged skip status and de-rendered paths are not flips", () => {
    expect(
      ownershipFlips(oldPaths, stillRendered, matchers(["checks.yml"]), matchers(["checks.yml"])),
    ).toEqual([]);
    // gone.yml left the render entirely: that is retirement territory, not
    // an ownership flip.
    expect(ownershipFlips(oldPaths, new Set(["ci.yml"]), matchers(["gone.yml"]), [])).toEqual([]);
  });

  test("bare filenames match at any depth, the gitwildmatch semantics copier applies", () => {
    // Bun.Glob would anchor 'bug.yml' to the root and miss this path; the
    // reused generate.ts matchers must not.
    expect(
      ownershipFlips(
        new Set([".github/ISSUE_TEMPLATE/bug.yml"]),
        new Set([".github/ISSUE_TEMPLATE/bug.yml"]),
        matchers(["bug.yml"]),
        [],
      ),
    ).toEqual([".github/ISSUE_TEMPLATE/bug.yml"]);
  });
});

describe("collectTransitions", () => {
  test("classifies retirements, generated-once removals, gate changes, and flips", () => {
    const oldRender = renderMap([
      "managed.yml",
      "checks.yml",
      "moved.yml",
      "{% if 'uv' in modules %}flip.yml{% endif %}",
      "stay.yml",
    ]);
    const newRender = renderMap([
      "{% if 'uv' in modules %}moved.yml{% endif %}",
      "{% if 'uv' in modules %}flip.yml{% endif %}",
      "stay.yml",
    ]);
    expect(
      collectTransitions(oldRender, newRender, matchers(["checks.yml"]), matchers(["flip.yml"])),
    ).toEqual([
      { path: "managed.yml", kind: "retired" },
      { path: "checks.yml", kind: "generated-once-removed" },
      {
        path: "moved.yml",
        kind: "gate-changed",
        detail: "was unconditional, now ('uv' in modules)",
      },
      { path: "flip.yml", kind: "ownership-flip" },
    ]);
  });

  test("a generated-once rename does not slip through as a no-op", () => {
    // old.yml was generated-once and becomes new.yml, with _skip_if_exists
    // moved along: the sync deletes nothing, so the client's customized
    // old.yml is stranded next to the fresh new.yml - a migration must be
    // demanded.
    const transitions = collectTransitions(
      renderMap(["old.yml", "README.md"]),
      renderMap(["new.yml", "README.md"]),
      matchers(["old.yml"]),
      matchers(["new.yml"]),
    );
    expect(transitions).toEqual([{ path: "old.yml", kind: "generated-once-removed" }]);
  });

  test("a path skip-listed only in the NEW version still classifies as generated-once-removed", () => {
    // The old version managed it, the new version drops the render and
    // adds the skip entry: the sync's cleanup exempts it (union skip), so
    // the deletion never happens and the transition still needs a
    // migration decision.
    expect(
      collectTransitions(
        renderMap(["late-skip.yml"]),
        renderMap([]),
        [],
        matchers(["late-skip.yml"]),
      ),
    ).toEqual([{ path: "late-skip.yml", kind: "generated-once-removed" }]);
  });

  test("a module-to-module gate move is a gate change", () => {
    const transitions = collectTransitions(
      renderMap(["{% if 'uv' in modules %}tool.cfg{% endif %}"]),
      renderMap(["{% if 'bun' in modules %}tool.cfg{% endif %}"]),
      [],
      [],
    );
    expect(transitions).toEqual([
      {
        path: "tool.cfg",
        kind: "gate-changed",
        detail: "was ('uv' in modules), now ('bun' in modules)",
      },
    ]);
  });

  test("whitespace-only gate reformatting is not a transition", () => {
    expect(
      collectTransitions(
        renderMap(["{% if 'uv' in modules %}x{% endif %}"]),
        renderMap(["{% if  'uv'  in  modules %}x{% endif %}"]),
        [],
        [],
      ),
    ).toEqual([]);
  });

  test("the always-protected settings.yml never demands a migration", () => {
    expect(collectTransitions(renderMap([".github/settings.yml"]), renderMap([]), [], [])).toEqual(
      [],
    );
  });

  test("identical versions produce no transitions", () => {
    const render = renderMap(["a.yml", "checks.yml"]);
    expect(
      collectTransitions(render, render, matchers(["checks.yml"]), matchers(["checks.yml"])),
    ).toEqual([]);
  });
});

describe("migrationErrors", () => {
  const retired: Transition = { path: ".yamllint", kind: "retired" };
  const flip: Transition = { path: "checks.yml", kind: "ownership-flip" };

  test("no transitions: no errors either way", () => {
    expect(migrationErrors([], "0.3.1", false)).toEqual([]);
    expect(migrationErrors([], "0.3.1", true)).toEqual([]);
  });

  test("transitions with the migration present: pass", () => {
    expect(migrationErrors([retired, flip], "0.3.1", true)).toEqual([]);
  });

  test("transitions without the migration: name the path, the kind, and the expected filename", () => {
    const removed: Transition = { path: "old.yml", kind: "generated-once-removed" };
    const gated: Transition = {
      path: "moved.yml",
      kind: "gate-changed",
      detail: "was unconditional, now ('uv' in modules)",
    };
    const errors = migrationErrors([retired, removed, gated, flip], "0.3.1", false);
    expect(errors).toHaveLength(4);
    expect(errors[0]).toContain("'.yamllint'");
    expect(errors[0]).toContain("migrations/0.3.1.ts");
    expect(errors[1]).toContain("'old.yml'");
    expect(errors[1]).toContain("strands the client's customized copy");
    expect(errors[2]).toContain("'moved.yml'");
    expect(errors[2]).toContain("was unconditional, now ('uv' in modules)");
    expect(errors[3]).toContain("'checks.yml'");
    expect(errors[3]).toContain("ownership class");
  });
});
