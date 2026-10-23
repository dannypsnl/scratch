import { selectedBlocks, setDeadline } from "./outline.js";
import { monthGrid } from "./calendar.js";
import { today, addDays, weekStart, longDate } from "./dates.js";
import { place } from "./popover.js";
import { t } from "./i18n.js";

// ⌘⇧D, or a click on a deadline badge: pick (or clear) a DEADLINE.
// Type a date (2026-10-30, 10/30, +3, 明天, 下週一) or click one in the grid.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// weekday -> offset from Monday
const WEEKDAY = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6, mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };

export function parseDate(text) {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const now = today();
  if (t === "今天" || t === "today") return now;
  if (t === "明天" || t === "tomorrow") return addDays(now, 1);
  if (t === "後天") return addDays(now, 2);
  let m;
  if ((m = /^\+(\d+)$/.exec(t))) return addDays(now, Number(m[1]));
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t))) return iso(m[1], m[2], m[3]);
  // the long format the field shows: 2026 年 10 月 26 日, Oct 26, 2026 (or without the year)
  if ((m = /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?$/.exec(t))) return iso(m[1], m[2], m[3]);
  if ((m = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/.exec(t))) {
    const mo = MONTHS.indexOf(m[1]) + 1;
    if (m[3]) return iso(m[3], mo, m[2]);
    const d = iso(now.slice(0, 4), mo, m[2]);
    return d && d < now ? iso(Number(now.slice(0, 4)) + 1, mo, m[2]) : d;
  }
  if ((m = /^(\d{1,2})[-/.](\d{1,2})$/.exec(t))) {
    // month/day: this year, or next year if that day has passed
    const d = iso(now.slice(0, 4), m[1], m[2]);
    return d && d < now ? iso(Number(now.slice(0, 4)) + 1, m[1], m[2]) : d;
  }
  if ((m = /^(下|next )?(?:週|周|星期)?([一二三四五六日天]|mon|tue|wed|thu|fri|sat|sun)[a-z]*$/.exec(t))) {
    // 週五 = the coming Friday (today counts); 下週五 = Friday next week
    const target = WEEKDAY[m[2]];
    if (m[1]) return addDays(weekStart(now), 7 + target);
    const d = addDays(weekStart(now), target);
    return d < now ? addDays(d, 7) : d;
  }
  return null;
}

function iso(y, mo, d) {
  const s = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const date = new Date(s + "T00:00");
  return !isNaN(date) && date.toLocaleDateString("sv") === s ? s : null;
}

export function openDeadlinePicker(view, positions) {
  positions ??= selectedBlocks(view.state).map(([pos]) => pos);
  if (!positions.length) return;
  const first = view.state.doc.nodeAt(positions[0]);
  const coords = view.coordsAtPos(positions[0] + first.firstChild.nodeSize);
  const current = first.attrs.deadline;

  const box = document.createElement("div");
  box.className = "palette deadline-picker";
  place(box, coords);
  box.innerHTML = `
    <input class="date-text" placeholder="${t("deadline.placeholder")}" spellcheck="false">
    <div class="hint"></div>
    <div class="grid"></div>
    <div class="row">${current ? `<button type="button" class="clear">${t("deadline.clear")}</button>` : ""}</div>`;
  const input = box.querySelector(".date-text");
  const hint = box.querySelector(".hint");
  input.value = current ? longDate(current) : "";
  document.body.append(box);

  const close = () => { box.remove(); view.focus(); };
  const apply = (value) => { close(); setDeadline(view, positions, value); };
  const grid = monthGrid(box.querySelector(".grid"), { selected: current, onPick: apply });

  const preview = () => {
    const d = parseDate(input.value);
    const shown = d && longDate(d);
    hint.textContent = input.value.trim() && !d ? t("deadline.unknown") : d && shown !== input.value.trim() ? `→ ${shown}` : "";
    if (d) grid.show(d);
  };
  input.addEventListener("input", preview);
  box.querySelector(".clear")?.addEventListener("mousedown", (e) => { e.preventDefault(); apply(null); });
  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      const d = parseDate(input.value);
      if (d) apply(d);
      else if (!input.value.trim()) apply(null);
    } else if (e.key === "Escape") { e.preventDefault(); close(); }
  });
  input.addEventListener("blur", () => setTimeout(() => {
    if (document.hasFocus() && document.activeElement !== input && box.isConnected) box.remove();
  }));
  input.focus();
  input.select();
}
