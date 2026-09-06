// Drops agents, auto-assign, and settings-sync (now base content) from
// .repo-platform.yml ahead of module selection, which refuses a name the
// template no longer offers; copier records the shorter list itself.
// A repository's OWN file at an agent-file alias path (unlisted in HEAD's
// ownership manifest) is folded into AGENTS.md first, or copier would
// overwrite it with the managed symlink. Self-contained (docs/migrations.md).

import { lstatSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
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
        /** The declaration's outcome, suffixed `+aliases` when the
         * repository's own agent-file aliases were folded into AGENTS.md. */
        readonly kind: string;
        readonly note: { readonly text: string; readonly review: boolean } | null;
      };
    }
  | { readonly kind: "error"; readonly message: string };

const REGISTRATION = ".repo-platform.yml";

/** The module names this rung drops from every declaration. */
const FOLDED = ["agents", "auto-assign", "settings-sync"];

const AGENTS = "AGENTS.md";
/** The ownership manifest every render stamps: the paths it lists were
 * rendered by the template. */
const MANIFEST = ".github/repo-platform-manifest.json";
/** The agent-file aliases the template renders as symlinks to AGENTS.md. */
const ALIASES = ["CLAUDE.md", ".github/agents.md", ".github/copilot-instructions.md"];
/** The other files the fold makes managed for every repository; a
 * repository's own file there has no home the sync may choose for it. */
const MANAGED_ARRIVALS = [
  ".github/instructions/review.instructions.md",
  ".github/workflows/auto-assign.yml",
  ".github/workflows/settings-sync.yml",
];

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
function entryKind(path: string): "file" | "dir" | "absent" | "other" {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "absent";
    if (code === "ENOTDIR") return "other";
    throw err;
  }
  if (stat.isFile()) return "file";
  return stat.isDirectory() && !stat.isSymbolicLink() ? "dir" : "other";
}

/** The declared module list, or null when the sync's selection would refuse
 * the file (no mapping or list, a non-string, empty, or duplicate entry): that
 * step owns the diagnosis, and a rewrite must not launder what it refuses. */
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

/** A one-line flow list's inner text with the folded items spliced out, each
 * with the separator to its predecessor (the first takes the one after it); a
 * trailing comma is no item. Null when an item is not a plain or quoted scalar. */
function spliceFlowItems(inner: string): string | null {
  if (inner.trim() === "") return inner;
  const segments = inner.split(",");
  const trailingComma = segments.length > 1 && segments[segments.length - 1].trim() === "";
  if (trailingComma) segments.pop();
  const items: { start: number; end: number; name: string; index: number }[] = [];
  let cursor = 0;
  for (const [index, segment] of segments.entries()) {
    const name = itemName(segment);
    if (name === null) return null;
    const start = cursor + segment.indexOf(segment.trim());
    items.push({ start, end: start + segment.trim().length, name, index });
    cursor += segment.length + 1;
  }
  const kept = items.filter((item) => !FOLDED.includes(item.name));
  const first = items[0];
  const last = items[items.length - 1];
  // Everything after the last item: the trailing comma and its whitespace,
  // kept only while an item remains to trail.
  const tail = inner.slice(last.end);
  let out = inner.slice(0, first.start);
  kept.forEach((item, j) => {
    // A kept item keeps the separator to its OWN predecessor in the original
    // list; the first kept item keeps none (a dropped first item took the
    // separator after it).
    if (j > 0) out += inner.slice(items[item.index - 1].end, item.start);
    out += inner.slice(item.start, item.end);
  });
  return out + (kept.length === 0 && trailingComma ? tail.replace(/^\s*,\s*/, "") : tail);
}

/** `text` with the folded names spliced out of its top-level `modules` list,
 * every other byte kept. Null for a shape the edit does not understand (a flow
 * list spanning lines, a non-scalar item). */
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

