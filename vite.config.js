import { defineConfig } from "vite";

export default defineConfig({
  // `build/` is what Neutralino serves; `neu build` writes the app to `dist/`.
  build: { outDir: "build", target: "es2022" },
});
