// Declarative dragging in plain DOM, after Horowitz, Blinn & Heer's
// "Declarative Dragging" and the shape of their library, dragology. A drag
// is declared as the states it can end in, not as what the pointer does:
//
//   drag(ev, { states, render, held, onDrop })
//
// `render(state)` draws the UI as it would be in that state (the way a
// dragology Draggable draws a state); `held(root, state)` finds the dragged
// element in a drawing. When the press becomes a drag, every state is
// rendered speculatively, hidden, in the live element's place, to measure
// where the held element lands in it and the box it lands in (its parent:
// a column, a day). The pointer picks a state by that box: the state shown
// keeps while the pointer stays in the box it shows the element in, so what
// is on screen is what a drop does; leaving it, a state whose box holds the
// pointer in its own layout wins, else the nearest box. The live element is
// morphed into the picked state's drawing, the held element faded in it,
// while a copy floats under the pointer (dragology's `withFloating`).
// Letting go commits the picked state through `onDrop`; Escape, or a drag
// that ends where it began, puts the live element back. A press that does
// not move is a click and does nothing here.
//
// A drawing need not draw everything again: where a live element goes, it
// puts a stand-in for it (`standin(el)`: an empty box of its size, keyed to
// it, like a keyed element in React). Measuring lays out boxes. Showing a
// drawing moves only what is not already in place: the live elements are
// put in the order the drawing's stand-ins have, inside the live element's
// own boxes (matched to the drawing's by tag, class and data attributes),
// and the drawing's other nodes (headings, counts) replace those that
// differ. So a drag costs one layout of boxes per state and, per picked
// state, a move of the held element and whatever else changed.
//
// The block drag of the outline (drag.js) is the same idea with its own
// slots and drawing; this is the general shape for the rest of the UI.

const THRESHOLD = 4; // px the pointer moves before a press becomes a drag

const standsFor = new WeakMap(); // stand-in -> the live element it stands for
let heights = null; // element -> its height, measured once per drag (set while measuring)
let margins = null; // class name -> margin: elements of a class share theirs (laying out a plain box is cheap, reading computed style is not)

// A stand-in for the live element `el` in a drawing: a plain box of its
// height and margins, with its data attributes (so it is found as it would
// be), nothing inside.
export function standin(el) {
  const s = document.createElement("div");
  s.className = "drag-standin";
  let h = heights?.get(el);
  if (h === undefined) {
    h = `${el.getBoundingClientRect().height}px`;
    heights?.set(el, h);
  }
  let m = margins?.get(el.className);
  if (m === undefined) {
    m = getComputedStyle(el).margin;
    margins?.set(el.className, m);
  }
  s.style.height = h;
  s.style.margin = m;
  Object.assign(s.dataset, el.dataset);
  standsFor.set(s, el);
  return s;
}

const isStandin = (n) => n.nodeType === 1 && n.classList.contains("drag-standin");
// a box (the parent of stand-ins / live elements) is matched across drawings by this
const keyOf = (el) => `${el.tagName}.${el.className}|${JSON.stringify(el.dataset)}`;

const inRect = (r, p) => p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom;
const toRect = (r, p) => Math.hypot(Math.max(r.left - p.x, 0, p.x - r.right), Math.max(r.top - p.y, 0, p.y - r.bottom));
const nearest = (ls, p, dist) => {
  let best = null, d0 = Infinity;
  for (const l of ls) { const d = dist(l, p); if (d < d0) { d0 = d; best = l; } }
  return best;
};

// The state the pointer p picks. Each landing: { x, y (the point of the held
// element under the pointer, in that state), region (the box it lands in) }.
// `shown` is the landing shown now; `onScreen(l)` is l's box as it is on
// screen now (null when it is not there).
export function pick(landings, p, shown, onScreen) {
  if (shown && inRect(shown.region, p)) return shown;
  const inside = landings.filter((l) => inRect(l.region, p));
  if (inside.length > 1) {
    const seen = inside.filter((l) => { const r = onScreen(l); return r && inRect(r, p); });
    if (seen.length) return nearest(seen, p, (l, p) => Math.hypot(l.x - p.x, l.y - p.y));
  }
  if (inside.length) return nearest(inside, p, (l, p) => Math.hypot(l.x - p.x, l.y - p.y));
  return nearest(landings, p, (l, p) => toRect(l.region, p));
}

