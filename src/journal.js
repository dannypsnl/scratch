import { allTasks } from "./store.js";
import { taskItem } from "./taskitem.js";
import { openCalendar, monthGrid } from "./calendar.js";
import { today, addDays, weekStart, longDate } from "./dates.js";
import { mountOutline } from "./page.js";
import { t } from "./i18n.js";

// Heptabase-style journal: a week strip on top, one day below it; ‹ › move a
// week, Today plus a calendar dropdown.
//
// A dot on a day means something is still open there: a TODO / DOING task
// written that day, or one due that day. A red ring when that due date has
// passed. The week strip and both calendars mark days the same way.

const dow = (d) => new Date(d + "T00:00").getDay();

export function renderJournal(root, ctx) {
  const date = ctx.state.date ?? today();
  const now = today();
  const open = new Map(); // day -> "open" | "overdue"
  for (const t of allTasks()) {
    if (t.task === "done") continue;
    if (t.date) open.set(t.date, open.get(t.date) ?? "open");
    if (t.deadline) open.set(t.deadline, t.deadline < now ? "overdue" : open.get(t.deadline) ?? "open");
  }
  const start = weekStart(date);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const [y, m, d] = date.split("-").map(Number);

  root.innerHTML = `
   <div class="journal-grid">
   <div class="journal-main">
    <div class="weekbar">
      <button class="wk-prev" title="${t("week.prev")}">‹</button>
      <div class="week">
        ${days.map((day) => `
          <button data-day="${day}" class="${[day === date && "selected", day === now && "is-today", open.has(day) && "has", open.get(day) === "overdue" && "overdue"].filter(Boolean).join(" ")}">
            <span class="dot"></span><span class="wd">${t("weekday.short")[dow(day)]}</span><span class="dn">${Number(day.slice(8))}</span>
          </button>`).join("")}
      </div>
      <button class="wk-next" title="${t("week.next")}">›</button>
      <div class="today-group">
        <button class="today-btn">${t("today")}</button><button class="cal-btn" title="${t("calendar")}">⌄</button>
      </div>
    </div>
    <div class="journal">
      <section class="page">
        <div class="day-head">
          <div class="day-name">${t("weekday.long")[dow(date)]}</div>
          <h1>${longDate(date)}</h1>
        </div>
        <div class="editor"></div>
        <section class="due-here"></section>
        <section class="backlinks"></section>
      </section>
    </div>
   </div>
   <aside class="journal-side"></aside>
   </div>`;

  const go = (day) => ctx.openPage(day);
  root.querySelectorAll(".week [data-day]").forEach((b) => { b.onclick = () => go(b.dataset.day); });
  root.querySelector(".wk-prev").onclick = () => go(addDays(date, -7));
  root.querySelector(".wk-next").onclick = () => go(addDays(date, 7));
  root.querySelector(".today-btn").onclick = () => go(now);
  const calBtn = root.querySelector(".cal-btn");
  const mark = (day) => open.get(day) ?? null;
  calBtn.onclick = () => openCalendar(calBtn, date, mark, go);
  // with room to spare (see .journal-grid in style.css) the calendar is
  // always shown on the right and the dropdown button hides
  monthGrid(root.querySelector(".journal-side"), { selected: date, mark, onPick: go });

  mountOutline(root, date, ctx);
  renderDue(root.querySelector(".due-here"), date, ctx);
}

// Unfinished tasks written elsewhere and due on this day (what its dot also
// counts), editable in place. Hidden when there are none.
function renderDue(el, date, ctx) {
  const due = allTasks().filter((t) => t.deadline === date && t.task !== "done" && t.page !== date);
  el.hidden = !due.length;
  if (!due.length) return;
  const h = document.createElement("h3");
  h.innerHTML = `${t("due.title")}<span class="count">${due.length}</span>`;
  el.append(h);
  const itemCtx = { ...ctx, rerender: () => ctx.render() };
  for (const task of due) el.append(taskItem(task, itemCtx));
}
