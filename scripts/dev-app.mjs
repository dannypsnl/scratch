// Dev server for `npm run app` (neu run). If a Vite server is already on the
// port (say, one started for the browser), reuse it instead of failing.
import net from "node:net";
import { spawn } from "node:child_process";

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
