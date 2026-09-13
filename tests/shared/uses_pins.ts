import { PLATFORM_NAME, PLATFORM_OWNER } from "../../actions/shared/platform";

export interface Pin {
  file: string;
  action: string;
  ref: string;
  /** The trailing `# <tag>` comment naming what the ref was pinned from, or null when the line carries none. */
  version: string | null;
}

/** Every `uses:` pin of a source, commented example lines included; a placeholder-owner line is a self pin (sourceSelfPins), not a third-party one. */
export function extractUsesPins(text: string, file: string): Pin[] {
  const pins: Pin[] = [];
  for (const rawLine of text.split("\n")) {
    // A line can carry BOTH a real pin and an unrelated placeholder, so the placeholder becomes a sentinel no owner or ref can hold.
    const line = rawLine.replace(/\{\{[^}]*\}\}/g, "<PLACEHOLDER>");
    const match = line.match(
      /uses:\s*['"]?([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)@([^\s'"]+)['"]?(?:[ \t]+#[ \t]*(\S+))?/,
    );
    if (!match) continue;
    if (match[2].includes("<PLACEHOLDER>")) continue;
    const action = match[1].split("/").slice(0, 2).join("/");
    pins.push({ file, action, ref: match[2], version: match[3] ?? null });
  }
  return pins;
}

export interface SelfPin {
  file: string;
  /** The owner slot as written: the `github_username` placeholder or a literal owner. */
  owner: string;
  /** The pin's stem after the owner: <name>/<path>. */
  stem: string;
  ref: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A self pin is a `uses:` naming this repository under any owner slot (a placeholder or a literal), so a mistyped owner is judged
 *  rather than skipped. Only the `uses:` keyword marks a pin: prose spells the shape with an ellipsis. */
export function sourceSelfPins(text: string, file: string): SelfPin[] {
  const ownerSlot = String.raw`(\{\{\s*[a-z_]+\s*\}\}|[A-Za-z0-9-]+)`;
  const token = new RegExp(
    String.raw`uses:\s*['"]?${ownerSlot}/(${escapeRegExp(PLATFORM_NAME)}/[A-Za-z0-9_./-]+)@([^\s"'\x60]*)`,
    "gi",
  );
  return [...text.matchAll(token)].map((match) => ({
    file,
    owner: match[1],
    stem: match[2],
    ref: match[3],
  }));
}

/** The owner a self pin may name: this repository's owner in any case, or the writer's `github_username` placeholder in either spelling. */
export function ownsPlatform(owner: string): boolean {
  return (
    /^\{\{\s*github_username(_lower)?\s*\}\}$/.test(owner) ||
    owner.toLowerCase() === PLATFORM_OWNER.toLowerCase()
  );
}
