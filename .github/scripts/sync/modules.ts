// The module vocabulary the operator judges a scope or a registration
// against: files.yml's modules keys, in the data file's order (the
// canonical module order). The registration grammar itself lives with the
// plan action (actions/plan/registration.ts), the one home every reader
// imports it from.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseFilesConfig } from "../../../actions/plan/files_config.ts";

export const FILES_CONFIG = resolve(import.meta.dir, "..", "..", "..", "files.yml");

/** Every module files.yml knows, in canonical order. */
export function moduleRoster(path: string = FILES_CONFIG): string[] {
  return Object.keys(parseFilesConfig(readFileSync(path, "utf-8"), path).modules);
}
