// The fleet LICENSE must not ship alongside registry metadata still
// claiming a different license: npm, crates.io, PyPI, and the VS Code
// Marketplace all display the manifest's claim, not the LICENSE file, so
// a repo that adopts the fleet license while its package.json says "MIT"
// publishes a false grant under the licensor's name. When the sync
// renders the fleet LICENSE (custom-license module not selected), this
// script scans the target's manifests and writes a PR-body section for
// every conflicting claim; open_pr.ts appends it. Repos on the
// custom-license module keep their own license, so their metadata is
// theirs to state.
//
// Allowed forms (LicenseRef expressions are valid SPDX and the correct
// custom-license spelling; a listed identifier like MIT is the error):
//   package.json   "license": "SEE LICENSE IN LICENSE"
//   Cargo.toml     license-file = "LICENSE" and no license key
//   pyproject.toml license = "LicenseRef-..." (a single expression) or
//                  license = { file = "LICENSE" }, and no "License ::"
//                  trove classifier
//
// Manifest values are target-derived, so the log line names only the
// manifest files and the specifics travel in the summary file (it ships
// in the target's PR).
//
// Env: MODULES (JSON array), TARGET_DIR (default target), RUNNER_TEMP.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env, requireEnv, warning } from "../shared/gha.ts";

const FLEET_NPM_LICENSE = "SEE LICENSE IN LICENSE";

export type ManifestTexts = {
  packageJson?: string;
  cargoToml?: string;
  pyprojectToml?: string;
};

type TomlTable = Record<string, unknown>;

function parseToml(text: string): TomlTable | null {
  try {
    return Bun.TOML.parse(text) as TomlTable;
  } catch {
    return null;
  }
}

function table(value: unknown): TomlTable | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as TomlTable)
    : undefined;
}

export function checkManifests(texts: ManifestTexts): string[] {
  const problems: string[] = [];

  if (texts.packageJson !== undefined) {
    let manifest: TomlTable | undefined;
    try {
      manifest = table(JSON.parse(texts.packageJson));
    } catch {
      problems.push("`package.json`: unparseable, license claim unknown");
    }
    const license = manifest?.license;
    if (license !== undefined && license !== FLEET_NPM_LICENSE) {
      problems.push(
        `\`package.json\`: \`"license": ${JSON.stringify(license)}\` - set it to \`"${FLEET_NPM_LICENSE}"\``,
      );
    }
    if (manifest?.licenses !== undefined) {
      problems.push(
        `\`package.json\`: the legacy \`"licenses"\` field claims a license - delete it and set \`"license": "${FLEET_NPM_LICENSE}"\``,
      );
    }
  }

  if (texts.cargoToml !== undefined) {
    const cargo = parseToml(texts.cargoToml);
    if (!cargo) {
      problems.push("`Cargo.toml`: unparseable, license claim unknown");
    } else {
      const sections: [string, TomlTable | undefined][] = [
        ["package", table(cargo.package)],
        ["workspace.package", table(table(cargo.workspace)?.package)],
      ];
      for (const [name, section] of sections) {
        if (!section) continue;
        if (section.license !== undefined) {
          problems.push(
            `\`Cargo.toml\`: \`[${name}]\` has a \`license\` key - delete it and set \`license-file = "LICENSE"\``,
          );
        }
        const licenseFile = section["license-file"];
        if (licenseFile !== undefined && licenseFile !== "LICENSE") {
          problems.push(
            `\`Cargo.toml\`: \`[${name}] license-file\` points at ${JSON.stringify(licenseFile)} - point it at \`"LICENSE"\``,
          );
        }
      }
    }
  }

  if (texts.pyprojectToml !== undefined) {
    const pyproject = parseToml(texts.pyprojectToml);
    if (!pyproject) {
      problems.push("`pyproject.toml`: unparseable, license claim unknown");
    } else {
      const project = table(pyproject.project);
      const license = project?.license;
      if (typeof license === "string") {
        if (!/^LicenseRef-\S+$/.test(license)) {
          problems.push(
            '`pyproject.toml`: `license =` claims an SPDX license - use a single `LicenseRef-` expression or `{ file = "LICENSE" }`',
          );
        }
      } else if (license !== undefined) {
        const licenseTable = table(license);
        if (licenseTable?.file !== "LICENSE" || Object.keys(licenseTable).length !== 1) {
          problems.push(
            '`pyproject.toml`: the `license` table claims something other than the LICENSE file - use `{ file = "LICENSE" }`',
          );
        }
      }
      const classifiers = project?.classifiers;
      if (
        Array.isArray(classifiers) &&
        classifiers.some((entry) => typeof entry === "string" && entry.startsWith("License ::"))
      ) {
        problems.push(
          "`pyproject.toml`: a `License ::` trove classifier claims a listed license - delete it (no classifier exists for the fleet license)",
        );
      }
    }
  }

  return problems;
}

export function manifestSummary(problems: string[]): string {
  if (problems.length === 0) return "";
  return `> [!WARNING]
> Registry metadata still claims a different license than the fleet
> LICENSE this update delivers. Registries publish the manifest's
> claim, so fix these on this branch or right after merging:

${problems.map((problem) => `- ${problem}`).join("\n")}
`;
}

if (import.meta.main) {
  const targetDir = env("TARGET_DIR", "target");
  const outFile = join(requireEnv("RUNNER_TEMP"), "manifest-license-warnings.md");
  if (env("MODULES").includes("custom-license")) {
    writeFileSync(outFile, "");
    process.exit(0);
  }
  const read = (name: string): string | undefined => {
    const path = join(targetDir, name);
    return existsSync(path) ? readFileSync(path, "utf-8") : undefined;
  };
  const texts: ManifestTexts = {
    packageJson: read("package.json"),
    cargoToml: read("Cargo.toml"),
    pyprojectToml: read("pyproject.toml"),
  };
  const problems = checkManifests(texts);
  writeFileSync(outFile, manifestSummary(problems));
  if (problems.length > 0) {
    const files = [...new Set(problems.map((problem) => problem.split("`")[1]))].join(", ");
    warning(
      `license claims in ${files} conflict with the fleet LICENSE; details in the sync PR body`,
    );
  }
}
