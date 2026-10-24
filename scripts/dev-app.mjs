// Dev server for `npm run app` (neu run). Dependencies are brought up to date
// first (package-lock.json newer than the last install: npm install), so a
// pull that adds one needs nothing by hand. If a Vite server is already on
// the port (say, one started for the browser), reuse it instead of failing.
import net from "node:net";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";

const mtime = (path) => { try { return fs.statSync(path).mtimeMs; } catch { return 0; } };
// npm writes node_modules/.package-lock.json on every install
if (mtime("package-lock.json") > mtime("node_modules/.package-lock.json")) {
  console.log("dependencies changed: npm install");
  const r = spawnSync("npm", ["install"], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const PORT = 5178;
const free = await new Promise((resolve) => {
  const probe = net.createServer().once("error", () => resolve(false)).once("listening", () => probe.close(() => resolve(true)));
  probe.listen(PORT, "localhost");
});

if (free) {
  spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { stdio: "inherit" }).on("exit", (code) => process.exit(code ?? 0));
} else {
  console.log(`dev server already running on http://localhost:${PORT}, reusing it`);
  setInterval(() => {}, 1 << 30); // stay alive like a server would
}
