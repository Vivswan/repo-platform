#!/usr/bin/env bun
// The row step before the rungs and the writer read the target's registration: the names the plan admitted go onto
// its modules list, so the build's writer renders the new selection and the delivery carries the edit in the sync PR
// (docs/platform/sync/operator.md, "Adding modules"). ADD_MODULES is the plan's output, roster names in files.yml order
// and nothing else, so it may ride step env; what is left to refuse here is the target's registration, and that goes
// to the log the writer's report replaces, as a rung's failure does.

import { isSeq, type Node, parseDocument, type YAMLSeq } from "yaml";
import { declaredModules, readModules } from "../../../actions/plan/registration.ts";
import { REGISTRATION_PATH } from "../../../actions/shared/platform.ts";
import { env, fail } from "../shared/gha.ts";
import { existingFile, writeFile } from "./writer/target_files.ts";

export type Extended = { text: string; added: string[] } | { error: string };

const UNKNOWN_LAYOUT = `${REGISTRATION_PATH}: the modules list could not be extended in place (a layout this step does not know); add the names on a branch and sync that`;

/** A block list grows by one `- name` line per name after its last item, at that item's indentation; a flow list grows
 *  before its `]`. */
function spliced(text: string, seq: YAMLSeq, names: readonly string[]): string | null {
  if (seq.flow === true) {
    if (seq.range === null || seq.range === undefined) {
      return null;
    }
    const close = seq.range[1] - 1;
    if (text[close] !== "]") {
      return null;
    }
    const joint = seq.items.length === 0 ? "" : ", ";
    return `${text.slice(0, close)}${joint}${names.join(", ")}${text.slice(close)}`;
  }
  const last = seq.items.at(-1) as Node | undefined;
  if (last === undefined || last.range === null || last.range === undefined) {
    return null;
  }
  const [start, valueEnd] = last.range;
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const dash = text.indexOf("-", lineStart);
  if (dash < 0 || dash > start) {
    return null;
  }
  const indent = text.slice(lineStart, dash);
  const lineEnd = text.indexOf("\n", valueEnd);
  const at = lineEnd === -1 ? text.length : lineEnd;
  return `${text.slice(0, at)}${names.map((name) => `\n${indent}- ${name}`).join("")}${text.slice(at)}`;
}

/** The registration text with the names its modules list lacks appended, the rest of the file byte for byte: the
 *  library's serializer re-indents an unindented list and folds a long description, and its CST tokens place the
 *  first item's indent on another token, so either route positions the insert by hand. The result is read back
 *  through the registration grammar before it is returned. */
export function withModules(text: string, names: readonly string[]): Extended {
  const doc = parseDocument(text, { logLevel: "error" });
  if (doc.errors.length > 0) {
    return {
      error: `${REGISTRATION_PATH}: YAML parse error: ${doc.errors[0].message.split("\n")[0]}`,
    };
  }
  const read = readModules(doc.toJS());
  if (read.modules === null) {
    return { error: read.errors.join("\n") };
  }
  const added = names.filter((name) => !read.modules?.includes(name));
  if (added.length === 0) {
    return { text, added };
  }
  const seq = doc.get("modules");
  const edited = isSeq(seq) ? spliced(text, seq, added) : null;
  if (edited === null) {
    return { error: UNKNOWN_LAYOUT };
  }
  const back = declaredModules(edited);
  if (back === null || back.join("\n") !== [...read.modules, ...added].join("\n")) {
    return { error: UNKNOWN_LAYOUT };
  }
  return { text: edited, added };
}

/** The writer's own file guards (target_files.ts), so a registration that is a link is refused here before any edit,
 *  as the writer refuses it. */
function main(): number {
  const names = env("ADD_MODULES")
    .split(",")
    .filter((name) => name !== "");
  if (names.length === 0) {
    return 0;
  }
  const target = env("TARGET_DIR", "target");
  let bytes: Buffer | null;
  try {
    bytes = existingFile(target, REGISTRATION_PATH);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (bytes === null) {
    fail(`${REGISTRATION_PATH}: missing from the target repository`);
  }
  const extended = withModules(bytes.toString("utf-8"), names);
  if ("error" in extended) {
    fail(extended.error);
  }
  if (extended.added.length === 0) {
    console.log(
      "add_modules: every dispatched module is already selected; the registration is unchanged",
    );
    return 0;
  }
  writeFile(target, REGISTRATION_PATH, Buffer.from(extended.text));
  console.log(`add_modules: added ${extended.added.join(", ")} to ${REGISTRATION_PATH}`);
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
