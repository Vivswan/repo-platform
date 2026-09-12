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
const PROJECT = { name: "My Repo", slug: "myrepo", description: "Does things" };
const PROJECT_YAML = "project: {name: My Repo, slug: myrepo, description: Does things}\n";

describe("placeholderValues", () => {
  // The project block names the project and the slug names the owner alone;
  // the copyright holder is the one project key with a default.
  test.each([
    { reason: "a set copyright holder", copyright_holder: "Owner Inc", expected: "Owner Inc" },
    {
      reason: "an unset copyright holder is the owner",
      copyright_holder: undefined,
      expected: "OwnerOrg",
    },
  ])("$reason", ({ copyright_holder, expected }) => {
    const registration = { modules: [], project: { ...PROJECT, copyright_holder } };
    expect(placeholderValues(registration, SLUG, {}, NOW)).toEqual({
      project_name: "My Repo",
      project_slug: "myrepo",
      description: "Does things",
      github_username: "OwnerOrg",
      github_username_lower: "ownerorg",
      copyright_holder: expected,
      year: "2031",
    });
  });
});

describe("placeholderValues: the registration-backed names", () => {
  const defaults = {
    fuzzer_label: "fuzz-nightly",
    nightly_label: "nightly-failure",
    site_label: "docs-link-rot",
  };

  test("absent from both sides, the name has no value; a module default fills it", () => {
    const bare = placeholderValues({ modules: [], project: PROJECT }, SLUG, {}, NOW);
    expect(Object.keys(bare)).not.toContain("fuzzer_label");
    expect(placeholderValues({ modules: [], project: PROJECT }, SLUG, defaults, NOW)).toMatchObject(
      defaults,
    );
  });

  test("the registration's own labels win over the defaults", () => {
    const registration = { modules: [], project: PROJECT, labels: { fuzzer: "fuzz", site: "rot" } };
    expect(placeholderValues(registration, SLUG, defaults, NOW)).toMatchObject({
      fuzzer_label: "fuzz",
      nightly_label: "nightly-failure",
      site_label: "rot",
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
    writeFileSync(join(target, ".repo-platform.yml"), `modules: [bun, site]\n${PROJECT_YAML}`);
    expect(readRegistration(target)).toEqual({ modules: ["bun", "site"], project: PROJECT });
    const linked = temp.dir("writer-registration-link-");
    writeFileSync(join(linked, "elsewhere.yml"), `modules: [bun]\n${PROJECT_YAML}`);
    symlinkSync("elsewhere.yml", join(linked, ".repo-platform.yml"));
    expect(() => readRegistration(linked)).toThrow("not a regular file");
  });

  test("a malformed registration is a hard error naming the file; unknown module names pass", () => {
    const target = temp.dir("writer-registration-bad-");
    const file = join(target, ".repo-platform.yml");
    writeFileSync(file, `modules: [bun]\n${PROJECT_YAML}projekt: {name: x}\n`);
    expect(() => readRegistration(target)).toThrow(
      ".repo-platform.yml: (top level): Unrecognized key",
    );
    writeFileSync(file, `modules: [bun, bun]\n${PROJECT_YAML}`);
    expect(() => readRegistration(target)).toThrow(
      '.repo-platform.yml: duplicate modules entry "bun"',
    );
    writeFileSync(file, PROJECT_YAML);
    expect(() => readRegistration(target)).toThrow(".repo-platform.yml: no module selection found");
    // The one grammar refuses a project-less registration here as in the plan job.
    writeFileSync(file, "modules: [bun]\n");
    expect(() => readRegistration(target)).toThrow(
      ".repo-platform.yml: project: Invalid input: expected object, received undefined",
    );
    writeFileSync(file, `modules: [bun, not-a-module]\n${PROJECT_YAML}`);
    expect(readRegistration(target)).toEqual({
      modules: ["bun", "not-a-module"],
      project: PROJECT,
    });
  });
});
