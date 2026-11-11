import { Plugin, PluginKey, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { Fragment } from "prosemirror-model";
import { closeHistory } from "prosemirror-history";
import { schema } from "./schema.js";
import { toggleFoldAt } from "./outline.js";
import { BlockSelection } from "./blockselect.js";

// Dragging a block by its bullet: it moves with its children, in one
// undoable step. Selected blocks (blockselect.js) are dragged together by
// any of their bullets. A press that does not move is a click: it folds /
// unfolds.
//
// Declarative, after Horowitz, Blinn & Heer's "Declarative Dragging": rather
// than working out from the pointer what a drop would do, every outline the
// drag can end in is laid out first, as a slot: a gap between two rows and a
// depth. The gap below a row and above the next takes every depth from the
// next row's (it must stay where it is in the tree) to one deeper than the
// row's (its first child). The pointer picks the gap by its height and the
// depth by where the held bullet is; the slots of that gap are drawn as
// rings at their bullets' places, the one picked larger. The gap the blocks
// came from has its slots too: held and moved sideways, a block is indented
// or outdented where it is. The held blocks follow the pointer as a card.

const T = schema.nodes;
const key = new PluginKey("blockDrag");
const THRESHOLD = 4; // px the pointer moves before a press becomes a drag

const blockPos = (view, el) => view.posAtDOM(el.querySelector(":scope > .pm-body"), 0) - 1;

function findBlock(doc, id) {
  let at = null;
  doc.descendants((n, p) => {
    if (at !== null || n.type !== T.block) return false;
    if (n.attrs.id === id) at = p;
    return at === null;
  });
  return at;
}

// Every block on screen, top to bottom, with its depth. Its row is its own
// line (with the widgets beside and under it), down to where its first
// visible child starts. Rows inside a held block are marked held.
function rows(view, held) {
  const out = [];
  for (const el of view.dom.querySelectorAll(".pm-block")) {
    if (!el.getClientRects().length) continue; // inside a folded block
    const pos = blockPos(view, el);
    const bullet = el.querySelector(":scope > .pm-bullet").getBoundingClientRect();
    const body = el.querySelector(":scope > .pm-body").getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const child = [...el.querySelectorAll(":scope > .pm-body > .pm-block")].find((c) => c.getClientRects().length);
    out.push({
      pos,
      depth: view.state.doc.resolve(pos).depth,
      held: held.some(([from, to]) => pos >= from && pos < to),
      top: box.top,
      rowBottom: child ? child.getBoundingClientRect().top : box.bottom,
      bottom: box.bottom,
      left: bullet.left,
      step: body.left - bullet.left, // one level of indentation
    });
  }
  return out;
}

// The slots a drag of the blocks `held` ([from, to) each) can drop into:
// one gap per place between the rows not held, each with its depths.
// A gap: { above, below (rows, null at the ends), y (its line), lo, hi
// (depths), x(d) (where the bullet of a block at depth d is) }.
export function gaps(view, held) {
  const all = rows(view, held);
  const free = all.filter((r) => !r.held);
  if (!free.length) return [];
  const first = free[0];
  const xAt = (r) => (d) => r.left + (d - r.depth) * r.step;
  const out = [];
  for (let i = 0; i <= free.length; i++) {
    const above = free[i - 1] ?? null, below = free[i] ?? null;
    // the line is at the top of whatever comes after the row above: the held
    // blocks, when it is the gap they came from
    const k = above ? all.indexOf(above) + 1 : 0;
    const y = k < all.length ? all[k].top : Math.max(...all.map((r) => r.bottom));
    const lo = below ? below.depth : 0;
    const hi = above ? above.depth + 1 : 0;
    out.push({ above, below, y, lo, hi: Math.max(lo, hi), x: xAt(above ?? below ?? first) });
  }
  return out;
}

// The slot for the held bullet at (x, y): the gap whose band holds y (from
// the middle of the row above to the middle of the row below), the depth
// whose bullet is nearest x.
export function pick(gs, x, y) {
  if (!gs.length) return null;
  const mid = (r) => (r.top + r.rowBottom) / 2;
  let g = gs[0];
  for (const c of gs) if (!c.above || mid(c.above) <= y) g = c;
  const half = (g.above ?? g.below).step / 2;
  let depth = g.lo, best = Infinity;
  for (let d = g.lo; d <= g.hi; d++) {
    const dist = Math.abs(g.x(d) + half - x);
    if (dist < best) { best = dist; depth = d; }
  }
  return { gap: g, depth };
}

// A slot as a place in the document: { pos, where } with where "before" /
// "after" / "child" (first child) of the block at pos.
export function placeOf(doc, { gap, depth }) {
  const { above, below } = gap;
  if (!above) return { pos: below.pos, where: "before" };
  if (depth === above.depth + 1) return { pos: above.pos, where: "child" };
  // after the row above's ancestor at that depth (the row itself at its own)
  const $a = doc.resolve(above.pos);
  return { pos: depth === above.depth ? above.pos : $a.before(depth + 1), where: "after" };
}

// Move the blocks at `froms` (positions, in document order, none inside
// another) to `where` of the block at `target`, one after another.
export function moveBlocks(state, dispatch, froms, target, where) {
  const { doc } = state;
  const nodes = froms.map((p) => doc.nodeAt(p));
  const t = doc.nodeAt(target);
  if (nodes.some((n) => n?.type !== T.block) || t?.type !== T.block) return false;
  if (froms.some((p, i) => target >= p && target < p + nodes[i].nodeSize)) return false;
  const at = where === "before" ? target : where === "after" ? target + t.nodeSize : target + 1 + t.firstChild.nodeSize;
  const sel = state.selection;
  const tr = state.tr;
  // a child dropped into a folded block shows up there
  if (where === "child" && t.attrs.folded) tr.setNodeMarkup(target, null, { ...t.attrs, folded: false });
  for (let i = froms.length - 1; i >= 0; i--) tr.delete(froms[i], froms[i] + nodes[i].nodeSize);
  const dest = tr.mapping.map(at);
  tr.insert(dest, Fragment.fromArray(nodes));
  if (tr.doc.eq(doc)) return false; // where they already are
  if (!dispatch) return true;
  // where each block went
  const landed = [];
  nodes.reduce((p, n) => { landed.push(p); return p + n.nodeSize; }, dest);
  if (sel instanceof BlockSelection) {
    // still selected
    tr.setSelection(BlockSelection.blocks(tr.doc, landed[0], landed[landed.length - 1]));
  } else if (sel instanceof TextSelection) {
    // a caret in a moved block goes with it
    const i = froms.findIndex((p, k) => sel.from >= p && sel.to <= p + nodes[k].nodeSize);
    if (i >= 0) tr.setSelection(TextSelection.create(tr.doc, landed[i] + (sel.anchor - froms[i]), landed[i] + (sel.head - froms[i])));
  }
  dispatch(closeHistory(tr));
  return true;
}

// one block: what the outline tests and other callers use
export const moveBlock = (state, dispatch, from, target, where) => moveBlocks(state, dispatch, [from], target, where);

// The scrolling box around the editor (the page itself when there is none).
function scroller(el) {
  for (let e = el.parentElement; e; e = e.parentElement) {
    const o = getComputedStyle(e).overflowY;
    if ((o === "auto" || o === "scroll") && e.scrollHeight > e.clientHeight) return e;
  }
  return document.scrollingElement;
}

// the held blocks, by id: the pressed one, or every selected root when it is
// among the selected blocks
function heldIds(view, pos) {
  const sel = view.state.selection, { doc } = view.state;
  if (sel instanceof BlockSelection && sel.ranges.some(({ $from, $to }) => pos >= $from.pos && pos < $to.pos)) {
    return sel.roots.map((p) => doc.nodeAt(p).attrs.id);
  }
  return [doc.nodeAt(pos).attrs.id];
}

// The held blocks are kept by id: their DOM may be redrawn, and the outline
// changed (sync), while the button is down.
function startDrag(view, ev) {
  const bullet = ev.button === 0 && ev.target.closest?.(".pm-bullet");
  if (!bullet || !view.dom.contains(bullet)) return false;
  ev.preventDefault();
  const x0 = ev.clientX, y0 = ev.clientY;
  const b0 = bullet.getBoundingClientRect();
  // where in the bullet it was pressed: the card's bullet stays under the pointer
  const grab = { x: x0 - b0.left, y: y0 - b0.top };
  const pressed = blockPos(view, bullet.parentElement);
  const pressedId = view.state.doc.nodeAt(pressed).attrs.id;
  const ids = heldIds(view, pressed);
  let dragging = false, done = false, slot = null, marks = null, card = null;
  // positions of the held blocks, in document order (null once one is gone)
  const held = () => {
    const ps = ids.map((id) => findBlock(view.state.doc, id));
    return ps.includes(null) ? null : ps.sort((a, b) => a - b);
  };
  const ranges = (ps) => ps.map((p) => [p, p + view.state.doc.nodeAt(p).nodeSize]);
  view.dispatch(view.state.tr.setMeta(key, { ids, dragging }));

  // the held blocks as a card under the pointer, drawn as they are now
  const makeCard = (ps) => {
    card = document.body.appendChild(Object.assign(document.createElement("div"), { className: "block-card" }));
    const first = view.nodeDOM(ps[0]);
    const box = first.getBoundingClientRect();
    const bl = first.querySelector(":scope > .pm-bullet").getBoundingClientRect();
    card.style.width = `${Math.max(...ps.map((p) => view.nodeDOM(p).getBoundingClientRect().right)) - box.left}px`;
    for (const p of ps) {
      const copy = view.nodeDOM(p).cloneNode(true);
      copy.classList.remove("pm-dragged", "pm-block-selected");
      copy.removeAttribute("contenteditable");
      copy.querySelectorAll("[contenteditable]").forEach((e) => e.removeAttribute("contenteditable"));
      card.append(copy);
    }
    // the card's first bullet, relative to the card
    card.dataset.dx = String(bl.left - box.left);
    card.dataset.dy = String(bl.top - box.top);
  };
  const place = (e) => {
    const dx = +card.dataset.dx + card.clientLeft + parseFloat(getComputedStyle(card).paddingLeft);
    const dy = +card.dataset.dy + card.clientTop + parseFloat(getComputedStyle(card).paddingTop);
    const left = e.clientX - grab.x - dx;
    card.style.left = `${left}px`;
    card.style.top = `${e.clientY - grab.y - dy}px`;
    // no further right than the editor
    card.style.maxWidth = `${Math.max(160, view.dom.getBoundingClientRect().right + 12 - left)}px`;
  };

  // the slots of the picked gap: a ring at each depth's bullet, the picked
  // one larger, over the card; a line from it, under the card
  let line = null;
  const show = (s) => {
    slot = s;
    if (!s) { marks?.remove(); line?.remove(); marks = line = null; return; }
    marks ??= document.body.appendChild(Object.assign(document.createElement("div"), { className: "block-slots" }));
    line ??= document.body.appendChild(Object.assign(document.createElement("span"), { className: "block-drop" }));
    const { gap, depth } = s;
    const step = (gap.above ?? gap.below).step;
    const right = view.dom.getBoundingClientRect().right;
    const rings = [];
    for (let d = gap.lo; d <= gap.hi; d++) {
      const r = document.createElement("span");
      r.className = d === depth ? "block-slot picked" : "block-slot";
      r.dataset.depth = String(d);
      r.style.left = `${gap.x(d) + step / 2}px`;
      r.style.top = `${gap.y}px`;
      rings.push(r);
    }
    const lineLeft = gap.x(depth) + step / 2;
    Object.assign(line.style, { left: `${lineLeft}px`, top: `${gap.y - 1}px`, width: `${Math.max(0, right - lineLeft)}px` });
    marks.replaceChildren(...rings);
  };

  const move = (e) => {
    const ps = view.isDestroyed ? null : held();
    if (!ps) return end(false);
    if (!dragging) {
      if (Math.hypot(e.clientX - x0, e.clientY - y0) < THRESHOLD) return;
      dragging = true;
      document.body.classList.add("block-dragging");
      makeCard(ps);
      view.dispatch(view.state.tr.setMeta(key, { ids, dragging }));
    }
    e.preventDefault();
    const s = scroller(view.dom), edge = 40;
    if (e.clientY < edge) s.scrollBy(0, -12);
    else if (e.clientY > innerHeight - edge) s.scrollBy(0, 12);
    place(e);
    // the held bullet's middle, as the card has it
    const bx = e.clientX - grab.x + b0.width / 2, by = e.clientY - grab.y + b0.height / 2;
    show(pick(gaps(view, ranges(ps)), bx, by));
  };
  const end = (drop) => {
    if (done) return;
    done = true;
    removeEventListener("mousemove", move, true);
    removeEventListener("mouseup", up, true);
    removeEventListener("keydown", onKey, true);
    document.body.classList.remove("block-dragging");
    const picked = slot;
    show(null);
    card?.remove();
    if (view.isDestroyed) return;
    const ps = held();
    view.dispatch(view.state.tr.setMeta(key, null));
    if (!ps) return;
    if (!dragging) { // a click
      const p = findBlock(view.state.doc, pressedId);
      if (p != null) toggleFoldAt(view, p);
      return;
    }
    if (drop && picked) {
      const { pos, where } = placeOf(view.state.doc, picked);
      moveBlocks(view.state, view.dispatch, ps, pos, where);
    }
  };
  const up = (e) => {
    if (dragging) { e.preventDefault(); move(e); } // the slot as the outline is now
    end(true);
  };
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); end(false); } };
  addEventListener("mousemove", move, true);
  addEventListener("mouseup", up, true);
  addEventListener("keydown", onKey, true);
  return true;
}

// The pressed blocks ({ ids, dragging }, null when none), drawn faded once
// they are being dragged.
export const blockDrag = new Plugin({
  key,
  state: {
    init: () => null,
    apply: (tr, held) => { const m = tr.getMeta(key); return m === undefined ? held : m; },
  },
  props: {
    decorations(state) {
      const held = key.getState(state);
      if (!held?.dragging) return null;
      const decos = [];
      for (const id of held.ids) {
        const at = findBlock(state.doc, id);
        if (at != null) decos.push(Decoration.node(at, at + state.doc.nodeAt(at).nodeSize, { class: "pm-dragged" }));
      }
      return DecorationSet.create(state.doc, decos);
    },
    handleDOMEvents: { mousedown: startDrag },
  },
});
