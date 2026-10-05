// mvdan-sh ships no types; these are the GopherJS surface check-shell-complexity reads. Interface methods (Pos, Lit)
// are functions; struct fields (Op, OpPos, Args, Until) are plain properties; a Go error is thrown as an object.
declare module "mvdan-sh" {
  export interface Pos {
    Line(): number;
    Col(): number;
  }
  export interface Node {
    Pos(): Pos;
  }
  export interface Word extends Node {
    /** The word's literal text when it is one plain literal, else "". */
    Lit(): string;
  }
  export interface CallExpr extends Node {
    Args: Word[];
  }
  export interface BinaryCmd extends Node {
    Op: number;
    OpPos: Pos;
  }
  export interface WhileClause extends Node {
    Until: boolean;
  }
  export interface ParseError {
    Text: string;
    Pos: Pos;
    Error(): string;
  }
  export interface Parser {
    Parse(source: string, name: string): Node;
  }
  const mvdan: {
    syntax: {
      NewParser(...options: unknown[]): Parser;
      Variant(variant: number): unknown;
      LangBash: number;
      NodeType(node: Node): string;
      /** Visits every node depth-first; after a node's children it visits `null` once when `visit` returned true. */
      Walk(root: Node, visit: (node: Node | null) => boolean): void;
    };
  };
  export = mvdan;
}
