// MODULES travels as the JSON list from modules.json; membership tests
// must run on the parsed list - a substring test on the JSON text would
// match any module whose name merely contains another's.
export function parseModules(text: string): string[] | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  return Array.isArray(data) && data.every((entry) => typeof entry === "string")
    ? (data as string[])
    : null;
}
