import { allTasks, moveBlockToPage, isDate } from "./store.js";
import { taskItem } from "./taskitem.js";
import { today, addDays, weekStart, md, weekday } from "./dates.js";
import { t as tr } from "./i18n.js";
import { drag } from "./dragspec.js";

// org-mode style agenda for one week. A task shows on the day it was written
// and on its DEADLINE; today also lists every overdue deadline.
//
// A task dragged by its handle to another day is moved there: the block, with
// its children, goes to the end of that day's journal page (dragspec.js). The
// states are the week's days and the page the block is on now; each is the
// week drawn with the task on that page, out of copies of the cards as they
// are, so the pointer picks a day by where the card would land in it and the
// week shows that outcome before the card is let go.

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

  const itemCtx = {
    ...ctx,
    rerender(focusId) {
      ctx.render();
      document.querySelector(`.task-item[data-id="${focusId}"]`)?.focusEditor();
    },
  };
  const tasks = allTasks();
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));

  // The week: a section per day, each task on it a card drawn by `card`
  // (with the labels it has there).
  function weekOf(tasks, card) {
    const el = document.createElement("div");
    el.className = "days";
    for (const day of days) {
      const sec = document.createElement("section");
      sec.className = "day" + (day === now ? " today" : "");
      sec.dataset.day = day;
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
      for (const [t, labels] of rows) sec.append(card(t, labels));
      if (!rows.length) sec.insertAdjacentHTML("beforeend", `<p class="empty">—</p>`);
      el.append(sec);
    }
    return el;
  }

  // the task's card in a drawing: on the day it is on when that is shown,
  // else wherever it is listed (its deadline, overdue today)
  const cardIn = (root, t, page) => root.querySelector(`.day[data-day="${page}"] .task-item[data-id="${t.id}"]`) ?? root.querySelector(`.task-item[data-id="${t.id}"]`);
  const copy = (t) => {
    const c = cardIn(live, t, t.page).cloneNode(true);
    c.querySelectorAll("[contenteditable]").forEach((e) => e.removeAttribute("contenteditable"));
    return c;
  };
  const live = weekOf(tasks, (t, labels) => {
    const card = taskItem(t, itemCtx, labels);
    const handle = document.createElement("span");
    handle.className = "drag";
    handle.textContent = "⠿";
    handle.onmousedown = (e) => drag(e, {
      live,
      state: t.page,
      states: [...new Set([t.page, ...days])],
      render: (p) => weekOf(tasks.map((x) => (x.id === t.id ? { ...x, page: p, date: isDate(p) ? p : null } : x)), copy),
      held: (root, p) => cardIn(root, t, p),
      onDrop: (p) => { moveBlockToPage(t.id, p); ctx.render(); },
    });
    card.prepend(handle);
    return card;
  });
  root.querySelector(".days").replaceWith(live);
}
