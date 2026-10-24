// Search across all notes (search.js, searchbox.js) in WebKit: a small
// notebook among a few thousand filler blocks, then every kind of query
// (words in any case, a tag as typed and as tag:, a link, a formula by its
// LaTeX and by its plain content, a page or journal day by its title,
// negation, task filters) checked for exactly the blocks it should find,
// with the matches marked; then the keyboard: ⌘K and the sidebar button
// open it, ↑ ↓ reach every result of a query in turn and ↵ opens its page
// at that block (unfolded, on screen, marked, caret in it), Esc closes, and
// an edit made just now is found. Starts its own Vite server.
//
//   npm run test:ui
import { createServer } from "vite";
import { webkit } from "playwright-core";

const NOTES = {
  拓樸: [
    "- 拓樸空間的定義",
    "  - Hausdorff 空間：任兩點可分離",
    ...Array.from({ length: 80 }, (_, k) => `- 補充 ${k}`), // pushes what follows off screen
    "- compact 空間",
  ],
  分析: [
    "- 數列 $\\frac{1}{n}$ 收斂到 0 #拓樸",
    "- 級數 $\\sum_{n=1}^{\\infty} \\frac{1}{n^2}$",
    "- $\\alpha + \\beta$ 的界",
    "- 圓 $x^2+y^2=1$",
  ],
  "2025-03-14": [
    "- 讀書會",
    "  - 討論 Hausdorff 與 compact #拓樸", // folded
    "    - 細節：每個 compact Hausdorff 空間都是 normal",
    "- 待辦 [[分析]] 習題",
  ],
  "2025-03-15": ["- TODO 寫 compact 的筆記 DEADLINE: <2025-03-20>"],
};
const FOLDED = "討論 Hausdorff 與 compact #拓樸";
// filler: 120 journal days of 25 blocks, none matching any query below
const FILLER = { days: 120, blocks: 25 };

// [query, { page: [texts of the blocks found, in order] }, pages found by title]
const CASES = [
  ["hausdorff", { 拓樸: ["Hausdorff 空間：任兩點可分離"], "2025-03-14": [FOLDED, "細節：每個 compact Hausdorff 空間都是 normal"] }],
  ["HAUSDORFF", { 拓樸: ["Hausdorff 空間：任兩點可分離"], "2025-03-14": [FOLDED, "細節：每個 compact Hausdorff 空間都是 normal"] }],
  ["#拓樸", { 分析: ["數列 \\frac{1}{n} 收斂到 0 #拓樸"], "2025-03-14": [FOLDED] }],
  ["tag:拓樸", { 分析: ["數列 \\frac{1}{n} 收斂到 0 #拓樸"], "2025-03-14": [FOLDED] }],
  ["link:分析", { "2025-03-14": ["待辦 分析 習題"] }],
  ["\\frac{1}{n}", { 分析: ["數列 \\frac{1}{n} 收斂到 0 #拓樸"] }],
  ["\\frac", { 分析: ["數列 \\frac{1}{n} 收斂到 0 #拓樸", "級數 \\sum_{n=1}^{\\infty}\\frac{1}{n^2}"] }],
  ["\\alpha+\\beta", { 分析: ["\\alpha+\\beta 的界"] }],
  ["x^2+y^2", { 分析: ["圓 x^2+y^2=1"] }],
  ["x2+y2", { 分析: ["圓 x^2+y^2=1"] }], // a formula's plain content
  ["compact -hausdorff", { 拓樸: ["compact 空間"], "2025-03-15": ["寫 compact 的筆記"] }],
  ["compact 空間", { 拓樸: ["compact 空間"], "2025-03-14": ["細節：每個 compact Hausdorff 空間都是 normal"] }],
  ["status:todo compact", { "2025-03-15": ["寫 compact 的筆記"] }],
  ["has:deadline", { "2025-03-15": ["寫 compact 的筆記"] }],
  ["分析", { 分析: [], "2025-03-14": ["待辦 分析 習題"] }, ["分析"]],
  ["2025-03-15", { "2025-03-15": [] }, ["2025-03-15"]],
  ["-hausdorff", {}],
  ["沒有這個字", {}],
];

