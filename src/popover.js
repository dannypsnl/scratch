// Put a floating box under `rect` (viewport coordinates), kept inside the
// window: left edges aligned, or right edges when that would run past the
// window; flipped above when there is no room below. Measured once the box
// is in the page.
// align: "start" (default) or "end" (right edges aligned, for buttons at
// the right end of a bar).
export function place(box, rect, { align = "start" } = {}) {
  queueMicrotask(() => {
    const w = box.offsetWidth, h = box.offsetHeight;
    let left = align === "end" ? rect.right - w : rect.left;
    if (left + w > window.innerWidth - 8) left = Math.min(rect.right ?? rect.left, window.innerWidth - 8) - w;
    let top = rect.bottom + 4;
    if (top + h > window.innerHeight - 8 && rect.top - h - 4 > 8) top = rect.top - h - 4;
    box.style.left = `${Math.max(8, left) + window.scrollX}px`;
    box.style.top = `${top + window.scrollY}px`;
  });
}
