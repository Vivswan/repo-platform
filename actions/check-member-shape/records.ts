// The record model the member-shape rules judge: every record (an interface body, a class body, a type literal, an
// enum body) and every block of adjacent module-level `const` statements, each member or declarator with the comments
// that belong to it. The TypeScript is read by oxc-parser (TypeScript 7 is the native port and exposes no in-process
// compiler API); line numbers come from offsets through one line-start table.

import type {
  ArrayExpression,
  BlockStatement,
  ClassBody,
  Node,
  ObjectExpression,
  Program,
  StaticBlock,
  TSEnumBody,
  TSInterfaceBody,
  TSTypeLiteral,
  VariableDeclarator,
} from "@oxc-project/types";
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

/** A construct whose comments are its own, never an enclosing member's: a record body (its members are judged on
 *  their own), a function body (code comments, not a doc comment), an object or array literal (its entries'). */
type Nested = RecordBody | BlockStatement | StaticBlock | ObjectExpression | ArrayExpression;

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

/** The lines of a file in order, so an offset maps to a 1-based line by a binary search over the line starts. Span
 *  ends are exclusive, so endLineOf reads the character before the end. */
class LineTable {
  readonly lines: string[];
  private readonly starts: number[];

  constructor(text: string) {
    this.lines = text.split("\n");
    this.starts = [0];
    for (const line of this.lines.slice(0, -1)) {
      this.starts.push(this.starts[this.starts.length - 1] + line.length + 1);
    }
  }

  lineOf(offset: number): number {
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (this.starts[mid] <= offset) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }

    return low + 1;
  }

  endLineOf(end: number): number {
    return this.lineOf(Math.max(end - 1, 0));
  }
}

function membersOf(body: RecordBody): Node[] {
  return "members" in body ? body.members : body.body;
}

function isRecordBody(node: Nested): node is RecordBody {
  return node.type in RECORD_KINDS;
}

/** Every record body and every other comment-owning construct in the tree, in visiting order. */
function nestedOf(program: Program): Nested[] {
  const found: Nested[] = [];
  const collect = (node: Nested): void => {
    found.push(node);
  };
  new Visitor({
    TSInterfaceBody: collect,
    ClassBody: collect,
    TSTypeLiteral: collect,
    TSEnumBody: collect,
    BlockStatement: collect,
    StaticBlock: collect,
    ObjectExpression: collect,
    ArrayExpression: collect,
  }).visit(program);
  return found;
}

/** The statement as a `const` statement, or null for any other. */
function constStatement(node: ModuleStatement): ConstStatement | null {
  const declaration = node.type === "ExportNamedDeclaration" ? node.declaration : node;
  if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
    return null;
  }

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

    if (run.length > 0) {
      runs.push(run);
    }
    run = [];
  }

  if (run.length > 0) {
    runs.push(run);
  }

  return runs;
}

/** An accessor is a field wherever it is declared (a class, an interface, a type literal): it stands for a value, and
 *  its doc reads as a field's does. */
function memberKind(node: Node): MemberKind {
  const kind = "kind" in node ? node.kind : undefined;
  if (kind === "get" || kind === "set") {
    return "field";
  }

  return METHOD_TYPES.has(node.type) ? "method" : "field";
}

/** The end of the `,` or `;` that follows an offset past whitespace and comments, or the offset itself: oxc ends an
 *  enum member or a declarator before its separator, and a comment between the two is the member's. */
function delimiterEnd(text: string, comments: OxcComment[], end: number): number {
  let at = end;
  let comment: OxcComment | undefined;
  do {
    while (/\s/.test(text.charAt(at))) {
      at += 1;
    }
    comment = comments.find((candidate) => candidate.start === at);
    at = comment?.end ?? at;
  } while (comment !== undefined);

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
    if (comment.endLine !== next - 1 && !onItemLine) {
      break;
    }
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
  table: LineTable,
): Comment[] {
  return comments
    .filter((comment) => within(comment, from, to))
    .map((comment) => ({
      line: table.lineOf(comment.start),
      endLine: table.endLineOf(comment.end),
    }));
}

/** The comments on a span's own lines: within it, outside any construct nested in it that owns its own. */
function commentsInside(
  comments: OxcComment[],
  nested: Nested[],
  span: Span,
  table: LineTable,
): Comment[] {
  const inner = nested.filter((node) => within(node, span.start, span.end));
  const owned = comments.filter(
    (comment) => !inner.some((node) => within(comment, node.start, node.end)),
  );
  return commentsWithin(owned, span.start, span.end, table);
}

/** The comments between two offsets. `from` is the end of the item above, or of what opens the block: a brace, the
 *  statement before, the file start at 0. */
function gapComments(comments: OxcComment[], from: number, to: number, table: LineTable): Gap {
  const openLine = from === 0 ? 0 : table.endLineOf(from);
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
  nested: Nested[],
  table: LineTable,
  { openAt, closeAt, opens }: Attribution,
): Item[] {
  const items: Item[] = spans.map((span) => ({
    kind: span.kind,
    line: table.lineOf(span.start),
    endLine: table.endLineOf(span.end),
    above: [],
    inside: commentsInside(comments, nested, span, table),
    trailing: null,
  }));
  spans.forEach((span, index) => {
    const from = index === 0 ? openAt : spans[index - 1].end;
    const gap = gapComments(comments, from, span.start, table);
    if (gap.trailing !== null && index > 0) {
      items[index - 1].trailing = gap.trailing;
    }

    const first = index === 0;
    items[index].above =
      first && opens === "statement" ? contiguousAbove(gap.above, items[0].line) : gap.above;
    if (first && opens === "brace" && gap.trailing !== null) {
      items[0].above.unshift(gap.trailing);
    }
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
  if (parsed.errors.length > 0) {
    return null;
  }

  const table = new LineTable(text);
  const comments = parsed.comments;
  const program = parsed.program;
  const nested = nestedOf(program);
  const toDelimiter = (span: Span): Span => ({
    ...span,
    end: delimiterEnd(text, comments, span.end),
  });
  const records: Block[] = nested
    .filter(isRecordBody)
    .filter((body) => membersOf(body).length > 0)
    .map((body) => ({
      kind: RECORD_KINDS[body.type],
      items: attribute(membersOf(body).map(memberSpan).map(toDelimiter), comments, nested, table, {
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
      items: attribute(run.flatMap(declaratorSpans).map(toDelimiter), comments, nested, table, {
        openAt: before?.end ?? 0,
        closeAt: after?.start ?? text.length,
        opens: "statement",
      }),
    };
  });

  return { lines: table.lines, blocks: [...records, ...constBlocks] };
}