// Where the held element lands in each state, and in what box: rendered
// hidden over `live`, at its width, and measured relative to live's
// top-left. Each state's drawing is kept, to show once picked.
function measure(live, states, render, held, grab) {
  const box = live.getBoundingClientRect();
  const rel = (r) => ({ left: r.left - box.left, top: r.top - box.top, right: r.right - box.left, bottom: r.bottom - box.top });
  const layer = document.createElement("div");
  layer.className = "drag-measure";
  Object.assign(layer.style, { position: "fixed", left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, visibility: "hidden", pointerEvents: "none" });
  heights = new WeakMap();
  margins = new Map();
  const drawings = states.map((state) => ({ state, el: render(state) }));
  heights = margins = null;
  document.body.append(layer);
  const out = [];
  for (const d of drawings) {
    layer.replaceChildren(d.el);
    const h = held(d.el, d.state);
    if (!h) continue;
    const r = rel(h.getBoundingClientRect());
    out.push({ ...d, held: h, x: r.left + grab.x, y: r.top + grab.y, region: rel(h.parentElement.getBoundingClientRect()), key: keyOf(h.parentElement) });
  }
  layer.remove();
  return out;
}

// The scrolling box around an element (the page itself when there is none).
function scroller(el) {
  for (let e = el.parentElement; e; e = e.parentElement) {
    const o = getComputedStyle(e).overflowY;
    if ((o === "auto" || o === "scroll") && e.scrollHeight > e.clientHeight) return e;
  }
  return document.scrollingElement;
}

