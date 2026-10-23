// Put a floating box under `rect` (viewport coordinates), kept inside the
// window: left edges aligned, or right edges when that would run past the
// window; flipped above when there is no room below. When it fits on neither
// side it goes on the roomier one, capped to the room there and scrolling.
// Measured once the box is in the page.
// align: "start" (default) or "end" (right edges aligned, for buttons at
// the right end of a bar).
export function place(box, rect, { align = "start" } = {}) {
  queueMicrotask(() => {
    const w = box.offsetWidth, h = box.offsetHeight;
    let left = align === "end" ? rect.right - w : rect.left;
    if (left + w > window.innerWidth - 8) left = Math.min(rect.right ?? rect.left, window.innerWidth - 8) - w;
    const below = window.innerHeight - 8 - (rect.bottom + 4), above = rect.top - 4 - 8;
    const down = h <= below || (h > above && below >= above);
    const room = down ? below : above;
    if (h > room) Object.assign(box.style, { maxHeight: `${room}px`, overflowY: "auto" });
    const top = down ? rect.bottom + 4 : rect.top - 4 - Math.min(h, room);
    box.style.left = `${Math.max(8, left) + window.scrollX}px`;
    box.style.top = `${top + window.scrollY}px`;
  });
}
