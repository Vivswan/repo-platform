// Manifest fixtures shared by the compose suites: a parsed module manifest
// from a few YAML lines, plus the module shapes the data-anchor tests group.

import { type ModuleManifest, parseManifest } from "../../../scripts/lib/module_manifests";

export function manifest(module: string, body: string[]): ModuleManifest {
  return parseManifest(
    module,
    ["description: a test module", ...body].join("\n"),
    `templates/${module}/module.yml`,
  );
}

export const BUN = manifest("bun", [
  "toolchain: {codeql_language: javascript-typescript}",
  'dependabot: {ecosystem: bun, label: javascript, color: "168700"}',
  "lockfiles: ['bun\\.lock', 'bun\\.lockb']",
]);
export const NODE = manifest("node", [
  "toolchain: {codeql_language: javascript-typescript}",
  'dependabot: {ecosystem: npm, label: javascript, color: "168700"}',
  "lockfiles: ['package-lock\\.json']",
]);
export const UV = manifest("uv", [
  "toolchain: {codeql_language: python}",
  'dependabot: {ecosystem: uv, label: "python:uv", color: "2b67c6"}',
  "lockfiles: ['uv\\.lock']",
]);
export const AGENTS = manifest("agents", []);
