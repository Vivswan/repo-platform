import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assignHints,
  enrich,
  enrichedRowSchema,
  hintName,
  parseDiscoveredList,
  parseSelectionList,
  VERIFY_HEX_LENGTH,
  verifyTag,
} from "../../.github/scripts/fleet/redact.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";

describe("hintName", () => {
  test.each([
    {
      name: "hidden-server",
      hint: "h**-s**r",
      reason: "a final of five or more keeps its last char",
    },
    { name: "chromium-bridge", hint: "c**-b**e", reason: "same rule on a longer final" },
    { name: "myrepo", hint: "m**o", reason: "a single long segment is its own final" },
    // A final under five chars would echo most of the name back.
    { name: "ab", hint: "a**", reason: "a two-char final echoes nothing" },
    { name: "api", hint: "a**", reason: "a three-char final echoes nothing" },
    { name: "home", hint: "h**", reason: "four chars is still under five" },
    { name: "a-b", hint: "a**-b**", reason: "a short final after a separator echoes nothing" },
    { name: "a.b_c", hint: "a**.b**_c**", reason: "every separator kind renders literally" },
    { name: "a--b", hint: "a**-**-b**", reason: "an empty segment renders as ** alone" },
    { name: "Repo2", hint: "R**2", reason: "case and digits pass through" },
    { name: "cloud-speech", hint: "c**-s**h", reason: "the initial keeps the name's case" },
  ])("$name -> $hint: $reason", ({ name, hint }) => {
    expect(hintName(name)).toBe(hint);
  });
});

describe("assignHints", () => {
  test("collisions get deterministic #N suffixes in slug order", () => {
    // "hail-sooner" and "hidden-server" share the base hint; slug order
    // decides who keeps it.
    expect(assignHints(["o/hidden-server", "o/hail-sooner", "o/skills"])).toEqual(
      new Map([
        ["o/hail-sooner", "h**-s**r"],
        ["o/hidden-server", "h**-s**r#2"],
        ["o/skills", "s**s"],
      ]),
    );
  });

  test("duplicate slugs assign once", () => {
    // The value is the claim: a duplicate that consumed a collision slot
    // would overwrite the same key with "#2" and still leave ONE entry.
    expect(assignHints(["o/a-repo", "o/a-repo"])).toEqual(new Map([["o/a-repo", "a**-r**"]]));
  });
});

describe("verifyTag", () => {
  test("is stable, truncated, and case-insensitive over the slug", () => {
    const tag = verifyTag("pat-value", "12345", "Owner/Hidden-Server");
    expect(tag).toBe(verifyTag("pat-value", "12345", "owner/hidden-server"));
    expect(tag).toHaveLength(VERIFY_HEX_LENGTH);
    expect(tag).toMatch(/^[0-9a-f]+$/);
    // Different run, key, or slug: different tag.
    expect(verifyTag("pat-value", "99999", "Owner/Hidden-Server")).not.toBe(tag);
    expect(verifyTag("other-pat", "12345", "Owner/Hidden-Server")).not.toBe(tag);
    expect(verifyTag("pat-value", "12345", "owner/other")).not.toBe(tag);
  });

  test("rejects an empty PAT instead of deriving a publicly known key", () => {
    expect(() => verifyTag("", "424242", "o/r")).toThrow(/empty PAT/);
  });
});

