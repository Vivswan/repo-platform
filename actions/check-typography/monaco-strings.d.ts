// Ambient declarations for the deep monaco-editor ESM import used by
// check-typography.ts (the package ships no types for this internal path).
// Shapes match monaco-editor 0.52's src/vs/base/common/strings.ts.
declare module "monaco-editor/esm/vs/base/common/strings.js" {
  export class AmbiguousCharacters {
    static getInstance(locales: Set<string>): AmbiguousCharacters;
    getPrimaryConfusable(codePoint: number): number | undefined;
  }
  export const InvisibleCharacters: {
    isInvisibleCharacter(codePoint: number): boolean;
  };
}
