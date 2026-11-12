// The agenda in WebKit (the engine the app runs in): a task dragged by its
// handle to another day moves its block, children and all, to that day's
// journal page (dragspec.js). While it is held, the week shows the task
// under the day it would land on, faded; let go, the block is there; Escape,
// or a drop back where it was, moves nothing. A task from a named page is
// listed on its deadline and can be dragged to a day too. Starts its own
// Vite server; needs the WebKit build: npx playwright-core install webkit
//
//   npm run test:ui
import { createServer } from "vite";
import { webkit } from "playwright-core";

const server = await createServer({ logLevel: "error", server: { port: 5195, hmr: false, watch: null } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await webkit.launch();
const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
const pg = await ctx.newPage();
const pageErrors = [];
pg.on("pageerror", (e) => pageErrors.push(String(e)));
await pg.goto(url);
await pg.waitForFunction(() => window.view);
// this week (the agenda opens on it): alpha and beta (with a child) on
// Monday, gamma on a named page with its deadline on Wednesday
const W = await pg.evaluate(async () => {
  const store = await import("/src/store.js");
  const IO = await import("/src/outline-io.js");
  const D = await import("/src/dates.js");
  const start = D.weekStart(D.today());
  const days = Array.from({ length: 7 }, (_, i) => D.addDays(start, i));
  const [MON, TUE, WED] = days;
  store.savePage(MON, IO.parseOutline("- TODO alpha\n- TODO beta\n  - a note under beta"));
  const notes = store.createPage("notes");
  store.savePage(notes, IO.parseOutline(`- TODO gamma DEADLINE: <${WED}>`));
  store.flush();
  const byText = (text) => store.allTasks().find((t) => t.node.firstChild.textContent.trim() === text);
  window.__h = {
    // the week as drawn: each day's cards (text, faded?)
    week: () => Object.fromEntries([...document.querySelectorAll(".agenda .day")].map((d) => [d.dataset.day, [...d.querySelectorAll(".task-item")].map((c) => ({ text: c.querySelector(".pm-line").textContent.trim(), held: c.classList.contains("drag-held") }))])),
    // where things are: each day's box, each card's handle (the first card of that text)
    where: () => ({
      days: Object.fromEntries([...document.querySelectorAll(".agenda .day")].map((d) => { const b = d.getBoundingClientRect(); return [d.dataset.day, { left: b.left, right: b.right, top: b.top, bottom: b.bottom }]; })),
      cards: Object.fromEntries([...document.querySelectorAll(".agenda .task-item")].reverse().map((c) => { const h = c.querySelector(".drag").getBoundingClientRect(); return [c.querySelector(".pm-line").textContent.trim(), { hx: h.left + h.width / 2, hy: h.top + h.height / 2 }]; })),
    }),
    card: () => !!document.querySelector(".drag-card"),
    page: (text) => byText(text)?.page ?? null,
    children: (text) => byText(text).node.childCount - 1, // blocks under it
    exists: (page) => !!store.getPage(page),
    notes: () => notes,
  };
  return { days, MON, TUE, WED, notes };
});
await pg.click('.tabs [data-tab="agenda"]');
await pg.waitForSelector(".agenda .task-item");

const H = (fn, ...args) => pg.evaluate(([fn, args]) => window.__h[fn](...args), [fn, args]);
const pause = (ms) => pg.waitForTimeout(ms);
const fails = [];
const check = (ok, what, detail) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push({ what, ...detail }); };
const on = (week, day) => (week[day] ?? []).map((c) => c.text).join();

// Press the handle of `text` (its first card), move onto `day`'s heading
// (the week above it shrinks as the task leaves its day, so its section is
// not where it was) and look at what is drawn; then let go, or press Escape
// first.
async function drag(text, day, { escape = false, dx = 0, dy = 0 } = {}) {
  const w = await H("where"), c = w.cards[text], d = w.days[day];
  await pg.mouse.move(c.hx, c.hy);
  await pg.mouse.down();
  await pg.mouse.move(c.hx + 6, c.hy + 6, { steps: 2 });
  if (day) await pg.mouse.move(d.left + 40, d.top + 30, { steps: 5 });
  else await pg.mouse.move(c.hx + dx, c.hy + dy, { steps: 5 });
  await pause(30);
  const seen = { week: await H("week"), card: await H("card") };
  if (escape) await pg.keyboard.press("Escape");
  await pg.mouse.up();
  await pause(80);
  return seen;
}

{
  const w = await H("week");
  check(on(w, W.MON) === "alpha,beta" && on(w, W.WED) === "gamma", "the week starts as the pages say", w);
}

// alpha to Wednesday
{
  const seen = await drag("alpha", W.WED);
  check(on(seen.week, W.WED).includes("alpha") && !on(seen.week, W.MON).includes("alpha"), "held over Wednesday, alpha is shown there, not on Monday", seen.week);
  check(seen.week[W.WED].find((c) => c.text === "alpha")?.held && seen.card, "…faded, with a copy under the pointer", seen);
  check(await H("page", "alpha") === W.WED, "let go, alpha's block is on Wednesday's page");
  const w = await H("week");
  check(on(w, W.WED).includes("alpha") && on(w, W.MON) === "beta" && !Object.values(w).flat().some((c) => c.held) && !(await H("card")), "the week is redrawn, nothing faded or left over", w);
}

// beta, with its child, to Tuesday: Monday is then empty and gone
{
  await drag("beta", W.TUE);
  const page = await H("page", "beta"), kids = await H("children", "beta");
  check(page === W.TUE && kids === 1, "beta moves to Tuesday with the block under it", { page, kids, TUE: W.TUE });
  check(!(await H("exists", W.MON)), "Monday, emptied, is no longer a journal day");
}

// Escape: nothing moves
{
  const seen = await drag("alpha", W.MON, { escape: true });
  check(on(seen.week, W.MON) === "alpha", "held over Monday, shown there", seen.week);
  check(await H("page", "alpha") === W.WED && on(await H("week"), W.WED).includes("alpha"), "Escape: alpha stays on Wednesday");
}

// a short drag that ends where it began
{
  await drag("alpha", null, { dx: 8, dy: 10 });
  check(await H("page", "alpha") === W.WED, "dropped where it was: alpha stays");
}

// gamma, from a named page, listed on its deadline: a short drag keeps it
// there; dragged to Monday it moves, and is still listed as due on Wednesday
{
  await drag("gamma", null, { dx: 8, dy: 10 });
  check(await H("page", "gamma") === W.notes, "a short drag of a task from a named page leaves it on that page");
  const seen = await drag("gamma", W.MON);
  check(on(seen.week, W.MON) === "gamma" && on(seen.week, W.WED).includes("gamma"), "held over Monday, gamma is shown there and still on its deadline", seen.week);
  check(await H("page", "gamma") === W.MON, "let go, gamma's block is on Monday's page");
  const w = await H("week");
  check(on(w, W.MON) === "gamma" && on(w, W.WED).includes("gamma"), "…listed on Monday and, as due, on Wednesday", w);
}

console.log(`\n${fails.length} failures`);
for (const x of fails.slice(0, 20)) console.log("  " + JSON.stringify(x));
for (const e of new Set(pageErrors)) console.log(`page error: ${e}`);
await ctx.close();
await browser.close();
await server.close();
if (fails.length || pageErrors.length) process.exitCode = 1;
else console.log("all passed");
