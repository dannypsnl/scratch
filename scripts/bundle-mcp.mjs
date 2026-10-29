// The MCP server (mcp/server.mjs) as one file, dist/mcp/scratch-mcp.mjs,
// that needs nothing but Node: shipped inside scratch.app and beside the
// other platforms' binaries, so the installed app can be registered with
// Claude Code without a checkout of this repository.
//   node scripts/bundle-mcp.mjs
import { build } from "vite";

await build({
  configFile: false,
  logLevel: "warn",
  publicDir: false,
  // loro-crdt's Node build reads its wasm from a file beside it; the base64
  // build carries it inside the script
  resolve: { alias: [{ find: /^loro-crdt$/, replacement: "loro-crdt/base64" }] },
  ssr: { noExternal: true, target: "node" },
  build: {
    ssr: "mcp/server.mjs",
    outDir: "dist/mcp",
    emptyOutDir: true,
    target: "node24",
    minify: false,
    rollupOptions: { output: { entryFileNames: "scratch-mcp.mjs", codeSplitting: false } },
  },
});
console.log("built dist/mcp/scratch-mcp.mjs");
