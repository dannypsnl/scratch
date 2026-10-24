// Derivations (chain.js) in WebKit: lines whose formulas start with a
// relation go on from the line above, their relations drawn under its first
// one and their notes at one column; an edit draws them again; a chain in
// child blocks is its own; the outline text is unchanged. And "=" typed to
// start such a line offers what the step above comes to. Starts its own
// Vite server.
//
//   npm run test:ui
import { createServer } from "vite";
import { webkit } from "playwright-core";

const server = await createServer({ logLevel: "error", server: { port: 5190, hmr: false, watch: null } });
await server.listen();
const browser = await webkit.launch();
const pg = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };
pg.on("pageerror", (e) => check(false, `page error: ${e}`));
await pg.goto(server.resolvedUrls.local[0]);
await pg.waitForFunction(() => window.view);

const TEXT = [
  "- $(a+b)^2 = (a+b)(a+b)$ 定義",
  "- $= a^2+ab+ba+b^2$ 分配律",
  "- $= a^2+2ab+b^2$ 交換律",
  "- 普通的一行",
  "- $x \\leq y$",
  "  - $f(x) = g(x)$",
  "  - $\\leq h(x)$ 單調",
].join("\n");
const load = (text) => pg.evaluate(async (text) => {
  const view = window.view, IO = await import("/src/outline-io.js");
  view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, IO.parseOutline(text).content));
}, text);
const frame = () => pg.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
// per line: the first relation's x, where its note starts, and its text
const rows = () => pg.evaluate(() => [...document.querySelectorAll(".ProseMirror .pm-line")].map((l) => {
  const rel = l.querySelector(":scope > .pm-math > .pm-rel"), gap = l.querySelector(":scope > .chain-gap");
  return { text: l.textContent, rel: rel ? Math.round(rel.getBoundingClientRect().left) : null, note: gap ? Math.round(gap.getBoundingClientRect().right) : null };
}));
// one column, to a pixel (positions are fractional)
const near = (a, b) => a !== null && b !== null && Math.abs(a - b) <= 1;
const outline = () => pg.evaluate(async () => (await import("/src/outline-io.js")).serializeOutline(window.view.state.doc));

await load(TEXT);
await frame();
let r = await rows();
check(near(r[1].rel, r[0].rel) && near(r[2].rel, r[0].rel), `the "=" of each step under the first one (${r.slice(0, 3).map((x) => x.rel)})`);
check(near(r[1].note, r[0].note) && near(r[2].note, r[0].note), `the notes at one column (${r.slice(0, 3).map((x) => x.note)})`);
check(r[3].rel === null && !r[3].note, "a plain line after the chain is left alone");
check(near(r[6].rel, r[5].rel) && !near(r[5].rel, r[0].rel), `a chain in child blocks lines up on its own first line (${r[5].rel}, ${r[6].rel})`);
const plain = await pg.evaluate(async (text) => { const IO = await import("/src/outline-io.js"); return IO.serializeOutline(IO.parseOutline(text)); }, TEXT);
check((await outline()) === plain, "the outline text is what it was without the chain drawn");

// a longer left side: drawn again
await pg.evaluate(() => {
  const view = window.view;
  let at = -1;
  view.state.doc.descendants((n, p) => { if (at < 0 && n.type.name === "math") at = p + 1; return at < 0; });
  view.dispatch(view.state.tr.insertText("2c+", at));
});
await frame();
r = await rows();
check(near(r[1].rel, r[0].rel) && near(r[2].rel, r[0].rel), `after the first line grows, the steps follow it (${r.slice(0, 3).map((x) => x.rel)})`);

// typing the next step: "=" at the start offers what the step above comes to
await load("- $x = (a+b)^2$");
await pg.evaluate(() => {
  const view = window.view;
  view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.create(view.state.doc, view.state.doc.content.size - 2)));
  view.focus();
});
await pg.keyboard.press("End");
await pg.keyboard.press("Enter");
await pg.keyboard.type("$=");
await pg.evaluate(async () => { await (await import("/src/notation.js")).casSettled(); });
await frame();
const offered = await pg.evaluate(() => [...document.querySelectorAll(".notation-hint button.equals annotation")].map((a) => a.textContent.replace(/\s/g, "")));
check(offered.some((t) => t.split("+").sort().join("+") === "2ab+a^2+b^2"), `"=" starting the next line offers the step above expanded (${JSON.stringify(offered)})`);
const btn = await pg.evaluate(() => { const b = document.querySelector(".notation-hint button.equals").getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
await pg.mouse.click(btn.x, btn.y);
await frame();
r = await rows();
check(/= ?a\^/.test((await outline()).split("\n")[1]) && near(r[1].rel, r[0].rel), `picked, the new step is in and lined up (${(await outline()).split("\n")[1]}; ${r[0].rel}, ${r[1].rel})`);

if (process.env.SHOT) {
  await load(TEXT);
  await frame();
  const box = await pg.evaluate(() => { const r = document.querySelector(".ProseMirror").getBoundingClientRect(); return { x: r.x, y: r.y, width: Math.min(r.width, 760), height: 260 }; });
  await pg.screenshot({ path: process.env.SHOT, clip: box });
}

await browser.close();
await server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
