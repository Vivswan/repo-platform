// Rules pinning what the fleet executes from: upstream action refs, every
// self-reference riding the build branch, and copier.yml's stamp hooks.

import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  EXCLUDED_DIRS as EXCLUDED_ACTION_DIRS,
  FLEET_WORKFLOWS,
} from "../../../.github/scripts/build-branches/branch_tree.ts";
import { constStringValue } from "../../lib/ts_extract.ts";
import { canonical, type Mismatch, mustMatch, sortedSet } from "./comparison.ts";
import { asRecord, jinjaVars, REPO_ROOT, read, walkFiles } from "./inputs.ts";
import type { Rule } from "./rule_roster.ts";

// Actions allowed to be pinned at more than one ref, with the full expected
// ref set. Record any intentional split here with a comment. Empty since
// the delivery channels converged on the one green-gated `build` ref.
export const ALLOWED_MULTI_REFS: Record<string, string[]> = {};

export interface Pin {
  file: string;
  action: string;
  ref: string;
}

/** `uses: <owner>/<action>@<ref>` pins in a file, commented examples
 *  included; `uses: ./...` locals and jinja-ref lines are skipped. The
 *  action key is owner/repo (subpaths like codeql-action/init collapse). */
export function extractUsesPins(text: string, file: string): Pin[] {
  const pins: Pin[] = [];
  for (const rawLine of text.split("\n")) {
    // Substitute jinja expressions with a sentinel that cannot be part of a
    // valid owner/action or ref: a line can carry BOTH a real pin and
    // unrelated jinja, so skipping the whole line would drop the pin.
    const line = rawLine.replace(/\{\{[^}]*\}\}/g, "<JINJA>");
    const match = line.match(/uses:\s*['"]?([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)@([^\s'"]+)/);
    if (!match) continue;
    if (match[2].includes("<JINJA>")) continue;
    const action = match[1].split("/").slice(0, 2).join("/");
    pins.push({ file, action, ref: match[2] });
  }
  return pins;
}

export function pinMismatches(pins: Pin[], allowed: Record<string, string[]>): Mismatch[] {
  const byAction = new Map<string, Pin[]>();
  for (const pin of pins) {
    byAction.set(pin.action, [...(byAction.get(pin.action) ?? []), pin]);
  }
  const mismatches: Mismatch[] = [];
  for (const [action, actionPins] of [...byAction.entries()].sort()) {
    const refs = [...new Set(actionPins.map((p) => p.ref))].sort();
    // An allowlisted action must match its declared split exactly, so a
    // stale entry (split collapsed back to one ref) is flagged for removal.
    if (action in allowed) {
      if (sortedSet(allowed[action]) !== refs.join(", ")) {
        mismatches.push({
          file: action,
          expected: `the allowlisted refs [${sortedSet(allowed[action])}]`,
          got: refs.join(", "),
        });
      }
      continue;
    }
    if (refs.length === 1) continue;
    const sites = refs
      .map(
        (ref) =>
          `${ref} (${sortedSet(actionPins.filter((p) => p.ref === ref).map((p) => p.file))})`,
      )
      .join("; ");
    mismatches.push({ file: action, expected: "a single pinned ref", got: sites });
  }
  for (const action of Object.keys(allowed).sort()) {
    if (!byAction.has(action)) {
      mismatches.push({
        file: action,
        expected: "an action still pinned somewhere (allowlisted)",
        got: "no uses: pins found (stale allowlist entry - remove it)",
      });
    }
  }
  return mismatches;
}

/** The green-gated branch every rendered self-pin executes from. A twin of
 *  publish.ts's BRANCH constant (the one delivery channel post-green.yml
 *  publishes), pinned against it by the fleet-refs-ride-build rule, so a
 *  delivery-branch rename updates both. Starters render once
 *  (_skip_if_exists): a rename reaches fresh renders only, never a pin an
 *  already-rendered starter carries. */
export const DELIVERY_REF = "build";

export interface SelfPin {
  file: string;
  /** The rendered pin's stem after the username: repo-platform/<path>. */
  stem: string;
  ref: string;
}

/** Self-delivery pins for the categorical delivery-channel rule: any jinja
 *  expression carrying `github_username` in the owner slot renders an owner
 *  resolving to this account (GitHub owners are case-insensitive), so the
 *  slot is matched wholesale rather than by enumerating spellings. Recorded
 *  residual, the same class the label-preflight rules record: a deliberately
 *  obfuscated owner (a `{% set %}` alias, a nested-brace expression) is
 *  adversarial code in a reviewed file and stays review's, and renderedSelfPins
 *  over the goldens still reds every obfuscated pin the matrix renders. */
export function templateSelfPins(text: string, file: string): SelfPin[] {
  const token =
    /(?<![A-Za-z0-9-])\{\{[^{}]*\bgithub_username\b[^{}]*\}\}\/(repo-platform\/[A-Za-z0-9_./-]+)@([^\s"']*)/g;
  return [...text.matchAll(token)].map((match) => ({ file, stem: match[1], ref: match[2] }));
}

/** Self-delivery pins in RENDERED text (the golden snapshots), where the
 *  username expression is already substituted: templateSelfPins' grammar
 *  with the literal `owner` in the username slot, matched case-insensitively
 *  (`| lower` renders a lowercased owner and GitHub resolves owners in any
 *  case). The stem's `repo-platform` prefix is normalized to canonical case
 *  so the FLEET_WORKFLOWS coupling cannot be dodged by a case-variant repo
 *  name; the path after it keeps its case because paths at a ref ARE
 *  case-sensitive, so a case-variant filename must go loud. */
export function renderedSelfPins(text: string, file: string, owner: string): SelfPin[] {
  if (!/^[A-Za-z0-9-]+$/.test(owner)) {
    throw new Error(`renderedSelfPins: owner '${owner}' is not a plain GitHub username`);
  }
  const token = new RegExp(
    `(?<![A-Za-z0-9-])${owner}/repo-platform(/[A-Za-z0-9_./-]+)@([^\\s"']*)`,
    "gi",
  );
  return [...text.matchAll(token)].map((match) => ({
    file,
    stem: `repo-platform${match[1]}`,
    ref: match[2],
  }));
}

/** DELIVERY_REF against the branch publish.ts actually advances: the
 *  pins below are only right while both name the same branch, so a
 *  rename of either alone mismatches, naming the twin to update. */
export function deliveryRefTwinMismatches(published: string, deliveryRef: string): Mismatch[] {
  if (published === deliveryRef) return [];
  return [
    {
      file: "scripts/check/ssot/delivery_pins.ts DELIVERY_REF",
      expected: `'${published}' (publish.ts's BRANCH - the branch the fleet's pins execute from)`,
      got: `'${deliveryRef}'`,
    },
  ];
}

/** The categorical delivery-channel law over fleet-rendered content:
 *  every `<owner>/repo-platform/<path>@<ref>` token - composite action
 *  and reusable workflow alike - must ride the green-gated delivery
 *  branch. `@main` is the ungated live tip, and any other ref forks the
 *  delivery story, so a single off-channel pin mismatches, named with
 *  its file and offending ref. Throws when no pin is found at all: the
 *  templates always carry self-references, so an empty scan means the
 *  extraction grammar rotted, not a clean fleet. */
export function deliveryRefMismatches(pins: SelfPin[], deliveryRef: string): Mismatch[] {
  if (pins.length === 0) {
    throw new Error(
      "no repo-platform self-reference found in the scanned content - anchor lost " +
        "(the templates always pin their own actions and reusables)",
    );
  }
  return pins
    .filter((pin) => pin.ref !== deliveryRef)
    .map((pin) => ({
      file: pin.file,
      expected: `${pin.stem}@${deliveryRef} (fleet-rendered content executes only the green-gated delivery branch)`,
      got: `@${pin.ref}`,
    }));
}

/** The shipping side of the delivery-channel law: a reusable-workflow `uses:`
 *  fetches the FILE at the named ref, so a rendered pin on a workflow the
 *  build branch does not ship 404s every caller run even though the ref is
 *  right; every `repo-platform/.github/workflows/<name>` pin must name a
 *  FLEET_WORKFLOWS entry (branch_tree.ts ships exactly that roster). Actions
 *  need no twin check: copyActions ships the whole actions/ tree, so an
 *  action pin can only 404 by naming a directory that does not exist, which
 *  the compose smoke catches. */
export function fleetWorkflowPinMismatches(
  pins: SelfPin[],
  shipped: readonly string[],
): Mismatch[] {
  const prefix = "repo-platform/.github/workflows/";
  return pins
    .filter(
      (pin) => pin.stem.startsWith(prefix) && !shipped.includes(pin.stem.slice(prefix.length)),
    )
    .map((pin) => ({
      file: pin.file,
      expected: `a reusable workflow on branch_tree.ts's FLEET_WORKFLOWS roster [${shipped.join(", ")}] (the build branch ships only the roster, so any other pin 404s at call time)`,
      got: pin.stem,
    }));
}

/** The stamp hook's argument vector after the script path, as copier.yml
 *  spells it: the destination (".", where copier runs hooks), the template
 *  clone's full commit hash, and copier's active answers file (which the
 *  hook refuses unless it is the template's declared path). */
export const STAMP_HOOK_ARGV = [
  "--root",
  ".",
  "--commit",
  "{{ _copier_conf.vcs_ref_hash }}",
  "--answers",
  "{{ _copier_conf.answers_file }}",
] as const;

/** The `when` each stamp hook must carry so the destination is stamped
 *  ONCE per render: copier runs _tasks on the destination pass of an
 *  update too (measured on 9.17.0), where the 'after' migration already
 *  stamps, so the task stands down for updates. */
export const STAMP_HOOK_WHEN: Record<"_tasks" | "_migrations", string> = {
  _tasks: "{{ _copier_operation != 'update' }}",
  _migrations: "{{ _stage == 'after' }}",
};

/** A copier.yml hook command split into the src_path-relative script it
 *  runs, its argument vector, and its form: copier runs a STRING command
 *  through a shell (so a caller-controlled value in it is an injection
 *  vector) and a LIST as argv. Any other shape is a lost anchor. */
export function hookCommandParts(command: string | readonly string[]): {
  path: string;
  args: readonly string[];
  form: "shell" | "argv";
} {
  const anchor = /^\{\{ _copier_conf\.src_path \}\}\/([^"]+)$/;
  if (typeof command === "string") {
    const match = mustMatch(
      command,
      /^bun "\{\{ _copier_conf\.src_path \}\}\/([^"]+)"(?: (.*))?$/,
      "copier.yml",
      "a src_path-anchored bun hook command",
    );
    return {
      path: match[1],
      args: match[2] === undefined ? [] : match[2].split(" "),
      form: "shell",
    };
  }
  const [bun, script, ...args] = command;
  const match = bun === "bun" && script !== undefined ? anchor.exec(script) : null;
  if (match === null) {
    throw new Error(
      `copier.yml: anchor for a src_path-anchored bun hook command not found (list form: ${JSON.stringify(command)})`,
    );
  }
  return { path: match[1], args, form: "argv" };
}

/** A copier.yml hook as the rule judges it. */
export interface CopierHook {
  command: string | readonly string[];
  when: string;
}

/** The stamp-hook-path rule's judgment of one hook site: exactly one stamp
 *  hook (a second would stamp the destination twice), in the argv-list form
 *  (a shell string would interpolate the caller-controlled answers path),
 *  carrying exactly STAMP_HOOK_ARGV and the site's `when` (STAMP_HOOK_WHEN),
 *  so the destination is stamped once per render with everything the hook
 *  needs and nothing inferred. */
export function stampHookSiteMismatches(
  site: keyof typeof STAMP_HOOK_WHEN,
  hooks: readonly CopierHook[],
  stampHook: string,
): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const stampHooks = hooks.filter((hook) => hookCommandParts(hook.command).path === stampHook);
  if (stampHooks.length !== 1) {
    mismatches.push({
      file: "copier.yml",
      expected: `exactly one ${site} hook running ${stampHook} (copier runs _migrations only on update and _tasks on every other render, so each site needs its own, and a second would stamp the destination twice)`,
      got:
        stampHooks.length === 0
          ? "none - renders on that path would ship an unstamped manifest"
          : `${stampHooks.length} stamp hooks`,
    });
  }
  for (const hook of stampHooks) {
    const { args, form } = hookCommandParts(hook.command);
    if (form !== "argv") {
      mismatches.push({
        file: "copier.yml",
        expected: `the ${site} stamp hook in copier's list form (a string command runs through a shell with the caller-controlled answers path interpolated)`,
        got: "a shell string",
      });
    }
    if (canonical(args) !== canonical(STAMP_HOOK_ARGV)) {
      mismatches.push({
        file: "copier.yml",
        expected: `the ${site} stamp hook carrying ${JSON.stringify(STAMP_HOOK_ARGV)}`,
        got: args.length === 0 ? "no arguments" : JSON.stringify(args),
      });
    }
    if (hook.when !== STAMP_HOOK_WHEN[site]) {
      mismatches.push({
        file: "copier.yml",
        expected: `the ${site} stamp hook gated by when: "${STAMP_HOOK_WHEN[site]}"`,
        got:
          hook.when === ""
            ? "no when (the destination would be stamped twice on update)"
            : `when: "${hook.when}"`,
      });
    }
  }
  return mismatches;
}

/** The rules this module contributes to the checker's run (check_ssot.ts). */
export const deliveryPinRules: Rule[] = [
  {
    name: "action-pins",
    run: () => {
      const files = [
        ...walkFiles(".github/workflows").map((f) => f.path),
        ...walkFiles("templates")
          .filter((f) => !f.symlink)
          .map((f) => f.path),
        ...readdirSync(join(REPO_ROOT, "actions"))
          .sort()
          .map((name) => `actions/${name}/action.yml`)
          .filter((rel) => existsSync(join(REPO_ROOT, rel))),
      ];
      const pins = files.flatMap((rel) => extractUsesPins(read(rel), rel));
      if (pins.length === 0)
        throw new Error("no `uses: owner/action@ref` pins found anywhere - anchor lost");
      return pinMismatches(pins, ALLOWED_MULTI_REFS);
    },
  },
  {
    // The categorical delivery-channel law: EVERY self-reference in
    // fleet-rendered content (composite action or reusable workflow, template
    // source or golden snapshot) rides the green-gated build branch. One
    // blanket scan, never per-file pins, so a planted @main reds with the
    // file and ref; the scope (templates/ and tests/golden-renders/) is
    // structural, exactly what the fleet renders and executes, while this
    // repo's own workflows live outside both. DELIVERY_REF is pinned against
    // publish.ts's BRANCH by AST (importing the publisher would run its git wiring).
    name: "fleet-refs-ride-build",
    run: () => {
      const published = constStringValue(
        read(".github/scripts/build-branches/publish.ts"),
        "BRANCH",
        { where: "publish.ts", what: "the delivery branch" },
      );
      const templatePins = walkFiles("templates")
        .filter((f) => !f.symlink)
        .flatMap((f) => templateSelfPins(read(f.path), f.path));
      const goldenPins = walkFiles("tests/golden-renders")
        .filter((f) => !f.symlink)
        .flatMap((f) => renderedSelfPins(read(f.path), f.path, jinjaVars().username));
      const pins = [...templatePins, ...goldenPins];
      return [
        ...deliveryRefTwinMismatches(published, DELIVERY_REF),
        ...deliveryRefMismatches(pins, DELIVERY_REF),
        ...fleetWorkflowPinMismatches(pins, FLEET_WORKFLOWS),
      ];
    },
  },
  {
    // copier.yml's hooks run with {{ _copier_conf.src_path }} = the build
    // branch root, and actions/ is the one tree the branch ships verbatim at
    // its checkout-relative path, so a hook command resolves on renders
    // exactly when it names a clean actions/ file the copy ships; a moved
    // hook file copier.yml still names the old way would fail every render's
    // stamping on the fleet, not in this repo's CI. The stamping WIRING is
    // pinned too: _tasks (copy/recopy) and _migrations (update) must each run
    // the stamper, or every render's manifest stays unstamped and green.
    name: "stamp-hook-path",
    run: () => {
      const mismatches: Mismatch[] = [];
      const stampHook = "actions/shared/stamp_manifest.ts";
      const doc = asRecord(parseYaml(read("copier.yml")), "copier.yml");
      const hooksOf = (list: unknown): CopierHook[] =>
        (Array.isArray(list) ? list : []).map((hook) => {
          const record = asRecord(hook, "copier.yml hook");
          const command = record.command;
          return {
            command: Array.isArray(command) ? command.map(String) : String(command ?? ""),
            when: String(record.when ?? ""),
          };
        });
      const sites = [
        ["_tasks", hooksOf(doc._tasks)],
        ["_migrations", hooksOf(doc._migrations)],
      ] as const;
      const pathOf = (command: string | readonly string[]): string =>
        hookCommandParts(command).path;
      for (const [site, hooks] of sites) {
        mismatches.push(...stampHookSiteMismatches(site, hooks, stampHook));
        for (const { command } of hooks) {
          const path = pathOf(command);
          // Judged on the path the BRANCH serves, not what this checkout
          // can lexically reach: traversal ("actions/../scripts/x.ts") and
          // excluded segments (node_modules, dist, .turbo) exist here but
          // never ship, so they must fail like any other unshipped path.
          const segments = path.split("/");
          const clean =
            segments[0] === "actions" &&
            segments.every(
              (segment) =>
                segment !== "" &&
                segment !== "." &&
                segment !== ".." &&
                !EXCLUDED_ACTION_DIRS.has(segment),
            );
          const shipped = (): boolean => {
            try {
              return lstatSync(join(REPO_ROOT, path)).isFile();
            } catch {
              return false;
            }
          };
          if (!clean || !shipped()) {
            mismatches.push({
              file: "copier.yml",
              expected: `${site} hook path '${path}' to be a clean, traversal-free actions/ file (the only tree the build branch ships at its checkout-relative path, minus branch_tree.ts's excluded directories)`,
              got: "a path the branch does not serve, so every render's hook would fail",
            });
          }
        }
      }
      return mismatches;
    },
  },
];
