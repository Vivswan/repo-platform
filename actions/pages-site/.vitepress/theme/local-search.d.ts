// tsc-side stand-in for VitePress's local search index virtual module,
// which its local-search plugin serves at build time: one lazy loader per
// locale key, each resolving to the serialized MiniSearch index.
declare module "@localSearchIndex" {
  const indexes: Record<string, (() => Promise<{ default: string }>) | undefined>;
  export default indexes;
}
