// The task board in WebKit (the engine the app runs in): a card dragged by
// its handle to another column (dragspec.js). While it is held, the board
// shows the state it would be in — the card faded where it would land, the
// counts of that state — and a copy of the card follows the pointer; let go,
// the task has that status; Escape, or a drop back where it was, changes
// nothing. Starts its own Vite server; needs the WebKit build:
// npx playwright-core install webkit
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
    status: (text) => store.allTasks().find((t) => t.node.firstChild.textContent.trim() === text)?.task ?? null,
    editable: () => document.querySelectorAll(".board [contenteditable]").length,
  };
}, { day: DAY, lines: PAGE });
await pg.click('.tabs [data-tab="tasks"]');
await pg.click(".view-tabs .vtab:nth-child(2) button"); // the default board view: every task
await pg.waitForSelector(".board .task-item");

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
  await pause(30);
  const seen = { board: await H("board"), card: await H("card") };
  if (escape) await pg.keyboard.press("Escape");
  await pg.mouse.up();
  await pause(60);
  return seen;
}

{
  const b = await H("board");
  check(texts(b, "todo") === "late,early,loose" && texts(b, "doing") === "busy" && texts(b, "done") === "over", "the board starts as the page says", b);
  check(await H("editable") > 0, "the live cards are editable");
}

// into the middle of the doing column: it lands there, by its deadline, first
{
  const W = await H("where"), col = W.cols.doing;
  const seen = await drag("early", (col.left + col.right) / 2, (col.top + col.bottom) / 2);
  check(texts(seen.board, "doing") === "early,busy" && seen.board.doing.count === 2, "held over DOING, the board shows the card there, counted", seen.board);
  check(texts(seen.board, "todo") === "late,loose" && seen.board.todo.count === 2, "…and gone from TODO", seen.board);
  check(seen.board.doing.cards[0].held && !seen.board.doing.cards[1].held, "the card where it would land is faded", seen.board);
  check(seen.card?.text.includes("early"), "a copy of the card follows the pointer", seen.card);
  check(await H("status", "early") === "doing", "let go, the task is DOING");
  const after = await H("board");
  check(texts(after, "doing") === "early,busy" && !after.doing.cards.some((c) => c.held), "the board is redrawn in that state, nothing faded", after);
  check(!(await H("card")), "no card left on screen");
  check(await H("editable") > 0, "the redrawn cards are editable");
}

// pointing at the far bottom of DONE, under every card: still DONE
{
  const W = await H("where"), col = W.cols.done;
  await drag("loose", col.right - 20, col.bottom - 10);
  check(await H("status", "loose") === "done", "dropped below the last card of DONE, the task is DONE");
  check(texts(await H("board"), "done") === "loose,over", "…listed where it sorts", await H("board"));
}

// Escape: nothing changes, the live board is back
{
  const W = await H("where"), col = W.cols.todo;
  const seen = await drag("busy", (col.left + col.right) / 2, W.cards.late.top + 4, { escape: true });
  check(texts(seen.board, "todo") === "late,busy" && texts(seen.board, "doing") === "early", "held over TODO, shown there", seen.board);
  check(await H("status", "busy") === "doing", "Escape: the task keeps its status");
  const after = await H("board");
  check(texts(after, "doing") === "early,busy" && texts(after, "todo") === "late" && !after.doing.cards.some((c) => c.held) && !(await H("card")), "…and the board is as it was", after);
  check(await H("editable") > 0, "…still editable");
}

// back where it came from: nothing changes
{
  const W = await H("where"), c = W.cards.busy;
  const seen = await drag("busy", c.hx + 10, c.hy + 30);
  const busy = (b) => b.doing.cards.find((c) => c.text === "busy");
  check(busy(seen.board)?.held, "held near its own place, it is faded there", seen.board);
  check(await H("status", "busy") === "doing" && !busy(await H("board")).held, "dropped where it was: unchanged, not faded");
}

// a click on the handle does nothing
{
  const c = (await H("where")).cards.busy;
  await pg.mouse.click(c.hx, c.hy);
  await pause(40);
  check(await H("status", "busy") === "doing" && !(await H("card")), "a click on the handle changes nothing");
}

// a long DONE column, where the card would sort to the very bottom: pointed
// at the top of the column it still goes to DONE (the column is the target,
// not the spot the card would land at)
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
  const W = await H("where"), col = W.cols.done;
  const seen = await drag("late", col.left + 40, col.top + 30);
  const at = seen.board.done.cards.findIndex((c) => c.text === "late");
  check(at === 30 && seen.board.done.cards[at].held, "held at the top of a long DONE column, the card is shown at its place far down (after every old task)", seen.board);
  check(await H("status", "late") === "done", "…and let go there, the task is DONE");
}

console.log(`\n${fails.length} failures`);
for (const x of fails.slice(0, 20)) console.log("  " + JSON.stringify(x));
for (const e of new Set(pageErrors)) console.log(`page error: ${e}`);
await ctx.close();
await browser.close();
await server.close();
if (fails.length || pageErrors.length) process.exitCode = 1;
else console.log("all passed");
