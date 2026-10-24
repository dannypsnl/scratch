import { allTasks, pageDates, getPage } from "./store.js";
import { taskItem } from "./taskitem.js";
import { openCalendar, monthGrid } from "./calendar.js";
import { today, addDays, weekStart, longDate } from "./dates.js";
import { mountOutline } from "./page.js";
import { t } from "./i18n.js";

// Heptabase-style journal: a week strip on top, one day below it; ‹ › move a
// week, Today plus a calendar dropdown.
//
// What a day holds, marked under it: a dot, something written; a ring, a
// TODO / DOING task still open (written that day, or due that day); a red
// ring, a deadline that passed with its task still open.
// The week strip and both calendars mark days the same way.

const dow = (d) => new Date(d + "T00:00").getDay();

// anything written in a day's page (a formula or an image counts)
const hasContent = (doc) => {
  if (!doc) return false;
  let found = false;
  doc.descendants((n) => { if (found) return false; if ((n.isText && n.text.trim()) || (n.isInline && !n.isText)) found = true; return !found; });
  return found;
};

export function renderJournal(root, ctx) {
  const date = ctx.state.date ?? today();
  const now = today();
  const open = new Map(); // day -> "todo" | "overdue"
  const rank = { todo: 0, overdue: 1 };
  const put = (day, m) => { if (!(rank[open.get(day)] >= rank[m])) open.set(day, m); };
  for (const t of allTasks()) {
    if (t.task === "done") continue;
    if (t.date) put(t.date, "todo");
    if (t.deadline) put(t.deadline, t.deadline < now ? "overdue" : "todo");
  }
  const written = new Set([...pageDates()].filter((day) => hasContent(getPage(day))));
  const mark = (day) => open.get(day) ?? (written.has(day) ? "written" : null);
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
          <button data-day="${day}" class="${[day === date && "selected", day === now && "is-today", mark(day) && "has", mark(day) === "todo" && "todo", mark(day) === "overdue" && "overdue"].filter(Boolean).join(" ")}">
            <span class="dot"></span><span class="wd">${t("weekday.short")[dow(day)]}</span><span class="dn">${Number(day.slice(8))}</span>
          </button>`).join("")}
      </div>
      <button class="wk-next" title="${t("week.next")}">›</button>
      <div class="today-group">
        <button class="today-btn">${t("today")}</button><button class="cal-btn" title="${t("calendar")}">⌄</button>
      </div>
    </div>
    <div class="journal">
      <section class="page" data-date="${date}">
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
