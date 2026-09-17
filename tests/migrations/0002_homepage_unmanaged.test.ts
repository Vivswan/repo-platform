import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { repositoryOf } from "../../migrations/0002-homepage-unmanaged.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { fixtureGit, fixtureGitEnv } from "../shared/fixture_git";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const RUNG = new URL("../../migrations/0002-homepage-unmanaged.ts", import.meta.url).pathname;
const OVERLAY = ".github/settings.local.yml";
/** The URL checkout_target.ts leaves on origin, for OwnerOrg/Demo. */
const ORIGIN = "https://github.com/OwnerOrg/Demo.git";

/** The starter's shape as the fleet holds it: a comment above the identity keys, a CRLF line, an owner's ruleset,
 *  and no trailing newline, so the deletion is checked byte for byte around the one line it removes. */
const overlayWith = (homepageLine: string | null) =>
  [
    "---",
    "# Demo's OWN settings overlay",
    "repository:",
    "  description: A demo repository\r",
    "  # Declared even when empty: the apply manages only declared keys.",
    ...(homepageLine === null ? [] : [homepageLine]),
    "  topics: demo",
    "  private: false",
    "",
    "rulesets:",
    "  - name: release-branches",
    "    homepage: kept-elsewhere",
    "    rules: [{type: deletion}]",
  ].join("\n");
const MIGRATED = overlayWith(null);
const SILENT = { exitCode: 0, stdout: "", stderr: "" };

/** A clone as the sync leaves it: a git checkout whose origin names the repository. */
function checkout(overlay: string | null, origin: string | null = ORIGIN): string {
  const root = temp.dir("migration-0002-");
  fixtureGit(root, ["init", "-q"]);
  if (origin !== null) fixtureGit(root, ["remote", "add", "origin", origin]);
  mkdirSync(join(root, ".github"));
  if (overlay !== null) writeFileSync(join(root, OVERLAY), overlay);
  return root;
}

const run = (root: string) =>
  boundedSpawnSync([process.execPath, RUNG, root], { env: fixtureGitEnv() });
const homepageOf = (text: string) =>
  (parseYaml(text) as { repository: Record<string, unknown> }).repository.homepage;