const server = await createServer({ logLevel: "error", server: { port: 5195, hmr: false, watch: null } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await webkit.launch();
const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
const pg = await ctx.newPage();
const fails = [];
const fail = (kind, detail) => fails.push({ kind, ...detail });
pg.on("pageerror", (e) => fail("page error", { error: String(e) }));
await pg.goto(url);
await pg.waitForFunction(() => window.view);

// the notebook, written through the store the app uses; titles -> page ids
const ids = await pg.evaluate(async ({ NOTES, FOLDED, FILLER }) => {
  const store = await import("/src/store.js");
  const IO = await import("/src/outline-io.js");
  const { schema } = await import("/src/schema.js");
  const ids = {};
  for (const name of Object.keys(NOTES)) ids[name] = store.isDate(name) ? name : store.createPage(name);
  for (const [name, lines] of Object.entries(NOTES)) {
    const json = IO.parseOutline(lines.join("\n")).toJSON();
    const fold = (b) => { if (b.content[0].content?.map((n) => n.text ?? "").join("").startsWith(FOLDED.split(" #")[0])) b.attrs.folded = true; b.content.slice(1).forEach(fold); };
    json.content.forEach(fold);
    store.savePage(ids[name], schema.nodeFromJSON(json));
  }
  for (let d = 0; d < FILLER.days; d++) {
    const day = new Date(Date.UTC(2024, 0, 1 + d)).toISOString().slice(0, 10);
    store.savePage(day, IO.parseOutline(Array.from({ length: FILLER.blocks }, (_, k) => `- 日記 ${d}-${k} 內容 $y_{${k}}$`).join("\n")));
  }
  return ids;
}, { NOTES, FOLDED, FILLER });
const pageId = (name) => ids[name] ?? name;
const pause = (ms) => pg.waitForTimeout(ms);

// what the open search box shows
const shown = () => pg.evaluate(() => {
  const box = document.querySelector(".search-backdrop");
  if (!box) return null;
  return {
    groups: [...box.querySelectorAll(".search-group")].map((g) => ({
      page: g.dataset.page,
      titleHit: !g.querySelector(".search-page").classList.contains("plain"),
      hits: [...g.querySelectorAll(".search-hit")].map((h) => ({ id: h.dataset.block, text: h.textContent, marks: [...h.querySelectorAll("mark")].map((m) => m.textContent) })),
    })),
    items: [...box.querySelectorAll(".search-page:not(.plain), .search-hit")].map((el) => el.textContent),
    active: box.querySelector(".active")?.textContent ?? null,
    focused: document.activeElement === box.querySelector("input"),
  };
});
const openBox = async () => { await pg.keyboard.press("ControlOrMeta+k"); await pause(50); };
const query = async (q) => {
  await pg.fill(".search-input", q); // fires input
  await pause(30);
};

// ---------- queries ----------

await openBox();
if (!(await shown())?.focused) fail("open", { what: "⌘K did not open the box with its input focused" });
for (const [q, want, titles = []] of CASES) {
  await query(q);
  const got = await shown();
  const gotMap = Object.fromEntries(got.groups.map((g) => [g.page, g.hits.map((h) => h.text)]));
  const wantMap = Object.fromEntries(Object.entries(want).map(([k, v]) => [pageId(k), v]));
  const norm = (m) => JSON.stringify(Object.keys(m).sort().map((k) => [k, m[k]]));
  if (norm(gotMap) !== norm(wantMap)) fail("results", { q, want: wantMap, got: gotMap });
  const titleHits = got.groups.filter((g) => g.titleHit).map((g) => g.page).sort();
  if (JSON.stringify(titleHits) !== JSON.stringify(titles.map(pageId).sort())) fail("title hits", { q, want: titles, got: titleHits });
  // every plain word is marked in every block found (tag:/link: by the page's name)
  const words = q.split(/\s+/).filter((w) => w && !w.startsWith("-") && !/^(status|has):/.test(w)).map((w) => w.replace(/^(tag|link):/, "").toLowerCase());
  for (const g of got.groups) for (const h of g.hits) {
    const marked = h.marks.map((m) => m.toLowerCase());
    if (!words.every((w) => marked.some((m) => m.includes(w) || w.includes(m))) && !(q === "x2+y2")) fail("marks", { q, hit: h.text, marks: h.marks });
  }
  console.log(`search: ${q}`);
}

// speed: one keystroke's worth (query and drawing) over every block
const ms = await pg.evaluate(() => {
  const input = document.querySelector(".search-input");
  const times = [];
  for (const q of ["內容", "日記 5", "compact", "y_3", "-x 日記"]) {
    const t0 = performance.now();
    input.value = q;
    input.dispatchEvent(new Event("input"));
    times.push(performance.now() - t0);
  }
  return Math.max(...times);
});
console.log(`search: slowest query over ${FILLER.days * FILLER.blocks + 100} blocks ${ms.toFixed(1)} ms`);
if (ms > 150) fail("speed", { ms });

// ---------- keyboard: every result of a query, in turn ----------

// where the app is now: the page shown, the caret's block, whether it is on
// screen, marked, and with no folded block above it
const where = () => pg.evaluate(() => {
  const v = window.view, $h = v.state.selection.$head;
  let d = $h.depth;
  while (d > 0 && $h.node(d).type.name !== "block") d--;
  const block = $h.node(d);
  const folded = Array.from({ length: d - 1 }, (_, k) => $h.node(k + 1)).some((n) => n.attrs.folded);
  const el = v.nodeDOM($h.before(d));
  const r = el.querySelector(":scope > .pm-body > .pm-line").getBoundingClientRect();
  return {
    page: document.querySelector(".page[data-date]")?.dataset.date ?? document.querySelector(".page-title")?.value,
    block: block.attrs.id, text: block.firstChild.textContent,
    onScreen: r.top >= 0 && r.bottom <= innerHeight && r.height > 0,
    flash: el.classList.contains("pm-flash"),
    folded, focused: v.hasFocus(),
    open: !!document.querySelector(".search-backdrop"),
  };
});

for (const q of ["compact", "hausdorff", "#拓樸", "\\frac", "分析"]) {
  await openBox();
  await query(q);
  const first = await shown();
  const n = first.items.length;
  for (let k = 0; k < n; k++) {
    if (k) { await openBox(); await query(q); }
    // half the time down from the top, else up from the top (wrapping round)
    const up = k % 2 === 1;
    const steps = up ? n - k : k;
    for (let s = 0; s < steps; s++) await pg.keyboard.press(up ? "ArrowUp" : "ArrowDown");
    const before = await shown();
    if (before.active !== first.items[k]) { fail("arrows", { q, k, want: first.items[k], got: before.active }); continue; }
    // the item: a page (title) or a block of a page
    const g = before.groups.find((g) => g.hits.some((h) => h.text === before.active)) ?? before.groups.find((g) => g.titleHit && !g.hits.some((h) => h.text === before.active));
    const hit = g.hits.find((h) => h.text === before.active);
    await pg.keyboard.press("Enter");
    await pause(120);
    const at = await where();
    const page = Object.keys(ids).find((name) => ids[name] === g.page) ?? g.page;
    if (at.open) fail("enter", { q, k, what: "the box stayed open" });
    if (at.page !== page) fail("enter", { q, k, want: page, got: at.page });
    if (hit) {
      if (at.block !== hit.id) fail("enter", { q, k, want: hit.text, got: at.text });
      if (!at.onScreen) fail("scroll", { q, k, text: hit.text });
      if (!at.flash) fail("flash", { q, k, text: hit.text });
      if (at.folded) fail("unfold", { q, k, text: hit.text });
      if (!at.focused) fail("focus", { q, k, text: hit.text });
    }
    console.log(`search: ${q} → ${k}: ${before.active}`);
  }
}
// the mark fades
await pause(1800);
if ((await where()).flash) fail("flash", { what: "still marked after 1.8s" });

// ---------- Esc, the sidebar button, and what was just typed ----------

const beforeEsc = await where();
await openBox();
await pg.keyboard.press("Escape");
await pause(50);
const afterEsc = await where();
if (afterEsc.open) fail("escape", { what: "still open" });
if (!afterEsc.focused || afterEsc.block !== beforeEsc.block) fail("escape", { what: "focus not back in the editor where it was" });

await pg.click(".side-search");
await pause(50);
if (!(await shown())?.focused) fail("button", { what: "the sidebar button did not open the box" });
await pg.keyboard.press("Escape");

// (the button took the focus from the editor) a word at the end of the block
await pg.evaluate(() => window.view.focus());
await pg.keyboard.press("End");
await pg.keyboard.type(" zeta函數");
await openBox();
await query("zeta函數");
const fresh = await shown();
if (!fresh.groups.some((g) => g.hits.some((h) => h.id === afterEsc.block))) fail("fresh", { what: "an edit just made was not found", got: fresh.groups });
await pg.keyboard.press("Escape");

await browser.close();
await server.close();
for (const f of fails) console.log(`\nsearch: ${JSON.stringify(f)}`);
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exitCode = fails.length ? 1 : 0;
