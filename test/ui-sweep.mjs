// Exhaustive sweep of the formula UI in WebKit (the engine the app runs in):
// every caret position x every navigation key, every selection x every
// notation action, each checked against invariants. Starts its own Vite
// server; needs the WebKit build: npx playwright-core install webkit
//
//   npm run test:ui          all formulas
//   npm run test:ui -- 0,4   only these (indices into FORMULAS)
import { createServer } from "vite";
import { webkit } from "playwright-core";

const FORMULAS = [
  "0\\to N\\to M\\to\\frac{M}{N}\\to 0",
  "h(m_1)+h(m_2)=h(m_1+m_2)",
  "N\\overset{f}{\\to}M\\overset{g}{\\to}P",
  "e^{i\\pi}+1=0",
  "x^2_i+\\sqrt{a+b}-\\frac{x^2-1}{x-1}",
  "\\underset{n\\to\\infty}{\\lim}a_n",
  "(a+b)^3",
  "\\mathbb{R}\\times\\mathcal{C}",
];
const KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Alt+ArrowLeft", "Alt+ArrowRight", "ControlOrMeta+ArrowLeft", "ControlOrMeta+ArrowRight", "Shift+Alt+ArrowLeft", "Shift+Alt+ArrowRight", "Space"];
// Option + arrow from one end of the formula: the LaTeX left of the caret at
// each stop. A relation over a label (\overset{f}{\to}) splits terms like a bare one.
const PATHS = [
  ["N\\overset{f}{\\to}M\\overset{g}{\\to}P", ["N", "N\\overset{f}{\\to}", "N\\overset{f}{\\to}M", "N\\overset{f}{\\to}M\\overset{g}{\\to}", "N\\overset{f}{\\to}M\\overset{g}{\\to}P"]],
  ["0\\to N\\to\\frac{M}{N}\\to 0", ["0", "0\\to", "0\\to N", "0\\to N\\to", "0\\to N\\to\\frac{M}{N}", "0\\to N\\to\\frac{M}{N}\\to", "0\\to N\\to\\frac{M}{N}\\to0"]],
  ["h(m_1)+h(m_2)=0", ["h(m_1)", "h(m_1)+", "h(m_1)+h(m_2)", "h(m_1)+h(m_2)=", "h(m_1)+h(m_2)=0"]],
];
const HINTED = ["slash", "frac", "power"]; // the actions the hint under a selection offers
const ONLY = process.argv[2] ? process.argv[2].split(",").map(Number) : null;

