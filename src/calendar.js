import { today, addDays, weekStart } from "./dates.js";
import { place } from "./popover.js";
import { t } from "./i18n.js";

// A month grid (Monday first, ISO dates), drawn into `el`.
// opts: { selected, base, mark(day) -> "open" | "stale" | "overdue" | "written" | null, onPick(day) }.
// Opens on the month of `selected`, else of `base` (default today), the day
// relative dates count from, outlined when it is not today.
// Returns { show(day) }.
export function monthGrid(el, { selected, base = today(), mark = () => false, onPick }) {
  let month = (selected ?? base).slice(0, 7); // YYYY-MM

  const shift = (n) => {
    const d = new Date(month + "-01T00:00");
    d.setMonth(d.getMonth() + n);
    month = d.toLocaleDateString("sv").slice(0, 7);
    draw();
  };

  function draw() {
    // only the weeks that contain days of this month (4 to 6 rows)
    let day = weekStart(month + "-01");
    const cells = [];
    for (let i = 0; day.slice(0, 7) <= month || i % 7 !== 0; i++, day = addDays(day, 1)) {
      const cls = [
        day.slice(0, 7) !== month && "other",
        day === today() && "today",
        day === base && day !== today() && "base",
        day === selected && "selected",
        mark(day) && "has",
        mark(day) === "stale" && "stale",
        mark(day) === "overdue" && "overdue",
        mark(day) === "written" && "written",
      ].filter(Boolean).join(" ");
      cells.push(`<button type="button" data-day="${day}" class="${cls}">${Number(day.slice(8))}</button>`);
    }
    const [y, m] = month.split("-");
    el.innerHTML = `
      <div class="cal-head"><button type="button" class="pm">‹</button><span>${t("date.month", Number(y), Number(m))}</span><button type="button" class="nm">›</button></div>
      <div class="cal-grid">${[1, 2, 3, 4, 5, 6, 0].map((i) => `<span>${t("weekday.short")[i]}</span>`).join("")}${cells.join("")}</div>`;
    el.querySelector(".pm").onmousedown = (e) => { e.preventDefault(); shift(-1); };
    el.querySelector(".nm").onmousedown = (e) => { e.preventDefault(); shift(1); };
    el.querySelectorAll("[data-day]").forEach((b) => { b.onmousedown = (e) => { e.preventDefault(); onPick(b.dataset.day); }; });
  }
  draw();
  return {
    show(day) {
      selected = day;
      month = day.slice(0, 7);
      draw();
    },
  };
}

// Month grid popover, marked like the journal's week strip.
// Clicking the same button again closes it.
export function openCalendar(anchor, selected, mark, onPick) {
  const open = document.querySelector(".calendar");
  if (open) {
    open.close();
    if (open.anchor === anchor) return;
  }
  const box = document.createElement("div");
  box.className = "calendar";
  const r = anchor.getBoundingClientRect();
  place(box, r, { align: "end" });
  document.body.append(box);
  const close = () => { box.remove(); document.removeEventListener("mousedown", away); };
  box.anchor = anchor;
  box.close = close;
  monthGrid(box, { selected, mark, onPick: (day) => { close(); onPick(day); } });
  const away = (e) => { if (!box.contains(e.target) && !anchor.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener("mousedown", away));
}
