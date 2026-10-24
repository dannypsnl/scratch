// Arrow keys around a formula in a real WKWebView (test/keys-webkit.swift,
// macOS with swiftc): where the caret is after each key, in the model and as
// drawn. Playwright's WebKit is not the one the app runs in, and the caret
// beside a formula is where the two differ. Starts its own Vite server.
//
//   npm run test:ui
import { createServer } from "vite";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";

const W = "$\\frac{b^2-a^2}{b-a} =$";
// [what, outline, line, at, keys, where the caret is after each key]
const CASES = [
  ["→ out of a formula, ← back in after the =", `- ${W}\n- $=$`, 0, "math-end", ["right", "wait:800", "left", "left"],
    ["line math| @math-right", "math =| @-7", "math struct|= @-30"]],
  ["← from a space after a formula: its edge, then in after the =", `- ${W} `, 0, "end", ["left", "left"],
    ["line math|  @math-right", "math =| @-7"]],
  ["→ from the line's start: into the formula, then into the fraction", `- ${W}\n- $=$`, 0, "start", ["right", "right"],
    ["math |struct @math-left", "slot |b @-85"]],
  ["→ from the formula's start goes into the fraction", `- ${W}`, 0, "math-start", ["right", "right"],
    ["slot |b @-85", "slot b|sup @-77"]],
];

if (process.platform !== "darwin") {
  console.log("keys: skipped (needs macOS)");
  process.exit(0);
}
const server = await createServer({ logLevel: "error", server: { port: 5187, hmr: false, watch: null } });
await server.listen();
const src = new URL("./keys-webkit.swift", import.meta.url).pathname;
// (in a folder of its own: WebKit keeps its caches in $TMPDIR/<program name>)
mkdirSync(`${tmpdir()}/pm-keys-webkit`, { recursive: true });
const bin = `${tmpdir()}/pm-keys-webkit/keys-webkit`;
if (!existsSync(bin) || statSync(bin).mtimeMs < statSync(src).mtimeMs) execFileSync("swiftc", ["-O", src, "-o", bin], { stdio: "inherit" });
const runs = CASES.map(([, text, line, at, keys]) => ({ text, line, at, keys }));
const { stdout } = await promisify(execFile)(bin, [server.resolvedUrls.local[0], JSON.stringify(runs)], { encoding: "utf8", timeout: 300000 });
await server.close();

const fails = [];
stdout.trimEnd().split("\n").forEach((out, k) => {
  const [what, , , , keys, want] = CASES[k];
  // the caret before the keys, then after each (a wait is no key)
  const got = out.split(" ; ").slice(1).filter((_, i) => !keys[i].startsWith("wait:"));
  // (inside a formula, a drawn caret's offset depends on the fonts: only its edges count)
  const norm = (x) => x.replace(/@-?\d+$/, "@inside");
  const ok = got.length === want.length && got.every((g, i) => norm(g) === norm(want[i]));
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) { fails.push(what); console.log(`  got  ${got.join(" ; ")}\n  want ${want.join(" ; ")}`); }
});
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exitCode = fails.length ? 1 : 0;
