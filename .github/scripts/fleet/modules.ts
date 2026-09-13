// Key order is the canonical module order every reader relies on; the registration grammar itself lives in actions/plan/registration.ts.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseFilesConfig } from "../../../actions/plan/files_config.ts";

export const FILES_CONFIG = resolve(import.meta.dir, "..", "..", "..", "files.yml");

export function moduleRoster(path: string = FILES_CONFIG): string[] {
  return Object.keys(parseFilesConfig(readFileSync(path, "utf-8"), path).modules);
}
