import { createServer } from "vite";
import { webkit } from "playwright-core";

const server = await createServer({ logLevel: "error", server: { port: 5188, hmr: false, watch: null } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await webkit.launch();
const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
const pg = await ctx.newPage();
const pageErrors = [];
pg.on("pageerror", (e) => pageErrors.push(String(e)));
await pg.goto(url);
await pg.waitForFunction(() => window.view);
const W = await pg.evaluate(async () => {
  const store = await import("/src/store.js");
  const IO = await import("/src/outline-io.js");
  const D = await import("/src/dates.js");
  const { BlockSelection } = await import("/src/blockselect.js");
  const TODAY = D.today();
  const start = D.weekStart(TODAY);
  const OTHER = start === TODAY ? D.addDays(TODAY, 1) : start;
  store.savePage(TODAY, IO.parseOutline("- alpha\n  - alpha child\n- beta\n- gamma\n- delta"));
  store.flush();
  const blocks = (n) => { const out = []; n.forEach((c) => { if (c.type.name === "block") out.push(c); }); return out; };
  const tree = (n) => blocks(n).map((b) => [b.firstChild.textContent, ...tree(b)].join(">"));
  const bulletOf = (text) => [...window.view.dom.querySelectorAll(".pm-block")].find((el) => el.querySelector(":scope > .pm-body > .pm-line").textContent === text)?.querySelector(":scope > .pm-bullet");
  const center = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  window.__h = {
    page: (day) => { const d = store.getPage(day); return d ? tree(d) : null; },
    shown: () => tree(window.view.state.doc),
    bullet: (text) => center(bulletOf(text)),
    day: (day) => center(document.querySelector(`.week [data-day="${day}"]`)),
    lit: () => [...document.querySelectorAll(".week .drop")].map((b) => b.dataset.day),
    rings: () => document.querySelectorAll(".block-slot").length,
    card: () => !!document.querySelector(".block-card"),
    button: () => { const b = document.querySelector(".move-day"); return b && !b.hidden ? center(b) : null; },
    calendar: () => !!document.querySelector(".calendar"),
    calDay: (day) => { const b = document.querySelector(`.calendar [data-day="${day}"]:not(.other)`); return b ? center(b) : null; },
    select: (a, b) => {
      const v = window.view;
      const at = (text) => { let p = null; v.state.doc.descendants((n, pos) => { if (p === null && n.type.name === "block" && n.firstChild.textContent === text) p = pos; return p === null; }); return p; };
      v.dispatch(v.state.tr.setSelection(BlockSelection.blocks(v.state.doc, at(a), at(b))));
    },
  };
  const next = new Date(TODAY.slice(0, 7) + "-01T00:00");
  next.setMonth(next.getMonth() + 2);
  return { TODAY, OTHER, FAR: next.toLocaleDateString("sv").slice(0, 8) + "15" };
});
await pg.click(".today-btn");
await pg.waitForFunction(() => window.view && document.querySelector(".week .selected"));

const H = (fn, ...args) => pg.evaluate(([fn, args]) => window.__h[fn](...args), [fn, args]);
const pause = (ms) => pg.waitForTimeout(ms);
const fails = [];
const check = (ok, what, detail) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) { fails.push({ what, ...detail }); console.log("     " + JSON.stringify(detail)); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function drag(text, day, { escape = false } = {}) {
  const b = await H("bullet", text), d = await H("day", day);
  await pg.mouse.move(b.x, b.y);
  await pg.mouse.down();
  await pg.mouse.move(b.x + 6, b.y + 6, { steps: 2 });
  await pg.mouse.move(d.x, d.y, { steps: 8 });
  await pause(30);
  const seen = { lit: await H("lit"), rings: await H("rings"), card: await H("card") };
  if (escape) await pg.keyboard.press("Escape");
  await pg.mouse.up();
  await pause(80);
  return seen;
}

{
  const seen = await drag("alpha", W.OTHER, { escape: true });
  check(same(seen.lit, [W.OTHER]) && seen.rings === 0 && seen.card, "held over another day in the week strip: that day is lit, no slot rings, the card follows", seen);
  const page = await H("page", W.TODAY);
  check(same(page, ["alpha>alpha child", "beta", "gamma", "delta"]) && !(await H("lit")).length, "Escape: nothing moves, nothing lit", { page });
}

{
  const seen = await drag("alpha", W.TODAY);
  check(!seen.lit.length, "over the day it is on, nothing is lit", seen);
  check(same(await H("page", W.TODAY), ["alpha>alpha child", "beta", "gamma", "delta"]), "…and letting go there moves nothing out of the day");
}

{
  await drag("alpha", W.OTHER);
  const here = await H("page", W.TODAY), there = await H("page", W.OTHER), shown = await H("shown");
  check(same(there, ["alpha>alpha child"]), "dropped on another day, alpha goes there with its child", { there });
  check(same(here, ["beta", "gamma", "delta"]) && same(shown, here), "…and leaves this day, on the page and in the editor", { here, shown });
  check(!(await H("lit")).length && !(await H("card")), "nothing is left lit or floating");
}

{
  await H("select", "beta", "gamma");
  await drag("gamma", W.OTHER);
  const here = await H("page", W.TODAY), there = await H("page", W.OTHER);
  check(same(there, ["alpha>alpha child", "beta", "gamma"]) && same(here, ["delta"]), "selected blocks dragged to a day go there together, in order", { here, there });
}

{
  const b = await H("bullet", "delta");
  await pg.mouse.move(b.x, b.y);
  await pause(50);
  const btn = await H("button");
  check(!!btn && btn.x < b.x, "hovering a bullet shows the move button beside it", { btn, b });
  await pg.mouse.move(btn.x, btn.y, { steps: 3 });
  await pause(350);
  check(!!(await H("button")), "…and it stays while the pointer is on it");
  await pg.mouse.click(btn.x, btn.y);
  await pause(50);
  check(await H("calendar"), "clicking it opens a calendar");
  let cell = await H("calDay", W.FAR);
  for (let i = 0; !cell && i < 3; i++) {
    await pg.click(".calendar .nm");
    cell = await H("calDay", W.FAR);
  }
  await pg.mouse.click(cell.x, cell.y);
  await pause(80);
  const here = await H("page", W.TODAY), there = await H("page", W.FAR), shown = await H("shown");
  check(same(there, ["delta"]) && here === null && same(shown, [""]), "picking a day weeks away moves the block there; the emptied day is no longer a journal day, its editor one empty block", { here, there, shown });
  check(!(await H("calendar")) && !(await H("button")), "the calendar and the button are gone");
}

{
  const b = await H("bullet", "");
  await pg.mouse.move(b.x, b.y);
  await pause(50);
  await pg.mouse.move(b.x + 200, b.y + 200, { steps: 3 });
  await pause(350);
  check(!(await H("button")), "the button goes away once the pointer leaves the bullet");
}

console.log(`\n${fails.length} failures`);
for (const x of fails.slice(0, 20)) console.log("  " + JSON.stringify(x));
for (const e of new Set(pageErrors)) console.log(`page error: ${e}`);
await ctx.close();
await browser.close();
await server.close();
if (fails.length || pageErrors.length) process.exitCode = 1;
else console.log("all passed");
