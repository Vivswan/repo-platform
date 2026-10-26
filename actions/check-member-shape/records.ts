// The record model the member-shape rules judge: every record (an interface body, a class body, a type literal, an
// enum body) and every block of adjacent module-level `const` statements, each member or declarator with the comments
// that belong to it. The TypeScript is read by oxc-parser (TypeScript 7 is the native port and exposes no in-process
// compiler API); line numbers come from offsets through lines-and-columns.

import type {
  ClassBody,
  Node,
  Program,
  TSEnumBody,
  TSInterfaceBody,
  TSTypeLiteral,
  VariableDeclarator,
} from "@oxc-project/types";
import { LinesAndColumns } from "lines-and-columns";
import { type Comment as OxcComment, parseSync, Visitor } from "oxc-parser";

/** The record kinds the rules judge: a body whose members stand together. */
export type RecordKind = "interface" | "class" | "type literal" | "enum";

/** A record, or a block of adjacent module-level `const` statements. */
export type BlockKind = RecordKind | "const block";

/** What an item is to the rules: a field (a property, an accessor, an index signature, an enum member, a module
 *  constant) answers for its comment's shape; a method (a method, a constructor, a call or construct signature) carries
 *  a doc comment of any length. */
export type MemberKind = "field" | "method";

/** A comment by its 1-based lines. */
export interface Comment {
  line: number;
  endLine: number;
}

/** A member of a record or one declarator of a block's `const` statements. */
export interface Item {
  /** Field or method; a module constant is a field. */
  kind: MemberKind;

  /** The item's own first line: its `export` keyword or first decorator, never its comment; a later declarator's own. */
  line: number;

  /** The line its last character sits on. */
  endLine: number;

  /** The comments above the item that belong to it, top to bottom, whatever blank lines sit between. */
  above: Comment[];

  /** The comments on the item's own lines, from its first to its last, outside any nested construct that owns its own. */
  inside: Comment[];

  /** A comment after the item on its last line belongs to it, never to the item below. */
  trailing: Comment | null;
}

/** One record or const block with its items in source order; the rules judge a block on its own. */
export interface Block {
  kind: BlockKind;
  items: Item[];
}

/** One parsed file: its lines, for the blank-line tests, and the blocks the rules judge. */
export interface Source {
  lines: string[];
  blocks: Block[];
}

type RecordBody = TSInterfaceBody | ClassBody | TSTypeLiteral | TSEnumBody;
type ModuleStatement = Program["body"][number];

/** The offsets of a construct whose comments are its own, never an enclosing member's: a record body (its members
 *  are judged on their own), a function body, braced or an arrow's expression (code comments, not a doc comment), an
 *  object or array literal (its entries'). */
interface Owned {
  start: number;
  end: number;
}

/** The record bodies of a file in visiting order, and every owned region, the record bodies among them. */
interface Constructs {
  records: RecordBody[];
  owned: Owned[];
}

/** What the attribution reads of a member or a declarator: its kind and the offsets its own lines span, its
 *  delimiter included. */
interface Span {
  kind: MemberKind;
  start: number;
  end: number;
}

/** One `const` statement with its declarators, each a constant of its own. */
interface ConstStatement {
  node: ModuleStatement;
  declarators: VariableDeclarator[];
}

/** Each record body's node type, as a finding's block names it. */
const RECORD_KINDS: Readonly<Record<RecordBody["type"], RecordKind>> = {
  TSInterfaceBody: "interface",
  ClassBody: "class",
  TSTypeLiteral: "type literal",
  TSEnumBody: "enum",
};

/** TypeScript in every flavor oxc reads as such. */
const TS_EXTENSIONS: ReadonlySet<string> = new Set(["ts", "mts", "cts", "tsx"]);

/** The member node types that are methods, an accessor's `kind` aside. */
const METHOD_TYPES: ReadonlySet<string> = new Set([
  "MethodDefinition",
  "TSAbstractMethodDefinition",
  "TSMethodSignature",
  "TSCallSignatureDeclaration",
  "TSConstructSignatureDeclaration",
  "StaticBlock",
]);

/** The 1-based line of an offset. lines-and-columns counts lines from 0 and answers null only for an offset past the
 *  text's end, which oxc never produces. */
function lineOf(table: LinesAndColumns, offset: number): number {
  const location = table.locationForIndex(offset);
  if (location === null) throw new Error(`offset ${offset} lies outside the text`);

  return location.line + 1;
}

/** The line an exclusive span end sits on: that of the character before it. */
function endLineOf(table: LinesAndColumns, end: number): number {
  return lineOf(table, Math.max(end - 1, 0));
}

function membersOf(body: RecordBody): Node[] {
  return "members" in body ? body.members : body.body;
}

