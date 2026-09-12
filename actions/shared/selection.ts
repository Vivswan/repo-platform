// DEPENDENCY-FREE ZONE (see grammar.ts): node builtins and zone-internal imports only.

/** One `when` clause of files.yml; null is the unconditional entry, the one spelling of "always" every reader parses
 *  an absent or empty clause to. */
export interface When {
  modules?: string[];
  any?: string[];
  without?: string[];
  private?: boolean;
}

/** A module-list position of a `when` clause as files.yml spells it: the names, or every module whose data declares
 *  `key`. A list that IS a module-data fact (the CodeQL toolchains) is spelled the second way, so the modules block
 *  stays its one source and a new module joins the list by declaring the key. */
export type ModuleList = string[] | { declaring: string };

/** The names a list position resolves to; a derived list comes out in the modules block's order. */
export function moduleList(list: ModuleList, modules: Readonly<Record<string, unknown>>): string[] {
  if (Array.isArray(list)) return list;
  return Object.keys(modules).filter((name) => {
    const data = modules[name];
    return typeof data === "object" && data !== null && Object.hasOwn(data, list.declaring);
  });
}

/** One repository's side of every `when` clause. */
export interface Selection {
  /** Selected modules. */
  modules: readonly string[];
  private: boolean;
}

/** The ONE "this entry applies to this repository" rule (docs/sync.md, Selection): the writer, the fleet plan, and
 *  the validator select by it, so a clause the validator judges live is the clause the writer wrote. Absent clauses hold. */
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
