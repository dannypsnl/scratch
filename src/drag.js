import { Plugin, PluginKey, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { closeHistory } from "prosemirror-history";
import { schema } from "./schema.js";
import { toggleFoldAt } from "./outline.js";

// Dragging a block by its bullet: it moves with its children, before or
// after another block or as its first child, in one undoable step. A press
// that does not move is a click: it folds / unfolds.

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

// Every block on screen, top to bottom. Its row is its own line (with the
// widgets beside and under it), down to where its first visible child starts.
function rows(view) {
  const out = [];
  for (const el of view.dom.querySelectorAll(".pm-block")) {
    if (!el.getClientRects().length) continue; // inside a folded block
    const bullet = el.querySelector(":scope > .pm-bullet").getBoundingClientRect();
    const body = el.querySelector(":scope > .pm-body").getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const child = [...el.querySelectorAll(":scope > .pm-body > .pm-block")].find((c) => c.getClientRects().length);
    out.push({
      pos: blockPos(view, el),
      top: box.top,
      rowBottom: child ? child.getBoundingClientRect().top : box.bottom,
      bottom: box.bottom,
      left: bullet.left,
      bodyLeft: body.left,
      indent: bullet.width,
      children: !!child,
    });
  }
  return out;
}

// Where a drop at (x, y) puts the dragged block [from, to): { pos, where }
// with where "before" / "after" / "child" of the block at pos, and the line
// to draw. null over the dragged block itself.
export function dropTarget(view, from, to, x, y) {
  const all = rows(view);
  if (!all.length) return null;
  const byPos = new Map(all.map((r) => [r.pos, r]));
  let row = all[0];
  for (const r of all) if (r.top <= y) row = r;
  if (row.pos >= from && row.pos < to) return null;
  const right = view.dom.getBoundingClientRect().right;
  const line = (top, left) => ({ top, left, right });
  if (y < (row.top + row.rowBottom) / 2) return { pos: row.pos, where: "before", line: line(row.top, row.left) };
  // the lower half of a row with children shown is their top
  if (row.children || x >= row.bodyLeft + row.indent) return { pos: row.pos, where: "child", line: line(row.rowBottom, row.bodyLeft) };
  // after the last child of a block, further left: after that block
  const { doc } = view.state;
  for (;;) {
    const $p = doc.resolve(row.pos);
    if ($p.depth === 0 || x >= row.left) break;
    const parent = $p.parent, i = $p.index();
    const last = i === parent.childCount - 1 || (i === parent.childCount - 2 && row.pos + doc.nodeAt(row.pos).nodeSize === from);
    const up = byPos.get($p.before());
    if (!last || !up) break;
    row = up;
  }
  return { pos: row.pos, where: "after", line: line(row.bottom, row.left) };
}

// Move the block at `from` to `where` of the block at `target`.
export function moveBlock(state, dispatch, from, target, where) {
  const node = state.doc.nodeAt(from), to = from + node.nodeSize;
  const t = state.doc.nodeAt(target);
  if (node?.type !== T.block || t?.type !== T.block || (target >= from && target < to)) return false;
  const at = where === "before" ? target : where === "after" ? target + t.nodeSize : target + 1 + t.firstChild.nodeSize;
  if (at >= from && at <= to) return false; // where it already is
  if (!dispatch) return true;
  const sel = state.selection;
  const tr = state.tr;
  // a child dropped into a folded block shows up there
  if (where === "child" && t.attrs.folded) tr.setNodeMarkup(target, null, { ...t.attrs, folded: false });
  tr.delete(from, to);
  const dest = tr.mapping.map(at);
  tr.insert(dest, node);
  // a caret in the moved block goes with it
  if (sel instanceof TextSelection && sel.from >= from && sel.to <= to) {
    tr.setSelection(TextSelection.create(tr.doc, dest + (sel.anchor - from), dest + (sel.head - from)));
  }
  dispatch(closeHistory(tr));
  return true;
}

// The scrolling box around the editor (the page itself when there is none).
function scroller(el) {
  for (let e = el.parentElement; e; e = e.parentElement) {
    const o = getComputedStyle(e).overflowY;
    if ((o === "auto" || o === "scroll") && e.scrollHeight > e.clientHeight) return e;
  }
  return document.scrollingElement;
}

// The held block is kept by id: its DOM may be redrawn, and the outline
// changed (sync), while the button is down.
function startDrag(view, ev) {
  const bullet = ev.button === 0 && ev.target.closest?.(".pm-bullet");
  if (!bullet || !view.dom.contains(bullet)) return false;
  ev.preventDefault();
  const x0 = ev.clientX, y0 = ev.clientY;
  let dragging = false, done = false, target = null, indicator = null;
  const id = view.state.doc.nodeAt(blockPos(view, bullet.parentElement)).attrs.id;
  const held = () => findBlock(view.state.doc, id);
  view.dispatch(view.state.tr.setMeta(key, { id, dragging }));

  const show = (t) => {
    target = t;
    if (!t) { indicator?.remove(); indicator = null; return; }
    indicator ??= document.body.appendChild(Object.assign(document.createElement("div"), { className: "block-drop" }));
    Object.assign(indicator.style, { top: `${t.line.top - 1}px`, left: `${t.line.left}px`, width: `${Math.max(0, t.line.right - t.line.left)}px` });
  };
  const move = (e) => {
    if (view.isDestroyed || held() == null) return end(false);
    if (!dragging) {
      if (Math.hypot(e.clientX - x0, e.clientY - y0) < THRESHOLD) return;
      dragging = true;
      document.body.classList.add("block-dragging");
      view.dispatch(view.state.tr.setMeta(key, { id, dragging }));
    }
    e.preventDefault();
    const s = scroller(view.dom), edge = 40;
    if (e.clientY < edge) s.scrollBy(0, -12);
    else if (e.clientY > innerHeight - edge) s.scrollBy(0, 12);
    const from = held();
    show(dropTarget(view, from, from + view.state.doc.nodeAt(from).nodeSize, e.clientX, e.clientY));
  };
  const end = (drop) => {
    if (done) return;
    done = true;
    removeEventListener("mousemove", move, true);
    removeEventListener("mouseup", up, true);
    removeEventListener("keydown", onKey, true);
    document.body.classList.remove("block-dragging");
    indicator?.remove();
    if (view.isDestroyed) return;
    const from = held();
    view.dispatch(view.state.tr.setMeta(key, null));
    if (from == null) return;
    if (!dragging) toggleFoldAt(view, from); // a click
    else if (drop && target) moveBlock(view.state, view.dispatch, from, target.pos, target.where);
  };
  const up = (e) => {
    if (dragging) { e.preventDefault(); move(e); } // the target as the outline is now
    end(true);
  };
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); end(false); } };
  addEventListener("mousemove", move, true);
  addEventListener("mouseup", up, true);
  addEventListener("keydown", onKey, true);
  return true;
}

// The pressed block ({ id, dragging }, null when none), drawn faded once
// it is being dragged.
export const blockDrag = new Plugin({
  key,
  state: {
    init: () => null,
    apply: (tr, held) => { const m = tr.getMeta(key); return m === undefined ? held : m; },
  },
  props: {
    decorations(state) {
      const held = key.getState(state);
      const at = held?.dragging ? findBlock(state.doc, held.id) : null;
      if (at == null) return null;
      return DecorationSet.create(state.doc, [Decoration.node(at, at + state.doc.nodeAt(at).nodeSize, { class: "pm-dragged" })]);
    },
    handleDOMEvents: { mousedown: startDrag },
  },
});
