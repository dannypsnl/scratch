export function place(box, rect, { align = "start" } = {}) {
  if (!box.isConnected) throw new Error("place: append the box to the page before placing it");
  const w = box.offsetWidth, h = box.offsetHeight;
  let left = align === "end" ? rect.right - w : rect.left;
  if (left + w > window.innerWidth - 8) left = Math.min(rect.right ?? rect.left, window.innerWidth - 8) - w;
  const below = window.innerHeight - 8 - (rect.bottom + 4), above = rect.top - 4 - 8;
  const down = h <= below || (h > above && below >= above);
  const room = down ? below : above;
  if (h > room) Object.assign(box.style, { maxHeight: `${room}px`, overflowY: "auto" });
  const top = down ? rect.bottom + 4 : rect.top - 4 - Math.min(h, room);
  const fixed = getComputedStyle(box).position === "fixed";
  box.style.left = `${Math.max(8, left) + (fixed ? 0 : window.scrollX)}px`;
  box.style.top = `${top + (fixed ? 0 : window.scrollY)}px`;
}
