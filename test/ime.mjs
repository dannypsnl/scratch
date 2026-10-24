// An input method (注音 here) composing beside a formula or at its edge:
// the composed text goes where the caret is, all of it once (no leftovers of
// the composition), and the rest of the line is left as it was. The place
// just outside a formula and the formula's own edge are one place to the
// DOM, and the browser composes at whichever it picks.
//
// In WebKit (the app's engine) through a real WKWebView driven as an input
// method drives it (test/ime-webkit.swift, macOS with swiftc); Playwright
// cannot compose in WebKit. In Chromium through CDP Input.imeSetComposition
// (needs npx playwright-core install chromium-headless-shell). Starts its
// own Vite server.
//
//   npm run test:ui     (after the WebKit sweep)
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";

// [line, where the caret goes (a place in the line, by what is before it), the line afterwards]
// a place: "after N" / "before N" for the Nth formula (outside it), "end N" /
// "start N" inside it, "in text" for the end of a \text
const CASES = [
  ["表示 $m_1=m_2$", "after 0", "表示 $m_1=m_2$主"],
  ["$m_1=m_2$ 表示", "before 0", "主$m_1=m_2$ 表示"],
  ["表示 $x$ 後", "after 0", "表示 $x$主 後"],
  ["表示 $x$ 後", "before 0", "表示 主$x$ 後"],
  ["$a^2$$b_1$", "after 0", "$a^2$主$b_1$"],
  ["$\\frac{a}{b}$", "after 0", "$\\frac{a}{b}$主"],
  ["$\\xrightarrow{f}$", "after 0", "$\\xrightarrow{f}$主"],
  ["$\\sqrt{x}$ 後", "before 0", "主$\\sqrt{x}$ 後"],
  ["前 $\\text{ab}$", "in text", "前 $\\text{ab主}$"],
  ["前 $\\text{ab}$ 後", "in text", "前 $\\text{ab主}$ 後"],
  // inside a formula at its edge: the composition stays in the formula
  ["表示 $x$ 後", "end 0", "表示 $x主$ 後"],
  ["表示 $x$ 後", "start 0", "表示 $主x$ 後"],
  ["$x$", "start 0", "$主x$"],
  // no formula: the composition is the whole line, or follows Latin text
  ["", "line end", "主"],
  ["If ", "line end", "If 主"],
];
// what the input method shows while composing, then what it commits (主 in
// CASES stands for it): one syllable; a phrase, converted in place as 注音
// on macOS does, the first word already a character while the next is typed;
// a symbol taken back with Backspace while composing
const COMPOSITIONS = [
  [["ㄓ", "ㄓㄨ", "ㄓㄨˇ"], "主"],
  [["ㄘ", "ㄘㄜ", "ㄘㄜˋ", "測", "測ㄕ", "測ㄕˋ", "測試"], "測試"],
  [["ㄓ", "ㄓㄨ", "ㄓ", "ㄓㄨ", "ㄓㄨˇ"], "主"],
];
const RUNS = CASES.flatMap(([line, where, expect]) => COMPOSITIONS.map(([steps, word]) => ({ line, where, steps, word, expect: expect.replace("主", word) })));

const server = await createServer({ logLevel: "error", server: { port: 5198, hmr: false, watch: null } });
await server.listen();
const url = server.resolvedUrls.local[0];
const fails = [];

// Chromium (first: it also warms Vite up)
const browser = await chromium.launch();
for (const { line, where, steps, word, expect } of RUNS) {
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  pg.on("pageerror", (e) => fails.push({ line, error: String(e) }));
  await pg.goto(url);
  await pg.waitForFunction(() => window.view);
  await pg.evaluate((line) => {
    const v = window.view;
    v.focus();
    const dt = new DataTransfer();
    dt.setData("text/plain", `- ${line}`);
    v.dom.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, line);
  await pg.waitForTimeout(300);
  // the caret, put there by the editor (which also puts the DOM caret)
  await pg.evaluate((where) => {
    const v = window.view;
    const [kind, n] = where.split(" ");
    const maths = [];
    let text = null;
    v.state.doc.descendants((node, pos) => {
      if (node.type.name === "math") maths.push([pos, node.nodeSize]);
      if (node.type.name === "struct" && node.attrs.name === "text") text = pos + 2 + node.firstChild.content.size;
    });
    const [p, size] = maths[n] ?? [];
    const at = { in: text, after: p + size, before: p, end: p + size - 1, start: p + 1, line: v.state.selection.constructor.atEnd(v.state.doc).head }[kind];
    v.focus();
    v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, at)));
  }, where);
  await pg.waitForTimeout(300);
  const cdp = await ctx.newCDPSession(pg);
  for (const t of steps) {
    await cdp.send("Input.imeSetComposition", { text: t, selectionStart: t.length, selectionEnd: t.length });
    await pg.waitForTimeout(80);
  }
  await cdp.send("Input.insertText", { text: word });
  await pg.waitForTimeout(300);
  // the line as text and $LaTeX$
  const got = await pg.evaluate(async () => {
    const { serializeMath } = await import("/src/latex.js");
    let out = "";
    window.view.state.doc.descendants((n) => {
      if (n.type.name !== "line" || out) return !out;
      n.forEach((c) => { out += c.isText ? c.text : c.type.name === "math" ? `$${serializeMath(c.content)}$` : ""; });
      return false;
    });
    return out;
  });
  if (got !== expect) fails.push({ engine: "chromium", line, where, steps, expect, got });
  await ctx.close();
}

console.log(`ime: ${RUNS.length} compositions in Chromium`);
await browser.close();

// WebKit
if (process.platform === "darwin") {
  const src = new URL("./ime-webkit.swift", import.meta.url).pathname;
  // (in a folder of its own: WebKit keeps its caches in $TMPDIR/<program name>)
  mkdirSync(`${tmpdir()}/pm-ime-webkit`, { recursive: true });
  const bin = `${tmpdir()}/pm-ime-webkit/ime-webkit`;
  try {
    if (!existsSync(bin) || statSync(bin).mtimeMs < statSync(src).mtimeMs) execFileSync("swiftc", ["-O", src, "-o", bin], { stdio: "inherit" });
    const out = execFileSync(bin, [url, JSON.stringify(RUNS)], { encoding: "utf8", timeout: 600000, stdio: ["ignore", "pipe", "ignore"] }).trimEnd().split("\n");
    RUNS.forEach((r, k) => { if (out[k] !== r.expect) fails.push({ engine: "webkit", ...r, got: out[k] }); });
    console.log(`ime: ${RUNS.length} compositions in WebKit`);
  } catch (e) {
    fails.push({ engine: "webkit", error: String(e.message ?? e).split("\n")[0].slice(0, 200) });
  }
} else console.log("ime: WebKit skipped (needs macOS)");

await server.close();
for (const f of fails) console.log(`\nIME composition: ${JSON.stringify(f)}`);
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exitCode = fails.length ? 1 : 0;
