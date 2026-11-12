// The task board in WebKit (the engine the app runs in): a card dragged by
// its handle to a gap in a column (dragspec.js). While it is held, a copy of
// it follows the pointer, the cards make room at the gap it would go to and
// a faded copy of it sits there (all by transform; the board is not laid
// out again); let go, the task
// has that status and the column that order, which the view keeps; Escape,
// or a drop back where it was, changes nothing. Starts its own Vite server;
// needs the WebKit build: npx playwright-core install webkit
//
//   npm run test:ui
import { createServer } from "vite";
import { webkit } from "playwright-core";

const DAY = "2025-05-01";
// three todo, one doing, one done; deadlines put "late" before "early" in a column
const PAGE = ["- TODO early DEADLINE: <2025-05-09>", "- TODO late DEADLINE: <2025-05-02>", "- TODO loose", "- DOING busy", "- DONE over"];

const server = await createServer({ logLevel: "error", server: { port: 5198, hmr: false, watch: null } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await webkit.launch();
const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
const pg = await ctx.newPage();
const pageErrors = [];
pg.on("pageerror", (e) => pageErrors.push(String(e)));
await pg.goto(url);
await pg.waitForFunction(() => window.view);
await pg.evaluate(async ({ day, lines }) => {
  const store = await import("/src/store.js");
  const IO = await import("/src/outline-io.js");
  store.savePage(day, IO.parseOutline(lines.join("\n")));
  store.flush();
  window.__h = {
    // the board as drawn: each column's cards (text, faded?) and count
    board: () => Object.fromEntries([...document.querySelectorAll(".board .column")].map((col) => [
      col.className.replace(/.*col-/, ""),
      { count: +col.querySelector(".count").textContent, cards: [...col.querySelectorAll(".task-item")].map((c) => ({ text: c.querySelector(".pm-line").textContent.trim(), held: c.classList.contains("drag-held") })) },
    ])),
    // where things are: each card's handle and box by text, each column's box
    where: () => ({
      cards: Object.fromEntries([...document.querySelectorAll(".board .task-item")].map((c) => {
        const h = c.querySelector(".drag").getBoundingClientRect(), b = c.getBoundingClientRect();
        return [c.querySelector(".pm-line").textContent.trim(), { hx: h.left + h.width / 2, hy: h.top + h.height / 2, top: b.top, left: b.left, height: b.height }];
      })),
      cols: Object.fromEntries([...document.querySelectorAll(".board .column")].map((col) => { const b = col.getBoundingClientRect(); return [col.className.replace(/.*col-/, ""), { left: b.left, right: b.right, top: b.top, bottom: b.bottom }]; })),
    }),
    card: () => { const c = document.querySelector(".drag-card"); return c ? { text: c.textContent.trim(), ...c.getBoundingClientRect().toJSON() } : null; },
    // the faded copy at the gap: the held card as drawn (transformed)
    ghost: () => { const g = document.querySelector(".board .drag-held"); return g ? g.getBoundingClientRect().toJSON() : null; },
    moved: () => [...document.querySelectorAll(".board .task-item")].filter((c) => c.style.transform).length,
    status: (text) => store.allTasks().find((t) => t.node.firstChild.textContent.trim() === text)?.task ?? null,
    editable: () => document.querySelectorAll(".board [contenteditable]").length,
  };
}, { day: DAY, lines: PAGE });
await pg.click('.tabs [data-tab="tasks"]');
await pg.click(".view-tabs .vtab:nth-child(2) button"); // the default board view: every task
// cards drawn with content-visibility: auto take a frame before what is in
// them can be hit, so the board is given a moment after each render
const settle = () => pg.waitForTimeout(100);
await pg.waitForSelector(".board .task-item");
await settle();

const H = (fn, ...args) => pg.evaluate(([fn, args]) => window.__h[fn](...args), [fn, args]);
const pause = (ms) => pg.waitForTimeout(ms);
const fails = [];
const check = (ok, what, detail) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push({ what, ...detail }); };
const texts = (b, col) => b[col].cards.map((c) => c.text).join();

// Press the handle of `text`, move to (x, y) and look at what is drawn; then
// let go, or press Escape first.
async function drag(text, x, y, { escape = false } = {}) {
  const c = (await H("where")).cards[text];
  await pg.mouse.move(c.hx, c.hy);
  await pg.mouse.down();
  await pg.mouse.move(c.hx + 6, c.hy + 6, { steps: 2 });
  await pg.mouse.move(x, y, { steps: 5 });
  await pause(250); // the cards' move is a transition
  const seen = { board: await H("board"), card: await H("card"), ghost: await H("ghost"), moved: await H("moved") };
  if (escape) await pg.keyboard.press("Escape");
  await pg.mouse.up();
  await settle();
  return seen;
}

const inCol = (g, col) => g && g.left >= col.left - 1 && g.right <= col.right + 1;
const near = (a, b) => Math.abs(a - b) <= 2;

{
  const b = await H("board");
  check(texts(b, "todo") === "late,early,loose" && texts(b, "doing") === "busy" && texts(b, "done") === "over", "the board starts as the page says, each column by deadline", b);
  check(await H("editable") > 0, "the live cards are editable");
}

// within a column: the last TODO card to the top
{
  const W = await H("where");
  const seen = await drag("loose", W.cards.late.hx, W.cards.late.top + 4);
  check(inCol(seen.ghost, W.cols.todo) && near(seen.ghost.top, W.cards.late.top), "held above the first card, its faded copy sits where that card was", seen.ghost);
  check(seen.moved === 3 && texts(seen.board, "todo") === "late,early,loose", "…the cards above moved down to make room, the board not laid out again", seen);
  check(texts(await H("board"), "todo") === "loose,late,early", "let go, the column has that order");
  await pg.click('.tabs [data-tab="journal"]');
  await pg.click('.tabs [data-tab="tasks"]');
  await pg.waitForSelector(".board .task-item");
  await settle();
  check(texts(await H("board"), "todo") === "loose,late,early", "…and still after the view is drawn again");
}

// into the middle of the DOING column: below its one card
{
  const W = await H("where"), col = W.cols.doing;
  const seen = await drag("early", (col.left + col.right) / 2, (col.top + col.bottom) / 2);
  check(inCol(seen.ghost, col) && near(seen.ghost.top, W.cards.busy.top + W.cards.busy.height + 8), "held over DOING below its card, its faded copy sits under that card", seen.ghost);
  check(seen.card?.text.includes("early") && seen.board.todo.cards[2].held, "a copy of the card follows the pointer, the held card is the faded one", seen);
  check(await H("status", "early") === "doing", "let go, the task is DOING");
  const after = await H("board");
  check(texts(after, "doing") === "busy,early" && texts(after, "todo") === "loose,late" && after.doing.count === 2 && !after.doing.cards.some((c) => c.held), "the board is redrawn in that state, counted, nothing faded", after);
  check(!(await H("card")) && !(await H("ghost")) && (await H("moved")) === 0, "no copy, ghost or moved card left on screen");
  check(await H("editable") > 0, "the redrawn cards are editable");
}

// pointing at the far bottom of DONE, under every card: last there
{
  const W = await H("where"), col = W.cols.done;
  await drag("loose", col.right - 20, col.bottom - 10);
  check(await H("status", "loose") === "done", "dropped below the last card of DONE, the task is DONE");
  check(texts(await H("board"), "done") === "over,loose", "…listed last", await H("board"));
}

// Escape: nothing changes
{
  const W = await H("where");
  const seen = await drag("busy", W.cards.late.hx, W.cards.late.top + 4, { escape: true });
  check(inCol(seen.ghost, W.cols.todo) && near(seen.ghost.top, W.cards.late.top), "held over TODO above its card, its faded copy sits there", seen.ghost);
  check(await H("status", "busy") === "doing", "Escape: the task keeps its status");
  const after = await H("board");
  check(texts(after, "doing") === "busy,early" && texts(after, "todo") === "late" && !after.doing.cards.some((c) => c.held) && !(await H("card")) && (await H("moved")) === 0, "…and the board is as it was, every card back in place", after);
  check(await H("editable") > 0, "…still editable");
}

// back where it came from: no line, nothing changes
{
  const W = await H("where"), c = W.cards.busy;
  const seen = await drag("busy", c.hx + 10, c.hy + 10);
  const busy = (b) => b.doing.cards.find((c) => c.text === "busy");
  check(busy(seen.board)?.held && seen.moved === 0, "held near its own place: faded where it is, nothing moved", seen);
  check(await H("status", "busy") === "doing" && texts(await H("board"), "doing") === "busy,early" && !busy(await H("board")).held, "dropped where it was: unchanged, not faded");
}

// a click on the handle does nothing
{
  const c = (await H("where")).cards.busy;
  await pg.mouse.click(c.hx, c.hy);
  await pause(40);
  check(await H("status", "busy") === "doing" && !(await H("card")), "a click on the handle changes nothing");
}

// a long DONE column: pointed at its top, the card goes first there
{
  await pg.evaluate(async ({ day }) => {
    const store = await import("/src/store.js");
    const IO = await import("/src/outline-io.js");
    store.savePage(day, IO.parseOutline(Array.from({ length: 30 }, (_, i) => `- DONE old ${i} DEADLINE: <2024-01-${String(i + 1).padStart(2, "0")}>`).join("\n")));
    store.flush();
  }, { day: "2025-04-01" });
  await pg.click('.tabs [data-tab="journal"]');
  await pg.click('.tabs [data-tab="tasks"]');
  await pg.waitForSelector(".board .task-item");
  await settle();
  const W = await H("where"), col = W.cols.done, first = W.cards[(await H("board")).done.cards[0].text];
  const seen = await drag("late", col.left + 40, col.top + 30);
  check(inCol(seen.ghost, col) && near(seen.ghost.top, first.top), "held at the top of a long DONE column, its faded copy sits where its first card was", { ghost: seen.ghost, col, first });
  check(await H("status", "late") === "done" && (await H("board")).done.cards[0].text === "late", "…and let go there, the task is DONE, first in the column");
}

console.log(`\n${fails.length} failures`);
for (const x of fails.slice(0, 20)) console.log("  " + JSON.stringify(x));
for (const e of new Set(pageErrors)) console.log(`page error: ${e}`);
await ctx.close();
await browser.close();
await server.close();
if (fails.length || pageErrors.length) process.exitCode = 1;
else console.log("all passed");