describe("0002-homepage-unmanaged", () => {
  // The overlay starter seeded `homepage: ""` fleet-wide, and a declared empty value clears the live homepage on
  // every apply; the repository's own address is the same nothing spelled out.
  test.each<{ reason: string; line: string }>([
    { reason: "an empty double-quoted value", line: '  homepage: ""' },
    { reason: "an empty single-quoted value", line: "  homepage: ''" },
    { reason: "no value at all", line: "  homepage:" },
    {
      reason: "the repository's own address",
      line: "  homepage: https://github.com/OwnerOrg/Demo",
    },
    {
      reason: "the own address with a trailing slash and another case",
      line: '  homepage: "https://GitHub.com/ownerorg/demo/"  # set by hand',
    },
    {
      reason: "the own address as a clone URL",
      line: "  homepage: https://github.com/OwnerOrg/Demo.git",
    },
    {
      reason: "the own address as a clone URL with a trailing slash",
      line: "  homepage: https://github.com/OwnerOrg/Demo.git/",
    },
  ])("deletes the homepage key carrying $reason and reports the overlay path", ({ line }) => {
    const root = checkout(overlayWith(line));
    // Control: as seeded, the rendered document would carry the key and the apply would clear the live value.
    expect(homepageOf(overlayWith(line))).not.toBeUndefined();
    expect(run(root)).toEqual({ exitCode: 0, stdout: `${OVERLAY}\n`, stderr: "" });
    const text = readFileSync(join(root, OVERLAY), "utf-8");
    expect(text).toBe(MIGRATED);
    expect(homepageOf(text)).toBeUndefined();
    expect(run(root)).toEqual(SILENT);
    expect(readFileSync(join(root, OVERLAY), "utf-8")).toBe(MIGRATED);
  });

  // The settings loader resolves aliases, so `*empty` cleared the homepage exactly as `""` did; a folded value spans
  // two lines and both go; a cycle or a `!!binary` elsewhere in the document is no reason to leave the key behind.
  test.each<{ reason: string; overlay: string; cut: string }>([
    {
      reason: "an alias of an empty value",
      overlay: 'repository:\n  description: &empty ""\n  homepage: *empty\n  private: false\n',
      cut: "  homepage: *empty\n",
    },
    {
      reason: "a block scalar spelling the own address",
      overlay:
        "repository:\n  homepage: >-\n    https://github.com/OwnerOrg/Demo\n  private: false\n",
      cut: "  homepage: >-\n    https://github.com/OwnerOrg/Demo\n",
    },
    {
      reason: "an unrelated cycle beside it",
      overlay: 'repository:\n  homepage: ""\n  private: false\nx: &a\n  y: *a\n',
      cut: '  homepage: ""\n',
    },
    {
      reason: "a binary value beside it",
      overlay: 'repository:\n  homepage: ""\n  private: false\nicon: !!binary R0lGODlh\n',
      cut: '  homepage: ""\n',
    },
  ])("deletes the key for $reason and nothing else", ({ overlay, cut }) => {
    const root = checkout(overlay);
    expect(run(root)).toEqual({ exitCode: 0, stdout: `${OVERLAY}\n`, stderr: "" });
    expect(readFileSync(join(root, OVERLAY), "utf-8")).toBe(overlay.replace(cut, ""));
  });

  // The repository chose a website, or another repository's address: the line is its own, and the sync PR's diff
  // is the record of what the rung did, so a kept line earns no note either.
  test.each([
    "  homepage: https://demo.example.test/docs/",
    "  homepage: https://github.com/OwnerOrg/Other",
    "  homepage: https://github.com/OtherOrg/Demo",
  ])("a homepage of the repository's own choosing stays as written, silently: %s", (line) => {
    const kept = overlayWith(line);
    const root = checkout(kept);
    expect(run(root)).toEqual(SILENT);
    expect(readFileSync(join(root, OVERLAY), "utf-8")).toBe(kept);
  });

  // The rung runs before the writer seeds the starter, so a repository's first sync has no overlay yet; an emptied
  // overlay reads as no document at all, which the settings loader takes as `{}`. Neither an absent key nor an
  // empty value needs the repository, so a checkout without a usable origin crosses these too.
  test.each<{ reason: string; overlay: string | null }>([
    { reason: "no overlay", overlay: null },
    { reason: "an overlay without the key", overlay: MIGRATED },
    { reason: "an overlay holding only a comment", overlay: "# nothing of our own yet\n" },
    { reason: "a bare non-finite number", overlay: ".nan\n" },
  ])("$reason is a no-op", ({ overlay }) => {
    const root = checkout(overlay, null);
    expect(run(root)).toEqual(SILENT);
    if (overlay === null) expect(existsSync(join(root, OVERLAY))).toBe(false);
    else expect(readFileSync(join(root, OVERLAY), "utf-8")).toBe(overlay);
  });

  // One judge: the edited text must read as the original minus the one key. These spellings lose a flow separator
  // or half an explicit key with the line, lose the key twice through an alias of the block or a cycle through it,
  // keep supplying the value through a merge key, or leave an alias unresolvable; each fails the row with the
  // owner's bytes untouched.
  const MORE = "removing its homepage line would change more than the homepage";
  test.each<{ reason: string; overlay: string; said: string }>([
    {
      reason: "a flow mapping on one line",
      overlay: 'repository: {homepage: "", description: Keep, private: false}\n',
      said: MORE,
    },
    {
      reason: "a flow mapping with the separator on the next line",
      overlay: 'repository: {\n  homepage: ""\n  , description: Keep, private: false\n}\n',
      said: MORE,
    },
    {
      reason: "an explicit key spread over lines, its anchor on the key",
      overlay: 'repository:\n  ? &field\n    homepage\n  : ""\n  description: *field\n',
      said: MORE,
    },
    {
      reason: "an explicit key with no value, its anchor on the key",
      overlay: "repository:\n  ? &field\n    homepage\n  description: *field\n  private: false\n",
      said: MORE,
    },
    {
      reason: "an anchored value another key aliases",
      overlay: 'repository:\n  homepage: &empty ""\n  topics: *empty\n',
      said: MORE,
    },
    {
      reason: "an alias as the key",
      overlay: 'repository:\n  description: &field homepage\n  *field : ""\n  private: false\n',
      said: "its homepage key is not written as a plain line",
    },
    {
      reason: "an alias of the whole repository block, which would lose the key too",
      overlay: 'repository: &r\n  homepage: ""\n  private: false\nactions: *r\n',
      said: MORE,
    },
    {
      reason: "a cycle through the repository block",
      overlay: 'repository: &r\n  homepage: ""\n  self: *r\n',
      said: MORE,
    },
    {
      reason: "a `!!set` holding an alias of the block beside its homepage-less twin",
      overlay:
        'repository: &r\n  homepage: ""\n  private: false\ncopy: !!set\n  ? *r\n  ? {private: false}\n',
      said: MORE,
    },
    {
      reason: "a timestamp a merge key would replace",
      overlay:
        '%YAML 1.1\n---\nrepository: {\n  <<: {updated: 2020-01-01},\n  homepage: "", updated: 2021-01-01,\n  private: false\n}\n',
      said: MORE,
    },
    {
      reason: "an `!!omap` holding an alias of the block",
      overlay:
        '%YAML 1.1\n---\nrepository: &r\n  homepage: ""\n  private: false\ncopy: !!omap\n  - saved: *r\n',
      said: MORE,
    },
    {
      reason: "a `.nan` beside a null that a JSON reading would confuse",
      overlay:
        "repository:\n  description: &v .nan\n  homepage: &v null\n  name: *v\n  private: false\n",
      said: MORE,
    },
    {
      reason: "a merge key still supplying the value",
      overlay:
        '%YAML 1.1\n---\nrepository:\n  <<: {homepage: ""}\n  homepage: ""\n  private: false\n',
      said: MORE,
    },
  ])("refuses to edit $reason and leaves the overlay as written", ({ overlay, said }) => {
    const root = checkout(overlay);
    expect(run(root)).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: `0002-homepage-unmanaged: ${OVERLAY}: ${said}; settle the homepage line by hand\n`,
    });
    expect(readFileSync(join(root, OVERLAY), "utf-8")).toBe(overlay);
  });

  // `.nan` is a number, not an empty string, so the field applies a value and the line is the repository's.
  test("a non-finite homepage is kept", () => {
    const kept = "repository:\n  homepage: .nan\n  private: false\n";
    const root = checkout(kept);
    expect(run(root)).toEqual(SILENT);
    expect(readFileSync(join(root, OVERLAY), "utf-8")).toBe(kept);
  });

  // checkout_target.ts leaves the https URL with `.git` (a token in the userinfo until it resets the URL);
  // actions/checkout leaves it without; a developer's clone may be ssh, scp-like, ported, or git+ssh. Anything else
  // is no GitHub repository.
  test.each<[string, string | null]>([
    ["https://github.com/OwnerOrg/Demo.git", "OwnerOrg/Demo"],
    ["https://github.com/OwnerOrg/Demo", "OwnerOrg/Demo"],
    ["https://github.com/OwnerOrg/Demo/", "OwnerOrg/Demo"],
    ["https://github.com/Owner.Org/demo.site.git", "Owner.Org/demo.site"],
    ["https://x-access-token:example-token@github.com/OwnerOrg/Demo.git", "OwnerOrg/Demo"],
    ["https://github.com:443/OwnerOrg/Demo.git", "OwnerOrg/Demo"],
    ["git@github.com:OwnerOrg/Demo.git", "OwnerOrg/Demo"],
    ["ssh://git@github.com/OwnerOrg/Demo.git", "OwnerOrg/Demo"],
    ["ssh://git@github.com:22/OwnerOrg/Demo.git", "OwnerOrg/Demo"],
    ["git+ssh://git@github.com/OwnerOrg/Demo.git", "OwnerOrg/Demo"],
    ["ssh://git@ssh.github.com:443/OwnerOrg/Demo.git", "OwnerOrg/Demo"],
    ["https://GITHUB.COM/OwnerOrg/Demo.git", "OwnerOrg/Demo"],
    ["https://gitlab.com/OwnerOrg/Demo.git", null],
    ["https://github.com/OwnerOrg", null],
    ["https://github.com/OwnerOrg/Demo/extra", null],
    ["/srv/git/Demo.git", null],
  ])("reads the repository from origin %s", (url, repository) => {
    expect(repositoryOf(url)).toBe(repository);
  });

  // Only a non-empty value asks which repository this is; without an answer the own-address rule cannot be judged,
  // and the message names no URL, since a checkout's origin can carry a token.
  test("a non-empty homepage in a checkout whose origin is not a GitHub repository fails the rung and writes nothing", () => {
    const seeded = overlayWith("  homepage: https://github.com/OwnerOrg/Demo");
    for (const origin of [
      null,
      "/srv/git/Demo.git",
      "https://user:example-token@gitlab.com/o/r.git",
    ]) {
      const root = checkout(seeded, origin);
      expect(run(root)).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: `0002-homepage-unmanaged: ${OVERLAY}: the checkout's origin does not name a GitHub repository; settle the homepage line by hand\n`,
      });
      expect(readFileSync(join(root, OVERLAY), "utf-8")).toBe(seeded);
    }
  });

  test("a symbolic link where .github should be fails the rung and writes nothing through it", () => {
    const root = temp.dir("migration-0002-linked-");
    mkdirSync(join(root, "shared"));
    const seeded = overlayWith('  homepage: ""');
    writeFileSync(join(root, "shared/settings.local.yml"), seeded);
    symlinkSync("shared", join(root, ".github"));
    expect(run(root)).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: `${OVERLAY}: its ancestor '.github' is a symbolic link, so the write could leave the checkout\n`,
    });
    expect(readFileSync(join(root, "shared/settings.local.yml"), "utf-8")).toBe(seeded);
  });
});