describe("enrich", () => {
  const tagFor = (slug: string) => `tag(${slug})`;
  const discovered = [
    { repo: "o/pub", private: false },
    { repo: "o/hidden-one", private: true },
    { repo: "o/committed-private", private: true },
    { repo: "o/skipped-private", private: true },
  ];
  const selfDisclosed = (slug: string) => slug === "o/committed-private";

  test("classifies public, hinted, and self-disclosed rows", () => {
    const { rows } = enrich(
      [{ repo: "o/pub" }, { repo: "o/hidden-one" }, { repo: "o/committed-private" }],
      discovered,
      selfDisclosed,
      tagFor,
    );
    expect(rows[0]).toEqual({
      repo: "o/pub",
      redact_name: false,
      hide_details: false,
      display: "o/pub",
      verify: "",
    });
    expect(rows[1]).toEqual({
      repo: "o/hidden-one",
      redact_name: true,
      hide_details: true,
      display: "h**-o**",
      verify: "tag(o/hidden-one)",
    });
    // Committed name stays visible; details still hide.
    expect(rows[2]).toEqual({
      repo: "o/committed-private",
      redact_name: false,
      hide_details: true,
      display: "o/committed-private",
      verify: "",
    });
  });

  test("fails closed: absent from discovery asks the probe, defaulting private", () => {
    const { rows } = enrich([{ repo: "o/undiscovered" }], discovered, () => false, tagFor);
    expect(rows[0].redact_name).toBe(true);
    expect(rows[0].hide_details).toBe(true);
    expect(rows[0].display).toBe("u**d");
    expect(rows[0].verify).toBe("tag(o/undiscovered)");
  });

  test("a probe that proves an undiscovered repo public keeps it plain", () => {
    const { rows } = enrich(
      [{ repo: "other/cross-owner" }],
      discovered,
      () => false,
      tagFor,
      () => false,
    );
    expect(rows[0]).toEqual({
      repo: "other/cross-owner",
      redact_name: false,
      hide_details: false,
      display: "other/cross-owner",
      verify: "",
    });
  });

  test("hints stay stable when the selection narrows", () => {
    // A single-repo dispatch must number collision suffixes the same way
    // a full run does: the hint table spans all discovered privates.
    const colliding = [
      { repo: "o/hail-sooner", private: true },
      { repo: "o/hidden-server", private: true },
    ];
    const { rows } = enrich([{ repo: "o/hidden-server" }], colliding, () => false, tagFor);
    expect(rows[0].display).toBe("h**-s**r#2");
  });
});

describe("enrichedRowSchema", () => {
  const redacted = {
    repo: "o/hidden-one",
    redact_name: true,
    hide_details: true,
    display: "h**-o**",
    verify: "deadbeef",
  };
  const plain = {
    repo: "o/pub",
    redact_name: false,
    hide_details: false,
    display: "o/pub",
    verify: "",
  };

  test("accepts both row kinds", () => {
    expect(enrichedRowSchema.safeParse(redacted).success).toBe(true);
    expect(enrichedRowSchema.safeParse(plain).success).toBe(true);
  });

  // The issue path pins WHICH rule fired: success=false alone cannot tell
  // the display refinement from a union arm failing for another reason.
  test.each([
    {
      reason: "a redacted row missing its verify tag",
      row: { ...redacted, verify: "" },
      path: ["verify"],
    },
    {
      reason: "a redacted row not hiding its details",
      row: { ...redacted, hide_details: false },
      path: ["hide_details"],
    },
    {
      reason: "a redacted row whose display is the slug, not a hint",
      row: { ...redacted, display: "o/hidden-one" },
      path: ["display"],
    },
    {
      reason: "an unredacted row carrying a verify tag",
      row: { ...plain, verify: "deadbeef" },
      path: ["verify"],
    },
    {
      reason: "an unredacted row whose display is a hint, not its slug",
      row: { ...plain, display: "p**" },
      path: ["display"],
    },
  ])("rejects $reason", ({ row, path }) => {
    const result = enrichedRowSchema.safeParse(row);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected a rejection");
    expect(result.error.issues.map((issue) => issue.path)).toEqual([path]);
  });
});

// Parity with the pre-zod hand-rolled ladders: the discovered list fails
// CLOSED (an entry without an explicit boolean `private` rejects the whole
// list), the selection stays fail-open on everything but `repo`.
describe("parseDiscoveredList", () => {
  // Identity on every accepted payload: the legacy ladder checked exactly
  // repo and private; everything else passed through untouched, whatever
  // its type - pinned so a schema tightening cannot silently change it.
  test.each([
    {
      reason: "{repo, private} entries pass their extra keys through",
      input: [{ repo: "o/a", private: true, archived: false, pushed_at: "now" }],
    },
    { reason: "an empty list is valid", input: [] },
    {
      reason: "a wrong-typed EXTRA key survives unchanged (only repo and private are inspected)",
      input: [{ repo: "o/a", private: true, extra: 42 }],
    },
  ])("accepts: $reason", ({ input }) => {
    expect(parseDiscoveredList(input)).toEqual(input);
  });

  test("rejects a missing or non-boolean private (fail closed, whole list)", () => {
    expect(parseDiscoveredList([{ repo: "o/a" }])).toBeNull();
    expect(parseDiscoveredList([{ repo: "o/a", private: "true" }])).toBeNull();
    expect(parseDiscoveredList([{ repo: "o/a", private: true }, { repo: "o/b" }])).toBeNull();
  });

  test("rejects non-object entries, a non-string repo, and a non-array payload", () => {
    expect(parseDiscoveredList(["o/a"])).toBeNull();
    expect(parseDiscoveredList([{ repo: 7, private: true }])).toBeNull();
    expect(parseDiscoveredList({ repo: "o/a", private: true })).toBeNull();
  });
});

