// The outline UI in WebKit (the engine the app runs in): a block dragged by
// its bullet to every place in a small outline, each checked against what
// should happen. Starts its own Vite server; needs the WebKit build:
// npx playwright-core install webkit
//
//   npm run test:ui
import { createServer } from "vite";
import { webkit } from "playwright-core";

const OUTLINE = "- A\n  - A1\n  - A2\n- B\n  - B1\n    - B1a\n- C\n- D";

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
    // another device's edit: a block in at the top, and a deadline on the
    // block named `name` (which redraws it)
    remote: (name) => {
      const tr = v.state.tr.insert(0, IO.parseOutline("- Z").content);
      tr.doc.descendants((n, p) => { if (n.type.name === "block" && n.firstChild.textContent === name) tr.setNodeMarkup(p, null, { ...n.attrs, deadline: "2030-01-01" }); });
      v.dispatch(tr.setMeta("addToHistory", false));
    },
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

// The model: `x` moved before / after / as the first child of `y`. Into its
// own subtree nothing moves.
function move(t, x, y, where) {
  t = structuredClone(t);
  if (find([find(t, x)], y)) return t;
  let moved;
  const take = (list) => { const i = list.findIndex((n) => n.name === x); if (i >= 0) [moved] = list.splice(i, 1); else list.forEach((n) => take(n.children)); };
  take(t);
  const put = (list) => {
    const i = list.findIndex((n) => n.name === y);
    if (i < 0) return list.some((n) => put(n.children));
    if (where === "child") list[i].children.unshift(moved);
    else list.splice(where === "before" ? i : i + 1, 0, moved);
    return true;
  };
  put(t);
  return t;
}

// Press on x's bullet, move to (tx, ty), and see what the drop line shows
// before letting go (or pressing Escape instead).
async function drag(x, tx, ty, { escape = false } = {}) {
  const r = (await H("rows"))[x];
  await pg.mouse.move(r.cx, r.cy);
  await pg.mouse.down();
  // by way of the gutter beside the target and the middle of its line
  await pg.mouse.move(tx - 30, ty, { steps: 3 });
  await pg.mouse.move(tx + 60, ty, { steps: 2 });
  await pg.mouse.move(tx, ty, { steps: 2 });
  await pause(30);
  const seen = { drop: await H("drop"), dragged: await H("dragged") };
  if (escape) await pg.keyboard.press("Escape");
  await pg.mouse.up();
  await pause(40);
  return seen;
}

// Drop x where `where` of y, by a gesture at y's row, and check the outline
// against the model: ids kept, one undo step, the drop line where it lands.
async function dragCase(x, y, where, gesture, expectShape) {
  await H("load", OUTLINE);
  const before = await H("tree"), json = await H("json");
  const expect = expectShape ?? shape(move(before, x, y, where));
  const moves = expect !== shape(before);
  const seen = await drag(x, ...gesture(await H("rows")));
  const after = await H("tree");
  const label = { x, y, where };
  if (shape(after) !== expect) fail("drop went somewhere else", { ...label, expect, got: shape(after) });
  if (ids(after) !== ids(before)) fail("a moved block lost its id", label);
  const ok = await H("check");
  if (ok !== true) fail("invalid document after a drop", { ...label, ok });
  if (!seen.dragged) fail("the dragged block is not drawn as held", label);
  if (await H("drop")) fail("drop line left on screen", label);
  if (await H("dragged")) fail("block still drawn as held after the drop", label);
  if (find([find(before, x)], y) && seen.drop) fail("a drop line over the dragged block itself", label);
  if (!find([find(before, x)], y) && !seen.drop) fail("no drop line", label);
  if (!moves) return;
  // the line is drawn at the indent the block lands at
  const landed = (await H("rows"))[x];
  if (seen.drop && Math.abs(seen.drop.left - landed.left) > 2) fail("drop line at another indent than the block lands", { ...label, line: seen.drop.left, block: landed.left });
  await pg.keyboard.press("ControlOrMeta+z"); await pause(40);
  if ((await H("json")) !== json) fail("one undo does not put the block back", { ...label, got: shape(await H("tree")) });
  await pg.keyboard.press("ControlOrMeta+Shift+z"); await pause(40);
  if (shape(await H("tree")) !== expect) fail("redo does not move it again", label);
}

// ---- dragging a bullet

{
  await H("load", OUTLINE);
  const names = Object.keys(await H("rows"));
  const shown = await H("rows");
  let n = 0;
  for (const x of names) for (const y of names) for (const where of ["before", "after", "child"]) {
    // below a block whose children are shown is their top: "child"
    if (where === "after" && shown[y].children) continue;
    await dragCase(x, y, where, (R) => {
      const r = R[y];
      return where === "before" ? [r.left + r.indent / 2, r.top + 3]
        : where === "after" ? [r.left + 2, r.rowBottom - 3]
        : [r.bodyLeft + r.indent + 6, r.rowBottom - 3];
    });
    n++;
  }
  console.log(`drag: ${n} drops`);

  // after the last child, further left: after the block it ends (at each level)
  await dragCase("D", "B1a", "after", (R) => [R.B.left + 2, R.B1a.rowBottom - 3], "A(A1,A2),B(B1(B1a)),D,C");
  await dragCase("D", "B1a", "after", (R) => [R.B1.left + 2, R.B1a.rowBottom - 3], "A(A1,A2),B(B1(B1a),D),C");
  // the dragged block itself being the last one does not count
  await dragCase("A2", "A1", "after", (R) => [R.A.left + 2, R.A1.rowBottom - 3], "A(A1),A2,B(B1(B1a)),C,D");
  console.log("drag: out of a subtree");

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
  const a = (await H("rows")).A;
  await drag("D", a.bodyLeft + a.indent + 6, a.rowBottom - 3);
  if (shape(await H("tree")) !== "A(D,A1,A2),B(B1(B1a)),C" || find(await H("tree"), "A").folded) fail("drop into a folded block", { got: shape(await H("tree")) });

  // one long drag over every row, the drop line following, let go at the top
  await H("load", OUTLINE);
  {
    const R = await H("rows"), d = R.D;
    await pg.mouse.move(d.cx, d.cy);
    await pg.mouse.down();
    for (const name of Object.keys(R).reverse()) {
      const r = R[name];
      for (const [x, y, at] of [[r.bodyLeft + r.indent + 6, r.rowBottom - 3, r.rowBottom], [r.cx, r.top + 3, r.top]]) {
        await pg.mouse.move(x, y, { steps: 3 });
        const drop = await H("drop");
        if (name !== "D" && (!drop || Math.abs(drop.top + 1 - at) > 2)) fail("the drop line does not follow the pointer", { name, at, drop });
      }
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
  const before = await H("json"), c = (await H("rows")).A;
  const seen = await drag("C", c.cx, c.top + 3, { escape: true });
  if (!seen.drop) fail("no drop line before Escape", {});
  if ((await H("json")) !== before || (await H("drop")) || (await H("dragged"))) fail("Escape does not cancel a drag", {});
  console.log("drag: click, folded target, a long drag, a change meanwhile, Escape");
}

console.log(`\n${fails.length} failures`);
for (const x of fails.slice(0, 20)) console.log("  " + JSON.stringify(x));
for (const e of new Set(pageErrors)) console.log(`page error: ${e}`);
await ctx.close();
await browser.close();
await server.close();
if (fails.length || pageErrors.length) process.exitCode = 1;
else console.log("all passed");
