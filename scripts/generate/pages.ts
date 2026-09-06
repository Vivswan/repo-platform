// The Pages regions: copier.yml's pages_setup and pages_*_command questions
// and docs/pages.md's table cells, all from the manifests declaring Pages
// commands.

import type { ModuleManifest } from "../lib/module_manifests.ts";

export type PagesManifest = ModuleManifest & { pages: NonNullable<ModuleManifest["pages"]> };

/** The manifests declaring Pages commands, filtered once for the three
 *  pages_* region builders. */
export function pagesManifests(manifests: ModuleManifest[]): PagesManifest[] {
  const withPages = manifests.filter((m): m is PagesManifest => m.pages !== undefined);
  if (withPages.length === 0) {
    throw new Error(
      "no manifest declares pages commands, so copier.yml's pages_setup and " +
        "pages_*_command defaults would offer no toolchains - declare " +
        "pages: {install, build} in at least one module.yml",
    );
  }
  return withPages;
}

/** copier.yml `pages_setup`: default expression + validator token list. */
export function pagesSetup(withPages: PagesManifest[]): string[] {
  const defaultExpr = withPages
    .map((m) => `(['${m.module}'] if '${m.module}' in modules else [])`)
    .join(" + ");
  const names = withPages.map((m) => m.module);
  const tokenList = [...names, "none"].map((t) => `'${t}'`).join(", ");
  const tokenProse = names.length === 1 ? `${names[0]} or none` : `${names.join(", ")}, or none`;
  return [
    `  default: "{{ (${defaultExpr}) | join(',') or 'none' }}"`,
    `  validator: "{% set ts = pages_setup.split(',') %}{% if '' in ts or ts | map('trim') | list != ts %}` +
      "pages_setup must be comma-separated with no spaces or empty tokens" +
      `{% elif ts | reject('in', [${tokenList}]) | list %}pages_setup tokens must be ${tokenProse}` +
      "{% elif ts | unique | list | length != ts | length %}pages_setup tokens must be unique" +
      `{% elif 'none' in ts and ts | length > 1 %}pages_setup 'none' cannot be combined with toolchains{% endif %}"`,
  ];
}

/** The nested `'<cmd>' if '<module>' in pages_setup.split(',') else (...)`
 *  chain for a per-toolchain pages command, ending in ''. */
function pagesCommandChain(
  withPages: PagesManifest[],
  command: (pages: PagesManifest["pages"]) => string,
): string[] {
  let chain = "''";
  for (const m of [...withPages].reverse()) {
    const alternative = chain === "''" ? "''" : `(${chain})`;
    chain = `'${command(m.pages)}' if '${m.module}' in pages_setup.split(',') else ${alternative}`;
  }
  return [`  default: "{{ ${chain} }}"`];
}

/** copier.yml `pages_install_command` default chain. */
export function pagesInstallCommand(withPages: PagesManifest[]): string[] {
  return pagesCommandChain(withPages, (pages) => pages.install);
}

/** copier.yml `pages_build_command` default chain. */
export function pagesBuildCommand(withPages: PagesManifest[]): string[] {
  return pagesCommandChain(withPages, (pages) => pages.build);
}

/** docs/pages.md `pages_setup` row: the Meaning cell. */
export function pagesSetupMeaning(withPages: PagesManifest[]): string {
  const names = withPages.map((m) => m.module);
  if (names.length === 1) {
    return `Toolchain installed on the build runner (\`${names[0]}\` or \`none\`)`;
  }
  const tokens = names.map((name) => `\`${name}\``).join("/");
  return `Toolchain(s) installed on the build runner (comma-separated ${tokens}, or \`none\`)`;
}

/** docs/pages.md `pages_setup` row: the Default cell. */
export function pagesSetupDefault(withPages: PagesManifest[]): string {
  const names = withPages.map((m) => m.module);
  if (names.length === 1) {
    return `\`${names[0]}\` when that module is selected, else \`none\``;
  }
  return (
    "every selected toolchain module joined with commas " +
    `(e.g. \`${names.join(",")}\`), else \`none\``
  );
}

/** docs/pages.md `pages_install_command` row: the Default cell. */
export function pagesInstallRow(withPages: PagesManifest[]): string {
  return [...withPages.map((m) => `\`${m.pages.install}\``), "empty"].join(" / ");
}

/** docs/pages.md `pages_build_command` row: the Default cell. */
export function pagesBuildRow(withPages: PagesManifest[]): string {
  return withPages.map((m) => `\`${m.pages.build}\``).join(" / ");
}