function git(dir: string, ...args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["git", "-C", dir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 300_000,
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

/** Whether the symlink at `rel` is the one the template renders: its target
 * is AGENTS.md at the repository root (`AGENTS.md` or `../AGENTS.md`). */
function isTemplateAlias(dir: string, rel: string): boolean {
  let target: string;
  try {
    target = readlinkSync(join(dir, rel));
  } catch {
    return false;
  }
  return target === (rel.includes("/") ? `../${AGENTS}` : AGENTS);
}

/** The paths HEAD's ownership manifest lists, or null when the manifest is
 * absent or not the shape the stamper writes (nothing can then be told
 * about a file's origin, and the caller refuses to guess). */
function manifestPaths(dir: string): Set<string> | null {
  if (entryKind(join(dir, MANIFEST)) !== "file") return null;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(join(dir, MANIFEST), "utf-8"));
  } catch {
    return null;
  }
  const files = (data as { files?: unknown } | null)?.files;
  if (typeof files !== "object" || files === null || Array.isArray(files)) return null;
  return new Set(Object.keys(files));
}

const ALIAS_NOTE = [
  "> [!WARNING]",
  "> AGENT FILES FOLDED: this repository carried its own regular file at an",
  "> agent-file alias path that the template now renders as a symlink to",
  "> `AGENTS.md`. Its content was moved verbatim into `AGENTS.md` below the",
  "> managed region, under a heading naming the source path (a final newline",
  "> is added when the file had none), and the alias became the managed",
  "> symlink. Reconcile the moved content into your repository-specific",
  "> section before merging; nothing was deleted.",
];

/** The block appended to AGENTS.md for one folded alias. Repository bytes
 * ride as Buffers (a utf-8 decode would fold a non-UTF-8 byte onto U+FFFD); a
 * final newline is added when the file had none, so the next block starts a line. */
function foldedBlock(alias: string, content: Buffer): Buffer {
  const heading =
    `\n## Folded from ${alias}\n\n` +
    `This repository carried its own \`${alias}\` before the agent files became managed ` +
    `symlinks to \`AGENTS.md\`; its content follows verbatim. Reconcile it into the sections above.\n\n`;
  const newline =
    content.length > 0 && content[content.length - 1] === 0x0a ? [] : [Buffer.from("\n")];
  return Buffer.concat([Buffer.from(heading, "utf-8"), content, ...newline]);
}

const HAND_EDIT =
  `${REGISTRATION}'s modules list cannot be rewritten mechanically (a flow list spanning ` +
  "lines, an item that is not a plain module name, or an indentation this rung does not " +
  "understand). Remove `agents`, `auto-assign`, and `settings-sync` from its `modules` " +
  "list by hand on the default branch, then re-run the sync.";

