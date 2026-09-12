// DEPENDENCY-FREE ZONE (see grammar.ts): node builtins and zone-internal imports only.

/** One `when` clause of files.yml; null is the unconditional entry, the one spelling of "always" every reader parses
 *  an absent or empty clause to. */
export interface When {
  modules?: string[];
  any?: string[];
  without?: string[];
  private?: boolean;
}

/** One repository's side of every `when` clause. */
export interface Selection {
  /** Selected modules in files.yml order. */
  modules: readonly string[];
  private: boolean;
}

/** The ONE "this entry applies to this repository" rule (docs/sync.md, Selection): the writer, the fleet plan, and
 *  the validator select by it, so a clause the validator judges live is the clause the writer wrote. Absent clauses hold.
 *
 *  modules  -> every listed module is selected
 *  any      -> at least one listed module is selected
 *  without  -> none of the listed modules is selected
 *  private  -> the repository's visibility matches */
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
