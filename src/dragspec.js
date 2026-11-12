// Declarative dragging in plain DOM, after Horowitz, Blinn & Heer's
// "Declarative Dragging" and the shape of their library, dragology. A drag
// is declared as the states it can end in, not as what the pointer does:
//
//   drag(ev, { state, pick, render, held, onDrop })
//
// `render(state)` draws the UI as it would be in that state (the way a
// dragology Draggable draws a state); `held(root, state)` finds the dragged
// element in a drawing; `pick(p)` says which state the pointer at p (client
// coordinates) picks, from what is on screen. While the button is down, the
// live element is morphed into the drawing of the picked state, the held
// element faded in it, while a copy floats under the pointer (dragology's
// `withFloating`); so the pointer always sees the outcome it is over, and
// picks against that. Letting go commits the picked state through `onDrop`;
// Escape, or a drag that ends in the state it began in, puts the live
// element back. A press that does not move is a click and does nothing
// here.
//
// A drawing need not draw everything again: where a live element goes, it
// puts a stand-in for it (`standin(el)`: an empty box of its size, keyed to
// it, like a keyed element in React). A state is drawn once, when first
// picked. Showing a drawing moves only what is not already in place: the
// live elements are put in the order the drawing's stand-ins have, inside
// the live element's own boxes (matched to the drawing's by tag, class and
// data attributes down the same path of keys), and the drawing's other
// nodes (headings, counts) replace those that differ. So a picked state
// costs a move of the held element and whatever else changed.
//
// The block drag of the outline (drag.js) is the same idea with its own
// slots and drawing; this is the general shape for the rest of the UI.

const THRESHOLD = 4; // px the pointer moves before a press becomes a drag

const standsFor = new WeakMap(); // stand-in -> the live element it stands for
let heights = null; // element -> its height, measured once per drag (set while one is on)
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

// The scrolling box around an element (the page itself when there is none).
function scroller(el) {
  for (let e = el.parentElement; e; e = e.parentElement) {
    const o = getComputedStyle(e).overflowY;
    if ((o === "auto" || o === "scroll") && e.scrollHeight > e.clientHeight) return e;
  }
  return document.scrollingElement;
}

// Helpers for a pick: the box among `boxes` (elements) that holds the point
// p along an axis ("x" or "y"), else the nearest one along it.
export function boxAt(boxes, p, axis) {
  let best = null, dist = Infinity;
  for (const b of boxes) {
    const r = b.getBoundingClientRect();
    const [lo, hi] = axis === "x" ? [r.left, r.right] : [r.top, r.bottom];
    const d = Math.max(lo - p[axis], 0, p[axis] - hi);
    if (d < dist) { dist = d; best = b; }
  }
  return best;
}
// The gap among `items` (elements, top to bottom) the point p is level with:
// 0 above the first one's middle, n below the last one's.
export function gapAt(items, p) {
  let i = 0;
  for (const it of items) { const r = it.getBoundingClientRect(); if (p.y >= (r.top + r.bottom) / 2) i++; else break; }
  return i;
}

// ev: the mousedown that may become a drag.
// live: the element showing the current state; it is morphed into a state's
//   drawing while dragging and put back unless the drop re-renders.
// state: the current state; pick(p) → the state the pointer picks (null for
//   none); states are compared with `same` (Object.is unless given);
//   render(state) → element; held(root, state) → the dragged element in it;
//   onDrop(state) commits one (and is expected to render the live element
//   anew).
export function drag(ev, { live, state, pick, render, held, onDrop, same = Object.is }) {
  if (ev.button !== 0) return false;
  const h0 = held(live, state);
  if (!h0) return false;
  ev.preventDefault();
  const x0 = ev.clientX, y0 = ev.clientY;
  const b0 = h0.getBoundingClientRect();
  const grab = { x: x0 - b0.left, y: y0 - b0.top }; // the pointer's place in the held element
  let dragging = false, done = false, scroll = null;
  let picked = null, card = null;

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

  // Drawings, one per state picked so far.
  const elements = new Set(); // every live element some drawing stands in for
  const drawn = [];
  const drawingOf = (s) => {
    let d = drawn.find((x) => same(x.state, s));
    if (!d) {
      const el = render(s);
      d = { state: s, el, held: held(el, s) };
      drawn.push(d);
      for (const st of el.querySelectorAll(".drag-standin")) elements.add(standsFor.get(st));
    }
    return d;
  };

  // Morphing the live element into a drawing. A drawing's other nodes come
  // over as they are (leaving a mark to go back by, so the drawing can be
  // shown again), and nodes of the live element they replace go back to the
  // drawing they came from, or away.
  let clones = new Set(); // copies of an element a drawing puts in two places
  const isLive = (n) => elements.has(n) || clones.has(n);
  const origin = new WeakMap(); // a node brought over -> the mark where it was
  const take = (n) => { const m = document.createComment(""); origin.set(n, m); n.replaceWith(m); return n; };
  const displace = (n) => { const next = n.nextSibling; const m = origin.get(n); if (m) m.replaceWith(n); else n.remove(); return next; };
  // The live element's boxes, by key: each box of a drawing has its
  // counterpart down the same path of keys from the live element.
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
  const apply = (d) => {
    for (const c of clones) c.remove();
    clones = new Set();
    const standins = [...d.el.querySelectorAll(".drag-standin")];
    const wanted = new Set(standins.map((s) => standsFor.get(s)));
    const used = new Set();
    for (const C of new Set(standins.map((s) => s.parentElement))) {
      const S = boxIn(C, d.el);
      if (!S) continue;
      let cursor = S.firstChild;
      for (const child of [...C.childNodes]) {
        if (isStandin(child)) {
          let el = standsFor.get(child);
          if (used.has(el) || (el === h0 && child !== d.held)) { el = copy(el); clones.add(el); } else used.add(el);
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
  const show = (s) => {
    if (picked !== null && same(s, picked)) return;
    picked = s;
    apply(drawingOf(s));
  };

  const move = (e) => {
    if (!live.isConnected) return end(false); // re-rendered under us
    if (!dragging) {
      if (Math.hypot(e.clientX - x0, e.clientY - y0) < THRESHOLD) return;
      dragging = true;
      document.body.classList.add("block-dragging");
      scroll = scroller(live);
      heights = new WeakMap();
      margins = new Map();
      h0.classList.add("drag-held");
      makeCard();
    }
    e.preventDefault();
    const edge = 40;
    if (e.clientY < edge) scroll.scrollBy(0, -12);
    else if (e.clientY > innerHeight - edge) scroll.scrollBy(0, 12);
    place(e);
    const s = pick({ x: e.clientX, y: e.clientY });
    if (s != null) show(s);
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
    try {
      if (drop && picked !== null && !same(picked, state) && live.isConnected) {
        onDrop(picked); // renders anew; the drawing stays until then
        return;
      }
      if (live.isConnected) show(state);
    } finally {
      heights = margins = null;
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
