// Declarative dragging in plain DOM, after Horowitz, Blinn & Heer's
// "Declarative Dragging" and the shape of their library, dragology. A drag
// is declared as the states it can end in, not as what the pointer does:
//
//   drag(ev, { states, render, held, onDrop })
//
// `render(state)` draws the UI as it would be in that state (the way a
// dragology Draggable draws a state); `held(root, state)` finds the dragged
// element in a drawing. When the press becomes a drag, every state is rendered
// speculatively, hidden, in the live element's place, to measure where the
// held element lands in it. The pointer then picks the state whose landing
// is nearest where the held element is being carried (dragology's `closest`),
// and the live element is swapped for that state's drawing, the held element
// faded in it, while a copy floats under the pointer (`withFloating`).
// Letting go commits the picked state through `onDrop`; Escape, or a drag
// that ends where it began, puts the live element back. A press that does
// not move is a click and does nothing here.
//
// The block drag of the outline (drag.js) is the same idea with its own
// slots and drawing; this is the general shape for the rest of the UI.

const THRESHOLD = 4; // px the pointer moves before a press becomes a drag

// The state whose landing point is nearest p. landings: [{ state, x, y }].
export function closest(landings, p) {
  let best = null, dist = Infinity;
  for (const l of landings) {
    const d = Math.hypot(l.x - p.x, l.y - p.y);
    if (d < dist) { dist = d; best = l; }
  }
  return best;
}

// Where the held element lands in each state: rendered hidden over `live`,
// at its width, and measured relative to live's top-left. Each state's
// drawing is kept, to show once picked.
function measure(live, states, render, held) {
  const box = live.getBoundingClientRect();
  const layer = document.createElement("div");
  layer.className = "drag-measure";
  Object.assign(layer.style, { position: "fixed", left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, visibility: "hidden", pointerEvents: "none" });
  const drawings = states.map((state) => ({ state, el: render(state) }));
  document.body.append(layer);
  const out = [];
  for (const d of drawings) {
    layer.replaceChildren(d.el);
    const h = held(d.el, d.state);
    if (!h) continue;
    const r = h.getBoundingClientRect();
    out.push({ ...d, x: r.left - box.left, y: r.top - box.top, width: r.width, height: r.height });
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
// live: the element showing the current state; it is swapped for a state's
//   drawing while dragging and put back unless the drop re-renders.
// state: the current state; states: every state the drag can end in
//   (compared with `same`, Object.is unless given); render(state) → element;
//   held(root, state) → the dragged element in it; onDrop(state) commits one.
export function drag(ev, { live, state, states, render, held, onDrop, same = Object.is }) {
  if (ev.button !== 0) return false;
  const h0 = held(live, state);
  if (!h0) return false;
  ev.preventDefault();
  const x0 = ev.clientX, y0 = ev.clientY;
  const b0 = h0.getBoundingClientRect();
  const grab = { x: x0 - b0.left, y: y0 - b0.top }; // the pointer's place in the held element
  let dragging = false, done = false;
  let landings = null, shown = live, picked = null, card = null;

  // a copy of the held element, as it is now, under the pointer
  const makeCard = () => {
    card = document.body.appendChild(Object.assign(document.createElement("div"), { className: "drag-card" }));
    const copy = h0.cloneNode(true);
    copy.classList.remove("drag-held");
    copy.querySelectorAll("[contenteditable]").forEach((e) => e.removeAttribute("contenteditable"));
    card.style.width = `${b0.width}px`;
    card.append(copy);
  };
  const place = (e) => {
    card.style.left = `${e.clientX - grab.x}px`;
    card.style.top = `${e.clientY - grab.y}px`;
  };
  // the live element's place shows the picked state's drawing (the live
  // element itself for the state it is in)
  const show = (l) => {
    if (l === picked) return;
    picked = l;
    const next = l && !same(l.state, state) ? l.el : live;
    if (next === shown) return;
    shown.replaceWith(next);
    shown = next;
    (next === live ? h0 : held(next, l.state))?.classList.add("drag-held");
  };
  const restore = () => {
    if (shown === live) return;
    shown.replaceWith(live);
    shown = live;
    h0.classList.remove("drag-held");
  };

  const move = (e) => {
    if (!shown.isConnected) return end(false); // re-rendered under us
    if (!dragging) {
      if (Math.hypot(e.clientX - x0, e.clientY - y0) < THRESHOLD) return;
      dragging = true;
      document.body.classList.add("block-dragging");
      landings = measure(live, states, render, held);
      h0.classList.add("drag-held");
      makeCard();
    }
    e.preventDefault();
    const s = scroller(shown), edge = 40;
    if (e.clientY < edge) s.scrollBy(0, -12);
    else if (e.clientY > innerHeight - edge) s.scrollBy(0, 12);
    place(e);
    // the held element's top-left, as the card carries it, against each landing
    const box = shown.getBoundingClientRect();
    const p = { x: e.clientX - grab.x - box.left, y: e.clientY - grab.y - box.top };
    show(closest(landings, p));
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
    if (drop && to !== undefined && !same(to, state) && shown.isConnected) {
      onDrop(to); // usually re-renders; the drawing stays until then
      return;
    }
    if (shown.isConnected) restore();
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
