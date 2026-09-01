// tsc-side stand-in for Vite's CSS handling: the theme's side-effect CSS
// import is real at build time (Vite bundles it) and typeless here.
declare module "*.css";
