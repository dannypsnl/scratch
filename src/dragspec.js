// Dragging by a handle, declared as the places the drag can end (after
// Horowitz, Blinn & Heer's "Declarative Dragging"; the outline's drag.js is
// the same idea with its own slots and drawing):
//
//   drag(ev, { live, held, state, zones, show, onDrop })
//
// When the press becomes a drag, `zones()` lists every place the held
// element can be dropped — { state, band } each, the band a rectangle
// relative to the live element's box — worked out once from what is on
// screen with the held element taken out of its list as a hole, and kept
// for the whole drag: nothing is laid out again while the button is down,
// so the zones stay true and a move costs a lookup. The pointer picks the
// zone whose band holds it (else the nearest band); `show(zone)` draws what
// a drop there would do (cards making room, with transforms; a highlighted
// day); letting go commits the zone's state through `onDrop`. Escape, or a drop
// in the state the drag began in, does nothing. The held element is faded
// where it is while a copy of it floats under the pointer. A press that
// does not move is a click and does nothing here.

const THRESHOLD = 4; // px the pointer moves before a press becomes a drag

const inRect = (r, p) => p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom;
const toRect = (r, p) => Math.hypot(Math.max(r.left - p.x, 0, p.x - r.right), Math.max(r.top - p.y, 0, p.y - r.bottom));

// The zone the point p (relative to the live element's box) picks: the one
// picked now while p stays in its `hold` (the band it covers once it is
// drawn, when drawing it makes room), else the zone whose band holds p,
// else the nearest band.
export function pick(zones, p, picked = null) {
  if (picked && inRect(picked.hold ?? picked.band, p)) return picked;
  let best = null, dist = Infinity;
  for (const z of zones) {
    const d = inRect(z.band, p) ? 0 : toRect(z.band, p);
    if (d < dist) { dist = d; best = z; if (d === 0) break; }
  }
  return best;
}

// A rectangle relative to `box`.
export const within = (box, r) => ({ left: r.left - box.left, top: r.top - box.top, right: r.right - box.left, bottom: r.bottom - box.top });

// The scrolling box around an element (the page itself when there is none).
function scroller(el) {
  for (let e = el.parentElement; e; e = e.parentElement) {
    const o = getComputedStyle(e).overflowY;
    if ((o === "auto" || o === "scroll") && e.scrollHeight > e.clientHeight) return e;
  }
  return document.scrollingElement;
}

// ev: the mousedown that may become a drag.
// live: the element the zones are relative to; held: the dragged element;
// state: the state now; zones() → [{ state, band, ... }]; show(zone | null)
// draws the pick (null: none, at the end); onDrop(state) commits one; same
// compares states (Object.is unless given).
export function drag(ev, { live, held, state, zones, show, onDrop, same = Object.is }) {
  if (ev.button !== 0 || !held) return false;
  ev.preventDefault();
  const x0 = ev.clientX, y0 = ev.clientY;
  const b0 = held.getBoundingClientRect();
  const grab = { x: x0 - b0.left, y: y0 - b0.top }; // the pointer's place in the held element
  let dragging = false, done = false, scroll = null, all = null, picked = null, card = null, shield = null;

  // a copy of the held element, as it is now, under the pointer
  const makeCard = () => {
    card = document.body.appendChild(Object.assign(document.createElement("div"), { className: "drag-card" }));
    const copy = held.cloneNode(true);
    copy.classList.remove("drag-held");
    copy.querySelectorAll("[contenteditable]").forEach((e) => e.removeAttribute("contenteditable"));
    card.style.width = `${b0.width}px`;
    card.append(copy);
  };
  const place = (e) => {
    card.style.left = `${e.clientX - grab.x}px`;
    card.style.top = `${e.clientY - grab.y}px`;
  };

  const move = (e) => {
    if (!live.isConnected) return end(false); // re-rendered under us
    if (!dragging) {
      if (Math.hypot(e.clientX - x0, e.clientY - y0) < THRESHOLD) return;
      dragging = true;
      // the cursor over everything, without touching everything's style
      shield = document.body.appendChild(Object.assign(document.createElement("div"), { className: "drag-shield" }));
      scroll = scroller(live);
      all = zones();
      held.classList.add("drag-held");
      makeCard();
    }
    e.preventDefault();
    const edge = 40;
    if (e.clientY < edge) scroll.scrollBy(0, -12);
    else if (e.clientY > innerHeight - edge) scroll.scrollBy(0, 12);
    place(e);
    const box = live.getBoundingClientRect();
    const z = pick(all, { x: e.clientX - box.left, y: e.clientY - box.top }, picked);
    if (z !== picked) { picked = z; show(z); }
  };
  const end = (drop) => {
    if (done) return;
    done = true;
    removeEventListener("mousemove", move, true);
    removeEventListener("mouseup", up, true);
    removeEventListener("keydown", onKey, true);
    shield?.remove();
    card?.remove();
    held.classList.remove("drag-held");
    if (!dragging) return; // a click
    show(null);
    if (drop && picked && !same(picked.state, state) && live.isConnected) onDrop(picked.state);
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
