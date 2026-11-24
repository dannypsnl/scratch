import { Plugin, PluginKey, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { Fragment } from "prosemirror-model";
import { closeHistory } from "prosemirror-history";
import { schema } from "./schema.js";
import { toggleFoldAt } from "./outline.js";
import { BlockSelection, heldIds, findBlock } from "./blockselect.js";
import { dayAt, moveToDay } from "./daymove.js";

const T = schema.nodes;
const key = new PluginKey("blockDrag");
const THRESHOLD = 4;

const blockPos = (view, el) => view.posAtDOM(el.querySelector(":scope > .pm-body"), 0) - 1;

function rows(view, held) {
  const out = [];
  for (const el of view.dom.querySelectorAll(".pm-block")) {
    if (!el.getClientRects().length) continue;
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
      step: body.left - bullet.left,
    });
  }
  return out;
}

export function gaps(view, held) {
  const all = rows(view, held);
  const free = all.filter((r) => !r.held);
  if (!free.length) return [];
  const first = free[0];
  const xAt = (r) => (d) => r.left + (d - r.depth) * r.step;
  const out = [];
  for (let i = 0; i <= free.length; i++) {
    const above = free[i - 1] ?? null, below = free[i] ?? null;
    const k = above ? all.indexOf(above) + 1 : 0;
    const y = k < all.length ? all[k].top : Math.max(...all.map((r) => r.bottom));
    const lo = below ? below.depth : 0;
    const hi = above ? above.depth + 1 : 0;
    out.push({ above, below, y, lo, hi: Math.max(lo, hi), x: xAt(above ?? below ?? first) });
  }
  return out;
}

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

export function placeOf(doc, { gap, depth }) {
  const { above, below } = gap;
  if (!above) return { pos: below.pos, where: "before" };
  if (depth === above.depth + 1) return { pos: above.pos, where: "child" };
  const $a = doc.resolve(above.pos);
  return { pos: depth === above.depth ? above.pos : $a.before(depth + 1), where: "after" };
}

export function moveBlocks(state, dispatch, froms, target, where) {
  const { doc } = state;
  const nodes = froms.map((p) => doc.nodeAt(p));
  const t = doc.nodeAt(target);
  if (nodes.some((n) => n?.type !== T.block) || t?.type !== T.block) return false;
  if (froms.some((p, i) => target >= p && target < p + nodes[i].nodeSize)) return false;
  const at = where === "before" ? target : where === "after" ? target + t.nodeSize : target + 1 + t.firstChild.nodeSize;
  const sel = state.selection;
  const tr = state.tr;
  if (where === "child" && t.attrs.folded) tr.setNodeMarkup(target, null, { ...t.attrs, folded: false });
  for (let i = froms.length - 1; i >= 0; i--) tr.delete(froms[i], froms[i] + nodes[i].nodeSize);
  const dest = tr.mapping.map(at);
  tr.insert(dest, Fragment.fromArray(nodes));
  if (tr.doc.eq(doc)) return false;
  if (!dispatch) return true;
  const landed = [];
  nodes.reduce((p, n) => { landed.push(p); return p + n.nodeSize; }, dest);
  if (sel instanceof BlockSelection) {
    tr.setSelection(BlockSelection.blocks(tr.doc, landed[0], landed[landed.length - 1]));
  } else if (sel instanceof TextSelection) {
    const i = froms.findIndex((p, k) => sel.from >= p && sel.to <= p + nodes[k].nodeSize);
    if (i >= 0) tr.setSelection(TextSelection.create(tr.doc, landed[i] + (sel.anchor - froms[i]), landed[i] + (sel.head - froms[i])));
  }
  dispatch(closeHistory(tr));
  return true;
}

export const moveBlock = (state, dispatch, from, target, where) => moveBlocks(state, dispatch, [from], target, where);

function scroller(el) {
  for (let e = el.parentElement; e; e = e.parentElement) {
    const o = getComputedStyle(e).overflowY;
    if ((o === "auto" || o === "scroll") && e.scrollHeight > e.clientHeight) return e;
  }
  return document.scrollingElement;
}

