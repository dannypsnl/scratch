// The outline UI in WebKit (the engine the app runs in): a block dragged by
// its bullet to every slot in a small outline, blocks selected (with the
// mouse, with keys) and what is done to them, and every piece of a line cut
// and pasted into another, and the key for a new top-level block, each
// checked against what should happen. Starts its own Vite server; needs
// the WebKit build: npx playwright-core install webkit
//
//   npm run test:ui
import { createServer } from "vite";
import { webkit } from "playwright-core";

const OUTLINE = "- A\n  - A1\n  - A2\n- B\n  - B1\n    - B1a\n- C\n- D";
// deep, with blocks after each level and a formula deep down
const DEEP = "- R\n  - L1\n    - L2\n      - L3\n        - L4\n          - L5\n            - k\n          - F $a+b$\n        - L4b\n      - L3b\n    - L2b\n  - L1b\n- S";
// a line with marks, a formula and something that looks like a block ("- f")
const LINES = "- ab **cd** $x^2$ e - f\n- target line\n  - child\n- end";

const server = await createServer({ logLevel: "error", server: { port: 5197, hmr: false, watch: null } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await webkit.launch();
const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
const pg = await ctx.newPage();
const pageErrors = [];
pg.on("pageerror", (e) => pageErrors.push(String(e)));
await pg.goto(url);
await pg.waitForFunction(() => window.view);
await pg.evaluate(async () => {
  // the module instances the app itself uses (Vite adds a version query)
  const dep = (name) => performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes(`/deps/${name}.js`));
  const S = await import(dep("prosemirror-state"));
  const Hi = await import(dep("prosemirror-history"));
  const IO = await import("/src/outline-io.js");
  const v = window.view;
  const blocks = (n) => { const out = []; n.forEach((c) => { if (c.type.name === "block") out.push(c); }); return out; };
  const tree = (n) => blocks(n).map((b) => ({ name: b.firstChild.textContent, id: b.attrs.id, folded: b.attrs.folded, children: tree(b) }));
  // the i-th block in document order: [pos, node]
  const nth = (i) => { let k = 0, at = null; v.state.doc.descendants((n, p) => { if (n.type.name === "block" && k++ === i) at = [p, n]; return at === null; }); return at; };
  window.__h = {
    load: (text) => {
      v.focus();
      const doc = IO.parseOutline(text);
      const tr = v.state.tr.replaceWith(0, v.state.doc.content.size, doc.content).setMeta("addToHistory", false);
      v.dispatch(Hi.closeHistory(tr.setSelection(S.TextSelection.atEnd(tr.doc))));
    },
    tree: () => tree(v.state.doc),
    json: () => JSON.stringify(v.state.doc.toJSON()),
    check: () => { try { v.state.doc.check(); return true; } catch (e) { return String(e); } },
    close: () => v.dispatch(Hi.closeHistory(v.state.tr)),
    // geometry of every block on screen, by the text of its line
    rows: () => Object.fromEntries([...v.dom.querySelectorAll(".pm-block")].filter((el) => el.getClientRects().length).map((el) => {
      const bullet = el.querySelector(":scope > .pm-bullet").getBoundingClientRect();
      const body = el.querySelector(":scope > .pm-body");
      const box = el.getBoundingClientRect();
      const child = [...body.querySelectorAll(":scope > .pm-block")].find((c) => c.getClientRects().length);
      return [body.querySelector(":scope > .pm-line").textContent, {
        top: box.top, bottom: box.bottom, rowBottom: child ? child.getBoundingClientRect().top : box.bottom,
        left: bullet.left, cx: bullet.left + bullet.width / 2, cy: bullet.top + bullet.height / 2,
        bodyLeft: body.getBoundingClientRect().left, indent: bullet.width, children: !!child,
      }];
    })),
    drop: () => { const d = document.querySelector(".block-drop"); if (!d) return null; const r = d.getBoundingClientRect(); return { left: r.left, top: r.top }; },
    dragged: () => document.querySelectorAll(".pm-dragged").length,
    rings: () => [...document.querySelectorAll(".block-slot")].map((r) => { const b = r.getBoundingClientRect(); return { depth: +r.dataset.depth, picked: r.classList.contains("picked"), x: b.left + b.width / 2, y: b.top + b.height / 2 }; }),
    card: () => !!document.querySelector(".block-card"),
    // the selected blocks' names, in order ([] when no blocks are selected)
    selected: () => v.state.selection.rows?.map((p) => v.state.doc.nodeAt(p).firstChild.textContent) ?? [],
    // where each line's text is
    lines: () => Object.fromEntries([...v.dom.querySelectorAll(".pm-line")].map((l) => { const r = l.getBoundingClientRect(); return [l.textContent, { left: r.left, mid: r.top + r.height / 2 }]; })),
    // positions directly in the i-th block's line, and that line as text
    linePositions: (i) => { const [p, b] = nth(i); return Array.from({ length: b.firstChild.content.size + 1 }, (_, k) => p + 2 + k).filter((x) => v.state.doc.resolve(x).parent === b.firstChild); },
    line: (i) => IO.serializeInline(nth(i)[1].firstChild.content),
    setRange: (a, b) => { v.focus(); v.dispatch(v.state.tr.setSelection(S.TextSelection.create(v.state.doc, a, b))); },
    // what cutting [a, b) out of the i-th line should leave, the piece cut,
    // and the j-th line with that piece put in at offset o
    expectCut: (i, a, b, j, o) => {
      const [p, blk] = nth(i), line = blk.firstChild.content, s = p + 2;
      const piece = line.cut(a - s, b - s);
      const target = (j === i ? line.cut(0, a - s).append(line.cut(b - s)) : nth(j)[1].firstChild.content);
      return {
        left: IO.serializeInline(line.cut(0, a - s).append(line.cut(b - s))),
        pasted: IO.serializeInline(target.cut(0, o).append(piece).append(target.cut(o))),
      };
    },
    // another device's edit: a block in at the top, and a deadline on the
    // block named `name` (which redraws it)
    remote: (name) => {
      const tr = v.state.tr.insert(0, IO.parseOutline("- Z").content);
      tr.doc.descendants((n, p) => { if (n.type.name === "block" && n.firstChild.textContent === name) tr.setNodeMarkup(p, null, { ...n.attrs, deadline: "2030-01-01" }); });
      v.dispatch(tr.setMeta("addToHistory", false));
    },
    // the caret o characters into the line of the block named `name` (in its
    // formula when inMath), and where the caret is: its block's name and depth
    caretAt: (name, o, inMath = false) => {
      let at = null;
      v.state.doc.descendants((n, p) => { if (at === null && n.type.name === "block" && n.firstChild.textContent === name) at = p; return at === null; });
      let x = at + 2 + o;
      if (inMath) v.state.doc.nodeAt(at + 1).forEach((c, off) => { if (c.type.name === "math") x = at + 2 + off + 1; });
      window.__h.setRange(x, x);
    },
    head: () => {
      const $h = v.state.selection.$head;
      let d = $h.depth; while (v.state.doc.resolve($h.pos).node(d).type.name !== "block") d--;
      return { name: $h.node(d).firstChild.textContent, depth: d };
    },
    caretIn: (i, o) => { const [p] = nth(i); window.__h.setRange(p + 2 + o, p + 2 + o); },
  };
});
const H = (fn, ...args) => pg.evaluate(([fn, args]) => window.__h[fn](...args), [fn, args]);
const pause = (ms) => pg.waitForTimeout(ms);
const fails = [];
const fail = (kind, detail) => fails.push({ kind, ...detail });

// "A(A1,A2),B" for a tree of { name, children }
const shape = (t) => t.map((n) => n.name + (n.children.length ? `(${shape(n.children)})` : "")).join(",");
const ids = (t) => { const m = []; const walk = (t) => t.forEach((n) => { m.push(n.name + "=" + n.id); walk(n.children); }); walk(t); return m.sort().join(" "); };
const find = (t, name) => { for (const n of t) { if (n.name === name) return n; const c = find(n.children, name); if (c) return c; } return null; };

// ---- dragging a bullet
//
// The model (drag.js): with x's subtree lifted out, every gap between the
// rows left is a place to drop it, at each depth from the next row's to one
// deeper than the row above's. Dropped, the rows are the rows left with x's
// put in at the gap, x at that depth and its children under it.

// visible rows in order: { name, depth }
const flat = (t, d = 0, out = []) => { for (const n of t) { out.push({ name: n.name, depth: d }); if (!n.folded) flat(n.children, d + 1, out); } return out; };
// rows (each depth at most one more than the row before) back into a shape
function unflat(rows) {
  const root = { children: [] }, stack = [root];
  for (const r of rows) { const n = { name: r.name, children: [] }; stack.length = r.depth + 1; stack[r.depth].children.push(n); stack.push(n); }
  return shape(root.children);
}
// x held: its rows, the rows left, and the gaps among them
function slotsOf(tree, x) {
  const all = flat(tree), i = all.findIndex((r) => r.name === x);
  let j = i + 1;
  while (j < all.length && all[j].depth > all[i].depth) j++;
  const held = all.slice(i, j), rest = [...all.slice(0, i), ...all.slice(j)];
  const gaps = [];
  for (let g = 0; g <= rest.length; g++) {
    const above = rest[g - 1] ?? null, below = rest[g] ?? null;
    gaps.push({ g, above, below, lo: below ? below.depth : 0, hi: above ? above.depth + 1 : 0 });
  }
  const result = (g, d) => unflat([...rest.slice(0, g), ...held.map((r) => ({ name: r.name, depth: r.depth - held[0].depth + d })), ...rest.slice(g)]);
  return { all, held, rest, gaps, result };
}
// where on screen the held bullet goes to pick gap g at depth d: the gap's
// line (the top of what follows the row above), the bullet at that depth
function aim(R, all, { above, below }, d) {
  const k = above ? all.findIndex((r) => r.name === above.name) + 1 : 0;
  const y = k < all.length ? R[all[k].name].top : Math.max(...Object.values(R).map((r) => r.bottom));
  const base = above ?? below, b = R[base.name];
  return [b.left + (d - base.depth) * b.indent + b.indent / 2, y + 2];
}

// Press on x's bullet, move to (tx, ty), and see what is drawn before
// letting go (or pressing Escape instead).
async function drag(x, tx, ty, { escape = false } = {}) {
  const r = (await H("rows"))[x];
  await pg.mouse.move(r.cx, r.cy);
  await pg.mouse.down();
  await pg.mouse.move(r.cx + 6, r.cy + 6, { steps: 2 });
  await pg.mouse.move(tx, ty, { steps: 4 });
  await pause(30);
  const seen = { drop: await H("drop"), dragged: await H("dragged"), rings: await H("rings"), card: await H("card") };
  if (escape) await pg.keyboard.press("Escape");
  await pg.mouse.up();
  await pause(40);
  return seen;
}

// Drop x into gap g at depth d, and check the outline against the model:
// ids kept, one undo step, the rings that were drawn.
async function dragCase(x, g, d) {
  await H("load", OUTLINE);
  const before = await H("tree"), json = await H("json");
  const S = slotsOf(before, x), gap = S.gaps[g];
  const expect = S.result(g, d);
  const moves = expect !== shape(before);
  const seen = await drag(x, ...aim(await H("rows"), S.all, gap, d));
  const after = await H("tree");
  const label = { x, gap: `${gap.above?.name ?? "^"}|${gap.below?.name ?? "$"}`, d };
  if (shape(after) !== expect) fail("drop went somewhere else", { ...label, expect, got: shape(after) });
  if (ids(after) !== ids(before)) fail("a moved block lost its id", label);
  const ok = await H("check");
  if (ok !== true) fail("invalid document after a drop", { ...label, ok });
  if (!seen.dragged) fail("the dragged block is not drawn as held", label);
  if (!seen.card) fail("no card follows the pointer", label);
  const depths = seen.rings.map((r) => r.depth).join(), want = Array.from({ length: gap.hi - gap.lo + 1 }, (_, k) => gap.lo + k).join();
  if (depths !== want) fail("the rings are not the gap's depths", { ...label, want, got: depths });
  if (seen.rings.filter((r) => r.picked).map((r) => r.depth).join() !== String(d)) fail("the larger ring is not the depth it lands at", { ...label, rings: seen.rings });
  if ((await H("drop")) || (await H("rings")).length || (await H("card"))) fail("rings, line or card left on screen", label);
  if (await H("dragged")) fail("block still drawn as held after the drop", label);
  if (!moves) { if ((await H("json")) !== json) fail("a drop where it was changed something", label); return; }
  // the picked ring is where the block's bullet lands
  const landed = (await H("rows"))[x], ring = seen.rings.find((r) => r.picked);
  if (Math.abs(ring.x - landed.cx) > 2) fail("the picked ring at another indent than the block lands", { ...label, ring: ring.x, block: landed.cx });
  await pg.keyboard.press("ControlOrMeta+z"); await pause(40);
  if ((await H("json")) !== json) fail("one undo does not put the block back", { ...label, got: shape(await H("tree")) });
  await pg.keyboard.press("ControlOrMeta+Shift+z"); await pause(40);
  if (shape(await H("tree")) !== expect) fail("redo does not move it again", label);
}

{
  await H("load", OUTLINE);
  const tree = await H("tree");
  let n = 0, places = 0;
  for (const { name: x } of flat(tree)) {
    const S = slotsOf(tree, x);
    for (const gap of S.gaps) for (let d = gap.lo; d <= gap.hi; d++) { await dragCase(x, gap.g, d); n++; }
    places += new Set(S.gaps.flatMap((gap) => Array.from({ length: gap.hi - gap.lo + 1 }, (_, k) => S.result(gap.g, gap.lo + k)))).size;
  }
  console.log(`drag: ${n} slots (${places} outlines)`);

  // sideways where it is: indented under the block above, or outdented
  await H("load", OUTLINE);
  {
    const R = await H("rows"), b = R.B;
    await pg.mouse.move(b.cx, b.cy); await pg.mouse.down();
    await pg.mouse.move(b.cx + 5, b.cy, { steps: 2 });
    await pg.mouse.move(b.cx + b.indent, b.cy, { steps: 3 });
    await pg.mouse.up(); await pause(40);
    if (shape(await H("tree")) !== "A(A1,A2,B(B1(B1a))),C,D") fail("held and moved right, a block is indented where it is", { got: shape(await H("tree")) });
    const r = (await H("rows")).B1;
    await pg.mouse.move(r.cx, r.cy); await pg.mouse.down();
    await pg.mouse.move(r.cx - 5, r.cy, { steps: 2 });
    await pg.mouse.move(r.cx - 2 * r.indent, r.cy, { steps: 3 });
    await pg.mouse.up(); await pause(40);
    if (shape(await H("tree")) !== "A(A1,A2,B),B1(B1a),C,D") fail("held and moved left, a block is outdented where it is", { got: shape(await H("tree")) });
  }
  console.log("drag: sideways in place");

  // a click without dragging folds; a leaf's bullet does nothing
  await H("load", OUTLINE);
  const click = async (name, wiggle = 0) => { const r = (await H("rows"))[name]; await pg.mouse.move(r.cx, r.cy); await pg.mouse.down(); if (wiggle) await pg.mouse.move(r.cx + wiggle, r.cy); await pg.mouse.up(); await pause(40); };
  await click("A");
  if (!find(await H("tree"), "A").folded || "A1" in (await H("rows"))) fail("a click on a bullet does not fold", {});
  await click("A", 2); // a hand that shakes a little is still a click
  if (find(await H("tree"), "A").folded || !("A1" in (await H("rows")))) fail("a click on a folded bullet does not unfold", {});
  const json = await H("json");
  await click("C");
  if ((await H("json")) !== json) fail("a click on a leaf's bullet changed something", {});

  // into a folded block: it unfolds to show where the block went
  await H("load", OUTLINE);
  await click("A");
  {
    const R = await H("rows"), b = R.B;
    await drag("D", R.A.left + 1.5 * R.A.indent, b.top + 2);
    if (shape(await H("tree")) !== "A(D,A1,A2),B(B1(B1a)),C" || find(await H("tree"), "A").folded) fail("drop into a folded block", { got: shape(await H("tree")) });
  }

  // one long drag over every row, the rings following, let go at the top
  await H("load", OUTLINE);
  {
    const R = await H("rows"), d = R.D;
    await pg.mouse.move(d.cx, d.cy);
    await pg.mouse.down();
    for (const name of Object.keys(R).reverse()) {
      if (name === "D") continue;
      const r = R[name];
      await pg.mouse.move(r.cx, r.top + 2, { steps: 3 });
      const rings = await H("rings");
      if (!rings.length || rings.some((g) => Math.abs(g.y - r.top) > 2)) fail("the rings do not follow the pointer", { name, at: r.top, rings });
    }
    await pg.mouse.up(); await pause(40);
    if (shape(await H("tree")) !== "D,A(A1,A2),B(B1(B1a)),C") fail("a long drag", { got: shape(await H("tree")) });
  }
  // the outline changes while a block is held (sync): the same block moves
  await H("load", OUTLINE);
  {
    const c = (await H("rows")).C;
    await pg.mouse.move(c.cx, c.cy);
    await pg.mouse.down();
    await pg.mouse.move(c.cx + 10, c.cy - 10, { steps: 2 });
    await H("remote", "C"); await pause(30);
    const a = (await H("rows")).A;
    await pg.mouse.move(a.cx, a.top + 3, { steps: 3 });
    await pg.mouse.up(); await pause(40);
    if (shape(await H("tree")) !== "Z,C,A(A1,A2),B(B1(B1a)),D") fail("a drag across a change from elsewhere", { got: shape(await H("tree")) });
  }

  // Escape lets go without moving anything
  await H("load", OUTLINE);
  {
    const before = await H("json"), a = (await H("rows")).A;
    const seen = await drag("C", a.cx, a.top + 3, { escape: true });
    if (!seen.rings.length) fail("no rings before Escape", {});
    if ((await H("json")) !== before || (await H("drop")) || (await H("rings")).length || (await H("card")) || (await H("dragged"))) fail("Escape does not cancel a drag", {});
  }

  // selected blocks are dragged together, by any of their bullets, and stay selected
  await H("load", OUTLINE);
  {
    await H("caretAt", "A1", 1);
    await pg.keyboard.press("Escape");
    await pg.keyboard.press("Shift+ArrowDown");
    await pg.keyboard.press("Shift+ArrowDown");
    const R = await H("rows"), json = await H("json");
    const seen = await drag("A2", R.D.cx, R.D.bottom + 2);
    if (seen.dragged !== 3) fail("selected blocks are not all held", { dragged: seen.dragged });
    if (shape(await H("tree")) !== "A,C,D,A1,A2,B(B1(B1a))") fail("selected blocks dragged together", { got: shape(await H("tree")) });
    const sel = await H("selected");
    if (sel.join() !== "A1,A2,B") fail("dropped, the blocks are still selected", { sel });
    await pg.keyboard.press("ControlOrMeta+z"); await pause(40);
    if ((await H("json")) !== json) fail("one undo puts the selected blocks back", { got: shape(await H("tree")) });
  }
  console.log("drag: click, folded target, a long drag, a change meanwhile, Escape, selected blocks");
}

// ---- selecting blocks (as Logseq: no selection of text across blocks)

{
  const selected = () => H("selected");
  const bar = () => pg.evaluate(() => !!document.querySelector(".format-bar:not([hidden])"));
  // with the mouse, from text in A1 to text in B: A1, A2 and B, whole
  await H("load", OUTLINE);
  {
    const L = await H("lines");
    await pg.mouse.move(L.A1.left + 4, L.A1.mid); await pg.mouse.down();
    await pg.mouse.move(L.A2.left + 4, L.A2.mid, { steps: 4 });
    await pg.mouse.move(L.B.left + 4, L.B.mid, { steps: 4 });
    await pg.mouse.up(); await pause(40);
    if ((await selected()).join() !== "A1,A2,B") fail("a mouse selection across blocks takes them whole", { got: await selected() });
    if ((await pg.evaluate(() => document.querySelectorAll(".pm-block-selected").length)) !== 3) fail("selected blocks are not drawn tinted", {});
    if (!(await pg.evaluate(() => window.view.dom.classList.contains("ProseMirror-hideselection")))) fail("text is drawn selected over selected blocks", {});
    if (await bar()) fail("the format bar shows over selected blocks", {});
    // Backspace takes them away, children and all; one undo brings them back
    const json = await H("json");
    await pg.keyboard.press("Backspace"); await pause(30);
    if (shape(await H("tree")) !== "A,C,D") fail("Backspace on selected blocks", { got: shape(await H("tree")) });
    await pg.keyboard.press("ControlOrMeta+z"); await pause(30);
    if ((await H("json")) !== json) fail("undo after taking selected blocks away", { got: shape(await H("tree")) });
  }
  // Escape on a line selects its block; Shift-↑↓ grows and shrinks, ↑↓ moves,
  // typing does nothing, Enter edits again
  await H("load", OUTLINE);
  {
    await H("caretAt", "B1", 1);
    await pg.keyboard.press("Escape");
    if ((await selected()).join() !== "B1") fail("Escape selects the line's block", { got: await selected() });
    await pg.keyboard.press("Shift+ArrowUp");
    if ((await selected()).join() !== "B,B1") fail("Shift-Up grows the selection", { got: await selected() });
    await pg.keyboard.press("Shift+ArrowDown"); await pg.keyboard.press("Shift+ArrowDown");
    if ((await selected()).join() !== "B1,B1a") fail("Shift-Down past the anchor", { got: await selected() });
    await pg.keyboard.press("ArrowDown");
    if ((await selected()).join() !== "C") fail("Down moves to the block below", { got: await selected() });
    const json = await H("json");
    await pg.keyboard.type("xy"); await pause(30);
    if ((await H("json")) !== json) fail("typing over selected blocks changed something", {});
    await pg.keyboard.press("Enter"); await pause(30);
    const head = await H("head");
    if ((await selected()).length || head.name !== "C") fail("Enter edits the selected block again", { head });
  }
  // ⌘A twice: every block; ⌘⏎ marks each a task; Backspace leaves one empty block
  await H("load", OUTLINE);
  {
    await H("caretAt", "B", 0);
    await pg.keyboard.press("ControlOrMeta+a"); await pg.keyboard.press("ControlOrMeta+a");
    if ((await selected()).join() !== "A,A1,A2,B,B1,B1a,C,D") fail("⌘A twice selects every block", { got: await selected() });
    await pg.keyboard.press("ControlOrMeta+Enter"); await pause(30);
    const tasks = await pg.evaluate(async () => (await import("/src/outline-io.js")).serializeOutline(window.view.state.doc));
    if ((tasks.match(/TODO/g) ?? []).length !== 8) fail("⌘⏎ on every selected block", { tasks });
    await pg.keyboard.press("Backspace"); await pause(30);
    if (shape(await H("tree")) !== "" || (await H("check")) !== true) fail("all blocks taken away: one empty block", { got: shape(await H("tree")) });
  }
  // ⌘C: the blocks as outline text
  await H("load", OUTLINE);
  {
    await H("caretAt", "B", 0);
    await pg.keyboard.press("Escape");
    const text = await pg.evaluate(() => { let got = null; document.addEventListener("copy", (e) => { got = e.clipboardData.getData("text/plain"); }, { once: true }); document.execCommand("copy"); return got; });
    if (text !== "- B\n  - B1\n    - B1a") fail("⌘C on a selected block copies it as an outline", { text });
  }
  console.log("selecting blocks: mouse, keys, ⌘A, Backspace, ⌘C");
}

// ---- cut, copy and paste

{
  // the outline as text, one line per block, for what else must not change
  const lines = async () => { const t = await H("tree"), out = []; const walk = (t, d) => t.forEach((n) => { out.push(" ".repeat(d) + n.name); walk(n.children, d + 1); }); walk(t, 0); return out; };
  await H("load", LINES);
  const positions = await H("linePositions", 0);
  const originalLines = await lines();
  const O = 6; // pasted into "target line" here, after "target"
  let n = 0;
  for (const a of positions) for (const b of positions) {
    if (a >= b) continue;
    await H("load", LINES);
    const original = await H("json");
    const expect = await H("expectCut", 0, a, b, 1, O);
    const label = { a, b, line: await H("line", 0) };
    await H("setRange", a, b);
    await pg.keyboard.press("ControlOrMeta+x"); await pause(30);
    const cut = await H("line", 0), afterCut = await lines();
    if (cut !== expect.left) fail("cut inside a line took something else", { ...label, expect: expect.left, got: cut });
    if (afterCut.length !== originalLines.length || afterCut.slice(1).join("\n") !== originalLines.slice(1).join("\n")) fail("cut inside a line changed other blocks", { ...label, got: afterCut });
    await H("close");
    await H("caretIn", 1, O);
    await pg.keyboard.press("ControlOrMeta+v"); await pause(30);
    const pasted = await H("line", 1), afterPaste = await lines();
    if (pasted !== expect.pasted) fail("pasted text did not go in at the caret", { ...label, expect: expect.pasted, got: pasted });
    if (afterPaste.length !== originalLines.length) fail("paste inside a line made blocks", { ...label, got: afterPaste });
    if (await H("check") !== true) fail("invalid document after cut and paste", label);
    await pg.keyboard.press("ControlOrMeta+z"); await pause(30);
    await pg.keyboard.press("ControlOrMeta+z"); await pause(30);
    if ((await H("json")) !== original) fail("undo does not undo the cut and the paste", label);
    n++;
  }
  console.log(`clipboard: ${n} pieces of a line cut and pasted`);

  // as the hand does it: one character with Shift+Left, a word by double click
  await H("load", "- alpha one\n- beta two");
  await H("caretIn", 0, 9);
  await pg.keyboard.press("Shift+ArrowLeft");
  await pg.keyboard.press("ControlOrMeta+x"); await pause(30);
  await H("caretIn", 1, 4);
  await pg.keyboard.press("ControlOrMeta+v"); await pause(30);
  if (JSON.stringify(await lines()) !== JSON.stringify(["alpha on", "betae two"])) fail("cut one character, paste it in a line", { got: await lines() });
  const word = await pg.locator(".pm-line").nth(1).boundingBox();
  await pg.mouse.dblclick(word.x + word.width - 8, word.y + word.height / 2);
  await pg.keyboard.press("ControlOrMeta+c"); await pause(30);
  await H("caretIn", 0, 0);
  await pg.keyboard.press("ControlOrMeta+v"); await pause(30);
  if (JSON.stringify(await lines()) !== JSON.stringify(["twoalpha on", "betae two"])) fail("copy a double-clicked word, paste it in a line", { got: await lines() });

  // across blocks it is the blocks, whole: pasted after the caret's block
  await H("load", LINES);
  {
    const [a] = await H("linePositions", 0), t = await H("linePositions", 1);
    await H("setRange", a + 3, t[6]); // "**cd** $x^2$ e - f" through "target"
    await pg.keyboard.press("ControlOrMeta+c"); await pause(30);
    await H("caretIn", 3, 1);
    await pg.keyboard.press("ControlOrMeta+v"); await pause(30);
    const got = await lines();
    if (JSON.stringify(got) !== JSON.stringify([...originalLines, "ab cd x2 e - f", "target line", " child"])) fail("a copy across blocks pastes as those blocks", { got });
    // a block with its child
    await H("load", LINES);
    const c = await H("linePositions", 2);
    await H("setRange", t[0], c[c.length - 1]);
    await pg.keyboard.press("ControlOrMeta+x"); await pause(30);
    const left = await lines();
    await H("caretIn", left.length - 1, 1); // in "end"
    await pg.keyboard.press("ControlOrMeta+v"); await pause(30);
    const got2 = await lines();
    const want = [...left, "target line", " child"];
    if (left.includes("child") || JSON.stringify(got2) !== JSON.stringify(want)) fail("a block with its child cut and pasted", { left, want, got: got2 });
  }
  console.log("clipboard: by hand, across blocks");
}

// ---- Mod-Shift-Enter: a new block at the top level

{
  // [block, caret offset, in its formula]: the new block right after the
  // top-level ancestor's whole subtree, caret in it
  for (const [name, o, inMath] of [["R", 1, false], ["S", 1, false], ["L2", 1, false], ["L5", 2, false], ["F a+b", 0, true]]) {
    await H("load", DEEP);
    const before = await H("tree"), json = await H("json");
    const top = before.find((n) => find([n], name)).name;
    const expect = structuredClone(before);
    expect.splice(expect.findIndex((n) => n.name === top) + 1, 0, { name: "", children: [] });
    await H("caretAt", name, o, inMath);
    await pg.keyboard.press("ControlOrMeta+Shift+Enter"); await pause(30);
    const got = await H("tree"), head = await H("head");
    const label = { name, inMath };
    if (shape(got) !== shape(expect)) fail("new top-level block somewhere else", { ...label, expect: shape(expect), got: shape(got) });
    if (head.name !== "" || head.depth !== 1) fail("the caret is not in the new top-level block", { ...label, head });
    await pg.keyboard.press("ControlOrMeta+z"); await pause(30);
    if ((await H("json")) !== json) fail("one undo does not take the new top-level block back", label);
  }
  console.log("top level: Mod-Shift-Enter");
}

// ---- Backspace at the start of a line

{
  // [outline, block, caret offset, the outline afterwards, the caret's block]
  const cases = [
    // an empty block above goes; this one keeps its children
    ["- \n- S\n  - a\n  - b\n    - c", "S", 0, "- S\n  - a\n  - b\n    - c", "S"],
    ["- A\n  - \n- S\n  - a", "S", 0, "- A\n- S\n  - a", "S"],
    // a line above with text: this line joins it, its children step out
    ["- A\n- S\n  - a", "S", 0, "- AS\n- a", "AS"],
    // the line above is a child's (x): joined to it, as before; an empty
    // block above with a task: joined, as before
    ["- \n  - x\n- S", "S", 0, "- \n  - xS", "xS"],
    ["- TODO \n- S\n  - a", "S", 0, "- TODO S\n- a", "S"],
  ];
  for (const [text, name, o, expect, at] of cases) {
    await H("load", text);
    await H("caretAt", name, o);
    await pg.keyboard.press("Backspace"); await pause(30);
    const got = await pg.evaluate(async () => (await import("/src/outline-io.js")).serializeOutline(window.view.state.doc));
    const head = await H("head");
    if (got !== expect) fail("Backspace at a line's start", { text, expect, got });
    else if (head.name !== at) fail("Backspace left the caret elsewhere", { text, at, head });
  }
  console.log("Backspace at a line's start");
}

// ---- Tab / Shift-Tab

{
  // [outline, block, caret offset, key, the outline afterwards]: the caret
  // stays where it was in its line
  const cases = [
    // a first child has no sibling before it to go under: nothing happens
    ["- testse\n  - ", "", 0, "Tab", "- testse\n  - "],
    ["- A\n  - a1\n  - a2", "a1", 1, "Tab", "- A\n  - a1\n  - a2"],
    ["- A\n- B", "A", 1, "Tab", "- A\n- B"],
    // under the sibling before, as its last child
    ["- A\n  - a1\n  - a2", "a2", 1, "Tab", "- A\n  - a1\n    - a2"],
    ["- A\n  - a1\n- B\n  - b1", "B", 1, "Tab", "- A\n  - a1\n  - B\n    - b1"],
    // out: after its parent
    ["- A\n  - a1\n  - a2", "a1", 1, "Shift+Tab", "- A\n  - a2\n- a1"],
  ];
  for (const [text, name, o, key, expect] of cases) {
    await H("load", text);
    await H("caretAt", name, o);
    await pg.keyboard.press(key); await pause(30);
    const got = await pg.evaluate(async () => (await import("/src/outline-io.js")).serializeOutline(window.view.state.doc));
    const at = await pg.evaluate(() => { const $h = window.view.state.selection.$head; return { parent: $h.parent.type.name, offset: $h.parentOffset, line: $h.parent.textContent }; });
    if (got !== expect) fail(`${key}`, { text, name, expect, got });
    else if (at.parent !== "line" || at.line !== name || at.offset !== o) fail(`${key} moved the caret`, { text, name, at });
  }
  console.log("Tab / Shift-Tab");
}

// ---- tags are the block's, not the line's: Enter and Backspace leave them be

{
  // [outline, block, caret offset, key, the outline afterwards, the caret's block]
  const cases = [
    ["- AB #T\n- C", "AB", 2, "Enter", "- AB #T\n- \n- C", ""],
    ["- AB #T", "AB", 0, "Enter", "- \n- AB #T", "AB"],
    ["- AB #T", "AB", 1, "Enter", "- A #T\n- B", "B"],
    ["- AB #T\n- C", "AB", 2, "Backspace", "- A #T\n- C", "A"],
    // a line joining the one above brings its tags along
    ["- A #S\n- B #T #S", "B", 0, "Backspace", "- AB #S #T", "AB"],
  ];
  for (const [text, name, o, key, expect, at] of cases) {
    await H("load", text);
    await H("caretAt", name, o);
    await pg.keyboard.press(key); await pause(30);
    const got = await pg.evaluate(async () => (await import("/src/outline-io.js")).serializeOutline(window.view.state.doc));
    const head = await H("head");
    if (got !== expect) fail(`${key} on a tagged line`, { text, o, expect, got });
    else if (head.name !== at) fail(`${key} on a tagged line left the caret elsewhere`, { text, o, at, head });
  }
  console.log("Enter / Backspace on a tagged line");
}

console.log(`\n${fails.length} failures`);
for (const x of fails.slice(0, 20)) console.log("  " + JSON.stringify(x));
for (const e of new Set(pageErrors)) console.log(`page error: ${e}`);
await ctx.close();
await browser.close();
await server.close();
if (fails.length || pageErrors.length) process.exitCode = 1;
else console.log("all passed");
