// The editor against its model (model/, PureScript): random lines with a
// formula from the model's generator; at every caret position, every key the
// model specifies; every selection shape; every rewrite of every selection.
// The editor's own commands run on a plain EditorState (no page needed).
// Run `spago build` in model/ first (npm run test:model does both).
//
//   node test/model-diff.mjs [lines] [seed]
import { EditorState, TextSelection, NodeSelection } from "prosemirror-state";
import { schema } from "../src/schema.js";
import { SYMBOLS } from "../src/specs.js";
import { horizontal, term, selectTerm, selectStep, selectEdge, navGuard, selectionShape } from "../src/nav.js";
import { notationActions } from "../src/notation.js";
import * as M from "../model/output/Model/index.js";
import * as G from "../model/output/Gen/index.js";
import { Just } from "../model/output/Data.Maybe/index.js";

const T = schema.nodes;
const LINES = Number(process.argv[2] ?? 200);
const SEED = Number(process.argv[3] ?? 1);
const MODELLED = new Set(["slash", "frac", "power", "sup", "sub", "unscript"]); // Nerdamer's are not modelled
const maybe = (m) => (m instanceof Just ? m.value0 : null);

// ---- model line <-> ProseMirror document

function nodes(box) {
  const out = [];
  let text = "";
  const flush = () => { if (text) out.push(schema.text(text)); text = ""; };
  for (const it of box) {
    if (it.kind === "ch") { text += it.name; continue; }
    flush();
    const inner = (k) => nodes(it.slots[k]);
    if (it.kind === "sym") out.push(T.sym.create({ name: it.name }));
    else if (it.kind === "struct") out.push(T.struct.create({ name: it.name }, it.slots.map((_, k) => T.slot.create(null, inner(k)))));
    else out.push(T[it.kind].create(null, inner(0))); // sup, sub, math
  }
  flush();
  return out;
}
const toDoc = (line) => T.doc.create(null, T.block.create({ id: "b" }, T.line.create(null, nodes(line))));
const LINE_START = 2; // doc > block > line

function box(node) {
  const out = [];
  node.forEach((n) => {
    if (n.isText) for (const c of n.text) out.push({ kind: "ch", name: c, cls: "", slots: [] });
    else if (n.type === T.sym) out.push({ kind: "sym", name: n.attrs.name, cls: SYMBOLS[n.attrs.name]?.cls ?? "", slots: [] });
    else if (n.type === T.struct) { const slots = []; n.forEach((s) => slots.push(box(s))); out.push({ kind: "struct", name: n.attrs.name, cls: "", slots }); }
    else out.push({ kind: n.type.name, name: "", cls: "", slots: [box(n)] });
  });
  return out;
}
const lineOf = (doc) => box(doc.firstChild.firstChild);

const size = (it) => (it.kind === "ch" || it.kind === "sym" ? 1 : 2 + it.slots.reduce((n, s) => n + (it.kind === "struct" ? 2 : 0) + boxSize(s), 0));
const boxSize = (b) => b.reduce((n, it) => n + size(it), 0);

// model position -> document position
function toPM(line, pos) {
  let at = LINE_START, b = line;
  for (const step of pos.path) {
    at += boxSize(b.slice(0, step.item));
    const it = b[step.item];
    at += 1; // into the item
    if (it.kind === "struct") at += it.slots.slice(0, step.slot).reduce((n, s) => n + 2 + boxSize(s), 0) + 1; // into the slot
    b = it.slots[step.slot];
  }
  return at + boxSize(b.slice(0, pos.off));
}

// every model position, by document position
function positionTable(line) {
  const all = new Map();
  const walk = (path, b) => {
    for (let off = 0; off <= b.length; off++) { const p = { path, off }; all.set(toPM(line, p), p); }
    b.forEach((it, i) => it.slots.forEach((s, k) => walk([...path, { item: i, slot: k }], s)));
  };
  walk([], line);
  return all;
}

// ---- running the editor

const state = (doc, sel) => EditorState.create({ doc, selection: sel, plugins: [navGuard, selectionShape] });
function run(cmd, st) {
  let next = null;
  const handled = cmd(st, (tr) => { next = st.applyTransaction(tr).state; });
  return handled ? (next ?? st) : null;
}

const key = (p) => JSON.stringify(p);
const same = (a, b) => key(a) === key(b);
const fails = [];
// the container a position is in, written out, the position marked with |
function where(line, p) {
  if (!p?.path) return null;
  const box = maybe(M.containerAt(line)(p.path));
  return box && M.showBox(box.slice(0, p.off)) + "|" + M.showBox(box.slice(p.off));
}
const fail = (kind, line, detail) => fails.push({ kind, ...detail, at: where(line, detail.from), wantAt: where(line, detail.want?.head ?? detail.want), gotAt: where(line, detail.got?.head ?? detail.got), line: M.showBox(line) });

