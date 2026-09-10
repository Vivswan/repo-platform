// The registration bridge: the placeholder values derived from a v1 and a
// v2 registration plus the repository slug, and the slug grammar.

import { describe, expect, test } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseRepositorySlug,
  placeholderValues,
  readRegistration,
} from "../../../.github/scripts/sync/writer/registration.ts";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const NOW = new Date("2031-03-04T23:59:00Z");
const SLUG = { owner: "OwnerOrg", name: "my-repo" };

describe("placeholderValues", () => {
  test("a v1 registration falls back to the repository slug", () => {
    expect(placeholderValues({ modules: ["bun"] }, SLUG, NOW)).toEqual({
      project_name: "my-repo",
      project_slug: "my-repo",
      description: "",
      github_username: "OwnerOrg",
      github_username_lower: "ownerorg",
      copyright_holder: "OwnerOrg",
      year: "2031",
    });
  });

  test("a v2 project block wins over the slug", () => {
    const registration = {
      modules: [],
      project: {
        name: "My Repo",
        slug: "myrepo",
        description: "Does things",
        copyright_holder: "Owner Inc",
      },
    };
    expect(placeholderValues(registration, SLUG, NOW)).toMatchObject({
      project_name: "My Repo",
      project_slug: "myrepo",
      description: "Does things",
      copyright_holder: "Owner Inc",
    });
  });
});

describe("parseRepositorySlug", () => {
  test("splits owner/name and refuses anything else", () => {
    expect(parseRepositorySlug("Owner/repo.name")).toEqual({ owner: "Owner", name: "repo.name" });
    for (const bad of ["repo", "a/b/c", "-a/b", "a/b c"]) {
      expect(() => parseRepositorySlug(bad)).toThrow("repository must be owner/name");
    }
  });
});

describe("readRegistration", () => {
  test("reads .repo-platform.yml from the checkout; a symlink or a missing file is refused", () => {
    const target = temp.dir("writer-registration-");
    expect(() => readRegistration(target)).toThrow("missing from the target repository");
    writeFileSync(join(target, ".repo-platform.yml"), "modules: [bun, pages]\n");
    expect(readRegistration(target)).toEqual({ modules: ["bun", "pages"] });
    const linked = temp.dir("writer-registration-link-");
    writeFileSync(join(linked, "elsewhere.yml"), "modules: [bun]\n");
    symlinkSync("elsewhere.yml", join(linked, ".repo-platform.yml"));
    expect(() => readRegistration(linked)).toThrow("not a regular file");
  });
});