/** The offset past the whitespace and comments that follow `at`. */
function afterTrivia(text: string, comments: OxcComment[], at: number): number {
  let next = at;
  let comment: OxcComment | undefined;
  do {
    while (/\s/.test(text.charAt(next))) next += 1;
    comment = comments.find((candidate) => candidate.start === next);
    next = comment?.end ?? next;
  } while (comment !== undefined);

  return next;
}

/** The record bodies and the owned regions of the tree. A static block owns its braces only: a comment between
 *  `static` and the brace is the member's. An expression-bodied arrow owns its body, parentheses included. */
function constructsOf(program: Program, text: string, comments: OxcComment[]): Constructs {
  const records: RecordBody[] = [];
  const owned: Owned[] = [];
  const record = (node: RecordBody): void => {
    records.push(node);
    owned.push(node);
  };
  const own = (node: Owned): void => {
    owned.push(node);
  };
  new Visitor({
    TSInterfaceBody: record,
    ClassBody: record,
    TSTypeLiteral: record,
    TSEnumBody: record,
    BlockStatement: own,
    ObjectExpression: own,
    ArrayExpression: own,
    StaticBlock: (node) => {
      own({ start: afterTrivia(text, comments, node.start + "static".length), end: node.end });
    },
    ArrowFunctionExpression: (node) => {
      if (node.expression) own(node.body);
    },
  }).visit(program);
  return { records, owned };
}

/** The statement as a `const` statement, or null for any other. */
function constStatement(node: ModuleStatement): ConstStatement | null {
  const declaration = node.type === "ExportNamedDeclaration" ? node.declaration : node;
  if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") return null;

  return { node, declarators: declaration.declarations };
}

/** The maximal runs of adjacent `const` statements in the module body. */
function constRuns(program: Program): ConstStatement[][] {
  const runs: ConstStatement[][] = [];
  let run: ConstStatement[] = [];
  for (const statement of program.body) {
    const constant = constStatement(statement);
    if (constant !== null) {
      run.push(constant);
      continue;
    }

    if (run.length > 0) runs.push(run);
    run = [];
  }

  if (run.length > 0) runs.push(run);

  return runs;
}

/** An accessor is a field wherever it is declared (a class, an interface, a type literal): it stands for a value, and
 *  its doc reads as a field's does. */
function memberKind(node: Node): MemberKind {
  const kind = "kind" in node ? node.kind : undefined;
  if (kind === "get" || kind === "set") return "field";

  return METHOD_TYPES.has(node.type) ? "method" : "field";
}

/** The end of the `,` or `;` that follows an offset past whitespace and comments, or the offset itself: oxc ends an
 *  enum member or a declarator before its separator, and a comment between the two is the member's. */
function delimiterEnd(text: string, comments: OxcComment[], end: number): number {
  const at = afterTrivia(text, comments, end);
  return text.charAt(at) === "," || text.charAt(at) === ";" ? at + 1 : end;
}

/** A class member's span starts at its first decorator. */
function memberSpan(node: Node): Span {
  const decorators = "decorators" in node ? (node.decorators ?? []) : [];
  return {
    kind: memberKind(node),
    start: Math.min(node.start, ...decorators.map((decorator) => decorator.start)),
    end: node.end,
  };
}

/** Each declarator of a `const` statement as a constant of its own: the first spans from the statement's start (its
 *  `export` or `const` keyword), the last to the statement's end, so the statement's comments and its line are the
 *  first's. */
function declaratorSpans({ node, declarators }: ConstStatement): Span[] {
  const last = declarators.length - 1;
  return declarators.map((declarator, index) => ({
    kind: "field",
    start: index === 0 ? node.start : declarator.start,
    end: index === last ? node.end : declarator.end,
  }));
}

/** The comments directly above `line` (or opening on it) with no blank line among them, from the end of
 *  `candidates`. */
function contiguousAbove(candidates: Comment[], line: number): Comment[] {
  const taken: Comment[] = [];
  let next = line;
  for (const comment of [...candidates].reverse()) {
    const onItemLine = taken.length === 0 && comment.endLine === line;
    if (comment.endLine !== next - 1 && !onItemLine) break;
    taken.unshift(comment);
    next = comment.line;
  }

  return taken;
}

/** The comments in a gap, split by which item they belong to: the ones on the line the gap opens on trail the item
 *  above, the rest are above the item below. */
interface Gap {
  trailing: Comment | null;
  above: Comment[];
}

function within(inner: { start: number; end: number }, from: number, to: number): boolean {
  return inner.start >= from && inner.end <= to;
}

/** The comments lying within two offsets, by their lines. */
function commentsWithin(
  comments: OxcComment[],
  from: number,
  to: number,
  table: LinesAndColumns,
): Comment[] {
  return comments
    .filter((comment) => within(comment, from, to))
    .map((comment) => ({
      line: lineOf(table, comment.start),
      endLine: endLineOf(table, comment.end),
    }));
}