describe("parseSelectionList", () => {
  // The fail-open side of the parity claim: only repo is validated, the
  // rest rides along untouched.
  test.each([
    {
      reason: "only repo is validated; extras ride along untouched",
      input: [{ repo: "o/a", owner: "o", name: "a" }, { repo: "o/b" }, { repo: "o/c" }],
    },
    {
      reason: "a wrong-typed EXTRA key survives unchanged (the ladder never inspected it)",
      input: [{ repo: "o/a", extra: 42 }],
    },
  ])("accepts: $reason", ({ input }) => {
    expect(parseSelectionList(input)).toEqual(input);
  });

  test("rejects a missing or non-string repo and a non-array payload", () => {
    expect(parseSelectionList([{ owner: "o" }])).toBeNull();
    expect(parseSelectionList([{ repo: 7 }])).toBeNull();
    expect(parseSelectionList("o/a")).toBeNull();
  });
});

describe("enrich CLI", () => {
  test("end to end over fixture files", () => {
    const dir = mkdtempSync(join(tmpdir(), "redact-"));
    writeFileSync(
      join(dir, "selection.json"),
      JSON.stringify([
        { repo: "Vivswan/pub", owner: "Vivswan", name: "pub" },
        { repo: "Vivswan/hidden-server", owner: "Vivswan", name: "hidden-server" },
      ]),
    );
    writeFileSync(
      join(dir, "discovered.json"),
      JSON.stringify([
        { repo: "Vivswan/pub", private: false },
        { repo: "Vivswan/hidden-server", private: true },
      ]),
    );
    writeFileSync(join(dir, "repos.yml"), 'managed:\n  - "*"\n');
    const proc = boundedSpawnSync(
      [
        "bun",
        join(import.meta.dir, "../../.github/scripts/fleet/redact.ts"),
        "enrich",
        "--selection",
        join(dir, "selection.json"),
        "--discovered",
        join(dir, "discovered.json"),
        "--registry",
        join(dir, "repos.yml"),
      ],
      { env: { ...process.env, PAT: "p", GITHUB_RUN_ID: "1" } },
    );
    expect(proc.exitCode).toBe(0);
    // The whole payload: the flags, the hint, and the tag keyed on THIS
    // run's PAT, run id, and slug (verifyTag is deterministic over them).
    expect(JSON.parse(proc.stdout)).toEqual({
      rows: [
        {
          repo: "Vivswan/pub",
          redact_name: false,
          hide_details: false,
          display: "Vivswan/pub",
          verify: "",
        },
        {
          repo: "Vivswan/hidden-server",
          redact_name: true,
          hide_details: true,
          display: "h**-s**r",
          verify: verifyTag("p", "1", "Vivswan/hidden-server"),
        },
      ],
    });
  });

  test("hint subcommand prints the hint", () => {
    const proc = boundedSpawnSync([
      "bun",
      join(import.meta.dir, "../../.github/scripts/fleet/redact.ts"),
      "hint",
      "hidden-server",
    ]);
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.trim()).toBe("h**-s**r");
  });

  test("a malformed input file fails value-free (no SyntaxError echo)", () => {
    // The bare identifier is the leaking form: a raw JSON.parse error
    // quotes it ('Unexpected identifier "hiddenserver"') into this public
    // log, and both readJson inputs carry private slugs.
    const dir = mkdtempSync(join(tmpdir(), "redact-unparseable-"));
    writeFileSync(join(dir, "selection.json"), '[{"repo": hiddenserver}]');
    writeFileSync(join(dir, "discovered.json"), "[]");
    writeFileSync(join(dir, "repos.yml"), 'managed:\n  - "*"\n');
    const proc = boundedSpawnSync(
      [
        "bun",
        join(import.meta.dir, "../../.github/scripts/fleet/redact.ts"),
        "enrich",
        "--selection",
        join(dir, "selection.json"),
        "--discovered",
        join(dir, "discovered.json"),
        "--registry",
        join(dir, "repos.yml"),
      ],
      { env: { ...process.env, PAT: "p", GITHUB_RUN_ID: "1" } },
    );
    expect(proc.exitCode).toBe(1);
    expect(proc.stdout).toContain("not valid JSON");
    expect(proc.stdout + proc.stderr).not.toContain("hiddenserver");
  });
});
