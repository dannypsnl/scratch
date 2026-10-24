import { defineConfig } from "vite";

export default defineConfig({
  // `build/` is what Neutralino serves; `neu build` writes the app to `dist/`.
  build: { outDir: "build", target: "es2022" },
  // loaded only on first use (cas.js): pre-bundle it up front, or that first
  // use makes the dev server re-optimize and reload the page
  optimizeDeps: { include: ["nerdamer"] },
});
