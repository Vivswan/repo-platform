#!/usr/bin/env bun
// The jinja subset two consumers share: scripts/check_ssot.ts compares the
// dogfooded twins it still owns modulo these transforms, and
// scripts/render_dogfood.ts renders this repository's generated copies with
// them. Tag stripping, if/endif branch evaluation against a boolean
// context, identity substitution, and the remote-uses -> local-path rewrite
// all live here so the checker and the generator can never normalize
// differently. Pure functions only; the helpers moved verbatim from
// check_ssot.ts.

export interface JinjaVars {
  username: string;
  slug: string;
  copyrightHolder: string;
  /** The repo's project_name answer; only set by the dogfood renderer
   *  (the parity comparisons never meet a project_name expression),
   *  enabling the `{{ project_name | tojson }}` substitution below. */
  projectName?: string;
  /** The repo's skills_dir answer; only set while the skills module is
   *  selected (copier asks the question only then), enabling the
   *  `{{ skills_dir | tojson }}` substitutions below. */
  skillsDir?: string;
  /** The repo's docs_site_label answer; only set while the docs-site
   *  module is selected (copier asks the question only then), enabling
   *  the `{{ docs_site_label | tojson }}` substitution below. */
  docsSiteLabel?: string;
}

/** Resolve one if-condition against `context`: a condition that is exactly
 *  a context key (module membership like `'fuzzer' in modules`), a bare
 *  context variable, or `not <variable>` evaluates; anything else returns
 *  null (unresolvable - the caller keeps the body). */
export function resolveCondition(
  expr: string,
  context: Record<string, boolean>,
  used?: Set<string>,
): boolean | null {
  const trimmed = expr.trim();
  if (Object.hasOwn(context, trimmed)) {
    used?.add(trimmed);
    return context[trimmed];
  }
  const negated = trimmed.startsWith("not ");
  const name = (negated ? trimmed.slice(4) : trimmed).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
  const value = context[name];
  if (value === undefined) return null;
  used?.add(name);
  return negated ? !value : value;
}

/** Drop every if/endif block whose condition is false in `context` (see
 *  resolveCondition); an unresolvable condition keeps its body for the tag
 *  stripping in normalizeJinja. if/endif pairs are matched with a depth
 *  counter, so an outer false branch drops its nested blocks whole.
 *  else/elif are rejected here too - the no-else invariant must hold even
 *  inside a dropped branch, which the downstream guard would never see. */
export function evaluateIfBranches(
  text: string,
  context: Record<string, boolean>,
  used?: Set<string>,
): string {
  let out = "";
  let cursor = 0;
  let dropDepth = 0;
  for (const tag of text.matchAll(/\{%-?\s*(if|endif|else|elif)\b([^%]*?)-?%\}/g)) {
    const [tagText, kind, expr] = tag;
    if (kind === "else" || kind === "elif") {
      throw new Error(`normalizeJinja cannot handle ${tagText}`);
    }
    const start = tag.index ?? 0;
    if (dropDepth === 0) {
      if (kind === "if" && resolveCondition(expr, context, used) === false) {
        // Real-jinja whitespace around a dropped block: a {%- opener also
        // consumes the whitespace before it, newlines included; a plain
        // {% keeps it, the tag line's indentation included.
        let chunk = text.slice(cursor, start);
        if (tagText.startsWith("{%-")) chunk = chunk.replace(/[ \t\r\n]+$/, "");
        out += chunk;
        dropDepth = 1;
      }
    } else if (kind === "if") {
      dropDepth++;
    } else {
      dropDepth--;
      if (dropDepth === 0) {
        cursor = start + tagText.length;
        // Likewise on the way out: a -%} closer consumes the whitespace
        // after the endif; a plain %} keeps its trailing newline, leaving
        // the blank line real jinja leaves.
        if (tagText.endsWith("-%}")) {
          while (cursor < text.length && /[ \t\r\n]/.test(text[cursor])) cursor++;
        }
      }
    }
  }
  if (dropDepth > 0) throw new Error("evaluateIfBranches: a dropped if block has no endif");
  return out + text.slice(cursor);
}

