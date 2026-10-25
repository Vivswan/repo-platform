// The record model the member-shape rules judge: every record (an interface body, a class body, a type literal, an
// enum body) and every block of adjacent module-level `const` declarations, each item with the comments that belong
// to it. The TypeScript is read by oxc-parser (TypeScript 7 is the native port and exposes no in-process compiler
// API); line numbers come from offsets through one line-start table.

import type {
  ClassBody,
  Node,
  Program,
  TSEnumBody,
  TSInterfaceBody,
  TSTypeLiteral,
} from "@oxc-project/types";
import { type Comment as OxcComment, parseSync, Visitor } from "oxc-parser";

/** The record kinds the rules judge: a body whose members stand together. */
export type RecordKind = "interface" | "class" | "type literal" | "enum";

/** A record, or a block of adjacent module-level `const` statements. */
export type BlockKind = RecordKind | "const block";

/** A comment by its 1-based lines. */
export interface Comment {
  line: number;
  endLine: number;
}

/** A member of a record or one `const` statement of a block. */
export interface Item {
  /** The item's own first line: its `export` keyword or first decorator, never its comment. */
  line: number;

  /** The line its last character sits on. */
  endLine: number;

  /** The comments above the item that belong to it, top to bottom, whatever blank lines sit between. */
  above: Comment[];

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

const RECORD_KINDS: Readonly<Record<RecordBody["type"], RecordKind>> = {
  TSInterfaceBody: "interface",
  ClassBody: "class",
  TSTypeLiteral: "type literal",
  TSEnumBody: "enum",
};
const TS_EXTENSIONS: ReadonlySet<string> = new Set(["ts", "mts", "cts", "tsx"]);

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

/** Every record body in the tree, nested ones included, in visiting order. */
function recordBodies(program: Program): RecordBody[] {
  const found: RecordBody[] = [];
  const collect = (body: RecordBody): void => {
    found.push(body);
  };
  new Visitor({
    TSInterfaceBody: collect,
    ClassBody: collect,
    TSTypeLiteral: collect,
    TSEnumBody: collect,
  }).visit(program);
  return found;
}

function isConstStatement(node: Node): boolean {
  const declaration = node.type === "ExportNamedDeclaration" ? node.declaration : node;
  return declaration?.type === "VariableDeclaration" && declaration.kind === "const";
}

/** The maximal runs of adjacent `const` statements in the module body. */
function constRuns(program: Program): ModuleStatement[][] {
  const runs: ModuleStatement[][] = [];
  let run: ModuleStatement[] = [];
  for (const statement of program.body) {
    if (isConstStatement(statement)) {
      run.push(statement);
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

/** A class member's span starts at its first decorator. */
function startOf(node: Node): number {
  const decorators = "decorators" in node ? (node.decorators ?? []) : [];
  return Math.min(node.start, ...decorators.map((decorator) => decorator.start));
}

/** Where an item's own declaration begins past its prefix (decorators, modifiers, `export`): a comment before it
 *  inside the item is the item's, misplaced. */
function prefixEnd(node: Node): number {
  if ("key" in node) {
    return node.key.start;
  }
  if (node.type === "ExportNamedDeclaration" && node.declaration !== null) {
    return node.declaration.start;
  }
  return startOf(node);
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

/** The comments lying within two offsets, by their lines. */
function commentsWithin(
  comments: OxcComment[],
  from: number,
  to: number,
  table: LineTable,
): Comment[] {
  return comments
    .filter((comment) => comment.start >= from && comment.end <= to)
    .map((comment) => ({
      line: table.lineOf(comment.start),
      endLine: table.endLineOf(comment.end),
    }));
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

  /** Whether a blank-separated comment above the FIRST item is the group's tell (a const block) or the item's own. */
  tellAllowed: boolean;
}

/** The items of one block, with each comment given to the item it belongs to: a comment on the line an item ends on
 *  trails that item; every other comment between two items, or inside the lower item's prefix, is the lower item's. */
function attribute(
  nodes: Node[],
  comments: OxcComment[],
  table: LineTable,
  { openAt, closeAt, tellAllowed }: Attribution,
): Item[] {
  const items: Item[] = nodes.map((node) => ({
    line: table.lineOf(startOf(node)),
    endLine: table.endLineOf(node.end),
    above: [],
    trailing: null,
  }));
  nodes.forEach((node, index) => {
    const from = index === 0 ? openAt : nodes[index - 1].end;
    const gap = gapComments(comments, from, startOf(node), table);
    if (gap.trailing !== null && index > 0) {
      items[index - 1].trailing = gap.trailing;
    }
    const isTell = index === 0 && tellAllowed;
    const above = isTell ? contiguousAbove(gap.above, items[index].line) : gap.above;
    const misplaced = commentsWithin(comments, startOf(node), prefixEnd(node), table);
    items[index].above = [...above, ...misplaced];
  });
  const last = items.length - 1;
  items[last].trailing ??= gapComments(comments, nodes[last].end, closeAt, table).trailing;
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
  const records: Block[] = recordBodies(program)
    .filter((body) => membersOf(body).length > 0)
    .map((body) => ({
      kind: RECORD_KINDS[body.type],
      items: attribute(membersOf(body), comments, table, {
        openAt: body.start,
        closeAt: body.end,
        tellAllowed: false,
      }),
    }));
  const constBlocks: Block[] = constRuns(program).map((run) => {
    const index = program.body.indexOf(run[0]);
    const before = index === 0 ? program.hashbang : program.body[index - 1];
    const after = program.body[program.body.indexOf(run[run.length - 1]) + 1];
    return {
      kind: "const block",
      items: attribute(run, comments, table, {
        openAt: before?.end ?? 0,
        closeAt: after?.start ?? text.length,
        tellAllowed: true,
      }),
    };
  });

  return { lines: table.lines, blocks: [...records, ...constBlocks] };
}
