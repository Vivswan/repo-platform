// DEPENDENCY-FREE ZONE (see grammar.ts): node builtins and zone-internal imports only.

/** One `when` clause of files.yml; null is the unconditional entry, the one spelling of "always" every reader parses
 *  an absent or empty clause to. */
export interface When {
  modules?: string[];
  any?: string[];
  without?: string[];
  private?: boolean;
}

/** A list that IS a module-data fact (the CodeQL toolchains) is spelled `{declaring: <key>}`, so the modules block
 *  stays its one source and a new module joins the list by declaring the key. */
export type ModuleList = string[] | { declaring: string };

/** files_config.ts derives an entry's default source from the first `modules` name, so a derived list keeps the
 *  modules block's order. */
export function moduleList(list: ModuleList, modules: Readonly<Record<string, unknown>>): string[] {
  if (Array.isArray(list)) return list;
  return Object.keys(modules).filter((name) => {
    const data = modules[name];
    return typeof data === "object" && data !== null && Object.hasOwn(data, list.declaring);
  });
}

/** One repository's side of selection: the facts every `when` clause reads, and the paths it keeps as its own. */
export interface Selection {
  /** Selected modules. */
  modules: readonly string[];
  private: boolean;
  /** The registration's `except`: no entry at one of these paths is selected. Absent means none. */
  except?: readonly string[];
}

/** Whether one `when` clause holds for the repository: a files.yml entry's (through `selects`) or a settings layer's.
 *  Absent clauses hold. */
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

/** The ONE "this entry applies to this repository" rule (docs/sync.md, Selection): its `when` holds and its path is not
 *  excepted. The writer, the fleet plan, and the validator select by it, so a clause the validator judges live is the
 *  clause the writer wrote. */
export function selects(entry: { path: string; when: When | null }, selection: Selection): boolean {
  return applies(entry.when, selection) && !(selection.except ?? []).includes(entry.path);
}
