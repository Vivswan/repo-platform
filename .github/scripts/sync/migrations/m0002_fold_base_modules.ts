// agents, auto-assign, and settings-sync stopped being modules: every
// managed repository renders their files unconditionally from the base
// tree. A .repo-platform.yml still naming them fails module selection (a
// name that is not a choice of the delivered template is refused, never
// dropped), so the names leave the repository's declaration HERE, ahead of
// selection and copier. The answers file is not touched: copier update
// takes the filtered selection as data and records it itself.
//
// The edit is a byte splice - each folded item leaves with its own
// separator and every other byte stays, comments, spacing, line endings,
// and the `mirrors` declaration included (Bun.YAML has no
// comment-preserving emitter) - and the result is re-parsed and checked
// against the declared list minus the folded names before anything is
// written. Self-contained: node builtins and bun only
// (docs/migrations.md).

import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Target {
  readonly dir: string;
  readonly oldSha: string | null;
  readonly newSha: string;
}

type Outcome =
  | {
      readonly kind: "verdict";
      readonly verdict: {
        readonly kind: "dropped" | "in-place" | "missing" | "unreadable";
        readonly note: { readonly text: string; readonly review: boolean } | null;
      };
    }
  | { readonly kind: "error"; readonly message: string };

const REGISTRATION = ".repo-platform.yml";

/** The module names this rung drops from every declaration. */
const FOLDED = ["agents", "auto-assign", "settings-sync"];

const NOTE = [
  "> [!NOTE]",
  "> MODULE FOLD: `agents`, `auto-assign`, and `settings-sync` are no longer",
  "> modules - every managed repository renders their files unconditionally",
  "> (AGENTS.md and its agent-file symlinks, the Copilot review instructions",
  "> and setup starter, auto-assign.yml, settings-sync.yml, and the settings.yml",
  "> starter), and repository settings are applied centrally for every managed",
  "> repository. This update drops the retired name(s) from `.repo-platform.yml`'s",
  "> `modules` list - the rest of the file, comments and any `mirrors` declaration",
  "> included, is untouched - and copier records the shorter selection in",
  "> `.github/.copier-answers.yml`. No rendered file moves or leaves.",
];

/** lstat, so a symlink never reads as the file it points at. ENOENT is
 * absence; ENOTDIR means a parent segment is a file, the same broken shape
 * as a non-file entry; anything else (EACCES, EIO) throws. */
function entryKind(path: string): "file" | "absent" | "other" {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "absent";
    if (code === "ENOTDIR") return "other";
    throw err;
  }
  return stat.isFile() ? "file" : "other";
}

/** The declared module list of a registration text, or null when the sync's
 * selection would refuse the file (no mapping, no list, a non-string, empty,
 * or duplicate entry): that step owns the diagnosis, hide-details handling
 * included, and a rewrite must not launder a declaration it would refuse. */
