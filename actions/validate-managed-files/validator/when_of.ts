import { type ModuleList, moduleList, type When } from "../../shared/selection.ts";
import { isRecord } from "./readers.ts";

const LIST_KEYS = ["modules", "any", "without"] as const;
const WHEN_KEYS = new Set<string>([...LIST_KEYS, "private"]);

const isModuleList = (list: unknown): list is ModuleList =>
  (Array.isArray(list) && list.every((name) => typeof name === "string")) ||
  (isRecord(list) &&
    Object.keys(list).join() === "declaring" &&
    typeof list.declaring === "string");

/** Loose because the delivery commit's files.yml already passed the strict loader. An empty clause folds to null as the
 *  loader's whenSchema does, so `applies` meets one spelling of "always". */
export function whenOf(
  value: unknown,
  modules: Readonly<Record<string, unknown>>,
): When | null | undefined {
  if (value === undefined) return null;
  if (!isRecord(value) || Object.keys(value).some((key) => !WHEN_KEYS.has(key))) return undefined;
  const when: When = {};
  for (const key of LIST_KEYS) {
    const list = value[key];
    if (list === undefined) continue;
    if (!isModuleList(list)) return undefined;
    when[key] = moduleList(list, modules);
  }
  if (value.private !== undefined) {
    if (typeof value.private !== "boolean") return undefined;
    when.private = value.private;
  }
  return Object.keys(when).length === 0 ? null : when;
}