export default {
  id: "m0002_fold_base_modules",

  apply(target: Target): Outcome {
    // lstat follows a symlinked PARENT: a linked .github would have the fold
    // read and remove files wherever it points, so it is judged first (as m0001).
    const parent = entryKind(join(target.dir, ".github"));
    if (parent === "file" || parent === "other") {
      return {
        kind: "error",
        message:
          ".github is not a real directory (a symlink or a file), so the files this template " +
          "now renders beneath it cannot be judged. The sync refuses to read or write through " +
          "it: fix the default branch by hand, then re-run the sync.",
      };
    }
    // Judged before anything is written, so an error arm leaves the tree
    // untouched. Every arrival is a regular file or absent, or (for an alias)
    // the symlink the template renders; anything else is the error arm.
    const arrivals = [...ALIASES, ...MANAGED_ARRIVALS].map(
      (rel) => [rel, entryKind(join(target.dir, rel))] as const,
    );
    const odd = arrivals.find(
      ([rel, kind]) =>
        kind === "dir" ||
        (kind === "other" && !(ALIASES.includes(rel) && isTemplateAlias(target.dir, rel))),
    );
    if (odd !== undefined) {
      return {
        kind: "error",
        message:
          `carries something other than a regular file at ${odd[0]} (a directory, or a symlink ` +
          "that is not the template's own alias to AGENTS.md), a path this template now manages " +
          "for every repository. The sync refuses to guess: fix the default branch by hand, then " +
          "re-run the sync.",
      };
    }
    // AGENTS.md is classified with the arrivals, before the manifest is read.
    const agentsKind = entryKind(join(target.dir, AGENTS));
    if (agentsKind !== "file" && agentsKind !== "absent") {
      return {
        kind: "error",
        message:
          `carries something other than a regular file at ${AGENTS} (a symlink or a directory), ` +
          "a path this template renders for every repository. Fix the default branch by hand, " +
          "then re-run the sync.",
      };
    }
    const presentFiles = arrivals.filter(([, kind]) => kind === "file").map(([rel]) => rel);
    const listed = presentFiles.length === 0 ? new Set<string>() : manifestPaths(target.dir);
    if (listed === null) {
      return {
        kind: "error",
        message:
          `carries a regular file at ${presentFiles[0]}, a path this template now manages for every ` +
          `repository, and its ${MANIFEST} cannot be read, so whether the template rendered ` +
          "that file cannot be judged (the sync never overwrites a file it did not render). " +
          "Fix the default branch by hand, then re-run the sync.",
      };
    }
    const own = presentFiles.filter((rel) => !listed.has(rel));
    const ownArrival = own.find((rel) => MANAGED_ARRIVALS.includes(rel));
    if (ownArrival !== undefined) {
      return {
        kind: "error",
        message:
          `carries its own regular file at ${ownArrival}, a path this template now manages ` +
          "for every repository (the sync never overwrites a file it did not render). Move the " +
          "file aside on the default branch - its content has no place the sync may choose - " +
          "then re-run the sync.",
      };
    }
    const ownAliases = own.filter((rel) => ALIASES.includes(rel));
    const path = join(target.dir, REGISTRATION);
    const kind = entryKind(path);
    if (kind === "absent") return this.foldAliases(target, ownAliases, "missing", []);
    if (kind !== "file") {
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
    const listKind =
      declared === null
        ? "unreadable"
        : declared.some((name) => FOLDED.includes(name))
          ? "dropped"
          : "in-place";
    if (listKind !== "dropped") return this.foldAliases(target, ownAliases, listKind, []);
    if (declared === null) throw new Error("unreachable: a dropped list was declared");
    const present = declared.filter((name) => FOLDED.includes(name));
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
    return this.foldAliases(target, ownAliases, "dropped", [...NOTE, `> Dropped here: ${names}.`]);
  },

  /** Appends each own alias file to AGENTS.md (created when absent) and
   * removes it, both staged; the kind gains `+aliases` and the note holds the
   * PR. Nothing to fold returns `listKind` with its note unchanged. */
  foldAliases(
    target: Target,
    ownAliases: readonly string[],
    listKind: string,
    noteLines: readonly string[],
  ): Outcome {
    const note = (review: boolean) =>
      noteLines.length === 0 && !review
        ? null
        : {
            text: [
              ...noteLines,
              ...(review ? [...(noteLines.length ? [">"] : []), ...ALIAS_NOTE] : []),
            ].join("\n"),
            review,
          };
    if (ownAliases.length === 0) {
      return { kind: "verdict", verdict: { kind: listKind, note: note(false) } };
    }
    const agentsPath = join(target.dir, AGENTS);
    const parts: Buffer[] = [
      entryKind(agentsPath) === "file" ? readFileSync(agentsPath) : Buffer.alloc(0),
    ];
    // Only a TRACKED alias has a removal to stage; `git add` of a deleted
    // untracked path matches nothing and fails, so the index is asked first
    // (before the removal, while the path still exists).
    const tracked = ownAliases.filter(
      (alias) => git(target.dir, "ls-files", "--", alias).stdout.trim() !== "",
    );
    for (const alias of ownAliases) {
      const aliasPath = join(target.dir, alias);
      parts.push(foldedBlock(alias, readFileSync(aliasPath)));
      rmSync(aliasPath);
    }
    writeFileSync(agentsPath, Buffer.concat(parts));
    const added = git(target.dir, "add", "--", AGENTS, ...tracked);
    if (added.exitCode !== 0) {
      const lines = added.stderr.split("\n").filter((line) => line.trim() !== "");
      return {
        kind: "error",
        message: `git add ${AGENTS} failed (exit ${added.exitCode}: ${lines.length === 0 ? "no output" : lines[lines.length - 1].trim()})`,
      };
    }
    return { kind: "verdict", verdict: { kind: `${listKind}+aliases`, note: note(true) } };
  },
};