function declaredModules(text: string): string[] | null {
  let data: unknown;
  try {
    data = Bun.YAML.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const modules = (data as { modules?: unknown }).modules;
  if (!Array.isArray(modules) || !modules.every((m) => typeof m === "string" && m !== "")) {
    return null;
  }
  return new Set(modules).size === modules.length ? modules : null;
}

/** The scalar a list item's text names, quotes stripped; null when the item
 * is not a plain or quoted scalar (a nested collection, an alias). */
function itemName(item: string): string | null {
  const text = item.trim();
  const quoted = /^(["'])(.*)\1$/.exec(text);
  if (quoted !== null) return quoted[2];
  if (text === "" || /^[[{*&!]/.test(text) || text.includes(":")) return null;
  return text;
}

/** The text without its trailing ` # comment`, and that comment (with its
 * leading whitespace) or "". A # inside quotes is not a comment start. */
function splitComment(line: string): [body: string, comment: string] {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      const body = line.slice(0, i).replace(/\s+$/, "");
      return [body, line.slice(body.length)];
    }
  }
  return [line, ""];
}

/** A one-line flow list's inner text with the folded items spliced out:
 * each dropped item leaves with the separator that joined it to its
 * predecessor (the first item takes the separator after it), so the kept
 * items keep their own spacing and quoting byte for byte. Null when an item
 * is not a plain or quoted scalar. */
function spliceFlowItems(inner: string): string | null {
  if (inner.trim() === "") return inner;
  const items: { start: number; end: number; name: string; index: number }[] = [];
  let cursor = 0;
  for (const [index, segment] of inner.split(",").entries()) {
    const name = itemName(segment);
    if (name === null) return null;
    const start = cursor + segment.indexOf(segment.trim());
    items.push({ start, end: start + segment.trim().length, name, index });
    cursor += segment.length + 1;
  }
  const kept = items.filter((item) => !FOLDED.includes(item.name));
  const first = items[0];
  const last = items[items.length - 1];
  let out = inner.slice(0, first.start);
  kept.forEach((item, j) => {
    // A kept item keeps the separator to its OWN predecessor in the original
    // list; the first kept item keeps none (a dropped first item took the
    // separator after it).
    if (j > 0) out += inner.slice(items[item.index - 1].end, item.start);
    out += inner.slice(item.start, item.end);
  });
  return out + inner.slice(last.end);
}

/** `text` with the folded names removed from its top-level `modules` list,
 * every other byte kept (the line's own ending included). Null when the
 * list's shape is not one the edit understands (a flow list spanning lines,
 * an item that is not a scalar). */
function dropFolded(text: string): string | null {
  const lines = text.split("\n");
  const keyAt = lines.findIndex((line) => /^modules\s*:/.test(line));
  if (keyAt === -1) return null;
  const keyLine = lines[keyAt];
  const colon = keyLine.indexOf(":");
  const [value, comment] = splitComment(keyLine.slice(colon + 1));
  // A CR belongs to the line, never to a rewritten value.
  const eol = comment === "" && value.endsWith("\r") ? "\r" : "";
  if (value.trim() !== "") {
    // Flow style on one line: `modules: ["a", "b"] # comment`.
    const open = value.indexOf("[");
    const close = value.lastIndexOf("]");
    if (open === -1 || close === -1 || value.slice(close + 1).trim() !== "") return null;
    const spliced = spliceFlowItems(value.slice(open + 1, close));
    if (spliced === null) return null;
    lines[keyAt] =
      `${keyLine.slice(0, colon + 1)}${value.slice(0, open + 1)}${spliced}${value.slice(close)}${comment}`;
    return lines.join("\n");
  }
  // Block style: item lines follow the key, comments and blank lines allowed
  // between them, until the first line that is neither.
  let end = keyAt + 1;
  let indent: string | null = null;
  const dropped = new Set<number>();
  for (; end < lines.length; end++) {
    const line = lines[end];
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    // [\s\S], not `.`: a CR is a line terminator `.` never matches.
    const item = /^(\s+)-(\s[\s\S]*|)$/.exec(line);
    if (item === null) break;
    if (indent === null) indent = item[1];
    else if (item[1] !== indent) return null;
    const [body] = splitComment(item[2]);
    const name = itemName(body);
    if (name === null) return null;
    if (FOLDED.includes(name)) dropped.add(end);
  }
  // Trailing blank or comment lines belong to whatever follows the list.
  while (end > keyAt + 1 && (lines[end - 1].trim() === "" || /^\s*#/.test(lines[end - 1]))) end--;
  const remaining = lines.slice(keyAt + 1, end).filter((_line, i) => !dropped.has(keyAt + 1 + i));
  const emptied = !remaining.some((line) => /^\s+-/.test(line));
  const replacement = emptied
    ? [`${keyLine.slice(0, colon + 1)} []${comment}${eol}`, ...remaining]
    : [keyLine, ...remaining];
  return [...lines.slice(0, keyAt), ...replacement, ...lines.slice(end)].join("\n");
}

/** Everything but the modules list, for the rest-of-document check. */
function withoutModules(text: string): string {
  const data = Bun.YAML.parse(text) as Record<string, unknown>;
  const { modules: _modules, ...rest } = data;
  return JSON.stringify(rest);
}

function git(dir: string, ...args: string[]): { exitCode: number; stderr: string } {
  const proc = Bun.spawnSync(["git", "-C", dir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 300_000,
  });
  return { exitCode: proc.exitCode, stderr: proc.stderr.toString() };
}

const HAND_EDIT =
  `${REGISTRATION}'s modules list cannot be rewritten mechanically (a flow list spanning ` +
  "lines, an item that is not a plain module name, or an indentation this rung does not " +
  "understand). Remove `agents`, `auto-assign`, and `settings-sync` from its `modules` " +
  "list by hand on the default branch, then re-run the sync.";

export default {
  id: "m0002_fold_base_modules",

  apply(target: Target): Outcome {
    const path = join(target.dir, REGISTRATION);
    const kind = entryKind(path);
    if (kind === "absent") return { kind: "verdict", verdict: { kind: "missing", note: null } };
    if (kind === "other") {
      return {
        kind: "error",
        message:
          `${REGISTRATION} is not a regular file (a symlink or a directory), so the retired ` +
          "module names cannot be dropped in place - the sync never writes through a link. " +
          "Replace it with a regular file naming the current modules on the default branch, " +
          "then re-run the sync.",
      };
    }
    const text = readFileSync(path, "utf-8");
    const declared = declaredModules(text);
    if (declared === null) {
      return { kind: "verdict", verdict: { kind: "unreadable", note: null } };
    }
    const present = declared.filter((name) => FOLDED.includes(name));
    if (present.length === 0) {
      return { kind: "verdict", verdict: { kind: "in-place", note: null } };
    }
    const expected = declared.filter((name) => !FOLDED.includes(name));
    const rewritten = dropFolded(text);
    // The whole outcome is checked before the write: the list is exactly
    // the declared one minus the folded names, and nothing else moved.
    if (
      rewritten === null ||
      JSON.stringify(declaredModules(rewritten)) !== JSON.stringify(expected) ||
      withoutModules(rewritten) !== withoutModules(text)
    ) {
      return { kind: "error", message: HAND_EDIT };
    }
    writeFileSync(path, rewritten);
    const added = git(target.dir, "add", "--", REGISTRATION);
    if (added.exitCode !== 0) {
      const lines = added.stderr.split("\n").filter((line) => line.trim() !== "");
      return {
        kind: "error",
        message: `git add ${REGISTRATION} failed (exit ${added.exitCode}: ${lines.length === 0 ? "no output" : lines[lines.length - 1].trim()})`,
      };
    }
    const names = present.map((name) => `\`${name}\``).join(", ");
    return {
      kind: "verdict",
      verdict: {
        kind: "dropped",
        note: { text: [...NOTE, `> Dropped here: ${names}.`].join("\n"), review: false },
      },
    };
  },
};
