// The site's naming rules, owned once for their three readers: the
// renderer (derive.ts walks and localizes the docs tree by them), the
// assembler (lib.ts refuses a configuration the staging would misplace),
// and the registration grammar (actions/plan/registration.ts), so an
// include root the plan accepts is one the site builds.
//
// It lives inside .vitepress/ and imports nothing: build.ts copies this
// directory into every build root, where an import reaching outside it
// resolves to nothing, and the plan action imports it before any install.

/** ISO 639-1 primary language subtags: the locale-directory convention
 *  accepts exactly `<lang>` or `<lang>-<region>` with a two-letter primary
 *  from this set, so an ordinary docs directory (api/, cli/) can never be
 *  mistaken for a translation tree. */
const ISO_639_1 = new Set(
  (
    "aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu " +
    "cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi " +
    "ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks " +
    "ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl " +
    "nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl " +
    "sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve " +
    "vi vo wa wo xh yi yo za zh zu"
  ).split(" "),
);

const LOCALE_DIR_RE = /^([a-z]{2})(-[a-z0-9]{2,8})?$/;

/** Whether a top-level directory name is a translation tree by the fleet
 *  convention: docs/<lang>[-<region>]/ mirroring the root structure. */
export function isLocaleDir(name: string): boolean {
  const match = LOCALE_DIR_RE.exec(name);
  return match !== null && ISO_639_1.has(match[1]);
}

/** A directory entry the site never walks: dot-prefixed or node_modules
 *  (nothing under either should ever render). */
export function isUnwalkedEntry(name: string): boolean {
  return name.startsWith(".") || name === "node_modules";
}

/** Another root of the repository rendered inside the docs mount
 *  (docs/site.md, "Other roots on the site"). */
export interface IncludeRoot {
  /** Repo-relative source directory (`skills`). */
  path: string;
  /** URL path under the docs mount (`skills` -> `<mount>skills/`). */
  mount: string;
  /** The file that serves as each child directory's page (`SKILL.md`). */
  page: string;
}

/** The docs half of a site as configured: where it mounts, what it renders. */
export interface DocsConfig {
  /** The URL segment the docs mount under beside a website. */
  path: string;
  include: IncludeRoot[];
}

/** The site configuration document the plan action emits and the
 *  pages-site action reads (its `config` input); a registration-less
 *  caller writes it by hand. `docs_path` null is the docs half turned off. */
export interface SiteConfigJson {
  site_title: string;
  docs_path: string | null;
  include: IncludeRoot[];
  link_rot_label: string;
}

const PATH_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const URL_SEGMENT_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Why `value` is not a plain relative path inside the repository, or
 *  null: a "." or ".." segment could resolve outside the tree or to its
 *  root, and a dist escaping the tree publishes the whole checkout. */
export function relPathProblem(value: string): string | null {
  const parts = value.split("/");
  if (
    value === "" ||
    parts.some((part) => part === "." || part === ".." || !PATH_SEGMENT_RE.test(part))
  ) {
    return (
      "must be a plain relative path inside the repository: slash-joined segments of " +
      "letters, digits, dots, underscores, or dashes, with no empty, '.', or '..' segments"
    );
  }
  return null;
}

/** Why `value` is not one URL segment (the docs mount's `site.path`), or null. */
export function urlSegmentProblem(value: string): string | null {
  return URL_SEGMENT_RE.test(value)
    ? null
    : "must be one plain lowercase URL segment (letters, digits, dashes, underscores)";
}

/** Why an include root cannot mount at `mount`, or null. Each refusal is
 *  a placement the staging would get wrong, not a shape it cannot spell:
 *  a locale-shaped first segment would become a translation tree, an
 *  unwalked segment would stage pages that never get routes, and public/
 *  is copied to the site root instead of rendered. */
export function includeMountProblem(mount: string): string | null {
  const segments = mount.split("/");
  if (segments.some((segment) => !URL_SEGMENT_RE.test(segment))) {
    return "must be lowercase URL segments (letters, digits, dashes, underscores) joined by single slashes";
  }
  if (isLocaleDir(segments[0])) {
    return (
      "reads as a locale directory (docs/<lang>/ is a translation tree by convention) - " +
      "mount the root under another name"
    );
  }
  if (segments.some(isUnwalkedEntry)) {
    return (
      "has a segment the site never walks (dot-prefixed or node_modules), so its pages " +
      "would get no routes - mount the root under another name"
    );
  }
  if (segments[0] === "public") {
    return (
      "starts with public/, which VitePress copies to the site root as static files " +
      "instead of rendering - mount the root under another name"
    );
  }
  return null;
}

/** Why `page` cannot be an include root's page file, or null: index.md is
 *  a directory's page already, so the include would rename nothing. */
export function includePageProblem(page: string): string | null {
  if (!PATH_SEGMENT_RE.test(page) || !page.endsWith(".md")) {
    return "must be a plain markdown file name (SKILL.md)";
  }
  if (page === "index.md") {
    return "is index.md, which is a directory's page already - name the file the include renames to it";
  }
  return null;
}

/** Why include roots cannot ride beside a null docs path, or null: with
 *  the docs half off there is nothing to render them into (an unset path
 *  is the default mount, which renders them). */
export function includeWithoutDocsProblem(
  docsPath: string | null | undefined,
  include: readonly unknown[],
): string | null {
  return docsPath === null && include.length > 0
    ? "names roots to render into the docs, but a null docs path turns the docs half off - drop the list or set a path"
    : null;
}

/** Why the include list as a whole cannot stage, or null: two roots on
 *  one mount would claim one URL, one root on two mounts would render twice. */
export function includeListProblem(
  roots: readonly Pick<IncludeRoot, "path" | "mount">[],
): string | null {
  for (const key of ["path", "mount"] as const) {
    if (new Set(roots.map((root) => root[key])).size !== roots.length) {
      return `lists one ${key} twice - every root needs its own ${key}`;
    }
  }
  return null;
}
