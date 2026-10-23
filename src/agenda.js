import { allTasks } from "./store.js";
import { taskItem } from "./taskitem.js";
import { today, addDays, weekStart, md, weekday } from "./dates.js";
import { t as tr } from "./i18n.js";

// org-mode style agenda for one week. A task shows on the day it was written
// and on its DEADLINE; today also lists every overdue deadline.

export function renderAgenda(root, ctx) {
  const start = weekStart(ctx.state.week ?? today());
  const now = today();
  root.innerHTML = `
    <div class="agenda">
      <div class="datebar">
        <button class="prev" title="${tr("week.prev")}">‹</button>
        <h1>${md(start)} – ${md(addDays(start, 6))}</h1>
        <button class="next" title="${tr("week.next")}">›</button>
        <button class="this">${tr("week.this")}</button>
      </div>
      <div class="days"></div>
    </div>`;
  const go = (d) => { ctx.state.week = d; ctx.render(); };
  root.querySelector(".prev").onclick = () => go(addDays(start, -7));
  root.querySelector(".next").onclick = () => go(addDays(start, 7));
  root.querySelector(".this").onclick = () => go(now);

  const days = root.querySelector(".days");
  const itemCtx = {
    ...ctx,
    rerender(focusId) {
      ctx.render();
      document.querySelector(`.task-item[data-id="${focusId}"]`)?.focusEditor();
    },
  };
  const tasks = allTasks();

  for (let i = 0; i < 7; i++) {
    const day = addDays(start, i);
    const sec = document.createElement("section");
    sec.className = "day" + (day === now ? " today" : "");
    const h = document.createElement("h3");
    const link = document.createElement("a");
    link.href = "#";
    link.textContent = `${weekday(day)} ${md(day)}`;
    link.onclick = (e) => { e.preventDefault(); ctx.openPage(day); };
    h.append(link);
    sec.append(h);

    const rows = [];
    for (const t of tasks) {
      const labels = [];
      if (t.deadline === day) labels.push({ text: tr("agenda.due"), cls: "due" });
      if (t.date === day || labels.length) rows.push([t, labels]);
      else if (day === now && t.deadline && t.deadline < now && t.task !== "done") {
        const late = Math.round((new Date(now) - new Date(t.deadline)) / 864e5);
        rows.push([t, [{ text: tr("agenda.overdueDays", late), cls: "overdue" }]]);
      }
    }
    const order = { doing: 0, todo: 1, done: 2 };
    rows.sort((a, b) => order[a[0].task] - order[b[0].task]);
    for (const [t, labels] of rows) sec.append(taskItem(t, itemCtx, labels));
    if (!rows.length) sec.insertAdjacentHTML("beforeend", `<p class="empty">—</p>`);
    days.append(sec);
  }
}