function startDrag(view, ev) {
  const bullet = ev.button === 0 && ev.target.closest?.(".pm-bullet");
  if (!bullet || !view.dom.contains(bullet)) return false;
  ev.preventDefault();
  const x0 = ev.clientX, y0 = ev.clientY;
  const b0 = bullet.getBoundingClientRect();
  const grab = { x: x0 - b0.left, y: y0 - b0.top };
  const pressed = blockPos(view, bullet.parentElement);
  const pressedId = view.state.doc.nodeAt(pressed).attrs.id;
  const ids = heldIds(view.state, pressed);
  let dragging = false, done = false, slot = null, marks = null, card = null, shield = null, day = null;
  const held = () => {
    const ps = ids.map((id) => findBlock(view.state.doc, id));
    return ps.includes(null) ? null : ps.sort((a, b) => a - b);
  };
  const ranges = (ps) => ps.map((p) => [p, p + view.state.doc.nodeAt(p).nodeSize]);
  view.dispatch(view.state.tr.setMeta(key, { ids, dragging }));

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
    card.dataset.dx = String(bl.left - box.left);
    card.dataset.dy = String(bl.top - box.top);
  };
  const place = (e) => {
    const dx = +card.dataset.dx + card.clientLeft + parseFloat(getComputedStyle(card).paddingLeft);
    const dy = +card.dataset.dy + card.clientTop + parseFloat(getComputedStyle(card).paddingTop);
    const left = e.clientX - grab.x - dx;
    card.style.left = `${left}px`;
    card.style.top = `${e.clientY - grab.y - dy}px`;
    card.style.maxWidth = `${Math.max(160, view.dom.getBoundingClientRect().right + 12 - left)}px`;
  };

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
      shield = document.body.appendChild(Object.assign(document.createElement("div"), { className: "drag-shield" }));
      makeCard(ps);
      view.dispatch(view.state.tr.setMeta(key, { ids, dragging }));
    }
    e.preventDefault();
    place(e);
    light(dayAt(view.state, e.clientX, e.clientY));
    if (day) {
      card.style.top = `${day.getBoundingClientRect().bottom + 6}px`;
      return show(null);
    }
    const s = scroller(view.dom), edge = 40;
    if (e.clientY < edge) s.scrollBy(0, -12);
    else if (e.clientY > innerHeight - edge) s.scrollBy(0, 12);
    const bx = e.clientX - grab.x + b0.width / 2, by = e.clientY - grab.y + b0.height / 2;
    show(pick(gaps(view, ranges(ps)), bx, by));
  };
  const light = (el) => {
    if (el === day) return;
    day?.classList.remove("drop");
    day = el;
    day?.classList.add("drop");
  };
  const end = (drop) => {
    if (done) return;
    done = true;
    removeEventListener("mousemove", move, true);
    removeEventListener("mouseup", up, true);
    removeEventListener("keydown", onKey, true);
    shield?.remove();
    const picked = slot, toDay = day?.dataset.dropDay;
    show(null);
    light(null);
    card?.remove();
    if (view.isDestroyed) return;
    const ps = held();
    view.dispatch(view.state.tr.setMeta(key, null));
    if (!ps) return;
    if (!dragging) {
      const p = findBlock(view.state.doc, pressedId);
      if (p != null) toggleFoldAt(view, p);
      return;
    }
    if (drop && toDay) return moveToDay(view.state).move(ids, toDay);
    if (drop && picked) {
      const { pos, where } = placeOf(view.state.doc, picked);
      moveBlocks(view.state, view.dispatch, ps, pos, where);
    }
  };
  const up = (e) => {
    if (dragging) { e.preventDefault(); move(e); }
    end(true);
  };
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); end(false); } };
  addEventListener("mousemove", move, true);
  addEventListener("mouseup", up, true);
  addEventListener("keydown", onKey, true);
  return true;
}

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
