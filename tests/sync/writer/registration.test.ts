import { describe, expect, test } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  placeholderValues,
  readRegistration,
} from "../../../.github/scripts/sync/writer/registration.ts";
import type { Registration } from "../../../actions/plan/registration.ts";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const SLUG = { owner: "OwnerOrg", name: "my-repo" };
const PROJECT = { name: "My Repo", slug: "myrepo", description: "Does things" };
const PROJECT_YAML = "project: {name: My Repo, slug: myrepo, description: Does things}\n";

describe("placeholderValues", () => {
  // The facts every LICENSE and README render from: the owner and its lower-case form come from the operator's
  // slug, the holder defaults to the owner, and the year is UTC's. bun test pins the process to UTC, where a
  // local-time read agrees with UTC at every instant, so each row sets a zone in which its instant belongs to the
  // neighbouring year.
  test.each([
    {
      reason: "a set copyright holder, a public repository, the year's last minute east of UTC",
      copyright_holder: "Owner Inc",
      isPrivate: false,
      now: "2031-12-31T23:59:00Z",
      zone: "Pacific/Kiritimati",
      expected: "Owner Inc",
    },
    {
      reason:
        "an unset copyright holder is the owner, a private repository, the year's first half hour west of UTC",
      copyright_holder: undefined,
      isPrivate: true,
      now: "2031-01-01T00:30:00Z",
      zone: "Pacific/Honolulu",
      expected: "OwnerOrg",
    },
  ])("$reason", ({ copyright_holder, isPrivate, now, zone, expected }) => {
    const registration = { modules: [], project: { ...PROJECT, copyright_holder } };
    const runnerZone = process.env.TZ;
    process.env.TZ = zone;
    try {
      expect(placeholderValues(registration, SLUG, isPrivate, {}, new Date(now))).toEqual({
        project_name: "My Repo",
        project_slug: "myrepo",
        description: "Does things",
        github_username: "OwnerOrg",
        github_username_lower: "ownerorg",
        copyright_holder: expected,
        year: "2031",
        private: String(isPrivate),
      });
    } finally {
      if (runnerZone === undefined) delete process.env.TZ;
      else process.env.TZ = runnerZone;
    }
  });

  // Precedence: flipped, a repository's own label name would be ignored silently and its nightly issues filed
  // under the fleet default; a default alone fills the name. A name neither side gives has no value, and sync.ts
  // refuses a source that uses it.
  test("the registration's own labels win over the module defaults, a default alone fills the name, and a name neither side gives has no value", () => {
    const NOW = new Date("2031-06-01T00:00:00Z");
    const base = {
      project_name: "My Repo",
      project_slug: "myrepo",
      description: "Does things",
      github_username: "OwnerOrg",
      github_username_lower: "ownerorg",
      copyright_holder: "OwnerOrg",
      year: "2031",
      private: "false",
    };
    const defaults = {
      fuzzer_label: "fuzz-nightly",
      fuzzer_label_color: "B60205",
      fuzzer_label_description: "Automated nightly fuzz failure",
      nightly_label: "nightly-failure",
      site_label: "docs-link-rot",
    };
    const unlabeled = { modules: [], project: PROJECT };
    expect(placeholderValues(unlabeled, SLUG, false, {}, NOW)).toEqual(base);
    expect(placeholderValues(unlabeled, SLUG, false, defaults, NOW)).toEqual({
      ...base,
      ...defaults,
    });
    const registration = { ...unlabeled, labels: { fuzzer: "fuzz", site: "rot" } };
    expect(placeholderValues(registration, SLUG, false, defaults, NOW)).toEqual({
      ...base,
      ...defaults,
      fuzzer_label: "fuzz",
      site_label: "rot",
    });
  });
});

describe("readRegistration", () => {
  // The registration is the second file the writer trusts as a file (manifest.test.ts pins the first): a link is
  // never read through, and a missing or malformed document is a hard error, not a hold. The grammar's messages
  // are the plan's (tests/actions/plan/registration.test.ts); an unknown module name is judged later by the
  // selector with the plan's words.
  test.each<{ reason: string; text?: string; linked?: boolean; expected: string | Registration }>([
    { reason: "a missing file", expected: "missing from the target repository" },
    { reason: "a link to a valid document", linked: true, expected: "not a regular file" },
    {
      reason: "an unknown top-level key",
      text: `modules: [bun]\n${PROJECT_YAML}projekt: {name: x}\n`,
      expected: ".repo-platform.yml: (top level): Unrecognized key",
    },
    {
      reason: "a duplicated module",
      text: `modules: [bun, bun]\n${PROJECT_YAML}`,
      expected: '.repo-platform.yml: duplicate modules entry "bun"',
    },
    {
      reason: "no module selection",
      text: PROJECT_YAML,
      expected: ".repo-platform.yml: no module selection found",
    },
    {
      reason: "no project block",
      text: "modules: [bun]\n",
      expected: ".repo-platform.yml: project: Invalid input: expected object, received undefined",
    },
    {
      reason: "a module name files.yml does not know",
      text: `modules: [bun, not-a-module]\n${PROJECT_YAML}`,
      expected: { modules: ["bun", "not-a-module"], project: PROJECT },
    },
    {
      reason: "a valid document",
      text: `modules: [bun, site]\n${PROJECT_YAML}`,
      expected: { modules: ["bun", "site"], project: PROJECT },
    },
  ])("$reason", ({ text, linked, expected }) => {
    const target = temp.dir("writer-registration-");
    if (linked === true) {
      writeFileSync(join(target, "elsewhere.yml"), `modules: [bun]\n${PROJECT_YAML}`);
      symlinkSync("elsewhere.yml", join(target, ".repo-platform.yml"));
    }
    if (text !== undefined) writeFileSync(join(target, ".repo-platform.yml"), text);
    if (typeof expected === "string") {
      expect(() => readRegistration(target)).toThrow(expected);
    } else {
      expect(readRegistration(target)).toEqual(expected);
    }
  });
});