// ev: the mousedown that may become a drag.
// live: the element showing the current state; it is morphed into a state's
//   drawing while dragging and put back unless the drop re-renders.
// state: the current state; states: every state the drag can end in
//   (compared with `same`, Object.is unless given); render(state) → element;
//   held(root, state) → the dragged element in it; onDrop(state) commits one
//   (and is expected to render the live element anew).
export function drag(ev, { live, state, states, render, held, onDrop, same = Object.is }) {
  if (ev.button !== 0) return false;
  const h0 = held(live, state);
  if (!h0) return false;
  ev.preventDefault();
  const x0 = ev.clientX, y0 = ev.clientY;
  const b0 = h0.getBoundingClientRect();
  const grab = { x: x0 - b0.left, y: y0 - b0.top }; // the pointer's place in the held element
  let dragging = false, done = false, scroll = null;
  let landings = null, current = null, picked = null, card = null;

  const copy = (el) => {
    const c = el.cloneNode(true);
    c.classList.remove("drag-held");
    c.querySelectorAll("[contenteditable]").forEach((e) => e.removeAttribute("contenteditable"));
    return c;
  };
  // a copy of the held element, as it is now, under the pointer
  const makeCard = () => {
    card = document.body.appendChild(Object.assign(document.createElement("div"), { className: "drag-card" }));
    card.style.width = `${b0.width}px`;
    card.append(copy(h0));
  };
  const place = (e) => {
    card.style.left = `${e.clientX - grab.x}px`;
    card.style.top = `${e.clientY - grab.y}px`;
  };

  // Morphing the live element into a drawing. The live elements are those
  // the drawings stand in for; a drawing's other nodes come over as they
  // are (leaving a mark to go back by, so the drawing can be shown again),
  // and nodes of the live element they replace go back to the drawing they
  // came from, or away.
  const elements = new Set(); // every live element some drawing stands in for
  let clones = new Set(); // copies of an element a drawing puts in two places
  const isLive = (n) => elements.has(n) || clones.has(n);
  const origin = new WeakMap(); // a node brought over -> the mark where it was
  const take = (n) => { const m = document.createComment(""); origin.set(n, m); n.replaceWith(m); return n; };
  const displace = (n) => { const next = n.nextSibling; const m = origin.get(n); if (m) m.replaceWith(n); else n.remove(); return next; };
  // The live element's boxes, by key: each box of a drawing has its
  // counterpart down the same path of keys from the live element (an empty
  // box too, which holds no live element to find it by).
  const boxes = new Map();
  const boxIn = (C, d) => {
    const key = keyOf(C);
    if (boxes.has(key)) return boxes.get(key);
    const path = [];
    for (let n = C; n !== d && n; n = n.parentElement) path.unshift(keyOf(n));
    let cur = live;
    for (const k of path) cur = cur && [...cur.children].find((c) => keyOf(c) === k);
    boxes.set(key, cur ?? null);
    return cur ?? null;
  };
  const apply = (l) => {
    for (const c of clones) c.remove();
    clones = new Set();
    const d = l.el, first = l.held;
    const standins = [...d.querySelectorAll(".drag-standin")];
    const wanted = new Set(standins.map((s) => standsFor.get(s)));
    const used = new Set();
    for (const C of new Set(standins.map((s) => s.parentElement))) {
      const S = boxIn(C, d);
      if (!S) continue;
      let cursor = S.firstChild;
      for (const child of [...C.childNodes]) {
        if (isStandin(child)) {
          let el = standsFor.get(child);
          if (used.has(el) || (el === h0 && child !== first)) { el = copy(el); clones.add(el); } else used.add(el);
          while (cursor && !isLive(cursor)) cursor = displace(cursor);
          if (cursor === el) { cursor = cursor.nextSibling; continue; }
          S.insertBefore(el, cursor);
        } else {
          while (cursor && !isLive(cursor) && !cursor.isEqualNode(child)) cursor = displace(cursor);
          if (cursor && !isLive(cursor)) { cursor = cursor.nextSibling; continue; } // the same already
          S.insertBefore(take(child), cursor);
        }
      }
      while (cursor) {
        if (!isLive(cursor)) cursor = displace(cursor);
        else if (!wanted.has(cursor)) { const n = cursor; cursor = n.nextSibling; n.remove(); }
        else cursor = cursor.nextSibling; // another box takes it
      }
    }
  };
  const show = (l) => {
    if (l === picked) return;
    picked = l;
    apply(l);
  };
  // l's box as it is on screen now
  const onScreen = (l) => {
    const S = boxIn(l.held.parentElement, l.el);
    if (!S) return null;
    const box = live.getBoundingClientRect(), r = S.getBoundingClientRect();
    return { left: r.left - box.left, top: r.top - box.top, right: r.right - box.left, bottom: r.bottom - box.top };
  };

  const move = (e) => {
    if (!live.isConnected) return end(false); // re-rendered under us
    if (!dragging) {
      if (Math.hypot(e.clientX - x0, e.clientY - y0) < THRESHOLD) return;
      dragging = true;
      document.body.classList.add("block-dragging");
      scroll = scroller(live);
      landings = measure(live, states, render, held, grab);
      for (const l of landings) for (const s of l.el.querySelectorAll(".drag-standin")) elements.add(standsFor.get(s));
      current = landings.find((l) => same(l.state, state)) ?? null;
      h0.classList.add("drag-held");
      makeCard();
    }
    e.preventDefault();
    const edge = 40;
    if (e.clientY < edge) scroll.scrollBy(0, -12);
    else if (e.clientY > innerHeight - edge) scroll.scrollBy(0, 12);
    place(e);
    const box = live.getBoundingClientRect();
    const p = { x: e.clientX - box.left, y: e.clientY - box.top };
    const l = pick(landings, p, picked, onScreen);
    if (l) show(l);
  };
  const end = (drop) => {
    if (done) return;
    done = true;
    removeEventListener("mousemove", move, true);
    removeEventListener("mouseup", up, true);
    removeEventListener("keydown", onKey, true);
    document.body.classList.remove("block-dragging");
    card?.remove();
    h0.classList.remove("drag-held");
    if (!dragging) return; // a click
    const to = picked?.state;
    if (drop && to !== undefined && !same(to, state) && live.isConnected) {
      onDrop(to); // renders anew; the drawing stays until then
      return;
    }
    if (live.isConnected && current) show(current);
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