/** The comments on a span's own lines: within it, outside any owned region nested in it. */
function commentsInside(
  comments: OxcComment[],
  owned: Owned[],
  span: Span,
  table: LinesAndColumns,
): Comment[] {
  const inner = owned.filter((node) => within(node, span.start, span.end));
  const outside = comments.filter(
    (comment) => !inner.some((node) => within(comment, node.start, node.end)),
  );
  return commentsWithin(outside, span.start, span.end, table);
}

/** The comments between two offsets. `from` is the end of the item above, or of what opens the block: a brace, the
 *  statement before, the file start at 0. */
function gapComments(
  comments: OxcComment[],
  from: number,
  to: number,
  table: LinesAndColumns,
): Gap {
  const openLine = from === 0 ? 0 : endLineOf(table, from);
  const within = commentsWithin(comments, from, to, table);
  return {
    trailing: within.find((comment) => comment.line === openLine) ?? null,
    above: within.filter((comment) => comment.line !== openLine),
  };
}

interface Attribution {
  /** The offset the first item's comments may start after: a brace, the statement before, or the file start. */
  openAt: number;

  /** The offset the last item's trailing comment must end before. */
  closeAt: number;

  /** A record's brace, whose line's comment is the first member's, or the statement before a const block, whose line's comment is its own. */
  opens: "brace" | "statement";
}

/** The items of one block, with each comment given to the item it belongs to: a comment on the line an item ends on
 *  trails that item; every other comment between two items is the lower item's, and one on an item's own lines is
 *  that item's. A blank-separated comment above a const block's first item is the group's tell, not the item's. */
function attribute(
  spans: Span[],
  comments: OxcComment[],
  owned: Owned[],
  table: LinesAndColumns,
  { openAt, closeAt, opens }: Attribution,
): Item[] {
  const items: Item[] = spans.map((span) => ({
    kind: span.kind,
    line: lineOf(table, span.start),
    endLine: endLineOf(table, span.end),
    above: [],
    inside: commentsInside(comments, owned, span, table),
    trailing: null,
  }));
  spans.forEach((span, index) => {
    const from = index === 0 ? openAt : spans[index - 1].end;
    const gap = gapComments(comments, from, span.start, table);
    if (gap.trailing !== null && index > 0) items[index - 1].trailing = gap.trailing;

    const first = index === 0;
    items[index].above =
      first && opens === "statement" ? contiguousAbove(gap.above, items[0].line) : gap.above;
    if (first && opens === "brace" && gap.trailing !== null) items[0].above.unshift(gap.trailing);
  });
  const last = items.length - 1;
  items[last].trailing ??= gapComments(comments, spans[last].end, closeAt, table).trailing;
  return items;
}

/** The judged extensions: TypeScript in every flavor oxc reads as such. */
export function isTypeScript(relPath: string): boolean {
  return TS_EXTENSIONS.has(relPath.slice(relPath.lastIndexOf(".") + 1));
}

/** The record model of one file, or null when oxc cannot parse it (a file the check warns about, never judges).
 *  oxc reads the language off the file name, so a `.d.ts` parses as a declaration file. */
export function parseSource(relPath: string, text: string): Source | null {
  const parsed = parseSync(relPath, text);
  if (parsed.errors.length > 0) return null;

  const table = new LinesAndColumns(text);
  const comments = parsed.comments;
  const program = parsed.program;
  const { records: bodies, owned } = constructsOf(program, text, comments);
  const toDelimiter = (span: Span): Span => ({
    ...span,
    end: delimiterEnd(text, comments, span.end),
  });
  const records: Block[] = bodies
    .filter((body) => membersOf(body).length > 0)
    .map((body) => ({
      kind: RECORD_KINDS[body.type],
      items: attribute(membersOf(body).map(memberSpan).map(toDelimiter), comments, owned, table, {
        openAt: body.start,
        closeAt: body.end,
        opens: "brace",
      }),
    }));
  const constBlocks: Block[] = constRuns(program).map((run) => {
    const index = program.body.indexOf(run[0].node);
    const before = index === 0 ? program.hashbang : program.body[index - 1];
    const after = program.body[program.body.indexOf(run[run.length - 1].node) + 1];
    return {
      kind: "const block",
      items: attribute(run.flatMap(declaratorSpans).map(toDelimiter), comments, owned, table, {
        openAt: before?.end ?? 0,
        closeAt: after?.start ?? text.length,
        opens: "statement",
      }),
    };
  });

  // Split on the line breaks lines-and-columns counts (LF, CRLF, a lone CR), so its line numbers index `lines`.
  return { lines: text.split(/\r\n|\r|\n/), blocks: [...records, ...constBlocks] };
}
