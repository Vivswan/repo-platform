import { isRecord } from "./readers.ts";

export interface When {
  modules?: string[];
  any?: string[];
  without?: string[];
  private?: boolean;
}

export interface Selection {
  modules: readonly string[];
  private: boolean;
}

/** The writer's selection rule, `applies` in actions/plan/files_config.ts, repeated here because this action carries no
 *  zod and so cannot import the loader; tests/actions/validate-managed-files/validator/selection.test.ts pins the two equal. */
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

const LIST_KEYS = ["modules", "any", "without"] as const;
const WHEN_KEYS = new Set<string>([...LIST_KEYS, "private"]);

const isNames = (list: unknown): list is string[] =>
  Array.isArray(list) && list.every((name) => typeof name === "string");

/** Loose because the build branch's files.yml already passed the strict loader. An empty clause folds to null as the
 *  loader's whenSchema does, so `applies` meets one spelling of "always". */
export function whenOf(value: unknown): When | null | undefined {
  if (value === undefined) return null;
  if (!isRecord(value) || Object.keys(value).some((key) => !WHEN_KEYS.has(key))) return undefined;
  const when: When = {};
  for (const key of LIST_KEYS) {
    const list = value[key];
    if (list === undefined) continue;
    if (!isNames(list)) return undefined;
    when[key] = list;
  }
  if (value.private !== undefined) {
    if (typeof value.private !== "boolean") return undefined;
    when.private = value.private;
  }
  return Object.keys(when).length === 0 ? null : when;
}
