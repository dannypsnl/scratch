// Typing a command's name in a formula, without "\" (suggest.js), in WebKit:
// the suggestions come up under a word just typed, and the keys that take,
// move through or dismiss them do what they say. Starts its own Vite server.
//
//   npm run test:ui
import { createServer } from "vite";
import { webkit } from "playwright-core";

// [formula to start from (caret at its end), keys, LaTeX afterwards, what is shown at the end]
// keys: text is typed; {Name} presses a key
const CASES = [
  ["x+", "alpha{Enter}", "x+\\alpha", "none"],
  ["x+", "al", "x+al", "\\aleph \\alpha"], // shown, nothing taken yet
  ["x+", "al{ArrowDown}{Enter}", "x+\\alpha", "none"],
  ["x+", "al{ArrowUp}{Tab}", "x+\\alpha", "none"],
  ["", "sqrt{Enter}2", "\\sqrt{2}", "none"],
  ["", "root{Enter}2", "\\sqrt{2}", "none"], // a plain word for it
  ["", "lim{Meta+2}", "\\liminf", "none"],
  ["", "sin ", "sin", "none"], // Space: the letters stay
  ["", "in{Escape}", "in", "none"],
  ["", "xy", "xy", "none"], // nothing named so: nothing shown
  ["a", "bc", "abc", "none"],
  ["\\text{a}", "{ArrowLeft}bs", "\\text{abs}", "none"], // not in \text
];

const server = await createServer({ logLevel: "error", server: { port: 5197, hmr: false, watch: null } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await webkit.launch();
const fails = [];

for (const [start, keys, want, shown] of CASES) {
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  pg.on("pageerror", (e) => fails.push({ start, keys, error: String(e) }));
  await pg.goto(url);
  await pg.waitForFunction(() => window.view);
  await pg.evaluate(async (start) => {
    const v = window.view;
    v.focus();
    const dt = new DataTransfer();
    dt.setData("text/plain", `- 前 $${start || "\\,"}$ 後`);
    v.dom.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 200));
    // the caret at the end of the formula (inside it)
    let end;
    v.state.doc.descendants((n, p) => { if (n.type.name === "math") end = p + n.nodeSize - 1; });
    const S = await import(performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/deps/prosemirror-state.js")));
    const tr = v.state.tr;
    if (!start) tr.delete(end - 1, end), end--; // the \, placeholder
    v.dispatch(tr.setSelection(S.TextSelection.create(tr.doc, end)));
  }, start);
  await pg.waitForTimeout(100);
  for (const m of keys.matchAll(/\{([^}]+)\}|([^{]+)/g)) {
    if (m[1]) await pg.keyboard.press(m[1]); else await pg.keyboard.type(m[2]);
    await pg.waitForTimeout(60);
  }
  await pg.waitForTimeout(150);
  const got = await pg.evaluate(async () => {
    const { serializeMath } = await import("/src/latex.js");
    let tex = "";
    window.view.state.doc.descendants((n) => { if (n.type.name === "math") tex = serializeMath(n.content); });
    const box = document.querySelector(".palette.suggest");
    const list = box && box.checkVisibility() ? [...box.querySelectorAll(".cmd")].map((e) => e.textContent.split(" ").pop()).join(" ") : "none";
    return { tex, list };
  });
  if (got.tex !== want || got.list !== shown) fails.push({ start, keys, want, shown, got });
  console.log(`suggest: ${start || "(empty)"} + ${keys}`);
  await ctx.close();
}

await browser.close();
await server.close();
for (const f of fails) console.log(`\nsuggestion: ${JSON.stringify(f)}`);
console.log(fails.length ? `\n${fails.length} of ${CASES.length} failed` : "\nall passed");
process.exitCode = fails.length ? 1 : 0;
