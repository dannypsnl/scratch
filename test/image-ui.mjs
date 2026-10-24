// Image sizes in WebKit: a selected image shows a handle at its lower right;
// dragged, it sets the width the image is drawn at (kept in the outline text
// as ![alt|width](…), and read back from it), within the column; a double
// click on it goes back to the image's own size. Starts its own Vite server.
//
//   npm run test:ui
import { createServer } from "vite";
import { webkit } from "playwright-core";

const server = await createServer({ logLevel: "error", server: { port: 5186, hmr: false, watch: null } });
await server.listen();
const browser = await webkit.launch();
const pg = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };
pg.on("pageerror", (e) => check(false, `page error: ${e}`));
await pg.goto(server.resolvedUrls.local[0]);
await pg.waitForFunction(() => window.view);

// an image of 600 × 300, stored as the app stores a pasted one
const name = await pg.evaluate(async () => {
  const c = Object.assign(document.createElement("canvas"), { width: 600, height: 300 });
  const g = c.getContext("2d"); g.fillStyle = "#3a5a8c"; g.fillRect(0, 0, 600, 300);
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  return (await import("/src/images.js")).addImage(new File([blob], "x.png", { type: "image/png" }));
});
const load = (text) => pg.evaluate(async (text) => {
  const view = window.view, IO = await import("/src/outline-io.js");
  view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, IO.parseOutline(text).content));
  view.focus();
}, text);
const outline = () => pg.evaluate(async () => (await import("/src/outline-io.js")).serializeOutline(window.view.state.doc));
const box = (sel) => pg.evaluate((sel) => { const el = document.querySelector(sel); if (!el || !el.getClientRects().length) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, sel);

await load(`- before\n- ![a cat](images/${name})\n- after`);
await pg.waitForFunction(() => document.querySelector(".pm-image img")?.complete && document.querySelector(".pm-image img").naturalWidth > 0);
let img = await box(".pm-image img");
check(Math.round(img.w) === 600, `an image is drawn at its own size (${img?.w})`);
check(!(await box(".pm-image-handle")), "no handle while it is not selected");

await pg.mouse.click(img.x + img.w / 2, img.y + img.h / 2);
let h = await box(".pm-image-handle");
check(!!h, "selected, it shows the handle");

// drag the handle 300px to the left
await pg.mouse.move(h.x + h.w / 2, h.y + h.h / 2);
await pg.mouse.down();
await pg.mouse.move(h.x + h.w / 2 - 150, h.y + h.h / 2, { steps: 5 });
await pg.mouse.move(h.x + h.w / 2 - 300, h.y + h.h / 2, { steps: 5 });
await pg.mouse.up();
img = await box(".pm-image img");
check(Math.abs(img.w - 300) <= 1 && Math.abs(img.h - 150) <= 1, `dragged 300px in: drawn 300 × 150, its shape kept (${img.w} × ${img.h})`);
check(!!(await box(".pm-image-handle")), "resized, it stays selected, the handle there to go on");
check((await outline()).includes(`![a cat|300](images/${name})`), `the width is in the outline text (${(await outline()).split("\n")[1]})`);
await pg.keyboard.press("ControlOrMeta+z");
await pg.waitForTimeout(50);
check(!(await outline()).includes("|300"), "undo takes the width back");
await pg.keyboard.press("ControlOrMeta+Shift+z");
await pg.waitForTimeout(50);

// read back from the text
await load(`- ![a cat|200](images/${name})`);
await pg.waitForFunction(() => document.querySelector(".pm-image img")?.naturalWidth > 0);
img = await box(".pm-image img");
check(Math.abs(img.w - 200) <= 1, `![a cat|200](…) is drawn 200px wide (${img.w})`);

// wider than the column: no wider than the line
await pg.mouse.click(img.x + img.w / 2, img.y + img.h / 2);
h = await box(".pm-image-handle");
await pg.mouse.move(h.x + h.w / 2, h.y + h.h / 2);
await pg.mouse.down();
await pg.mouse.move(h.x + 3000, h.y + h.h / 2, { steps: 5 });
await pg.mouse.up();
const editor = await box(".ProseMirror");
img = await box(".pm-image img");
check(img.w > 600 && img.x + img.w <= editor.x + editor.w + 1, `dragged far out: larger, up to the editor's right edge (${img.x + img.w} ≤ ${editor.x + editor.w})`);

// a double click on the handle: its own size again
h = await box(".pm-image-handle");
await pg.mouse.dblclick(h.x + h.w / 2, h.y + h.h / 2);
img = await box(".pm-image img");
check(Math.round(img.w) === 600 && !(await outline()).includes("|"), `double click: back to its own size, no width in the text (${img.w})`);

await browser.close();
await server.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
