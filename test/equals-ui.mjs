// After "=" in a formula, the hint offers what the left side comes to
// (notation.js equalsActions, through Nerdamer): typed as a person types it
// in WebKit, (a+b)^2 = offers its expansion, a click puts it after the "=",
// and a left side with nothing to work out offers nothing. And ^ or _ on a
// selection moves it into a script, typed or in the menu Space opens. Starts its own
// Vite server.
//
//   npm run test:ui
import { createServer } from "vite";
import { webkit } from "playwright-core";

const server = await createServer({ logLevel: "error", server: { port: 5194, hmr: false, watch: null } });
await server.listen();
const browser = await webkit.launch();
const pg = await (await browser.newContext({ viewport: { width: 1100, height: 700 } })).newPage();
const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };
pg.on("pageerror", (e) => check(false, `page error: ${e}`));
await pg.goto(server.resolvedUrls.local[0]);
await pg.waitForFunction(() => window.view);

const settle = () => pg.evaluate(async () => { await (await import("/src/notation.js")).casSettled(); await new Promise((r) => setTimeout(r, 50)); });
const hint = () => pg.evaluate(() => {
  const b = document.querySelector(".notation-hint");
  return !b || b.hidden ? null : [...b.querySelectorAll("button.equals")].map((x) => ({ op: x.querySelector(".op").textContent, tex: x.querySelector("annotation")?.textContent ?? "" }));
});
// the last line holding `has`
const line = (has) => pg.evaluate(async (has) => (await import("/src/outline-io.js")).serializeOutline(window.view.state.doc).split("\n").findLast((l) => l.includes(has)) ?? "", has);
// a sum's terms in any order
const terms = (tex) => tex.replace(/\s/g, "").split("+").sort().join("+");

// a fresh line: type the formula as a person would
await pg.evaluate(() => window.view.focus());
await pg.keyboard.press("Meta+Shift+Enter");
await pg.keyboard.type("$(a+b)^2");
await pg.keyboard.press("ArrowRight"); // out of the superscript
await pg.keyboard.type(" =");
await settle();
let h = await hint();
check(!!h && h.some((x) => terms(x.tex) === terms("a^2+2ab+b^2")), `after (a+b)^2 = the hint offers the expansion (${JSON.stringify(h)})`);
check(!!h && h.every((x) => x.tex.replace(/\s/g, "") !== "(a+b)^{2}"), "and not the left side as written");

// pick it
const at = await pg.evaluate(() => { const b = document.querySelector(".notation-hint button.equals"); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
await pg.mouse.click(at.x, at.y);
const after = await line("(a+b)");
const right = /=\s*(.*)\$/.exec(after)?.[1] ?? "";
check(terms(right.replace(/[{}]/g, "")) === terms("a^2+2ab+b^2"), `picked, it goes after the "=" (${after})`);
check(!(await hint()), "and the hint is gone (the caret is no longer after an \"=\")");
check(!(await pg.$(".palette.suggest:not([hidden])")), "the answer's last word (ab) brings up no command suggestion");
await pg.keyboard.press("Meta+Shift+Enter");
check(/2ab\$/.test(await line("(a+b)")), "and ⌘⇧↵ after it opens a new line, leaving the answer as it was");
// a suggestion that is up: ⌘⇧↵ still opens a new line instead of taking it
await pg.keyboard.type("$ab");
check(!!(await pg.$(".palette.suggest:not([hidden])")), "(typing ab in a formula suggests commands)");
await pg.keyboard.press("Meta+Shift+Enter");
check(/\$ab\$/.test(await line("ab$")), "⌘⇧↵ does not take the suggestion");

// nothing to work out: no hint
await pg.keyboard.press("Meta+Shift+Enter");
await pg.keyboard.type("$x =");
await settle();
check(!(await hint()), "x = offers nothing");
await pg.keyboard.press("Meta+Shift+Enter");
await pg.keyboard.type("$a+b =");
await settle();
check(!(await hint()), "a+b = (already as simple as it gets) offers nothing");

// after a relation, only what follows it is worked out
await pg.keyboard.press("Meta+Shift+Enter");
await pg.keyboard.type("$y = 2x+3x =");
await settle();
h = await hint();
check(!!h && h.some((x) => x.tex.replace(/\s/g, "") === "5x"), `y = 2x+3x = offers 5x (${JSON.stringify(h)})`);

// a selection in a formula: ^ and _ move it into a script, still selected
const scriptLine = async (key) => {
  await pg.keyboard.press("Meta+Shift+Enter");
  await pg.keyboard.type("$(a+b)2");
  await pg.keyboard.press("Shift+ArrowLeft");
  await key();
  return { line: await line("(a+b)"), sel: await pg.evaluate(() => { const s = window.view.state.selection; return window.view.state.doc.textBetween(s.from, s.to) + "|" + s.$from.parent.type.name; }) };
};
let r = await scriptLine(() => pg.keyboard.type("^"));
check(/\(a\+b\)\^\{?2\}?\$/.test(r.line) && r.sel === "2|sup", `^ on a selected 2 makes it the power, still selected (${r.line}, ${r.sel})`);
await pg.keyboard.press("Escape");
r = await scriptLine(() => pg.keyboard.type("_"));
check(/\(a\+b\)_\{?2\}?\$/.test(r.line) && r.sel === "2|sub", `_ makes it a subscript (${r.line}, ${r.sel})`);
await pg.keyboard.press("Escape");
// the same keys in the menu Space opens on the selection
r = await scriptLine(async () => {
  await pg.keyboard.press("Space");
  await pg.waitForSelector(".palette li", { state: "attached" });
  check(await pg.evaluate(() => [...document.querySelectorAll(".palette kbd")].map((k) => k.textContent).join("") === "^_"), "the menu shows ^ and _ beside the two actions");
  await pg.keyboard.type("_");
});
// (the actions menu: its input hidden, keys only)
const left = await pg.evaluate(() => [...document.querySelectorAll(".palette:has(.hidden-input)")].map((p) => p.textContent.slice(0, 60)));
check(/\(a\+b\)_\{?2\}?\$/.test(r.line) && !left.length, `_ in the menu does it and closes the menu (${r.line} ${JSON.stringify(left)})`);

await browser.close();
await server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