/**
 * Reduce a template file to the text this repo's own copy should carry:
 * strip raw markers, jinja comments and set/if/endif tags, substitute the
 * identity expressions, and map remote
 * `<owner>/repo-platform/<path>@main` references to their local
 * `./<path>` form. Without a `context`, every if/endif body is kept (fine
 * while the kept bodies never contradict each other); with one, false
 * branches are dropped and only conditions the context cannot resolve keep
 * their bodies.
 */
export function normalizeJinja(
  text: string,
  vars: JinjaVars,
  context?: Record<string, boolean>,
): string {
  let out = text;
  out = out.replace(/\{%-?\s*(?:raw|endraw)\s*-?%\}/g, "");
  out = out.replace(/\{#-?[\s\S]*?-?#\}/g, "");
  out = out.replace(/\{%-?\s*set\b[\s\S]*?%\}/g, "");
  if (context) {
    const used = new Set<string>();
    out = evaluateIfBranches(out, context, used);
    // Mirror RECORDED_DIVERGENCES staleness: a context key no condition
    // consulted is dead configuration and must fail loudly, not linger.
    for (const key of Object.keys(context)) {
      if (!used.has(key)) {
        throw new Error(
          `normalizeJinja: context key ${JSON.stringify(key)} matched no condition (stale - remove it)`,
        );
      }
    }
  }
  // Keeping both branches of an if/else would concatenate mutually exclusive
  // content; no processed template uses statement-level else today, so its
  // appearance means this normalizer needs real branch handling.
  const branchTag = /\{%-?\s*(?:else|elif)\b[^%]*?-?%\}/.exec(out);
  if (branchTag) throw new Error(`normalizeJinja cannot handle ${branchTag[0]}`);
  // Kept-branch if/endif tags disappear with jinja's real whitespace
  // control, via the same helper the comment/set strips in renderJinjaFile
  // use: a `-` on either delimiter eats the adjacent whitespace, newlines
  // included, a plain delimiter keeps it, and an inline tag loses just the
  // tag text.
  out = stripTagsWithWhitespaceControl(
    out,
    /\{%(?<lead>-?)\s*(?:if|endif)\b[^%]*?(?<trail>-?)%\}/g,
  );
  out = out.replace(/\{\{ '([^']*)' if [^}]*? else '[^']*' \}\}/g, "$1");
  out = out.replace(
    new RegExp(`\\{\\{ github_username \\}\\}/${vars.slug}/([^\\s@]+)@main`, "g"),
    "./$1",
  );
  out = out.replace(/\{\{ copyright_holder \}\}/g, () => vars.copyrightHolder);
  out = out.replace(/\{\{ github_username \| lower \}\}/g, vars.username.toLowerCase());
  out = out.replace(/\{\{ github_username \}\}/g, vars.username);
  out = out.replace(/\{\{ project_slug \}\}/g, vars.slug);
  if (vars.projectName !== undefined) {
    const name = vars.projectName;
    // JSON.stringify matches jinja's tojson for plain strings.
    out = out.replace(/\{\{ project_name \| tojson \}\}/g, () => JSON.stringify(name));
  }
  if (vars.docsSiteLabel !== undefined) {
    const label = vars.docsSiteLabel;
    out = out.replace(/\{\{ docs_site_label \| tojson \}\}/g, () => JSON.stringify(label));
  }
  if (vars.skillsDir !== undefined) {
    const dir = vars.skillsDir;
    // The two shapes the skills templates use; JSON.stringify matches
    // jinja's tojson for plain strings.
    out = out.replace(/\{\{ \(skills_dir ~ "([^"]*)"\) \| tojson \}\}/g, (_whole, tail: string) =>
      JSON.stringify(dir + tail),
    );
    out = out.replace(/\{\{ skills_dir \| tojson \}\}/g, () => JSON.stringify(dir));
  }
  // A surviving statement tag ({% for %}, an if whose expression contains %,
  // ...) would silently corrupt the comparison text; fail loudly instead.
  const leftover = /\{%[^}]*%\}/.exec(out);
  if (leftover) throw new Error(`normalizeJinja left ${leftover[0]} unhandled`);
  return out;
}

/** Replace leftover jinja expressions with a parseable placeholder so the
 *  result can be YAML-parsed. `${{ ... }}` GitHub expressions are kept. */
export function placeholderJinja(text: string): string {
  return text.replace(/(?<!\$)\{\{[^}]*\}\}/g, '"JINJA"');
}