const lines = G.samples(SEED)(LINES);
let checks = 0;
for (const line of lines) {
  const doc = toDoc(line);
  if (!same(lineOf(doc), line)) { fail("line does not survive the round trip", line, {}); continue; }
  const table = positionTable(line);
  const posOf = (pm) => table.get(pm) ?? { pm }; // { pm } for a place the model has none
  const stops = M.stops(line);

  // ---- keys from every stop
  const KEYS = [
    ["right", horizontal(1), (p) => maybe(M.right(line)(p))],
    ["left", horizontal(-1), (p) => maybe(M.left(line)(p))],
    ["option-right", term(1), (p) => maybe(M.termRight(line)(p))],
    ["option-left", term(-1), (p) => maybe(M.termLeft(line)(p))],
  ];
  for (const p of stops) {
    const caret = TextSelection.create(doc, toPM(line, p));
    for (const [name, cmd, model] of KEYS) {
      const want = model(p);
      const got = run(cmd, state(doc, caret));
      checks++;
      if (want === null) continue; // the browser's own (text away from the formula)
      if (got === null) { fail(`${name}: left to the browser`, line, { from: p, want }); continue; }
      const head = posOf(got.selection.head);
      if (!same(head, want) || !got.selection.empty) fail(name, line, { from: p, want, got: head });
    }
    for (const [name, cmd, model] of [["option-shift", selectTerm, M.selectTerm], ["shift", selectStep, M.selectStep], ["shift-cmd", selectEdge, M.selectEdge]]) {
      for (const dir of [1, -1]) {
        const want = maybe(model(dir)(line)({ anchor: p, head: p }));
        const got = run(cmd(dir), state(doc, caret));
        checks++;
        if (want === null) continue;
        if (got === null) { fail(`${name} ${dir}: left to the browser`, line, { from: p, want }); continue; }
        const sel = { anchor: posOf(got.selection.anchor), head: posOf(got.selection.head) };
        if (!same(sel, want)) fail(`${name} ${dir}`, line, { from: p, want, got: sel });
      }
    }
  }

  // ---- shape: every pair of positions inside the line (a drag, a click)
  const positions = [...table.values()];
  for (let i = 0; i < positions.length; i += 3) for (let j = 0; j < positions.length; j += 2) {
    const a = positions[i], h = positions[j];
    const want = M.shape(line)({ anchor: a, head: h });
    // through applyTransaction, as a view does, so the shape rules run
    const base = state(doc, TextSelection.create(doc, LINE_START));
    const got = base.applyTransaction(base.tr.setSelection(TextSelection.create(doc, toPM(line, a), toPM(line, h)))).state;
    const sel = { anchor: posOf(got.selection.anchor), head: posOf(got.selection.head) };
    checks++;
    if (!same(sel, want)) fail("shape", line, { anchor: a, head: h, want, got: sel });
  }

  // ---- rewrites: every range of every container in the formula, and every
  // structure node-selected
  const containers = [];
  const walk = (path, b) => { if (path.length) containers.push([path, b]); b.forEach((it, i) => it.slots.forEach((s, k) => walk([...path, { item: i, slot: k }], s))); };
  walk([], line);
  for (const [path, b] of containers) {
    for (let from = 0; from <= b.length; from++) for (let to = from + 1; to <= b.length; to++) {
      const selections = [TextSelection.create(doc, toPM(line, { path, off: from }), toPM(line, { path, off: to }))];
      if (to === from + 1 && b[from].kind !== "ch") selections.push(NodeSelection.create(doc, toPM(line, { path, off: from })));
      const want = M.rewrites(line)(path)(from)(to);
      for (const sel of selections) {
        const st = EditorState.create({ doc, selection: sel });
        const acts = notationActions(st).filter((a) => MODELLED.has(a.id));
        checks++;
        const ids = acts.map((a) => a.id).sort(), wantIds = want.map((r) => r.id).sort();
        if (!same(ids, wantIds)) { fail("rewrites offered", line, { path, from, to, node: sel instanceof NodeSelection, want: wantIds, got: ids }); continue; }
        for (const a of acts) {
          const r = want.find((x) => x.id === a.id);
          const gotLine = lineOf(st.tr.replaceWith(sel.from, sel.to, a.replace).doc);
          const wantLine = M.replaceIn(line)(path)(from)(to)(r.replace);
          checks++;
          if (!same(gotLine, wantLine)) fail(`rewrite ${a.id}`, line, { path, from, to, want: M.showBox(wantLine), got: M.showBox(gotLine) });
        }
      }
    }
  }
}

const byKind = Object.groupBy(fails, (x) => x.kind);
console.log(`${lines.length} lines, ${checks} checks, ${fails.length} disagreements`);
for (const [kind, xs] of Object.entries(byKind)) {
  console.log(`\n${kind}: ${xs.length}`);
  for (const x of xs.slice(0, Number(process.env.SHOW ?? 4))) {
    const { kind: _, line, ...rest } = x;
    console.log("  " + JSON.stringify(rest) + (process.env.LINES ? "\n    in " + line : ""));
  }
}
if (fails.length) process.exitCode = 1;