// no file watching: an edit made while the sweep runs must not reload its pages
const server = await createServer({ logLevel: "error", server: { port: 5199, hmr: false, watch: null } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await webkit.launch();
const pageErrors = [];
let pg, ctx;

// A fresh page (empty storage) holding one formula between two lines of text,
// with helpers for the sweep installed as window.__h.
async function fresh(f) {
  await ctx?.close();
  ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  pg = await ctx.newPage();
  pg.on("pageerror", (e) => pageErrors.push(String(e)));
  await pg.goto(url);
  await pg.waitForFunction(() => window.view);
  await pg.evaluate((f) => {
    const v = window.view;
    v.focus();
    const dt = new DataTransfer();
    dt.setData("text/plain", `- 上一行文字 above\n- 前文 $${f}$ 後文\n- 下一行文字 below`);
    v.dom.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, f);
  await pg.waitForTimeout(300);
  await pg.evaluate(async () => {
    // the module instances the app itself uses (Vite adds a version query)
    const dep = (name) => performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes(`/deps/${name}.js`));
    const S = await import(dep("prosemirror-state"));
    const Hi = await import(dep("prosemirror-history"));
    const L = await import("/src/latex.js");
    const N = await import("/src/notation.js");
    const v = window.view;
    const CONTAINERS = ["math", "slot", "sup", "sub"];
    const math = () => { let at = null; v.state.doc.descendants((n, p) => { if (at === null && n.type.name === "math") at = p; }); return at; };
    window.__h = {
      ser: () => L.serializeMath(v.state.doc.nodeAt(math()).content),
      // caret positions in the formula's containers, plus the text right around it
      positions: () => {
        const p = math(), size = v.state.doc.nodeAt(p).nodeSize, out = [p - 1, p, p + size, p + size + 1];
        for (let x = p + 1; x < p + size; x++) if (CONTAINERS.includes(v.state.doc.resolve(x).parent.type.name)) out.push(x);
        return [...new Set(out)].sort((a, b) => a - b);
      },
      structNodes: () => { const p = math(), out = []; v.state.doc.nodeAt(p).descendants((n, q) => { if (["struct", "sup", "sub"].includes(n.type.name)) out.push(p + 1 + q); }); return out; },
      setCaret: (pos) => { v.focus(); v.dispatch(v.state.tr.setSelection(S.TextSelection.create(v.state.doc, pos)).setMeta("pointer", true)); },
      setRange: (a, b) => { v.focus(); v.dispatch(v.state.tr.setSelection(S.TextSelection.create(v.state.doc, a, b)).setMeta("pointer", true)); },
      setNode: (pos) => { v.focus(); v.dispatch(v.state.tr.setSelection(S.NodeSelection.create(v.state.doc, pos)).setMeta("pointer", true)); },
      sel: () => { const s = v.state.selection; return { head: s.head, empty: s.empty, parent: s.$head.parent.type.name, sameParent: s.$from.sameParent(s.$to), docSize: v.state.doc.content.size }; },
      caret: () => { const c = document.querySelector(".pm-caret"); if (!c || c.hidden) return null; const r = c.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; },
      // where the caret should sit vertically: its container's box in a
      // formula, a neighbouring character's glyph box in text
      box: (pos) => {
        const $p = v.state.doc.resolve(pos);
        if (CONTAINERS.includes($p.parent.type.name)) { const r = v.nodeDOM($p.before()).getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }
        const side = $p.nodeBefore?.isText ? -1 : $p.nodeAfter?.isText ? 1 : null;
        if (side === null) return null;
        const r = v.coordsAtPos(pos, side);
        return { top: r.top, bottom: r.bottom };
      },
      desc: (pos) => {
        const $x = v.state.doc.resolve(pos);
        const d = (n) => (n ? (n.isText ? JSON.stringify(n.text) : n.type.name + (n.attrs.name ? ":" + n.attrs.name : "")) : "-");
        return `${$x.parent.type.name}@${$x.parentOffset} ${d($x.nodeBefore)}|${d($x.nodeAfter)}`;
      },
      atEdge: (pos, dir) => { const $x = v.state.doc.resolve(pos); let d = $x.depth; while ($x.node(d).type.name !== "math") d--; return dir < 0 ? pos === $x.start(d) : pos === $x.end(d); },
      actions: () => N.notationActions(v.state).map((a) => a.id),
      hint: () => { const h = document.querySelector(".notation-hint"); return h && !h.hidden ? h.textContent : null; },
      close: () => v.dispatch(Hi.closeHistory(v.state.tr)),
      reset: (tex) => { const p = math(), n = v.state.doc.nodeAt(p); v.dispatch(v.state.tr.replaceWith(p + 1, p + n.nodeSize - 1, L.parseMath(tex)).setMeta("addToHistory", false)); },
      apply: (id) => N.applyNotation(v, N.notationActions(v.state).find((x) => x.id === id)),
      check: () => { try { v.state.doc.check(); return true; } catch (e) { return String(e); } },
      // the formula's LaTeX left of the caret, when the caret is directly in it
      leftOf: () => { const $h = v.state.selection.$head, p = math(); if ($h.parent !== v.state.doc.nodeAt(p)) return null; return L.serializeMath(v.state.doc.slice(p + 1, $h.pos).content); },
      edge: (end) => { const p = math(); return end ? p + v.state.doc.nodeAt(p).nodeSize - 1 : p + 1; },
      reparse: () => { const s = window.__h.ser(); const again = L.serializeMath(v.state.schema.nodes.math.create(null, L.parseMath(s)).content); return s === again ? null : [s, again]; },
    };
  });
}
const H = (fn, ...args) => pg.evaluate(([fn, args]) => window.__h[fn](...args), [fn, args]);
const pause = (ms) => pg.waitForTimeout(ms);

const fails = [];
async function fail(kind, f, detail) {
  if (detail.pos != null) detail.at = await H("desc", detail.pos);
  if (detail.head != null) detail.headAt = await H("desc", detail.head);
  fails.push({ kind, f, ...detail });
}

if (!ONLY) for (const [f, stops] of PATHS) {
  await fresh(f);
  for (const [key, from, expect] of [["Alt+ArrowRight", false, stops], ["Alt+ArrowLeft", true, ["", ...stops.slice(0, -1)].reverse()]]) {
    await H("setCaret", await H("edge", from)); await pause(30);
    const got = [];
    for (let k = 0; k < expect.length; k++) { await pg.keyboard.press(key); await pause(40); got.push(await H("leftOf")); }
    if (JSON.stringify(got) !== JSON.stringify(expect)) fails.push({ kind: "option-arrow stops", f, key, expect, got });
  }
  console.log(`path: ${f}`);
}

for (const [fi, f] of FORMULAS.entries()) {
  if (ONLY && !ONLY.includes(fi)) continue;
  await fresh(f);
  const original = await H("ser");
  const positions = await H("positions");

  // ---- navigation keys from every caret position
  const mainRow = []; // caret tops directly in the formula: one height for the whole row
  for (const pos of positions) {
    await H("setCaret", pos); await pause(30);
    const c0 = await H("caret");
    if ((await H("sel")).parent === "math" && c0) mainRow.push(c0.top);
    for (const key of KEYS) {
      await H("setCaret", pos); await pause(30);
      const before = await H("sel");
      if (key === "Space" && before.parent === "line") continue; // that is typing a space
      await H("close");
      await pg.keyboard.press(key); await pause(60);
      const s = await H("sel");
      if (s.docSize !== before.docSize || (await H("ser")) !== original) {
        await fail("key changed the document", f, { key, pos });
        await pg.keyboard.press("ControlOrMeta+z"); await pause(40);
        if ((await H("ser")) !== original) await H("reset", original);
        continue;
      }
      if (key.startsWith("Shift")) {
        if (!s.sameParent) await fail("selection ends in different containers", f, { key, pos });
        if (before.parent !== "line" && s.empty && !(await H("atEdge", pos, key.endsWith("Left") ? -1 : 1))) await fail("shift selected nothing", f, { key, pos });
      }
      if (s.empty) {
        const c = await H("caret"), box = await H("box", s.head);
        if (!c) await fail("no caret drawn", f, { key, pos, head: s.head });
        else if (box && ((c.top + c.bottom) / 2 < box.top - 2 || (c.top + c.bottom) / 2 > box.bottom + 2)) await fail("caret outside its container", f, { key, pos, head: s.head, caret: c, box });
      }
      if ((key === "ArrowUp" || key === "ArrowDown") && before.parent === "line" && ["slot", "sup", "sub"].includes(s.parent)) await fail("up/down from text into a slot or script", f, { key, pos, head: s.head });
    }
    // right then left comes back (from where the caret really is: the shape rules may move it)
    await H("setCaret", pos); await pause(30);
    const start = (await H("sel")).head;
    await pg.keyboard.press("ArrowRight"); await pause(40);
    const r = await H("sel");
    if (r.head !== start && r.parent !== "line" && positions.includes(r.head) && positions.includes(start)) {
      await pg.keyboard.press("ArrowLeft"); await pause(40);
      const l = await H("sel");
      if (l.head !== start) await fail("right then left does not come back", f, { pos, start, right: r.head, back: l.head });
    }
  }

  if (Math.max(...mainRow) - Math.min(...mainRow) > 2) await fail("caret height differs along the main row", f, { tops: mainRow.map(Math.round) });

  // ---- every selection x every action
  const inner = positions.slice(2, -2); // inside the formula
  const ranges = [];
  for (const a of inner) for (const b of inner) if (a < b) ranges.push(["range", a, b]);
  for (const p of await H("structNodes")) ranges.push(["node", p]);
  const select = (r) => (r[0] === "range" ? H("setRange", r[1], r[2]) : H("setNode", r[1]));
  for (const r of ranges) {
    await select(r);
    if (r[0] === "range" && !(await H("sel")).sameParent) continue; // not a selection the UI makes
    const acts = await H("actions");
    await pause(20);
    if (!!(await H("hint")) !== acts.some((a) => HINTED.includes(a))) await fail("hint shown or hidden wrongly", f, { r, acts });
    for (const id of acts) {
      await select(r);
      await H("close");
      try { await H("apply", id); } catch (e) { await fail("action threw", f, { r, id, e: String(e) }); continue; }
      await pause(30);
      const ok = await H("check");
      if (ok !== true) await fail("invalid document after action", f, { r, id, ok });
      const rp = await H("reparse");
      if (rp) await fail("result does not survive the LaTeX round trip", f, { r, id, rp });
      const after = await H("ser");
      // the inverse notation brings the original back
      const back = { slash: "frac", frac: "slash" }[id];
      if (back) {
        if (!(await H("actions")).includes(back)) await fail("no way back offered", f, { r, id, after });
        else {
          await H("close"); await H("apply", back);
          const again = await H("ser");
          if (again !== original) await fail("round trip changed the formula", f, { r, id, after, again });
          await pg.keyboard.press("ControlOrMeta+z"); await pause(30);
        }
      }
      if (after === original) continue; // nothing changed (Nerdamer had nothing to do)
      await pg.keyboard.press("ControlOrMeta+z"); await pause(40);
      const undone = await H("ser").catch(() => null);
      if (undone !== original) { await fail("undo does not restore", f, { r, id, after, undone }); await fresh(f); }
    }
  }
  console.log(`${fi}: ${f}  ${positions.length} positions, ${ranges.length} selections, ${fails.filter((x) => x.f === f).length} failures`);
}

await ctx?.close();
await browser.close();
await server.close();

const byKind = Object.groupBy(fails, (x) => x.kind);
for (const [kind, xs] of Object.entries(byKind)) {
  console.log(`\n${kind}: ${xs.length}`);
  for (const x of xs.slice(0, 5)) console.log("  " + JSON.stringify(x));
}
for (const e of new Set(pageErrors)) console.log(`\npage error: ${e}`);
if (fails.length || pageErrors.length) process.exitCode = 1;
else console.log("\nall passed");
