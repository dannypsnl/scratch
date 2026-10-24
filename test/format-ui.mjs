// The format bar (formatbar.js) in WebKit: text selected with the mouse
// brings it up over the selection with five buttons; each puts its mark on
// the selection and shows pressed, and takes it off again; a caret, a
// selection inside a formula, or a blurred editor shows none. Starts its own
// Vite server.
//
//   npm run test:ui
import { createServer } from "vite";
import { webkit } from "playwright-core";

const server = await createServer({ logLevel: "error", server: { port: 5198, hmr: false, watch: null } });
await server.listen();
const browser = await webkit.launch();
const pg = await (await browser.newContext({ viewport: { width: 1100, height: 700 } })).newPage();
const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };
pg.on("pageerror", (e) => check(false, `page error: ${e}`));
await pg.goto(server.resolvedUrls.local[0]);
await pg.waitForFunction(() => window.view);

const DAY = new Date().toLocaleDateString("sv");
await pg.evaluate(async (day) => {
  const store = await import("/src/store.js");
  const IO = await import("/src/outline-io.js");
  store.savePage(day, IO.parseOutline("- Scratch 隨筆 and $x+y$ more"));
}, DAY);
// show today's page again, from the store
await pg.evaluate(() => document.querySelector('[data-tab="pages"]').click());
await pg.evaluate(() => document.querySelector('[data-tab="journal"]').click());
await pg.waitForFunction(() => document.querySelector(".ProseMirror")?.textContent.includes("Scratch"));

const bar = () => pg.evaluate(() => {
  const b = document.querySelector(".format-bar");
  if (!b || b.hidden) return null;
  const r = b.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, buttons: [...b.querySelectorAll("button")].map((x) => ({ label: x.getAttribute("aria-label"), pressed: x.getAttribute("aria-pressed") === "true", x: x.getBoundingClientRect().x + x.offsetWidth / 2, y: x.getBoundingClientRect().y + x.offsetHeight / 2 })) };
});
// the text "Scratch 隨筆" on screen
const span = await pg.evaluate(() => {
  const view = window.view;
  let at = -1;
  view.state.doc.descendants((n, pos) => { if (at < 0 && n.isText && n.text.startsWith("Scratch")) at = pos; return at < 0; });
  const a = view.coordsAtPos(at), z = view.coordsAtPos(at + "Scratch 隨筆".length);
  return { at, x1: a.left + 1, x2: z.left - 1, y: (a.top + a.bottom) / 2, top: a.top };
});
const marksOn = () => pg.evaluate((at) => {
  const n = window.view.state.doc.nodeAt(at);
  return n ? n.marks.map((m) => m.type.name).sort().join(",") : "?";
}, span.at);

// select with the mouse
await pg.mouse.move(span.x1, span.y);
await pg.mouse.down();
await pg.mouse.move(span.x2, span.y, { steps: 8 });
await pg.mouse.up();
let b = await bar();
check(!!b && b.buttons.length === 5, "a mouse selection brings up the bar with five buttons");
check(!!b && b.bottom <= span.top && b.top >= 0, "over the selection, not on it");
check(!!b && b.buttons.every((x) => !x.pressed), "nothing pressed on plain text");
const sel = () => pg.evaluate(() => { const { from, to } = window.view.state.selection; return to - from; });
const width = await sel();

for (const [i, name] of [[0, "strong"], [1, "em"], [2, "underline"], [3, "strike"], [4, "highlight"]]) {
  b = await bar();
  await pg.mouse.click(b.buttons[i].x, b.buttons[i].y);
  b = await bar();
  check((await marksOn()).split(",").includes(name) && b?.buttons[i].pressed, `${b?.buttons[i].label ?? name}: on, shown pressed`);
  check((await sel()) === width, `  the selection stays`);
}
check((await marksOn()) === "em,highlight,strike,strong,underline", "all five together");
for (const i of [0, 1, 2, 3, 4]) { b = await bar(); await pg.mouse.click(b.buttons[i].x, b.buttons[i].y); }
check((await marksOn()) === "", "each one again takes it off");

// a caret: no bar
await pg.mouse.click(span.x1 + 20, span.y);
check(!(await bar()), "a caret shows no bar");

// inside a formula: no bar (the formula has its own hint)
await pg.evaluate(() => {
  const view = window.view;
  let inner = -1;
  view.state.doc.descendants((n, pos) => { if (inner < 0 && n.type.name === "math") inner = pos + 1; return inner < 0; });
  const TextSelection = view.state.selection.constructor; // the caret placed above is one
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, inner, inner + 1)));
  view.focus();
});
check(!(await bar()), "a selection inside a formula shows no bar");

// blurred: no bar
await pg.mouse.move(span.x1, span.y); await pg.mouse.down(); await pg.mouse.move(span.x2, span.y, { steps: 4 }); await pg.mouse.up();
check(!!(await bar()), "(selected again)");
await pg.evaluate(() => document.activeElement.blur());
await pg.waitForTimeout(50);
check(!(await bar()), "an editor without focus shows no bar");

if (process.env.SHOT) {
  await pg.mouse.move(span.x1, span.y); await pg.mouse.down(); await pg.mouse.move(span.x2, span.y, { steps: 4 }); await pg.mouse.up();
  b = await bar();
  await pg.mouse.click(b.buttons[4].x, b.buttons[4].y);
  await pg.screenshot({ path: process.env.SHOT, clip: { x: Math.max(0, span.x1 - 60), y: Math.max(0, span.top - 70), width: 480, height: 130 } });
}

await browser.close();
await server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
