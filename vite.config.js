import { defineConfig } from "vite";

export default defineConfig({
  // `build/` is what Neutralino serves; `neu build` writes the app to `dist/`.
  build: { outDir: "build", target: "es2022" },
  // loro-crdt's browser build loads its wasm as a file of its own; the
  // default in development (its bundler build) needs a wasm plugin, and the
  // base64 build carries the wasm a third larger inside the script
  resolve: { alias: [{ find: /^loro-crdt$/, replacement: "loro-crdt/browser" }] },
  // loaded only on first use (cas.js): pre-bundle it up front, or that first
  // use makes the dev server re-optimize and reload the page
  optimizeDeps: { include: ["nerdamer"] },
});