/** Remove every tag `re` matches (named groups `lead`/`trail` capture its
 *  whitespace-control dashes), modeling jinja's `-` faithfully: a leading
 *  dash consumes the whitespace before the tag, newlines included, and a
 *  trailing dash the whitespace after it. */
function stripTagsWithWhitespaceControl(text: string, re: RegExp): string {
  let out = "";
  let cursor = 0;
  for (const tag of text.matchAll(re)) {
    const start = tag.index ?? 0;
    let end = start + tag[0].length;
    let before = text.slice(cursor, start);
    if (tag.groups?.lead === "-") before = before.replace(/[ \t\r\n]+$/, "");
    out += before;
    if (tag.groups?.trail === "-") {
      while (end < text.length && /[ \t\r\n]/.test(text[end])) end++;
    }
    cursor = end;
  }
  return out + text.slice(cursor);
}

/**
 * Render a template file the way render_dogfood.ts writes this repo's
 * generated copies. The output IS the artifact, so unlike the
 * comparison-mode normalizeJinja this never falls back: raw blocks are
 * extracted first and restored last (substitution can never rewrite text
 * inside them), set/comment tags disappear with jinja's real whitespace
 * control (a `-` eats the adjacent whitespace, newlines included), every
 * if/ternary condition must resolve through `context` or this throws, and
 * an expression left unsubstituted at the end throws instead of shipping.
 */
export function renderJinjaFile(
  text: string,
  vars: JinjaVars,
  context: Record<string, boolean>,
): string {
  // Raw-block placeholders are fenced with NUL, the one byte a text
  // template can never carry, so nothing else can collide with them - and
  // neither the template nor a substituted variable value may smuggle one
  // in.
  const sentinel = String.fromCharCode(0);
  if (
    [
      text,
      vars.username,
      vars.slug,
      vars.copyrightHolder,
      vars.projectName ?? "",
      vars.skillsDir ?? "",
      vars.docsSiteLabel ?? "",
    ].some((value) => value.includes(sentinel))
  ) {
    throw new Error("renderJinjaFile: the template or a variable value contains a NUL byte");
  }
  const rawBlocks: string[] = [];
  let out = text.replace(
    /\{%-?\s*raw\s*-?%\}([\s\S]*?)\{%-?\s*endraw\s*-?%\}/g,
    (_, content: string) => {
      rawBlocks.push(content);
      return `${sentinel}${rawBlocks.length - 1}${sentinel}`;
    },
  );
  if (/\{%-?\s*(?:raw|endraw)\b/.test(out)) {
    throw new Error("renderJinjaFile found an unpaired raw/endraw marker");
  }
  out = stripTagsWithWhitespaceControl(out, /\{#(?<lead>-?)[\s\S]*?(?<trail>-?)#\}/g);
  out = stripTagsWithWhitespaceControl(out, /\{%(?<lead>-?)\s*set\b[\s\S]*?(?<trail>-?)%\}/g);
  out = out.replace(
    /\{\{ '([^']*)' if ([^}]*?) else '([^']*)' \}\}/g,
    (whole, whenTrue: string, condition: string, whenFalse: string) => {
      const value = resolveCondition(condition, context);
      if (value === null) {
        throw new Error(
          `renderJinjaFile cannot resolve the condition in ${whole} - add it to the render context`,
        );
      }
      return value ? whenTrue : whenFalse;
    },
  );
  for (const tag of out.matchAll(/\{%-?\s*if\b([^%]*?)-?%\}/g)) {
    if (resolveCondition(tag[1], context) === null) {
      throw new Error(
        `renderJinjaFile cannot resolve ${tag[0].trim()} - add its condition to the render context`,
      );
    }
  }
  out = evaluateIfBranches(out, context);
  out = normalizeJinja(out, vars);
  const leftover = /(?<!\$)\{\{[^}]*\}\}/.exec(out);
  if (leftover) {
    throw new Error(`renderJinjaFile left ${leftover[0]} unrendered - it has no substitution`);
  }
  // Each placeholder contributes a sentinel pair, so splitting leaves
  // the block indices at the odd positions.
  return out
    .split(sentinel)
    .map((part, index) => (index % 2 === 1 ? rawBlocks[Number(part)] : part))
    .join("");
}
