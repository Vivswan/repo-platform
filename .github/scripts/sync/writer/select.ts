// Which files.yml entries apply to one repository: its selected modules
// (unknown names dropped and reported, never an error that blocks the
// rest) and its visibility, judged against each entry's `when`.

import type { FileEntry, FilesConfig, When } from "../../../../actions/plan/files_config.ts";

export interface Selection {
  /** Selected modules in files.yml order. */
  modules: string[];
  private: boolean;
}

/** `modules` = all selected, `any` = at least one selected, `without` =
 *  none selected, `private` = the visibility matches; absent clauses hold. */
export function applies(when: When | null, selection: Selection): boolean {
  if (when === null) return true;
  const selected = (name: string) => selection.modules.includes(name);
  return (
    (when.modules ?? []).every(selected) &&
    (when.any === undefined || when.any.some(selected)) &&
    !(when.without ?? []).some(selected) &&
    (when.private === undefined || when.private === selection.private)
  );
}

export function selectEntries(config: FilesConfig, selection: Selection): FileEntry[] {
  return config.files.filter((entry) => applies(entry.when, selection));
}

/** The requested module names split into the ones files.yml knows (in its
 *  order) and the ones it does not. */
export function resolveModules(
  config: FilesConfig,
  requested: string[],
): { selected: string[]; dropped: string[] } {
  const known = Object.keys(config.modules);
  return {
    selected: known.filter((name) => requested.includes(name)),
    dropped: requested.filter((name) => !known.includes(name)),
  };
}
